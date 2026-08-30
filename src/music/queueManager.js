const GuildQueue = require('./GuildQueue');

const queues = new Map();

function getQueue(guildId) {
  let queue = queues.get(guildId);
  if (!queue) {
    queue = new GuildQueue(guildId);
    queues.set(guildId, queue);
  }
  return queue;
}

// Read-only: never creates a queue. Used by voiceStateUpdate and similar handlers that
// fire for every guild and shouldn't spin one up just to look.
function peekQueue(guildId) {
  return queues.get(guildId);
}

module.exports = { getQueue, peekQueue };
