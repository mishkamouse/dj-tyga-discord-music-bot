import httpx
from strands import tool


# Every tool here is a thin call to the bot's own internal API, scoped to exactly one
# guild's queue — never shell, file, or generic network access. guild_id is fixed by this
# factory (called once per session, from the original Discord interaction on the Node
# side) and is never an argument the model can set itself, so even a successful prompt
# injection can't redirect a tool call at another server's queue.
def make_tools(guild_id: str, bot_api_url: str):
    client = httpx.Client(base_url=f"{bot_api_url}/guilds/{guild_id}", timeout=30.0)

    @tool
    def search_youtube(query: str, max_results: int = 5) -> list[dict]:
        """Search YouTube for candidate tracks. Read-only — does not change the queue.
        For more than a handful of separate songs (e.g. building a radio-style pool),
        use search_youtube_batch instead — it's much faster.

        Args:
            query: What to search for, e.g. "Kanye West Ultralight Beam".
            max_results: How many candidates to return (max 10).

        Returns:
            A list of candidates, each with title, url, duration (seconds), and channel.
        """
        resp = client.post("/search", json={"query": query, "maxResults": max_results})
        resp.raise_for_status()
        return resp.json()["results"]

    @tool
    def search_youtube_batch(queries: list[str]) -> list[dict]:
        """Search YouTube for many songs at once — one round trip instead of one per
        song. Use this whenever you need more than ~5 distinct tracks (e.g. building a
        large radio-style pool), passing one specific song title per query (max 30).
        Read-only — does not change the queue.

        Args:
            queries: Specific song searches, e.g. ["Kanye West Stronger",
                "Kanye West Gold Digger", "Kanye West Flashing Lights"]. One real song
                per entry, not a broad topic — pick the actual songs yourself first.

        Returns:
            A list with one entry per query: {"query": ..., "matches": [...]}. A query
            with no good match returns an empty matches list — just skip it.
        """
        resp = client.post("/search/batch", json={"queries": queries}, timeout=60.0)
        resp.raise_for_status()
        return resp.json()["results"]

    @tool
    def get_queue() -> dict:
        """Get the full current state of this server's queue — the currently playing
        track, the upcoming queue in order, whether playback is paused, and the loop
        mode. Call this whenever you need to know what's actually happening before
        deciding what to do (e.g. don't blindly resume — check "paused" first).

        Returns:
            An object with "current" (track or null), "tracks" (upcoming, in order),
            "paused" (bool), and "loopMode" ("off", "track", or "queue").
        """
        resp = client.get("/queue")
        resp.raise_for_status()
        return resp.json()

    @tool
    def add_tracks(tracks: list[dict], position: str = "end") -> str:
        """Add one or more tracks to the queue. Use results from search_youtube — never
        invent a url. To replace the whole queue, call clear_queue first, then this.

        Args:
            tracks: Tracks to enqueue, each with "url", "title", and optionally "duration".
            position: "end" (default) to add after everything currently queued, or "next"
                to insert them right after the currently playing track, ahead of
                everything else already queued.

        Returns:
            A short confirmation of how many tracks were added.
        """
        resp = client.post(
            "/queue/add",
            json={"tracks": tracks, "requestedBy": "assistant", "position": position},
        )
        resp.raise_for_status()
        return f"Added {resp.json()['added']} track(s)."

    @tool
    def remove_tracks(indices: list[int]) -> str:
        """Remove specific tracks from the upcoming queue by position.

        Args:
            indices: Zero-based positions in the upcoming queue to remove (see get_queue).

        Returns:
            A short confirmation of what was removed.
        """
        resp = client.post("/queue/remove", json={"indices": indices})
        resp.raise_for_status()
        return f"Removed {len(resp.json()['removed'])} track(s)."

    @tool
    def move_track(from_index: int, to_index: int) -> str:
        """Reorder the upcoming queue by moving one track to a new position — e.g. to
        play something sooner or later without removing and re-adding it.

        Args:
            from_index: Zero-based current position of the track to move (see get_queue).
            to_index: Zero-based position to move it to (0 = play next).

        Returns:
            A short confirmation, or a note if from_index was out of range.
        """
        resp = client.post("/queue/move", json={"from": from_index, "to": to_index})
        if resp.status_code == 400:
            return "That position doesn't exist in the queue."
        resp.raise_for_status()
        return "Moved."

    @tool
    def clear_queue() -> str:
        """Remove everything from the upcoming queue. Does not stop the currently
        playing track or disconnect from voice.

        Returns:
            A short confirmation of how many tracks were cleared.
        """
        resp = client.post("/queue/clear")
        resp.raise_for_status()
        return f"Cleared {resp.json()['cleared']} track(s) from the queue."

    @tool
    def shuffle_queue() -> str:
        """Shuffle the order of the upcoming queue.

        Returns:
            A short confirmation.
        """
        client.post("/queue/shuffle").raise_for_status()
        return "Shuffled the queue."

    @tool
    def skip_current(count: int = 1) -> str:
        """Skip the currently playing track and move to the next one. Pass count > 1 to
        skip several at once (the current track plus the next count-1 queued ones are
        all skipped over) — e.g. count=3 to jump past the next two upcoming tracks too.

        Args:
            count: How many tracks to skip past, including the current one. Default 1.

        Returns:
            A short confirmation, or a note if nothing was playing.
        """
        resp = client.post("/queue/skip", json={"count": count})
        if resp.status_code == 409:
            return "Nothing is currently playing."
        resp.raise_for_status()
        return "Skipped." if count <= 1 else f"Skipped {count} tracks."

    @tool
    def pause_playback() -> str:
        """Pause the currently playing track.

        Returns:
            A short confirmation, or a note if nothing was playing.
        """
        resp = client.post("/queue/pause")
        if resp.status_code == 409:
            return "Nothing is currently playing."
        resp.raise_for_status()
        return "Paused."

    @tool
    def resume_playback() -> str:
        """Resume a paused track.

        Returns:
            A short confirmation, or a note if nothing was playing.
        """
        resp = client.post("/queue/resume")
        if resp.status_code == 409:
            return "Nothing is currently playing."
        resp.raise_for_status()
        return "Resumed."

    @tool
    def set_loop_mode(mode: str) -> str:
        """Set the loop mode for the queue.

        Args:
            mode: One of "off", "track" (repeat the current track), or "queue" (repeat
                the whole queue once it finishes).

        Returns:
            A short confirmation.
        """
        resp = client.post("/queue/loop", json={"mode": mode})
        resp.raise_for_status()
        return f"Loop mode set to {mode}."

    tools = [
        search_youtube,
        search_youtube_batch,
        get_queue,
        add_tracks,
        remove_tracks,
        move_track,
        clear_queue,
        shuffle_queue,
        skip_current,
        pause_playback,
        resume_playback,
        set_loop_mode,
    ]
    return tools, client
