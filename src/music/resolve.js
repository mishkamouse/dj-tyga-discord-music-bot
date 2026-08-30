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

  // A direct video link always plays exactly what was linked — a full extraction of it,
  // no search involved. Free-text queries go through searchYoutube (song-first — see
  // below) instead of a plain ytsearch1, so "/play mettaton" lands on the actual song
  // rather than, say, a full boss-fight recording that happens to feature it.
  if (url) {
    const info = await runYtDlpJson(['--no-playlist', url]);
    return { type: 'track', track: toTrack(info) };
  }

  const [top] = await searchYoutube(input.trim(), 1);
  if (!top) throw new Error('No results found.');
  // One more full extraction to backfill duration (song-first search results don't carry
  // it — see searchYoutube) — the exact same cost /play always paid before, just moved
  // here instead of being the search step itself, so the "Added to queue" card shows the
  // real duration right away instead of "Live/Unknown" until playback resolves it.
  const info = await runYtDlpJson(['--no-playlist', top.url]);
  return { type: 'track', track: toTrack(info) };
}

// Resolves a track's playable stream just-in-time (called for the current track and
// prefetched one track ahead — see GuildQueue). Also returns duration: search results from
// YouTube Music (see searchYoutube below) don't carry it, since that catalog's flat search
// listing doesn't expose it the way a regular YouTube search does — this full per-video
// extraction was always happening before playback anyway, so backfilling duration from it
// here is free (GuildQueue assigns it onto the track once resolved).
async function getStreamInfo(track) {
  const info = await runYtDlpJson([
    '--no-playlist',
    '-f', 'bestaudio[acodec=opus]/bestaudio',
    track.url,
  ]);
  return { url: info.url, acodec: info.acodec, ext: info.ext, duration: info.duration ?? null };
}

function mapFlatEntries(entries) {
  return entries
    .filter((entry) => entry && entry.id)
    .map((entry) => ({
      title: entry.title || entry.id,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      duration: entry.duration ?? null,
      channel: entry.channel || entry.uploader || null,
    }));
}

// music.youtube.com/search's `sp` param restricts results to one catalog section. These
// two values come from yt-dlp's YoutubeMusicSearchURLIE (its _SECTIONS map) — not
// documented anywhere user-facing, just how that search page's own filter chips encode
// their state.
const YTM_SECTION_PARAM = {
  songs: 'EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D', // canonical entries — usually the audio-only official upload
  videos: 'EgWKAQIQAWoKEAoQAxAEEAkQBQ%3D%3D', // official music videos — still music, just no audio-only upload
};

async function ytMusicSearch(query, maxResults, section) {
  const url = `https://music.youtube.com/search?q=${encodeURIComponent(query)}&sp=${YTM_SECTION_PARAM[section]}`;
  const entries = await runYtDlpJsonLines(['--flat-playlist', '--playlist-end', String(maxResults), url]);
  return mapFlatEntries(entries);
}

// Read-only multi-result search, used by /play, /radio's per-artist pool building, and the
// /ask agent's search tools. Prefers actual songs over incidental video content (a full
// boss-fight recording that happens to feature a song, a let's-play, a vlog) by searching
// YouTube Music's own catalog first, "Songs" section before "Videos" — this isn't a
// heuristic filter applied after the fact, YouTube Music's index simply doesn't contain
// non-music video in the first place. Falls back to a regular YouTube search only if
// neither YTM section has anything, so a track genuinely outside Music's catalog (an
// obscure remix, ambience, etc.) still comes back instead of erroring out.
async function searchYoutube(query, maxResults = 5) {
  const capped = Math.max(1, Math.min(maxResults, 50));
  const trimmed = query.trim();

  for (const section of ['songs', 'videos']) {
    const results = await ytMusicSearch(trimmed, capped, section);
    if (results.length > 0) return results;
  }

  const entries = await runYtDlpJsonLines(['--flat-playlist', `ytsearch${capped}:${trimmed}`]);
  return mapFlatEntries(entries);
}

module.exports = { resolveInput, getStreamInfo, searchYoutube };
