const fs = require('node:fs');
const path = require('node:path');

// Per-guild radio artist rotation, persisted to disk so it survives bot restarts and
// redeploys, not just a queue session (unlike everything else in GuildQueue). A plain
// JSON file is enough for a small list of strings; no database needed. Mount ./data as a
// volume in docker-compose so it survives `docker compose up -d --build`, not just
// `docker compose restart`.
const STORE_PATH = process.env.RADIO_STORE_PATH || path.join(__dirname, '../../data/radio-artists.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    // ENOENT (no file yet) is expected and starts empty silently. Anything else, a
    // corrupted or truncated file, also falls back to empty (best-effort local state, not
    // worth crashing over) but gets logged, since persist() would otherwise overwrite the
    // corrupted file with `{}` on the next write and lose it for good.
    if (err.code !== 'ENOENT') {
      console.error(`[radio] failed to read ${STORE_PATH}, starting with an empty rotation:`, err.message);
    }
    cache = {};
  }
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2));
}

function getArtists(guildId) {
  return [...(load()[guildId] || [])];
}

function addArtist(guildId, name) {
  const trimmed = name.trim();
  if (!trimmed) return getArtists(guildId);
  const store = load();
  const list = store[guildId] || (store[guildId] = []);
  const exists = list.some((a) => a.toLowerCase() === trimmed.toLowerCase());
  if (!exists) {
    list.push(trimmed);
    persist();
  }
  return [...list];
}

function removeArtist(guildId, name) {
  const trimmed = name.trim().toLowerCase();
  const store = load();
  const list = store[guildId] || [];
  const next = list.filter((a) => a.toLowerCase() !== trimmed);
  if (next.length !== list.length) {
    store[guildId] = next;
    persist();
  }
  return [...next];
}

module.exports = { getArtists, addArtist, removeArtist };
