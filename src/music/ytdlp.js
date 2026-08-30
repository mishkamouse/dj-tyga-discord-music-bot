const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL || 'http://127.0.0.1:4416';
// Left to yt-dlp's own default client selection rather than pinned here. yt-dlp's
// maintainers retune that list against YouTube's changes faster than we could, and a
// hardcoded list (e.g. "tv,web") has excluded clients that were working. Set
// YTDLP_PLAYER_CLIENTS to override if needed.
const PLAYER_CLIENTS = process.env.YTDLP_PLAYER_CLIENTS || '';
// Routes yt-dlp's requests through the warp sidecar (Cloudflare's network) for
// reliability on cloud hosts. Leave blank for local dev, where this isn't needed.
const PROXY_URL = process.env.YTDLP_PROXY_URL || '';

const BASE_ARGS = [
  '--no-warnings',
  // YouTube extraction requires solving a JS challenge; use the Node.js this bot already
  // runs on instead of pulling in Deno (yt-dlp's default runtime) as a separate dependency.
  '--js-runtimes', 'node',
  // Tokens come from the bgutil-ytdlp-pot-provider sidecar automatically. See "How it
  // works" in the README.
  '--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`,
  ...(PLAYER_CLIENTS ? ['--extractor-args', `youtube:player_client=${PLAYER_CLIENTS}`] : []),
  ...(PROXY_URL ? ['--proxy', PROXY_URL] : []),
];

async function runYtDlp(args) {
  try {
    const { stdout } = await execFileAsync(YTDLP_PATH, [...BASE_ARGS, ...args], {
      maxBuffer: 1024 * 1024 * 32,
    });
    return stdout;
  } catch (err) {
    const detail = err.stderr?.trim() || err.message;
    throw new Error(`yt-dlp failed: ${detail}`);
  }
}

async function runYtDlpJson(args) {
  const stdout = await runYtDlp(['-j', ...args]);
  const firstLine = stdout.trim().split('\n')[0];
  if (!firstLine) throw new Error('yt-dlp returned no data.');
  return JSON.parse(firstLine);
}

async function runYtDlpJsonLines(args) {
  const stdout = await runYtDlp(['-j', ...args]);
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = { runYtDlpJson, runYtDlpJsonLines };
