const http = require('node:http');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { getQueue } = require('../music/queueManager');
const { searchYoutube } = require('../music/resolve');
const { mapWithConcurrency } = require('../music/concurrency');
const radioStore = require('../music/radioStore');
const { dropArtist, addArtistSongs } = require('../music/radioManager');

// Internal-only API for the Strands agent sidecar's tools. Never exposed outside the
// compose network (no published port). This is the sole surface the LLM can act through,
// and every route is scoped to the guildId in the path, which the agent never controls
// (it's fixed per-session on the Python side from the original Discord interaction).
const PORT = Number(process.env.INTERNAL_API_PORT) || 8100;
const MAX_ADD_TRACKS = 25;
const MAX_SEARCH_BATCH = 30;
const BATCH_SEARCH_CONCURRENCY = 4; // each search spawns a yt-dlp subprocess; don't flood it

// The actual trust boundary for what the agent can get played: /queue/add is the only
// path from agent-controlled text to a URL that later gets handed to yt-dlp as a
// subprocess argument, which is a real SSRF-ish risk (yt-dlp's generic extractor will
// fetch arbitrary URLs) if left unconstrained. Enforced here regardless of what the
// agent-side InterventionHandler already filters, since that's a separate process we
// don't want to be the only thing standing between a bad url and yt-dlp.
const YOUTUBE_URL_RE = /^https:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]{11}(&.*)?$|^https:\/\/youtu\.be\/[\w-]{11}(\?.*)?$/;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function trackView(track) {
  if (!track) return null;
  return { title: track.title, url: track.url, duration: track.duration, requestedBy: track.requestedBy };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://internal');
  const parts = url.pathname.split('/').filter(Boolean); // ['guilds', ':id', ...]

  if (parts[0] !== 'guilds' || !parts[1]) {
    res.writeHead(404).end();
    return;
  }
  const guildId = parts[1];
  const rest = parts.slice(2).join('/');
  const queue = getQueue(guildId);

  try {
    if (req.method === 'GET' && rest === 'queue') {
      return json(res, 200, {
        current: trackView(queue.current),
        tracks: queue.tracks.map(trackView),
        paused: queue.player.state.status === AudioPlayerStatus.Paused,
        loopMode: queue.loopMode,
      });
    }

    if (req.method === 'POST' && rest === 'search') {
      const { query, maxResults } = await readJsonBody(req);
      if (!query) return json(res, 400, { error: 'query is required' });
      const results = await searchYoutube(query, maxResults);
      return json(res, 200, { results });
    }

    // Bulk variant of /search for building a large pool (e.g. /radio) in a handful of
    // round trips instead of one per song. Each query is independent, so one bad or empty
    // result doesn't fail the rest.
    if (req.method === 'POST' && rest === 'search/batch') {
      const { queries, maxResultsPerQuery } = await readJsonBody(req);
      if (!Array.isArray(queries) || queries.length === 0) {
        return json(res, 400, { error: 'queries must be a non-empty array' });
      }
      const capped = queries.slice(0, MAX_SEARCH_BATCH).filter((q) => typeof q === 'string' && q.trim());
      const results = await mapWithConcurrency(capped, BATCH_SEARCH_CONCURRENCY, async (query) => {
        try {
          const matches = await searchYoutube(query, maxResultsPerQuery || 1);
          return { query, matches };
        } catch (err) {
          console.error(`[internal-api] batch search failed for ${JSON.stringify(query)}:`, err.message);
          return { query, matches: [] };
        }
      });
      return json(res, 200, { results });
    }

    if (req.method === 'POST' && rest === 'queue/add') {
      const { tracks, requestedBy, position } = await readJsonBody(req);
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return json(res, 400, { error: 'tracks must be a non-empty array' });
      }
      const capped = tracks.slice(0, MAX_ADD_TRACKS);
      const valid = capped.filter((t) => t && t.title && YOUTUBE_URL_RE.test(t.url || ''));
      if (valid.length === 0) return json(res, 400, { error: 'no valid tracks (need a youtube.com/youtu.be url + title)' });

      // position="now" needs the "was something already playing" check to happen before
      // enqueue(). If the queue was already idle, enqueue() auto-starts the first new
      // track itself, and skipping afterward would skip straight past it.
      const wasPlaying = Boolean(queue.current);
      queue.enqueue(
        valid.map((t) => ({ title: t.title, url: t.url, duration: t.duration ?? null, requestedBy })),
        { atFront: position === 'next' || position === 'now' },
      );
      if (position === 'now' && wasPlaying) queue.skip();

      return json(res, 200, {
        added: valid.length,
        cappedFrom: tracks.length > MAX_ADD_TRACKS ? tracks.length : undefined,
        startedNow: position === 'now',
      });
    }

    if (req.method === 'POST' && rest === 'queue/remove') {
      const { indices } = await readJsonBody(req);
      if (!Array.isArray(indices)) return json(res, 400, { error: 'indices must be an array' });
      const removed = [...indices]
        .sort((a, b) => b - a)
        .map((i) => queue.remove(i))
        .filter(Boolean)
        .reverse();
      return json(res, 200, { removed: removed.map(trackView) });
    }

    if (req.method === 'POST' && rest === 'queue/clear') {
      const count = queue.clearQueue();
      return json(res, 200, { cleared: count });
    }

    if (req.method === 'POST' && rest === 'queue/shuffle') {
      queue.shuffle();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rest === 'queue/move') {
      const { from, to } = await readJsonBody(req);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return json(res, 400, { error: 'from and to must be integers' });
      }
      const moved = queue.moveTrack(from, to);
      if (!moved) return json(res, 400, { error: 'from is out of range' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rest === 'queue/skip') {
      if (!queue.current) return json(res, 409, { error: 'nothing is playing' });
      const { count } = await readJsonBody(req);
      queue.skip(count);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rest === 'queue/pause') {
      if (!queue.current) return json(res, 409, { error: 'nothing is playing' });
      queue.pause();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rest === 'queue/resume') {
      if (!queue.current) return json(res, 409, { error: 'nothing is playing' });
      queue.resume();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rest === 'queue/loop') {
      const { mode } = await readJsonBody(req);
      if (!['off', 'track', 'queue'].includes(mode)) {
        return json(res, 400, { error: 'mode must be off, track, or queue' });
      }
      queue.setLoop(mode);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && rest === 'radio/artists') {
      return json(res, 200, { artists: radioStore.getArtists(guildId) });
    }

    if (req.method === 'POST' && rest === 'radio/artists') {
      const { artist } = await readJsonBody(req);
      if (!artist || typeof artist !== 'string') return json(res, 400, { error: 'artist is required' });
      const artists = radioStore.addArtist(guildId, artist);
      if (queue.radioMode) await addArtistSongs(queue, artist, 'assistant');
      return json(res, 200, { artists });
    }

    if (req.method === 'POST' && rest === 'radio/artists/remove') {
      const { artist } = await readJsonBody(req);
      if (!artist || typeof artist !== 'string') return json(res, 400, { error: 'artist is required' });
      const artists = radioStore.removeArtist(guildId, artist);
      dropArtist(queue, artist);
      return json(res, 200, { artists });
    }

    res.writeHead(404).end();
  } catch (err) {
    console.error(`[internal-api] ${req.method} ${req.url} failed:`, err.message);
    json(res, 500, { error: err.message });
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function startInternalApi() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[internal-api] unhandled error:', err.message);
      json(res, 500, { error: 'internal error' });
    });
  });
  server.listen(PORT, () => {
    console.log(`Internal API listening on :${PORT}`);
  });
  return server;
}

module.exports = { startInternalApi };
