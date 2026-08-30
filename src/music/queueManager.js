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

// Read-only lookup — never creates one. Used by handlers that fire for every guild's
// voice activity (e.g. voiceStateUpdate) and should ignore guilds with no active queue
// instead of spinning one up just to look at it.
function peekQueue(guildId) {
  return queues.get(guildId);
}

module.exports = { getQueue, peekQueue };
