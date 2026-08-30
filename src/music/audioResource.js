const { createAudioResource, StreamType } = require('@discordjs/voice');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { ProxyAgent } = require('undici');
const ffmpegPath = require('ffmpeg-static');

// The googlevideo.com URL yt-dlp resolves is IP-locked to whatever address negotiated it
// (the URL's signed `ip=` param). On a cloud host that's the warp sidecar's Cloudflare
// exit IP (see ytdlp.js). Fetching the audio bytes has to go through that same exit IP,
// or Google's CDN 403s the mismatch: without this, resolution succeeds but every download
// fails with that error. AUDIO_PROXY_URL is the warp sidecar's HTTP-proxy port, separate
// from ytdlp.js's SOCKS5 one because fetch/ffmpeg proxy support is HTTP-proxy-shaped.
const PROXY_URL = process.env.AUDIO_PROXY_URL || '';
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;
const ffmpegEnv = PROXY_URL ? { ...process.env, http_proxy: PROXY_URL, https_proxy: PROXY_URL } : process.env;

// Fast path: most YouTube audio-only formats are already Opus packaged in a WebM
// container, so we can hand the bytes straight to Discord's WebM/Opus demuxer with no
// transcoding step. Fall back to an ffmpeg transcode only when that's not available.
async function buildResource(streamInfo) {
  if (streamInfo.acodec === 'opus' && streamInfo.ext === 'webm') {
    const response = await fetch(streamInfo.url, proxyAgent ? { dispatcher: proxyAgent } : undefined);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch audio stream (HTTP ${response.status})`);
    }
    const nodeStream = Readable.fromWeb(response.body);
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
      '-acodec', 'libopus',
      '-f', 'ogg',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], env: ffmpegEnv },
  );

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  return { resource, process: ffmpeg };
}

module.exports = { buildResource };
