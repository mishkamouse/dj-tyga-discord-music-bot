const { runYtDlpJson, runYtDlpJsonLines } = require('./ytdlp');

function normalizeInput(input) {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

function isPlaylistUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/playlist' && parsed.searchParams.has('list');
  } catch {
    return false;
  }
}

function toTrack(info) {
  return {
    title: info.title || 'Unknown title',
    url: info.webpage_url || info.original_url || info.url,
    duration: info.duration ?? null,
  };
}

// A plain video URL that also carries a `list=` param (played from within a playlist) is
// resolved with --no-playlist so /play always means "this one track" unless the link is a
// playlist URL itself (youtube.com/playlist?list=...).
async function resolveInput(input) {
  const url = normalizeInput(input);

  if (url && isPlaylistUrl(url)) {
    const entries = await runYtDlpJsonLines(['--flat-playlist', url]);
    const tracks = entries
      .filter((entry) => entry && entry.id)
      .map((entry) => ({
        title: entry.title || entry.id,
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        duration: entry.duration ?? null,
      }));
    if (tracks.length === 0) throw new Error('Playlist is empty or unavailable.');
    return { type: 'playlist', title: entries[0]?.playlist_title, tracks };
  }

  const searchTarget = url ?? `ytsearch1:${input.trim()}`;
  const info = await runYtDlpJson(['--no-playlist', searchTarget]);
  return { type: 'track', track: toTrack(info) };
}

// Resolves a track's playable stream just-in-time (called for the current track and
// prefetched one track ahead — see GuildQueue).
async function getStreamInfo(track) {
  const info = await runYtDlpJson([
    '--no-playlist',
    '-f', 'bestaudio[acodec=opus]/bestaudio',
    track.url,
  ]);
  return { url: info.url, acodec: info.acodec, ext: info.ext };
}

// Read-only multi-result search, used directly by /radio (a large single-query pool) and
// by the /ask agent's search tools (smaller, per-song lookups). --flat-playlist keeps this
// fast — no per-result stream resolution.
async function searchYoutube(query, maxResults = 5) {
  const capped = Math.max(1, Math.min(maxResults, 50));
  const entries = await runYtDlpJsonLines(['--flat-playlist', `ytsearch${capped}:${query.trim()}`]);
  return entries
    .filter((entry) => entry && entry.id)
    .map((entry) => ({
      title: entry.title || entry.id,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      duration: entry.duration ?? null,
      channel: entry.channel || entry.uploader || null,
    }));
}

module.exports = { resolveInput, getStreamInfo, searchYoutube };
