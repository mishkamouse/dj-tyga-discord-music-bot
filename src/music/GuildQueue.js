const {
  createAudioPlayer,
  joinVoiceChannel,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const { getStreamInfo } = require('./resolve');
const { buildResource } = require('./audioResource');
const { resetSession } = require('../internal/agentClient');
const { nowPlayingEmbed } = require('../discord/embeds');
const { nowPlayingButtons, disabledRow } = require('../discord/components');

const IDLE_TIMEOUT_MS = Number(process.env.QUEUE_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    this.tracks = []; // upcoming tracks; does not include the one currently playing
    this.current = null;
    this.loopMode = 'off'; // off | track | queue
    this.connection = null;
    this.textChannel = null; // last channel a command was run in, for failure notices
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.activeChildProcess = null; // ffmpeg fallback process for the playing track, if any
    this.nextStreamInfo = null; // { track, promise } prefetched one track ahead
    this.idleTimer = null;

    // Elapsed-time bookkeeping for the now-playing progress bar — approximate (to the
    // second) is plenty for a UI display, so no need to reconcile with the actual audio
    // player's internal playback clock.
    this.currentStartedAt = null;
    this.pausedAt = null;
    this.pausedMsTotal = 0;
    this.lastNowPlayingMessage = null;

    this.player.on(AudioPlayerStatus.Idle, () => this.onTrackEnd());
    this.player.on('error', (error) => {
      console.error(`[guild ${this.guildId}] player error:`, error.message);
      this.onTrackEnd();
    });
  }

  connect(voiceChannel) {
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
    this.connection.on('error', (error) => {
      console.error(`[guild ${this.guildId}] connection error:`, error.message);
    });
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.handleDisconnect());
    this.connection.subscribe(this.player);
  }

  // A manual disconnect (kicked from the channel, channel deleted, etc.) and a transient
  // blip (e.g. a voice server move) both land here first — @discordjs/voice recovers from
  // the latter on its own within a few seconds, so we only treat it as final if it doesn't.
  async handleDisconnect() {
    try {
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      this.connection?.destroy();
      this.connection = null;
      this.killActiveProcess();
      if (this.current) {
        this.tracks.unshift(this.current);
        this.current = null;
      }
      resetSession(this.guildId);
    }
  }

  enqueue(tracks, { atFront = false } = {}) {
    this.clearIdleTimer();
    if (atFront) this.tracks.unshift(...tracks);
    else this.tracks.push(...tracks);
    if (!this.current) {
      this.playNext();
    } else {
      this.ensurePrefetch();
    }
  }

  async playNext() {
    if (this.current) {
      if (this.loopMode === 'track') this.tracks.unshift(this.current);
      else if (this.loopMode === 'queue') this.tracks.push(this.current);
    }

    const next = this.tracks.shift();
    this.killActiveProcess();

    if (!next) {
      this.current = null;
      this.startIdleTimer();
      if (this.lastNowPlayingMessage) {
        this.lastNowPlayingMessage
          .edit({ components: [disabledRow(this.lastNowPlayingMessage.components[0])] })
          .catch(() => {});
        this.lastNowPlayingMessage = null;
      }
      return;
    }

    this.current = next;

    try {
      const streamInfo =
        this.nextStreamInfo?.track === next
          ? await this.nextStreamInfo.promise
          : await getStreamInfo(next);
      this.nextStreamInfo = null;

      const { resource, process: childProcess } = await buildResource(streamInfo);
      this.activeChildProcess = childProcess;
      this.player.play(resource);
      this.currentStartedAt = Date.now();
      this.pausedAt = null;
      this.pausedMsTotal = 0;
      this.ensurePrefetch();
      this.postNowPlaying();
    } catch (err) {
      console.error(`[guild ${this.guildId}] failed to play "${next.title}":`, err.message);
      this.textChannel?.send(`Skipping **${next.title}** — couldn't play it (${err.message}).`).catch(() => {});
      this.playNext();
    }
  }

  ensurePrefetch() {
    const upcoming = this.tracks[0];
    if (!upcoming || this.nextStreamInfo?.track === upcoming) return;
    this.nextStreamInfo = {
      track: upcoming,
      promise: getStreamInfo(upcoming).catch((err) => {
        console.error(`[guild ${this.guildId}] prefetch failed for "${upcoming.title}":`, err.message);
        throw err;
      }),
    };
  }

  onTrackEnd() {
    this.killActiveProcess();
    this.playNext();
  }

  // count > 1 skips past that many upcoming tracks in one go (the current track plus the
  // next count-1 queued ones are all discarded), landing on what was previously the
  // count-th queued track.
  skip(count = 1) {
    const n = Math.max(1, Math.floor(count) || 1);
    if (n > 1) this.tracks.splice(0, n - 1);
    this.player.stop(true);
  }

  pause() {
    this.player.pause();
    this.pausedAt = Date.now();
  }

  resume() {
    this.player.unpause();
    if (this.pausedAt) {
      this.pausedMsTotal += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }

  isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  getElapsedSeconds() {
    if (!this.currentStartedAt) return 0;
    const currentPauseMs = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Math.max(0, Math.floor((Date.now() - this.currentStartedAt - this.pausedMsTotal - currentPauseMs) / 1000));
  }

  // Posts a fresh Now Playing card to the last known text channel and disables the
  // buttons on the previous one (best-effort — an old message might be gone, or we might
  // lack permission by now; none of that should ever break playback).
  async postNowPlaying() {
    if (!this.textChannel || !this.current) return;
    const previous = this.lastNowPlayingMessage;
    this.lastNowPlayingMessage = null;
    if (previous) {
      previous
        .edit({ components: [disabledRow(previous.components[0])] })
        .catch(() => {});
    }
    try {
      const message = await this.textChannel.send({
        embeds: [nowPlayingEmbed(this)],
        components: [nowPlayingButtons(this)],
      });
      this.lastNowPlayingMessage = message;
    } catch (err) {
      console.error(`[guild ${this.guildId}] failed to post now-playing card:`, err.message);
    }
  }

  // Used by /nowplaying so its reply becomes the one live-controlled card too, instead of
  // leaving stale buttons active on whatever the auto-posted card was.
  trackNowPlayingMessage(message) {
    const previous = this.lastNowPlayingMessage;
    this.lastNowPlayingMessage = message;
    if (previous && previous.id !== message.id) {
      previous.edit({ components: [disabledRow(previous.components[0])] }).catch(() => {});
    }
  }

  stop() {
    this.tracks = [];
    this.loopMode = 'off';
    this.current = null;
    this.nextStreamInfo = null;
    this.killActiveProcess();
    this.player.stop(true);
    this.connection?.destroy();
    this.connection = null;
    this.clearIdleTimer();
    resetSession(this.guildId);
    if (this.lastNowPlayingMessage) {
      this.lastNowPlayingMessage.edit({ components: [disabledRow(this.lastNowPlayingMessage.components[0])] }).catch(() => {});
      this.lastNowPlayingMessage = null;
    }
  }

  // Empties the upcoming queue only — leaves the current track and voice connection alone.
  // Distinct from stop(), which also disconnects; this is what "clear the queue" means.
  clearQueue() {
    const count = this.tracks.length;
    this.tracks = [];
    this.nextStreamInfo = null;
    return count;
  }

  remove(index) {
    if (index < 0 || index >= this.tracks.length) return null;
    return this.tracks.splice(index, 1)[0];
  }

  // Reorders the upcoming queue — moves the track at fromIndex to toIndex (clamped into
  // range). Stale prefetches are harmless: playNext() only reuses a prefetch when it's
  // still reference-equal to the track it's about to play, so a reorder just means the
  // next play resolves fresh instead of using a cached prefetch.
  moveTrack(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.tracks.length) return false;
    const clampedTo = Math.max(0, Math.min(toIndex, this.tracks.length - 1));
    const [track] = this.tracks.splice(fromIndex, 1);
    this.tracks.splice(clampedTo, 0, track);
    return true;
  }

  shuffle() {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
  }

  setLoop(mode) {
    this.loopMode = mode;
  }

  killActiveProcess() {
    if (this.activeChildProcess && !this.activeChildProcess.killed) {
      this.activeChildProcess.kill('SIGKILL');
    }
    this.activeChildProcess = null;
  }

  startIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.connection?.destroy();
      this.connection = null;
      resetSession(this.guildId);
    }, IDLE_TIMEOUT_MS);
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

module.exports = GuildQueue;
