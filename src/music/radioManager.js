const { searchYoutube } = require('./resolve');
const { mapWithConcurrency } = require('./concurrency');
const radioStore = require('./radioStore');

const SEARCH_CONCURRENCY = 4; // each search spawns a yt-dlp subprocess; don't flood it
const POOL_PER_ARTIST = 8; // tracks fetched per artist when (re)building the pool
const TOP_UP_PER_ARTIST = 5; // tracks fetched per artist when just topping up after a mutation

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Batched search, one query per artist, each result tagged with the artist it came from —
// that tag is what lets reconcile() later tell a radio-sourced track apart from anything a
// user queued manually with /play.
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

// Starts (or restarts) radio mode: wipes the queue, skips whatever's currently playing, and
// fills it with a shuffled pool built from the guild's persisted artist list.
async function startRadio(queue, guildId, requestedBy) {
  let artists = radioStore.getArtists(guildId);
  if (artists.length === 0) {
    const seed = process.env.RADIO_DEFAULT_QUERY || 'Kanye West';
    artists = radioStore.addArtist(guildId, seed);
  }

  const pool = await buildPool(artists, POOL_PER_ARTIST);
  if (pool.length === 0) {
    throw new Error(`Couldn't find anything for: ${artists.join(', ')}`);
  }

  queue.clearQueue();
  if (queue.current) queue.skip();
  queue.setLoop('queue');
  queue.radioMode = true;
  queue.enqueue(shuffleArray(pool).map((t) => ({ ...t, requestedBy })));

  return { artists, count: pool.length };
}

// Reshapes the *live* queue to match the guild's current artist list — called after every
// /radio add|remove (and the equivalent agent tools), but only does anything if radio mode
// is actually on right now. Drops not-yet-played tracks whose artist was removed (the
// currently-playing track is left alone — it finishes naturally) and tops up with fresh
// tracks for any artist that's no longer represented in what's left.
async function reconcile(queue, guildId) {
  if (!queue.radioMode) return;

  const artists = radioStore.getArtists(guildId);
  if (artists.length === 0) {
    // Rotation emptied out entirely — let radio fizzle out rather than force-stopping
    // mid-playback. The current track finishes, the queue drains, and idle-timeout takes
    // over exactly like any other emptied queue.
    queue.tracks = queue.tracks.filter((t) => !t.artist);
    queue.radioMode = false;
    queue.loopMode = 'off';
    return;
  }

  const artistSet = new Set(artists.map((a) => a.toLowerCase()));
  queue.tracks = queue.tracks.filter((t) => !t.artist || artistSet.has(t.artist.toLowerCase()));

  const present = new Set(queue.tracks.filter((t) => t.artist).map((t) => t.artist.toLowerCase()));
  const missing = artists.filter((a) => !present.has(a.toLowerCase()));
  if (missing.length === 0) return;

  const fresh = await buildPool(missing, TOP_UP_PER_ARTIST);
  if (fresh.length > 0) queue.enqueue(shuffleArray(fresh));
}

module.exports = { startRadio, reconcile };
