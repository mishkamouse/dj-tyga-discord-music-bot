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

// googlevideo.com throttles bandwidth hard on a single continuous unranged request
// (confirmed live: a plain fetch of a 3.4MB file ran at ~32KB/s, at or below real-time
// playback rate; the same file fetched in 1MB Range chunks finished in 150ms at
// ~22MB/s). This is the same behavior yt-dlp's own downloader avoids via
// --http-chunk-size; this bot bypasses that entirely since it fetches the resolved URL
// directly rather than going through yt-dlp's downloader. Fetching in ranged chunks
// here avoids it the same way.
async function* fetchChunked(url) {
  let offset = 0;
  while (true) {
    const response = await fetch(url, {
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
      headers: { Range: `bytes=${offset}-${offset + CHUNK_SIZE - 1}` },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch audio stream (HTTP ${response.status})`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length === 0) return;
    yield buf;
    offset += buf.length;
    if (buf.length < CHUNK_SIZE) return; // short chunk means we just read the last one
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
