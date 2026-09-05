const { searchYoutube } = require('./resolve');
const { mapWithConcurrency } = require('./concurrency');
const { shuffleArray } = require('./shuffle');
const radioStore = require('./radioStore');

const SEARCH_CONCURRENCY = 4; // each search spawns a yt-dlp subprocess; don't flood it
const INITIAL_POOL_PER_ARTIST = 8; // /radio on's starting pool, per artist
const ADD_ARTIST_BATCH = 8; // /radio add's one-time top-up, for just that one artist
const TOPUP_THRESHOLD = 5; // queue.tracks.length below this triggers a top-up
const TOPUP_MAX = 15; // at most this many fresh songs added per top-up
const SEARCH_RESULT_CAP = 50; // searchYoutube's own per-query ceiling; the no-repeat ceiling too

// A song's identity for no-repeat purposes: its video URL, plus its title with bracketed
// noise stripped ("Runaway (Official Audio)" and "Runaway [HD]" collapse to one key), so a
// re-upload under a different video id doesn't come back around later in the session. The
// title key is scoped by rotation artist, so two artists' same-titled songs (a cover, a
// standard) still count as different songs.
function trackKeys(track) {
  const keys = [];
  if (track.url) keys.push(`u:${track.url}`);
  const title = String(track.title || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (title) keys.push(`t:${(track.artist || '').toLowerCase()}|${title}`);
  return keys;
}

// Records songs as heard for this radio session. Called at queue time rather than play
// time so a song sitting in the queue can't also be picked up by the next top-up;
// GuildQueue.playNext() calls it again for whatever actually plays.
function remember(queue, tracks) {
  for (const track of tracks) {
    const keys = trackKeys(track);
    if (keys.length === 0) continue;
    if (!keys.some((key) => queue.radioHistory.has(key))) {
      queue.radioHistoryCount += 1;
      queue._radioExhausted = false; // found something new, so the rotation isn't dry anymore
    }
    for (const key of keys) queue.radioHistory.add(key);
  }
}

// Drops anything already heard this session, and any duplicate within `tracks` itself:
// one sweep can return the same song for two different artists.
function freshOnly(queue, tracks) {
  const seen = new Set();
  return tracks.filter((track) => {
    const keys = trackKeys(track);
    if (keys.some((key) => queue.radioHistory.has(key) || seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
}

// How many results to ask for per artist. Searching only as deep as we need would come
// back fully played-out on the second top-up (the same query returns the same top hits),
// so the ask grows with the session's history. YouTube's own result cap is what eventually
// exhausts a rotation, see notifyExhausted().
function searchDepth(queue, perArtist) {
  return Math.min(SEARCH_RESULT_CAP, perArtist + queue.radioHistoryCount);
}

// Every result for the rotation is already played. Say so once per session instead of
// letting radio quietly run dry, since neither fix is guessable from silence.
function notifyExhausted(queue, artists) {
  if (queue._radioExhausted) return;
  queue._radioExhausted = true;
  queue.textChannel
    ?.send(
      `📻 Radio has played everything I can find for **${artists.join(', ')}** without repeating. ` +
        'Add another artist with `/radio add`, or `/radio off` then `/radio on` to start the rotation over.',
    )
    .catch(() => {});
}

// Batched search, one query per artist. Each result is tagged with the artist it came
// from, which is how dropArtist() later tells a radio-sourced track apart from one a user
// queued manually with /play.
async function buildPool(artists, perArtist) {
  const perArtistResults = await mapWithConcurrency(artists, SEARCH_CONCURRENCY, async (artist) => {
    try {
      const results = await searchYoutube(artist, perArtist);
      return results.map((t) => ({ ...t, artist }));
    } catch (err) {
      console.error(`[radio] search failed for artist "${artist}":`, err.message);
      return [];
    }
  });
  return perArtistResults.flat();
}

// Starts (or restarts) radio mode: wipes the queue, skips whatever's playing, and fills it
// with a shuffled pool from the guild's saved artist list. maybeTopUp() below keeps it
// going from there; radio doesn't loop or replay this pool, it's just a starting point.
async function startRadio(queue, guildId, requestedBy) {
  let artists = radioStore.getArtists(guildId);
  if (artists.length === 0) {
    const seed = process.env.RADIO_DEFAULT_QUERY || 'Kanye West';
    artists = radioStore.addArtist(guildId, seed);
  }

  const pool = await buildPool(artists, INITIAL_POOL_PER_ARTIST);
  if (pool.length === 0) {
    throw new Error(`Couldn't find anything for: ${artists.join(', ')}`);
  }

  queue.clearQueue();
  if (queue.current) queue.skip();
  queue.radioMode = true;
  queue.resetRadioHistory(); // switching radio on is what clears the no-repeat memory

  const tracks = freshOnly(queue, shuffleArray(pool)).map((t) => ({ ...t, requestedBy }));
  remember(queue, tracks);
  queue.enqueue(tracks);

  return { artists, count: tracks.length };
}

// Called after every track transition (see GuildQueue.playNext()). If the queue is
// running low, fetches fresh songs from the current artist list and appends up to
// TOPUP_MAX. Blind to whatever else is in the queue, manually added tracks, a reordered
// mess, whatever; it only checks depth, so the queue stays freely editable while this
// keeps it topped up.
async function maybeTopUp(queue) {
  if (!queue.radioMode || queue._radioTopUpInFlight) return;
  if (queue.tracks.length >= TOPUP_THRESHOLD) return;

  const artists = radioStore.getArtists(queue.guildId);
  if (artists.length === 0) return; // nothing to draw from right now

  queue._radioTopUpInFlight = true;
  try {
    const perArtist = Math.max(1, Math.ceil(TOPUP_MAX / artists.length));
    const pool = await buildPool(artists, searchDepth(queue, perArtist));
    const fresh = shuffleArray(freshOnly(queue, pool)).slice(0, TOPUP_MAX);
    if (fresh.length === 0) {
      notifyExhausted(queue, artists);
    } else {
      const tracks = fresh.map((t) => ({ ...t, requestedBy: 'Radio' }));
      remember(queue, tracks);
      queue.enqueue(tracks);
    }
  } catch (err) {
    console.error(`[radio] top-up failed for guild ${queue.guildId}:`, err.message);
  } finally {
    queue._radioTopUpInFlight = false;
  }
}

// One-time: drops this artist's not-yet-played queued tracks. The currently-playing
// track, if any, finishes naturally. Purely a queue edit, no network call, so it's
// synchronous. No-op if radio isn't on.
function dropArtist(queue, artist) {
  if (!queue.radioMode) return;
  const lower = artist.toLowerCase();
  queue.tracks = queue.tracks.filter((t) => !t.artist || t.artist.toLowerCase() !== lower);
}

// One-time: fetches this artist's songs and shuffles them into the live queue. No-op if
// radio isn't on (the artist is still saved to the rotation either way; this only
// controls whether it also affects what's playing now).
async function addArtistSongs(queue, artist, requestedBy) {
  if (!queue.radioMode) return;
  const pool = await buildPool([artist], searchDepth(queue, ADD_ARTIST_BATCH));
  const fresh = freshOnly(queue, pool).slice(0, ADD_ARTIST_BATCH);
  if (fresh.length === 0) return;
  const tracks = fresh.map((t) => ({ ...t, requestedBy }));
  remember(queue, tracks);
  queue.enqueue(tracks);
  queue.shuffle();
}

module.exports = { startRadio, maybeTopUp, dropArtist, addArtistSongs, remember, trackKeys };
