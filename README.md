# 🎧 DJ Tyga

An interactive Discord music bot that streams YouTube audio into your voice channel —
controllable via classic slash commands, rich interactive "Now Playing" cards with
one-click buttons, and an optional natural-language assistant that manages the queue for
you in plain English.

```
/play Kanye West Ultralight Beam
/ask queue up 10 popular kanye songs from 2016
/radio add Kendrick Lamar
/radio on
```

## Contents

- [Features](#features)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Configuration reference](#configuration-reference)
- [Security: the natural-language assistant's boundaries](#security-the-natural-language-assistants-boundaries)
- [Deploying to AWS](#deploying-to-aws)
- [Troubleshooting & operational notes](#troubleshooting--operational-notes)
- [Project layout](#project-layout)

## Features

**Playback**
- Search, direct video links, or full playlists via `/play`
- Queue management: add, remove, reorder, shuffle, loop (off / track / queue)
- Skip, pause, resume, stop — instantly, with no noticeable join/stream latency

**Interactive UI, not just text**
- Every track that starts playing auto-posts a rich **Now Playing** card — thumbnail,
  title, a live progress bar, requester, and loop state — with buttons to
  pause/resume, skip, stop, shuffle, and cycle loop mode right from the message, no
  typing required
- `/queue` renders a paginated, button-navigable embed instead of a wall of text
- Older cards automatically grey out their buttons once superseded, so there's only ever
  one "live" control panel per server

**Natural language, when you want it**
- `/ask <anything>` — a real LLM agent (Claude, via
  [AWS Strands Agents](https://strandsagents.com)) interprets free-form requests
  ("queue up some upbeat 2016 songs", "remove everything", "move the last song to play
  next") and carries them out using the same queue every slash command uses
- `/radio` — a continuous rotation built from a small, **saved-per-server list of
  artists** (`/radio add`/`remove`/`list`), not a one-shot topic search. Starting it
  (`/radio on`) is deliberately **not** LLM-driven — a fast bulk YouTube search per artist
  gets music playing in a couple of seconds, not a hand-curated playlist several round
  trips later. The list itself persists across restarts, and editing it — via the slash
  command or by asking `/ask` in plain English — reshapes the *live* queue immediately if
  radio is already on, without cutting off whatever's currently playing. Radio never locks
  the queue, either: `/play`-ing something outside the rotation doesn't turn radio off — it
  just cuts that song into the mix once, and the artist rotation keeps going underneath it
- Both are fully optional — every plain slash command works with zero LLM involvement,
  and the assistant is scoped to a fixed, audited set of queue-only tools (see
  [Security](#security-the-natural-language-assistants-boundaries))

## Commands

| Command | Description |
|---|---|
| `/play <query-or-url>` | Search term, video URL, or playlist URL. Joins your voice channel and queues it — plays immediately if idle. |
| `/pause` | Pause the current track. |
| `/resume` | Resume a paused track. |
| `/skip` | Skip the current track. |
| `/stop` | Stop playback and clear the queue. Leaves the voice channel too — unless 24/7 mode is on, in which case it stays connected (see below). |
| `/leave` | Leave the voice channel. |
| `/queue` | Show the queue — now playing plus upcoming, paginated with buttons. |
| `/nowplaying` | Show the current track as a live control-panel card (buttons included). |
| `/remove <index>` | Remove a specific track from the queue by position. |
| `/shuffle` | Shuffle the upcoming queue. |
| `/loop <off\|track\|queue>` | Set the loop mode. |
| `/247` | Toggle 24/7 mode — stay connected indefinitely instead of leaving on an empty queue (see below). |
| `/ask <query>` | Tell the bot what you want in plain language; the assistant figures out the tool calls. *(optional — needs an LLM provider configured)* |
| `/radio on [artist]` | Start radio from your saved artist rotation (optionally adding one first). |
| `/radio off` | Turn off radio mode; finishes what's queued, then stops normally. |
| `/radio add <artist>` / `/radio remove <artist>` | Edit the rotation — reshapes the live queue immediately if radio is on. |
| `/radio list` | Show the current rotation. |

The "Now Playing" card's buttons cover pause/resume, skip, stop, shuffle, and loop —
everything the most common single-click actions need — while `/ask` covers anything
harder to express as a button, like "skip the next three songs" or "move that to the
front."

`/247` replaces the normal empty-queue idle timeout with a much longer one based on
whether anyone else is actually in the channel — the bot stays connected through an empty
queue indefinitely, and only leaves once a human actually disconnects it (`/leave`, or
`/247` again to turn it off) or the channel has had no other members for over an hour
(`ALONE_TIMEOUT_MS`). `/stop` while 24/7 is on deliberately does **not** count as that
manual disconnect — it just stops playback and clears the queue, the same as it always
does, and the bot stays put; only `/leave` (or toggling `/247` off) actually ends the
session.

`/radio`'s artist list is per-server and survives restarts (stored under `data/`, not
in-memory queue state) — build it up over time with `/radio add`/`remove` regardless of
whether radio is currently playing. `/radio` doesn't touch the LLM at all: it's plain
YouTube search, one call per artist, so it starts fast. `/ask` *can* edit the same list in
plain English ("add some Kendrick to the radio") using three narrow tools scoped to that
one list — it still has no way to start radio itself or touch voice, same as every other
LLM boundary in this project (see [Security](#security-the-natural-language-assistants-boundaries)).

## How it works

```mermaid
flowchart TD
    Discord((Discord)) <-->|gateway websocket + voice UDP| Bot

    Bot["<b>bot</b> — Node.js / discord.js<br/>the only service that talks to Discord;<br/>owns the queue, voice connection, UI, and radio artist list"]
    Bot -->|"/ask queries"| Agent
    Agent -->|"tool calls, via internal API"| Bot
    Bot -->|PO token requests| Pot
    Bot -->|"yt-dlp traffic (cloud hosts only)"| Warp

    Agent["<b>strands-agent</b> — Python / FastAPI<br/>Strands Agents SDK · powers /ask<br/>(and can edit the radio list, but never starts radio or touches voice)"]
    Agent -->|model calls| LLM[("Anthropic API<br/>or Bedrock / Ollama")]

    Pot["<b>pot-provider</b><br/>runs BotGuard attestation itself,<br/>serves fresh YouTube anti-bot tokens"]
    Warp["<b>warp</b><br/>Cloudflare WARP — routes around YouTube's<br/>datacenter-IP blocks, automatic, no login"]
    Warp -->|WireGuard| Cloudflare[("Cloudflare network")]
```

Four containers, always running together. Every internal port (the bot's own API, the
agent's API, the pot-provider, the WARP proxy) is compose-internal only — nothing but
Discord, Cloudflare, and (if
configured) Anthropic's API is ever reachable from outside.

**A single track, end to end:** `/play` resolves the query via `yt-dlp` (with an
automatically-supplied anti-bot token from `pot-provider` — see below), joins your voice
channel, and hands YouTube's audio straight to Discord. Most YouTube audio is already
Opus inside a WebM container, so it's demuxed directly with no transcoding step — the
`ffmpeg` path only kicks in as a fallback for the rare format that isn't already Opus.
The *next* queued track's stream is resolved one track ahead in the background, so
skipping and track transitions feel instant instead of pausing to resolve a URL.

**Why free-text search prefers songs over videos:** typing an artist, character, or game
into plain YouTube search often surfaces the most-viewed video for that term — a full
boss-fight recording, a let's-play, a reaction video — rather than the actual song, since
regular search ranks by popularity across *all* video content, not music specifically. Every
search in this bot (`/play`, `/radio`, `/ask`'s search tools) instead queries **YouTube
Music's own catalog** first — `music.youtube.com`'s "Songs" section, then its "Videos"
(official music videos) section, falling back to a regular YouTube search only if neither
has anything. This isn't post-hoc filtering of regular results: YouTube Music's index
structurally only contains music, so non-music video never has a chance to surface in the
first place. See `searchYoutube` in `src/music/resolve.js`.

One trade-off: YouTube Music's search listing doesn't carry a track's duration up front the
way a regular YouTube search does. `/play` backfills it immediately with one extra
extraction of the chosen result — the same cost it always paid, just moved a step later —
so its "Added to queue" card still shows a real duration right away. Bulk results (radio's
per-artist pool, the `/ask` agent's search tools) skip that extra round trip to stay fast,
so those show "Live/Unknown" until a track is actually about to play: `getStreamInfo`
already does a full per-track extraction right before playback (and one ahead, via
prefetch) to get a playable stream, and backfills duration onto the track at that point for
free. In practice this means the currently-playing track and the very next one in queue
always show accurate durations; anything further back in a freshly-started radio rotation
shows "Live/Unknown" until its turn comes up.

**Why YouTube extraction needs help at all:** YouTube requires solving a JS challenge and
increasingly gates access behind a "Proof-of-Origin" token, especially from datacenter
IPs (which includes any cloud host, AWS included) — without it you get "Sign in to
confirm you're not a bot." The `pot-provider` sidecar runs the actual BotGuard
attestation itself and serves fresh tokens over a local API that `yt-dlp` calls
automatically. This is the standard, actively-maintained way bots solve this today —
**no browser cookie export, ever**, on this box or in production.

**Why yt-dlp also needs a proxy on cloud hosts:** a valid PO token isn't actually enough
once you're running on a well-known cloud IP range (AWS, GCP, Azure, ...) — YouTube blocks
those at the IP-reputation level, before PO tokens or player-client selection are even
evaluated. Confirmed directly against this project's own AWS deployment: even a bare,
unauthenticated metadata search failed with "Sign in to confirm you're not a bot" from an
AWS IP, regardless of player client (`tv`, `android_vr`, or the default all failed
identically) — this genuinely isn't a token or client problem on cloud hosts, it's the
network path. The `warp` sidecar routes `yt-dlp`'s traffic through Cloudflare's free
consumer WARP instead (`dublok/cloudflare-warp`) — device registration is fully automatic,
no login or manual step, same as `pot-provider`. `YTDLP_PROXY_URL` controls it (blank on a
residential dev machine, where this normally isn't needed at all; `socks5://warp:1080` in
docker-compose).

**Why the voice connection needs `@discordjs/voice` 0.19+:** Discord enforces its DAVE
end-to-end-encryption protocol on all voice calls now; an older client's connection gets
silently closed the moment it tries to actually stream, well after login/gateway/REST
calls all succeed normally. See [Troubleshooting](#troubleshooting--operational-notes)
for the full failure signature.

**Why `/ask` and `/radio` are architected differently:** `/ask` needs genuine reasoning
(picking specific real songs, deciding what "high energy" means, chaining several tool
calls) — that's the LLM's job, worth the latency. `/radio` needs to start playing music
in about two seconds — a bulk YouTube search per rotation artist does that, and going
through an LLM agent for it was tried first and was simply too slow (many sequential
search/tool round trips to hand-curate 25+ songs). The one place they meet is the radio
*artist list* itself: it's just per-guild state (`src/music/radioStore.js`), small enough
that the agent can safely mutate it through three narrow tools without needing to reason
about playback at all. Both interfaces still call the exact same `GuildQueue` the slash
commands use, so there's one single source of truth for what's actually playing no matter
which interface touched it.

## Getting started

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications),
   click **Create App**, and name it.
2. On **General Information**, copy the **Application ID** — this is `DISCORD_CLIENT_ID`.
3. Click **Bot** in the sidebar, click **Reset Token**, and copy the token immediately
   (it's shown once) — this is `DISCORD_TOKEN`. Leave **Privileged Gateway Intents** off;
   nothing here needs them (everything is slash commands and button interactions, no
   message content access).
4. Click **Installation** in the sidebar. Under **Guild Install**, set scopes to `bot`
   and `applications.commands`. In the **Permissions** picker, check exactly:
   `View Channels`, `Send Messages`, `Embed Links`, `Use Slash Commands`, `Connect`,
   `Speak` — nothing more (no Manage anything, no moderation permissions).
   `Embed Links` matters: every reply is a rich embed, and without it Discord silently
   drops them.
5. Copy the **Install Link**, open it in a browser, pick your server, and **Authorize**
   (you need Manage Server there to add bots).

### 2. Configure

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. For development, also set
`DISCORD_GUILD_ID` to your server's ID so slash commands register instantly instead of
waiting up to an hour for global propagation — leave it blank once you're running on
multiple servers (see [Configuration reference](#configuration-reference)).

### 3. Run locally with Docker (recommended)

```bash
docker compose up --build
```

This runs the bot together with `pot-provider` and `strands-agent`, exercising the exact
same setup you'd run in production.

### 4. Run locally without Docker

Requires Node.js 22+, Python 3.12+, and ffmpeg on your PATH.

```bash
pip install "yt-dlp[default]" bgutil-ytdlp-pot-provider
npm install
```

Start the PO-token provider in one terminal:

```bash
docker run --rm -p 4416:4416 brainicism/bgutil-ytdlp-pot-provider:latest
```

Start the bot:

```bash
npm start
```

To also run `/ask` locally without Docker (`/radio` doesn't need it — see above), start
the agent sidecar in another terminal:

```bash
cd agent
pip install -r requirements.txt
ANTHROPIC_API_KEY=... BOT_INTERNAL_API_URL=http://127.0.0.1:8100 uvicorn app:app --port 8000
```

## Configuration reference

All variables live in `.env` (copy from `.env.example`). Grouped by what they affect:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` | Bot credentials from the Developer Portal. |
| `DISCORD_GUILD_ID` | Optional. Set for instant command registration to one server during development; leave blank to register globally (works on every server the bot is in, ~1hr propagation). |
| `YTDLP_PATH` | Path to the `yt-dlp` binary. Default `yt-dlp`. |
| `YTDLP_POT_PROVIDER_URL` | Where `pot-provider` is reachable. Compose overrides this automatically. |
| `YTDLP_PLAYER_CLIENTS` | Leave blank — let yt-dlp choose Innertube clients itself. See [Troubleshooting](#troubleshooting--operational-notes). |
| `YTDLP_PROXY_URL` | Routes yt-dlp through a proxy — needed on cloud hosts (see [Troubleshooting](#troubleshooting--operational-notes)). Compose overrides this to the `warp` sidecar automatically; leave blank on a residential dev machine. |
| `QUEUE_IDLE_TIMEOUT_MS` | How long an empty queue waits before the bot leaves voice. Default 5 minutes. |
| `ALONE_TIMEOUT_MS` | In 24/7 mode (`/247`), how long the bot tolerates an empty channel before giving up anyway. Default 1 hour. |
| `RADIO_STORE_PATH` | Where the `/radio` artist rotation is persisted. Default `data/radio-artists.json`; Docker Compose mounts `./data` as a volume so this survives rebuilds. |
| `STRANDS_AGENT_URL` | Base URL for the agent sidecar. **Leave blank to disable `/ask` and `/radio` entirely.** |
| `INTERNAL_API_PORT` | Port the bot's internal queue API listens on (never published to the host). |
| `STRANDS_MODEL_PROVIDER` | `anthropic` (default), `bedrock`, or `ollama` — see `agent/model.py`. |
| `STRANDS_MODEL_ID` | Model id. Defaults to Claude Haiku for `anthropic` (cheapest tier — plenty for this tool set); required explicitly for `bedrock`/`ollama`. |
| `ANTHROPIC_API_KEY` | Required if using the `anthropic` provider. |
| `ANTHROPIC_WORKSPACE_ID` | Only needed for an "identity-linked" API key scoped to multiple workspaces. |
| `RADIO_DEFAULT_QUERY` | What `/radio` plays with no topic given. Just a config value — change it any time. |
| `BOT_INTERNAL_API_URL` | (agent-side) Where the bot's internal API is reachable. Compose sets this automatically. |

## Security: the natural-language assistant's boundaries

The agent's tools (`agent/tools.py`) only reach the bot through a small internal HTTP API
(`src/internal/api.js`) that's never published outside the container network. Every route
is scoped per-guild, and the guild ID is fixed from the original Discord interaction —
never something the model can set itself, so even a successful prompt injection can't
redirect a tool call at another server.

The agent has exactly fourteen tools — search, batch search, queue
read/add/remove/move/clear/shuffle/skip/pause/resume/loop, and radio artist-list
add/remove/list — and nothing else. No shell, file, or generic HTTP/network tool is
installed (`agent/requirements.txt` deliberately omits `strands-agents-tools`, the package
that would add those), and the agent is never given `load_tools_from_directory=True`, so
nothing beyond that fixed list is ever reachable. It also has no way to join or leave a
voice channel, or to start/stop radio mode itself — those stay human-triggered
(`/play`, `/stop`, `/leave`, `/radio on`, `/radio off`). The radio artist-list tools are
pure per-guild data mutation (add/remove/list a string) with no playback or voice
side-effects of their own — the only place they can influence what's actually
*playing* is through the exact same reconciliation path `/radio add`/`remove` already use
server-side, not anything the tool call does directly.

**`add_tracks`'s `url` is validated, not just trusted.** The tool's docstring tells the
model to only use URLs from `search_youtube`, but a docstring is a suggestion, not a
boundary — nothing stops a hallucinated or prompt-injected URL from reaching it, and that
URL eventually gets handed to `yt-dlp` as a subprocess argument on the bot side, which is
a real SSRF-ish risk (`yt-dlp`'s generic extractor will fetch arbitrary URLs, including
internal-only services or a cloud metadata endpoint once deployed). This is enforced at
two independent layers:
1. A Strands `InterventionHandler` (`agent/interventions.py`), using the SDK's own
   `before_tool_call` policy hook to `Deny` the call before it executes and tell the
   model why — the framework-idiomatic "infrastructure decides, not the prompt" pattern.
2. A matching check in the bot's own internal API — the actual trust boundary, enforced
   regardless of what the agent process does, in case that process is ever compromised or
   buggy.

`add_tracks` is also capped server-side (25 tracks/call) regardless of what's requested.
Conversation memory is per-guild and lives only as long as the current queue session
does — it resets the moment the queue empties and the bot disconnects (`/stop`, idle
timeout, or a real external disconnect).

## Deploying to AWS

This is a persistent-connection workload (Discord gateway websocket + voice UDP), which
rules out Lambda/Fargate-style short-lived compute. It runs on a single self-healing EC2
instance (an Auto Scaling Group pinned at 1) with zero inbound networking — every
container only makes outbound connections, so there's nothing to expose. Fully
CloudFormation-managed, with GitHub Actions handling routine deploys via SSM (no SSH, no
stored AWS keys). All of it — templates, boot script, and the full runbook — lives in
[`infra/`](infra/README.md), kept separate from the app so local dev never has to think
about AWS at all.

## Troubleshooting & operational notes

- **`@discordjs/voice` must be on 0.19.x or newer.** Discord enforces its DAVE E2EE
  protocol on all non-stage voice calls now — a client that doesn't support it gets its
  voice connection closed immediately with close code 4017 ("E2EE/DAVE protocol
  required"), and everything *looks* like a normal join right up until that point
  (gateway login, REST calls, even the voice websocket's initial handshake all succeed).
  DAVE support landed in `@discordjs/voice` 0.19.0 via a bundled `@snazzah/davey`
  dependency; `package.json` pins `^0.19.0` for exactly this reason — don't downgrade it.
- **Keep yt-dlp current.** YouTube changes frequently; if extraction starts failing,
  first try `pip install -U "yt-dlp[default]" bgutil-ytdlp-pot-provider` (or rebuild the
  Docker image) before investigating anything else.
- **yt-dlp needs a JS runtime.** YouTube extraction requires solving a JS challenge;
  `yt-dlp` handles this via its `yt-dlp-ejs` component (bundled by the `[default]` extra)
  plus an external JS runtime — Deno by default, but we point it at Node
  (`--js-runtimes node` in `src/music/ytdlp.js`) since the bot already runs on Node 22+
  and there's no reason to add Deno as a second runtime just for this.
- **Don't pin `YTDLP_PLAYER_CLIENTS`.** An earlier version hardcoded `tv,web`, and it
  broke extraction — YouTube had made `tv` return UNPLAYABLE and `web` SABR-only (no
  direct URL) for some videos, while yt-dlp's own default client selection worked fine.
  Leave it blank and let yt-dlp choose.
- **Datacenter IPs (including AWS) get blocked outright, separately from the PO token
  problem.** `pot-provider` alone isn't enough on a cloud host — confirmed directly against
  this project's own AWS deployment, where even an unauthenticated metadata search failed
  with "Sign in to confirm you're not a bot" regardless of player client. That's an
  IP-reputation block, evaluated before tokens or clients matter at all, which is what the
  `warp` sidecar (`YTDLP_PROXY_URL`) fixes — see "Why yt-dlp also needs a proxy on cloud
  hosts" above. There should never be a need to manually export browser cookies for either
  problem. If extraction still fails after updating both packages and confirming `warp` is
  connected (`docker compose logs warp` should show `StatusChanged(Connected ...)`), see
  the yt-dlp [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) for the
  current state of the arms race.
- **Rootless Podman + a custom bridge network wouldn't reach `ready` on the voice
  connection at all** (separate from the DAVE issue above) when this was first tested on
  Bazzite. Running both containers with `--network host` fixed that. This turned out not
  to be the actual blocker for the DAVE issue (that was a code-level fix), but it's a
  real difference from Docker Engine's bridge networking worth knowing if voice
  connections hang in `connecting`/`signalling` on a rootless-Podman host —
  `docker-compose.yml` still uses a normal bridge network since standard Docker Engine
  (not rootless Podman) doesn't have the same quirk.
- **"Identity-linked" Anthropic API keys need a workspace ID.** If `/ask` or `/radio`
  fail with an error mentioning `anthropic-workspace-id`, either generate a key scoped to
  one specific workspace instead (simplest), or set `ANTHROPIC_WORKSPACE_ID` in `.env`.

## Project layout

- **`src/index.js`** — bootstrap: client login, command registration, interaction routing
- **`src/commands/`** — one file per slash command
- **`src/music/`**
  - `GuildQueue.js` — per-guild queue/player state machine, the single source of truth
  - `resolve.js` — yt-dlp wrapper: search (song-first via YouTube Music), URL/playlist resolution, stream resolution
  - `audioResource.js` — builds a Discord audio resource (WebM/Opus fast path + ffmpeg fallback)
  - `ytdlp.js` — low-level yt-dlp subprocess wrapper, PO-token wiring
  - `queueManager.js` — guildId → `GuildQueue` registry
  - `radioStore.js` — persisted per-guild `/radio` artist list (`data/radio-artists.json`)
  - `radioManager.js` — builds/reconciles the radio queue from that artist list
- **`src/discord/`**
  - `embeds.js`, `components.js`, `format.js` — rich embed/button UI builders
  - `buttonHandler.js` — routes "Now Playing" card button clicks back into `GuildQueue`
- **`src/internal/`**
  - `api.js` — internal HTTP API the agent's tools call (never exposed externally)
  - `agentClient.js` — bot-side client for the strands-agent sidecar
- **`agent/`** — Python/FastAPI Strands Agents sidecar (powers `/ask`, and the radio
  artist-list tools `/ask` can use): `app.py`, `model.py`, `tools.py`, `interventions.py`
- **`infra/`** — CloudFormation templates, boot script, and deployment runbook for the AWS
  EC2 deployment (see [Deploying to AWS](#deploying-to-aws)); `.github/workflows/` holds
  the two GitHub Actions that deploy to it (a platform requirement — Actions only run from
  that exact path, so those two files can't live under `infra/` too)
