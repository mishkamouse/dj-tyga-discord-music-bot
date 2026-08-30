// Fisher-Yates shuffle, in place. Shared by GuildQueue.shuffle() and radioManager's pool
// building so there's exactly one shuffle implementation instead of two identical copies.
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { shuffleArray };
