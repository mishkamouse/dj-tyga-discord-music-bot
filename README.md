# music-bot

A Discord bot that joins a voice channel and streams YouTube audio (search, direct link,
or playlist) with play/pause/stop/skip and queue management. See the design notes this was
built from for the reasoning behind each choice (yt-dlp over JS extractor libraries, the
WebM/Opus fast path, the automated PO-token provider, etc.).

## 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications), click
   **Create App**, and name it.
2. On **General Information**, copy the **Application ID** — this is `DISCORD_CLIENT_ID`.
3. Click **Bot** in the sidebar, click **Reset Token**, and copy the token immediately (it's
   shown once) — this is `DISCORD_TOKEN`. Leave the **Privileged Gateway Intents** toggles
   off; nothing here needs them.
4. Click **Installation** in the sidebar. Under **Guild Install**, set scopes to `bot` and
   `applications.commands`. In the **Permissions** picker that appears, check only:
   `View Channels`, `Send Messages`, `Embed Links`, `Use Slash Commands`, `Connect`,
   `Speak` — this bot never needs anything beyond that (no Manage anything, no moderation
   permissions). `Embed Links` is required — every reply (now-playing card, queue view,
   etc.) is a rich embed, and without this permission Discord silently drops them.
5. Copy the **Install Link**, open it in a browser, pick your test server, and **Authorize**
   (you need Manage Server on that server to add bots to it).

## 2. Configure

```
cp .env.example .env
```

Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. For local testing, also set
`DISCORD_GUILD_ID` to your test server's ID so slash commands register instantly instead of
waiting up to an hour for global propagation.

## 3. Run locally with Docker (recommended)

This runs the bot together with the `bgutil-ytdlp-pot-provider` sidecar, exercising the same
automated PO-token path you'll use on AWS:

```
docker compose up --build
```

## 4. Run locally without Docker

Requires Node.js 22+ (yt-dlp's JS-challenge solver needs it — see Notes below), Python 3 +
pip, and ffmpeg on your PATH.

```
pip install "yt-dlp[default]" bgutil-ytdlp-pot-provider
npm install
```

Start the PO-token provider sidecar in a separate terminal (default port 4416, matches
`YTDLP_POT_PROVIDER_URL` in `.env.example`):

```
docker run --rm -p 4416:4416 brainicism/bgutil-ytdlp-pot-provider:latest
```

Then start the bot:

```
npm start
```

To also run `/ask` locally without Docker, start the agent sidecar in another terminal
(requires Python 3.12+):

```
cd agent
pip install -r requirements.txt
ANTHROPIC_API_KEY=... BOT_INTERNAL_API_URL=http://127.0.0.1:8100 uvicorn app:app --port 8000
```

## Commands

`/play <query-or-url>`, `/pause`, `/resume`, `/stop`, `/skip`, `/queue`, `/remove <index>`,
`/shuffle`, `/loop <off|track|queue>`, `/nowplaying`, `/leave`.

`/play` accepts a search term, a single video URL, or a playlist URL — playlists are
enqueued in full.

### `/ask <query>` — natural-language queue control (optional)

`/ask queue up 10 popular kanye songs from 2016`, `/ask remove everything from the queue`,
`/ask move the last song to play next`, `/ask skip the next 2 songs` — a Strands
Agents-based assistant (Python sidecar, `agent/`) interprets the request and carries it out
with full DJ-level control: search YouTube, read the complete queue state (including
whether it's paused and the loop mode), add tracks (to the end or to play next), remove or
reorder specific tracks, clear/shuffle the whole queue, skip one or many tracks at once,
pause/resume, and set loop mode. The plain slash commands above don't need this at all —
`/ask` is purely an additional interface onto the exact same queue, and both stay in sync
because they operate on the same underlying object.

### `/radio [query]` — continuous shuffled rotation (optional)

`/radio 90s R&B`, `/radio high energy workout songs`, or just `/radio` with no topic
(defaults to `RADIO_DEFAULT_QUERY` in `.env`, out of the box `Kanye West` — change that any
time, it's just a config value). Clears the current queue, then asks the same agent to
build a large pool (25+ tracks) of real songs matching the topic, shuffle it, and set loop
mode to `queue` — so it plays continuously and doesn't run dry. Under the hood this is just
`/ask` with an auto-generated instruction, reusing the exact same tools, security boundary,
and `search_youtube_batch` (looks up many songs in one round trip instead of one at a time,
which is what makes a 25+ song request finish in a reasonable time).

Both `/ask` and `/radio` require `ANTHROPIC_API_KEY` (or another provider — see
`STRANDS_MODEL_PROVIDER` in `.env.example`) and the `strands-agent` service running; leave
`STRANDS_AGENT_URL` blank to disable both.

**Least privilege, by design:**

- The agent's tools (`agent/tools.py`) only reach the bot through a small internal HTTP API
  (`src/internal/api.js`), never published outside the compose network. Every route is
  scoped per-guild — the guild ID is fixed from the original Discord interaction and is
  never something the model can set itself, so even a successful prompt injection can't
  redirect a tool call at another server.
- The agent has exactly eleven tools (search, batch search, queue
  read/add/remove/move/clear/shuffle/skip/pause/resume/loop) and nothing else — no shell,
  file, or generic HTTP/network tool is installed (`agent/requirements.txt` deliberately
  omits `strands-agents-tools`, the package that would add those), and `Agent(...)` is
  never given `load_tools_from_directory=True`, so nothing beyond that fixed list is ever
  reachable.
- **`add_tracks`'s `url` is validated, not just trusted.** The tool's docstring tells the
  model to only use URLs from `search_youtube`, but a docstring is a suggestion, not a
  boundary — nothing stops a hallucinated or prompt-injected URL from reaching it, and
  that URL eventually gets handed to yt-dlp as a subprocess argument on the bot side, which
  is a real SSRF-ish risk (yt-dlp's generic extractor will fetch arbitrary URLs, including
  internal-only services or a cloud metadata endpoint once deployed). This is enforced at
  two layers: a Strands `InterventionHandler` (`agent/interventions.py`, using the SDK's
  own `before_tool_call` policy hook to `Deny` the call before it executes and tell the
  model why, matching Strands' documented "infrastructure decides, not the prompt" pattern)
  as the first line of defense, and a matching regex check in the bot's own internal API
  as the actual trust boundary — enforced regardless of what the agent process does, in
  case that process is ever compromised or buggy.
- `add_tracks` is capped server-side (25 tracks/call) regardless of what's requested, and
  the agent has no way to join/leave a voice channel — that stays human-triggered
  (`/play`/`/stop`/`/leave`).
- Conversation memory is per-guild and lives only as long as the current queue session
  does — it resets the moment the queue empties and the bot disconnects (`/stop`, idle
  timeout, or a real external disconnect).

## Notes

- **`@discordjs/voice` must be on 0.19.x or newer.** Discord enforces its DAVE E2EE protocol
  on all non-stage voice calls (global rollout completed March 2026) — a client that doesn't
  support it gets its voice connection closed immediately with code 4017
  ("E2EE/DAVE protocol required"), and everything *looks* like a normal join right up until
  that point (gateway login, REST calls, even the voice websocket's initial handshake all
  succeed). DAVE support landed in `@discordjs/voice` 0.19.0 via a bundled
  `@snazzah/davey` dependency; `package.json` pins `^0.19.0` for this reason — don't downgrade
  it.
- **Keep yt-dlp current.** YouTube changes frequently; if extraction starts failing, first
  try `pip install -U "yt-dlp[default]" bgutil-ytdlp-pot-provider` (or rebuild the Docker
  image) before investigating anything else.
- **yt-dlp needs a JS runtime.** Since late 2025, YouTube extraction requires solving a JS
  challenge; yt-dlp handles this via its `yt-dlp-ejs` component (bundled by the `[default]`
  extra above) plus an external JS runtime — Deno by default, but we point it at Node
  (`--js-runtimes node` in `src/music/ytdlp.js`) since the bot already runs on Node 22+
  and there's no reason to add Deno as a second runtime just for this.
- **Don't pin `YTDLP_PLAYER_CLIENTS`** unless you have a specific reason to. We initially
  hardcoded `tv,web`, and it broke extraction — YouTube had made `tv` return UNPLAYABLE and
  `web` SABR-only (no direct URL) for some videos, while yt-dlp's own default client
  selection worked fine. Leave it blank and let yt-dlp choose.
- **Datacenter IPs (including AWS)** get YouTube's bot-detection challenge far more than home
  connections. The `pot-provider` sidecar handles this automatically — there should never be
  a need to manually export browser cookies. If extraction still fails after updating both
  packages, see the yt-dlp [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
  for the current state of the arms race.
- **Deploying to AWS**: this is a persistent-connection workload (Discord gateway + voice
  UDP), so it needs an always-on host — a small EC2 or Lightsail instance running
  `docker compose up -d` is the simplest fit. Lambda/Fargate-style short-lived compute
  doesn't work here.
- **Rootless Podman + a custom bridge network wouldn't reach `ready` on the voice
  connection at all** (separate from the DAVE issue above) when this was first tested on
  Bazzite. Running both containers with `--network host` fixed that. This turned out not to
  be the actual blocker for the DAVE issue (that was a code-level fix), but it's a real
  difference from Docker Engine's bridge networking worth knowing if voice connections hang
  in `connecting`/`signalling` on a rootless-Podman host — `docker-compose.yml` still uses a
  normal bridge network since standard Docker Engine (not rootless Podman) doesn't have the
  same quirk.
