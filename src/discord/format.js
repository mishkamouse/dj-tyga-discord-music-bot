function formatDuration(totalSeconds) {
  if (totalSeconds == null) return 'Live/Unknown';
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function progressBar(elapsedSeconds, totalSeconds, length = 18) {
  if (!totalSeconds) return '`' + '▬'.repeat(length) + '` (live/unknown length)';
  const ratio = Math.min(1, Math.max(0, elapsedSeconds / totalSeconds));
  const filled = Math.round(ratio * length);
  const bar = '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, length - filled - 1));
  return `\`${formatDuration(elapsedSeconds)}\` ${bar} \`${formatDuration(totalSeconds)}\``;
}

function extractVideoId(url) {
  const match = /(?:v=|youtu\.be\/)([\w-]{11})/.exec(url || '');
  return match ? match[1] : null;
}

function thumbnailUrl(url) {
  const id = extractVideoId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

module.exports = { formatDuration, progressBar, extractVideoId, thumbnailUrl, truncate };
