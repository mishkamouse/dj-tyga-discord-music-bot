#!/bin/bash
# Refreshes the warp sidecar's Cloudflare identity. Run on a schedule (see the cron entry
# in userdata.sh) since YouTube degrades a WARP identity's reputation under sustained use.
set -euo pipefail
docker exec dj-tyga-warp-1 warp-cli registration delete
docker exec dj-tyga-warp-1 warp-cli registration new
