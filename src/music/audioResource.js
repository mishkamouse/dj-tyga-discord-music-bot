const { createAudioResource, StreamType } = require('@discordjs/voice');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { ProxyAgent } = require('undici');
const ffmpegPath = require('ffmpeg-static');

// The googlevideo.com URL yt-dlp resolves is IP-locked to whatever address negotiated it
// (the URL's signed `ip=` param). On a cloud host that's the warp sidecar's Cloudflare
// exit IP (see ytdlp.js). Fetching the audio bytes has to go through that same exit IP,
// or Google's CDN 403s the mismatch. AUDIO_PROXY_URL is the warp sidecar's HTTP-proxy
// port, separate from ytdlp.js's SOCKS5 one because fetch's proxy support is
// HTTP-proxy-shaped.
const PROXY_URL = process.env.AUDIO_PROXY_URL || '';
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;
const ffmpegEnv = PROXY_URL ? { ...process.env, http_proxy: PROXY_URL, https_proxy: PROXY_URL } : process.env;

const CHUNK_SIZE = 1024 * 1024; // 1MiB — comfortably under YouTube's ~10MiB throttle trigger

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

// googlevideo.com throttles bandwidth hard on a single continuous unranged request; this
// fetches in ranged chunks to avoid it (same reason yt-dlp's downloader uses
// --http-chunk-size). A 403 means the proxy identity is likely reputation-flagged, so
// retrying it is pointless and fails fast; anything else gets a couple of quick retries.
async function fetchChunk(url, offset) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
        headers: { Range: `bytes=${offset}-${offset + CHUNK_SIZE - 1}` },
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    if (response.status === 403) throw new Error('Failed to fetch audio stream (HTTP 403)');
    if (response.ok && response.body) return Buffer.from(await response.arrayBuffer());
    if (attempt >= MAX_ATTEMPTS) throw new Error(`Failed to fetch audio stream (HTTP ${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

async function* fetchChunked(url) {
  let offset = 0;
  while (true) {
    const buf = await fetchChunk(url, offset);
    if (buf.length === 0) return;
    yield buf;
    offset += buf.length;
    if (buf.length < CHUNK_SIZE) return;
  }
}

// Fast path: most YouTube audio-only formats are already Opus packaged in a WebM
// container, so we can hand the bytes straight to Discord's WebM/Opus demuxer with no
// transcoding step. Falls back to an ffmpeg transcode only when that's not available.
async function buildResource(streamInfo) {
  if (streamInfo.acodec === 'opus' && streamInfo.ext === 'webm') {
    const nodeStream = Readable.from(fetchChunked(streamInfo.url));
    const resource = createAudioResource(nodeStream, { inputType: StreamType.WebmOpus });
    return { resource, process: null };
  }

  const ffmpeg = spawn(
    ffmpegPath,
    [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', streamInfo.url,
      '-vn',
      '-acodec', streamInfo.acodec === 'opus' ? 'copy' : 'libopus',
      '-f', 'ogg',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], env: ffmpegEnv },
  );

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  return { resource, process: ffmpeg };
}

module.exports = { buildResource };
