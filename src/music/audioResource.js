const { createAudioResource, StreamType } = require('@discordjs/voice');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const ffmpegPath = require('ffmpeg-static');

// Fast path: most YouTube audio-only formats are already Opus packaged in a WebM
// container, so we can hand the bytes straight to Discord's WebM/Opus demuxer with no
// transcoding step. Fall back to an ffmpeg transcode only when that's not available.
async function buildResource(streamInfo) {
  if (streamInfo.acodec === 'opus' && streamInfo.ext === 'webm') {
    const response = await fetch(streamInfo.url);
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
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  return { resource, process: ffmpeg };
}

module.exports = { buildResource };
