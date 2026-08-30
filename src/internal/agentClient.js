const STRANDS_AGENT_URL = process.env.STRANDS_AGENT_URL || '';

// Fire-and-forget: dropping a guild's agent memory a little late (or not at all, if the
// sidecar isn't running) is harmless — the next /ask just gets a fresh session either way.
function resetSession(guildId) {
  if (!STRANDS_AGENT_URL) return;
  fetch(`${STRANDS_AGENT_URL}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guildId }),
  }).catch((err) => {
    console.error(`[guild ${guildId}] failed to reset agent session:`, err.message);
  });
}

function isConfigured() {
  return Boolean(STRANDS_AGENT_URL);
}

// Sends a query to the guild's agent session and returns its natural-language reply.
async function askAgent(guildId, query, requestedBy, { timeoutMs = 90_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${STRANDS_AGENT_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId, query, requestedBy }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`agent returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
    }
    const { reply } = await response.json();
    return reply;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { resetSession, isConfigured, askAgent };
