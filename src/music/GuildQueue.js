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
const radioStore = require('./radioStore');

const IDLE_TIMEOUT_MS = Number(process.env.QUEUE_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;
const ALONE_TIMEOUT_MS = Number(process.env.ALONE_TIMEOUT_MS) || 60 * 60 * 1000;

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    this.tracks = []; // upcoming tracks; does not include the one currently playing
    this.current = null;
    this.loopMode = 'off'; // off | track | queue
    this.connection = null;
    this.textChannel = null; // channel for auto-posted now-playing cards and failure notices
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.activeChildProcess = null; // ffmpeg fallback process for the playing track, if any
    this.nextStreamInfo = null; // { track, promise } prefetched one track ahead
    this.idleTimer = null;

    // Elapsed-time bookkeeping for the now-playing progress bar — accurate to the
    // second, which is all a UI display needs.
    this.currentStartedAt = null;
    this.pausedAt = null;
    this.pausedMsTotal = 0;
    this.lastNowPlayingMessage = null;

    // 24/7 mode (/247): suppresses the empty-queue idle timeout below, replaced by a
    // separate, much longer timeout that only fires once the voice channel itself has had
    // no other members for a while — see checkAlone().
    this.persistent = false;
    this.aloneTimer = null;

    // Radio mode (/radio): loopMode is set to 'queue' as an implementation detail, and
    // tracks pulled in for radio carry a `.artist` tag (see radioManager.js) so this queue
    // can tell them apart from anything a user queues manually — see enqueue() below.
    this.radioMode = false;

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
      this.clearAloneTimer();
      this.persistent = false;
      this.radioMode = false;
      if (this.current) {
        this.tracks.unshift(this.current);
        this.current = null;
      }
      resetSession(this.guildId);
    }
  }

  // Radio never locks the queue, but it also doesn't get knocked out by a manual /play
  // (or the agent's add_tracks) anymore — a manually-added track just cuts into the
  // rotation once (see the loop-recycle guard in playNext(): untagged tracks aren't
  // recycled, so it plays through and the artist rotation carries on underneath it).
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
      else if (this.loopMode === 'queue') {
        if (this.radioMode) {
          // Only radio-sourced tracks are part of the permanent rotation — a manually
          // added track (no .artist tag) plays once and doesn't loop back in, and a
          // radio-sourced one only recycles while its artist is still in the rotation
          // (otherwise it'd keep resurfacing forever even after reconcile() stripped the
          // other queued copies at removal time).
          const stillWanted =
            this.current.artist &&
            radioStore.getArtists(this.guildId).some((a) => a.toLowerCase() === this.current.artist.toLowerCase());
          if (stillWanted) this.tracks.push(this.current);
        } else {
          this.tracks.push(this.current);
        }
      }
    }

    const next = this.tracks.shift();
    this.killActiveProcess();

    if (!next) {
      this.current = null;
      this.startIdleTimer();
      this.retireNowPlayingCard();
      return;
    }

    this.current = next;

    try {
      const streamInfo =
        this.nextStreamInfo?.track === next
          ? await this.nextStreamInfo.promise
          : await getStreamInfo(next);
      this.nextStreamInfo = null;
      if (streamInfo.duration != null) next.duration = streamInfo.duration;

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
      promise: getStreamInfo(upcoming)
        .then((info) => {
          // Backfill onto the queued track itself (not just used at playback time) so a
          // /queue view checked after the prefetch resolves shows its real duration too.
          if (info.duration != null) upcoming.duration = info.duration;
          return info;
        })
        .catch((err) => {
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

  // Posts a fresh Now Playing card to the last known text channel and retires the
  // previous one. Best-effort throughout — an old message might be gone, or we might
  // lack permission by now; none of that should ever break playback.
  async postNowPlaying() {
    if (!this.textChannel || !this.current) return;
    this.retireNowPlayingCard();
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

  // Disables the buttons on the currently-tracked card (if any) and starts tracking
  // `next` instead — or nothing, if omitted. Also used directly by /nowplaying so its
  // reply becomes the one live-controlled card, instead of leaving stale buttons active
  // on whatever the auto-posted card was.
  retireNowPlayingCard(next = null) {
    const previous = this.lastNowPlayingMessage;
    this.lastNowPlayingMessage = next;
    if (previous && previous.id !== next?.id) {
      previous.edit({ components: [disabledRow(previous.components[0])] }).catch(() => {});
    }
  }

  // Stops playback and empties the queue without necessarily disconnecting — the shared
  // core of stop() below, and also what /stop uses on its own in 24/7 mode, where clearing
  // the current queue shouldn't count as the "manually disconnected" override 24/7 promises
  // to honor (see stop()). startIdleTimer() at the end is a no-op while persistent.
  clearPlayback() {
    this.tracks = [];
    this.loopMode = 'off';
    this.radioMode = false;
    this.current = null;
    this.nextStreamInfo = null;
    this.killActiveProcess();
    this.player.stop(true);
    this.retireNowPlayingCard();
    this.startIdleTimer();
  }

  // Fully ends the session: stops playback, clears the queue, and disconnects from voice —
  // also turning off 24/7 mode, since actually leaving the channel *is* the manual
  // disconnect 24/7 mode is waiting for. Used by /leave, /stop outside 24/7 mode, and the
  // alone-timer giving up after too long with no one else in the channel.
  stop() {
    this.clearPlayback();
    this.connection?.destroy();
    this.connection = null;
    this.clearIdleTimer();
    this.clearAloneTimer();
    this.persistent = false;
    resetSession(this.guildId);
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
    if (this.persistent) return; // 24/7 mode — an empty queue alone never disconnects
    this.idleTimer = setTimeout(() => {
      this.connection?.destroy();
      this.connection = null;
      resetSession(this.guildId);
    }, IDLE_TIMEOUT_MS);
  }

  enablePersistent() {
    this.persistent = true;
    this.clearIdleTimer();
  }

  // Turns 24/7 mode off and, if the queue happens to be idle right now, starts the normal
  // empty-queue timeout immediately rather than waiting for the next track to end.
  disablePersistent() {
    this.persistent = false;
    this.clearAloneTimer();
    if (!this.current) this.startIdleTimer();
  }

  // Call whenever voice-channel membership changes for the channel this queue is
  // connected to. Only does anything in 24/7 mode — otherwise the normal empty-queue
  // timeout already handles walking away on its own.
  checkAlone(voiceChannel) {
    if (!this.persistent || !this.connection) return;
    const hasOthers = voiceChannel.members.some((m) => !m.user.bot);
    if (hasOthers) this.clearAloneTimer();
    else this.startAloneTimer();
  }

  startAloneTimer() {
    if (this.aloneTimer) return; // already counting down
    this.aloneTimer = setTimeout(() => this.stop(), ALONE_TIMEOUT_MS);
  }

  clearAloneTimer() {
    if (this.aloneTimer) clearTimeout(this.aloneTimer);
    this.aloneTimer = null;
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

module.exports = GuildQueue;
