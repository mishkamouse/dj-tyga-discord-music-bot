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
const { shuffleArray } = require('./shuffle');
const radioManager = require('./radioManager');

const IDLE_TIMEOUT_MS = Number(process.env.QUEUE_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;
const ALONE_TIMEOUT_MS = Number(process.env.ALONE_TIMEOUT_MS) || 60 * 60 * 1000;
// How often the Now Playing card is redrawn so its progress bar keeps up with the song.
// Ten seconds is frequent enough to read as moving and nowhere near Discord's edit rate
// limit, which is per-message and far looser than this.
const NOW_PLAYING_REFRESH_MS = Number(process.env.NOW_PLAYING_REFRESH_MS) || 10 * 1000;

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

    // Elapsed-time bookkeeping for the now-playing progress bar, accurate to the second,
    // which is all a UI display needs.
    this.currentStartedAt = null;
    this.pausedAt = null;
    this.pausedMsTotal = 0;
    this.lastNowPlayingMessage = null;
    this.nowPlayingTimer = null; // redraws the card on a tick; see startNowPlayingUpdates()
    this._nowPlayingEditInFlight = false; // one edit at a time, so a slow tick can't stack up

    // 24/7 mode (/247): suppresses the empty-queue idle timeout below, replaced by a
    // separate, much longer timeout that only fires once the voice channel has had no
    // other members for a while. See checkAlone().
    this.persistent = false;
    this.aloneTimer = null;

    // Radio mode (/radio): tracks carry a `.artist` tag (see radioManager.js) so /radio
    // remove can drop just that artist's queued tracks. radioManager.maybeTopUp(), called
    // from playNext() below, keeps the queue from running dry.
    this.radioMode = false;
    this._radioTopUpInFlight = false; // guards against overlapping top-up fetches

    // No-repeat memory for the current radio session: keys (see radioManager.trackKeys)
    // for every song radio has queued or played since it was switched on. Top-ups filter
    // against it, so a song comes back around only after /radio off and on again.
    this.radioHistory = new Set();
    this.radioHistoryCount = 0; // distinct songs remembered; drives how deep radio searches
    this._radioExhausted = false; // "played everything" notice already sent this session

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

  // A manual disconnect (kicked, channel deleted) and a transient blip (e.g. a voice
  // server move) both land here first. @discordjs/voice recovers from the latter on its
  // own within a few seconds, so this only treats it as final if that doesn't happen.
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
      this.stopNowPlayingUpdates();
      this.persistent = false;
      this.radioMode = false;
      this.resetRadioHistory();
      if (this.current) {
        this.tracks.unshift(this.current);
        this.current = null;
      }
      resetSession(this.guildId);
    }
  }

  // Radio never locks the queue: a manual /play (or the agent's add_tracks) just adds a
  // track like normal, and radioManager.maybeTopUp() keeps the flow of artist songs going
  // underneath it regardless of what else ends up here.
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
      this.stopNowPlayingUpdates();
      // A dry queue in radio mode is a hiccup between top-ups, not the end of the session,
      // so keep the card tracked: the next track edits it instead of posting (and pinging)
      // a new one.
      if (!this.radioMode) this.retireNowPlayingCard();
      radioManager.maybeTopUp(this);
      return;
    }

    this.current = next;
    // Radio-queued songs were remembered when they were queued; this also covers a track
    // that got here some other way (/play, the agent) while radio is running, so radio
    // won't turn around and queue something the room just heard.
    if (this.radioMode) radioManager.remember(this, [next]);

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
      radioManager.maybeTopUp(this);
    } catch (err) {
      console.error(`[guild ${this.guildId}] failed to play "${next.title}":`, err.message);
      this.textChannel?.send(`Skipping **${next.title}**, couldn't play it (${err.message}).`).catch(() => {});
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

  // Puts the Now Playing card in the last known text channel: edits the tracked card in
  // place in radio mode, otherwise posts a fresh one and retires the previous. Best-effort
  // throughout: an old message might be gone, or permissions might have changed, and none
  // of that should break playback.
  //
  // Radio queues songs indefinitely, so a new message per track means a Discord
  // notification every few minutes. An edit produces none. The trade-off is that the card
  // stays wherever it was posted rather than following the conversation down; /nowplaying
  // re-posts it at the bottom and becomes the card edited from then on.
  async postNowPlaying() {
    if (!this.textChannel || !this.current) return;
    const payload = this.nowPlayingPayload();

    const existing = this.lastNowPlayingMessage;
    if (this.radioMode && existing) {
      try {
        this.lastNowPlayingMessage = await existing.edit(payload);
        this.startNowPlayingUpdates();
        return;
      } catch (err) {
        // Card deleted, or no longer editable. Fall through and post a fresh one.
        console.error(`[guild ${this.guildId}] failed to edit now-playing card:`, err.message);
      }
    }

    this.retireNowPlayingCard();
    try {
      this.lastNowPlayingMessage = await this.textChannel.send(payload);
      this.startNowPlayingUpdates();
    } catch (err) {
      console.error(`[guild ${this.guildId}] failed to post now-playing card:`, err.message);
    }
  }

  nowPlayingPayload() {
    return { embeds: [nowPlayingEmbed(this)], components: [nowPlayingButtons(this)] };
  }

  // Redraws the tracked card every NOW_PLAYING_REFRESH_MS so the progress bar's 🔘 walks
  // along with the song instead of freezing where the track started. Always edits the
  // message it is already tracking, so this adds no notifications of its own, in radio
  // mode or out of it.
  startNowPlayingUpdates() {
    this.stopNowPlayingUpdates();
    this.nowPlayingTimer = setInterval(() => this.refreshNowPlayingCard(), NOW_PLAYING_REFRESH_MS);
    // Node keeps the process alive for a pending interval; this one is pure UI and should
    // never be the reason the bot doesn't exit.
    this.nowPlayingTimer.unref?.();
  }

  stopNowPlayingUpdates() {
    if (this.nowPlayingTimer) clearInterval(this.nowPlayingTimer);
    this.nowPlayingTimer = null;
  }

  // Starts the redraw tick if a track is playing and a card is being tracked but nothing
  // is ticking yet. Lets /nowplaying and the card buttons pick the clock back up after a
  // failed post stopped it.
  ensureNowPlayingUpdates() {
    if (!this.nowPlayingTimer && this.current && this.lastNowPlayingMessage) this.startNowPlayingUpdates();
  }

  async refreshNowPlayingCard() {
    const message = this.lastNowPlayingMessage;
    if (!message || !this.current) return this.stopNowPlayingUpdates();
    // Paused: elapsed isn't moving, so the redraw would be byte-identical. Skip the call
    // rather than spend a request on it; the pause button already redrew the card itself.
    if (this.isPaused() || this._nowPlayingEditInFlight) return;

    this._nowPlayingEditInFlight = true;
    try {
      this.lastNowPlayingMessage = await message.edit(this.nowPlayingPayload());
    } catch (err) {
      // Deleted, or the bot lost access to the channel. Either way it won't fix itself, so
      // stop ticking instead of logging the same failure every ten seconds forever.
      console.error(`[guild ${this.guildId}] now-playing refresh stopped:`, err.message);
      this.stopNowPlayingUpdates();
    } finally {
      this._nowPlayingEditInFlight = false;
    }
  }

  // Disables the buttons on the currently-tracked card (if any) and starts tracking
  // `next` instead, or nothing if omitted. Also used directly by /nowplaying so its reply
  // becomes the one live-controlled card, instead of leaving stale buttons on the
  // auto-posted one.
  retireNowPlayingCard(next = null) {
    const previous = this.lastNowPlayingMessage;
    this.lastNowPlayingMessage = next;
    if (previous && previous.id !== next?.id) {
      previous.edit({ components: [disabledRow(previous.components[0])] }).catch(() => {});
    }
    this.ensureNowPlayingUpdates();
  }

  // Wipes the no-repeat memory, so the next radio session starts from a clean slate.
  // Called whenever radio switches off, and again by startRadio() when it switches on.
  resetRadioHistory() {
    this.radioHistory.clear();
    this.radioHistoryCount = 0;
    this._radioExhausted = false;
  }

  // Stops playback and empties the queue without disconnecting. The shared core of
  // stop() below, and what /stop uses on its own in 24/7 mode, where clearing the queue
  // shouldn't count as the manual disconnect 24/7 waits for (see stop()).
  // startIdleTimer() at the end is a no-op while persistent.
  clearPlayback() {
    this.tracks = [];
    this.loopMode = 'off';
    this.radioMode = false;
    this.resetRadioHistory();
    this.current = null;
    this.nextStreamInfo = null;
    this.killActiveProcess();
    this.player.stop(true);
    this.stopNowPlayingUpdates();
    this.retireNowPlayingCard();
    this.startIdleTimer();
  }

  // Fully ends the session: stops playback, clears the queue, disconnects from voice, and
  // turns off 24/7 mode, since leaving the channel is the manual disconnect 24/7 mode
  // waits for. Used by /leave, /stop outside 24/7 mode, and the alone-timer giving up.
  stop() {
    this.clearPlayback();
    this.connection?.destroy();
    this.connection = null;
    this.clearIdleTimer();
    this.clearAloneTimer();
    this.persistent = false;
    resetSession(this.guildId);
  }

  // Empties the upcoming queue only. Leaves the current track and voice connection alone.
  // Distinct from stop(), which also disconnects.
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

  // Reorders the upcoming queue: moves the track at fromIndex to toIndex (clamped into
  // range). Stale prefetches are harmless: playNext() only reuses a prefetch when it's
  // still reference-equal to the track it's about to play, so a reorder just means the
  // next play resolves fresh.
  moveTrack(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.tracks.length) return false;
    const clampedTo = Math.max(0, Math.min(toIndex, this.tracks.length - 1));
    const [track] = this.tracks.splice(fromIndex, 1);
    this.tracks.splice(clampedTo, 0, track);
    return true;
  }

  shuffle() {
    shuffleArray(this.tracks);
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
    if (this.persistent) return; // 24/7 mode: an empty queue alone never disconnects
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
  // connected to. Only does anything in 24/7 mode; otherwise the normal empty-queue
  // timeout already handles walking away.
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
