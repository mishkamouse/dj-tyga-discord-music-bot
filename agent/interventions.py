import re

from strands.interventions.actions import Deny, Proceed
from strands.interventions.handler import InterventionHandler

YOUTUBE_URL_RE = re.compile(
    r"^https://(www\.)?youtube\.com/watch\?v=[\w-]{11}(&.*)?$"
    r"|^https://youtu\.be/[\w-]{11}(\?.*)?$"
)


class QueueGuardHandler(InterventionHandler):
    """Hard, framework-level enforcement that add_tracks can only ever act on real
    YouTube URLs — never one the model invented or a user tried to smuggle in through
    free-form query text. Without this, nothing stops the model from passing an
    arbitrary url straight through to yt-dlp on the bot side, which is a real SSRF-ish
    risk (yt-dlp's generic extractor will fetch arbitrary URLs, including internal-only
    services). This is defense-in-depth: the bot's internal API enforces the same rule
    server-side regardless of what this catches, since that's the actual trust boundary.
    """

    name = "queue-guard"

    def before_tool_call(self, event, **kwargs):
        if event.tool_use["name"] != "add_tracks":
            return Proceed()

        tracks = event.tool_use["input"].get("tracks") or []
        for track in tracks:
            url = track.get("url", "")
            if not YOUTUBE_URL_RE.match(url):
                return Deny(
                    reason=(
                        f"Rejected: {url!r} is not a youtube.com/youtu.be video url. "
                        "Only use urls returned by search_youtube — call it first."
                    )
                )
        return Proceed()
