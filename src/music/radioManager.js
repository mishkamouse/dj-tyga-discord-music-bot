const { searchYoutube } = require('./resolve');
const { mapWithConcurrency } = require('./concurrency');
const { shuffleArray } = require('./shuffle');
const radioStore = require('./radioStore');

const SEARCH_CONCURRENCY = 4; // each search spawns a yt-dlp subprocess; don't flood it
const INITIAL_POOL_PER_ARTIST = 8; // /radio on's starting pool, per artist
const ADD_ARTIST_BATCH = 8; // /radio add's one-time top-up, for just that one artist
const TOPUP_THRESHOLD = 5; // queue.tracks.length below this triggers a top-up
const TOPUP_MAX = 15; // at most this many fresh songs added per top-up

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
  queue.enqueue(shuffleArray(pool).map((t) => ({ ...t, requestedBy })));

  return { artists, count: pool.length };
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
    const fresh = shuffleArray(await buildPool(artists, perArtist)).slice(0, TOPUP_MAX);
    if (fresh.length > 0) queue.enqueue(fresh.map((t) => ({ ...t, requestedBy: 'Radio' })));
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
  const fresh = await buildPool([artist], ADD_ARTIST_BATCH);
  if (fresh.length === 0) return;
  queue.enqueue(fresh.map((t) => ({ ...t, requestedBy })));
  queue.shuffle();
}

module.exports = { startRadio, maybeTopUp, dropArtist, addArtistSongs };
