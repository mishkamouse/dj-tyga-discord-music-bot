// Runs fn(item) over items with at most `limit` in flight at once. Shared by anything that
// fans out multiple yt-dlp search subprocesses at once (batch search, radio pool building)
// and needs to bound how many run concurrently.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { mapWithConcurrency };
