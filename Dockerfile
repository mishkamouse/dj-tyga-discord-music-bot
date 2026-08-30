FROM node:22-slim

# yt-dlp and its PO-token provider plugin are Python packages; ffmpeg backs the fallback
# transcode path in src/music/audioResource.js. yt-dlp now needs an external JS runtime to
# solve YouTube's player challenges — the [default] extra bundles the yt-dlp-ejs component,
# and we point it at the Node.js already in this image (>=22, required by that component)
# instead of installing Deno separately.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg gosu \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir "yt-dlp[default]" bgutil-ytdlp-pot-provider

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

# See docker-entrypoint.sh — starts as root only to fix /app/data's ownership, then drops
# to the non-root `node` user this base image already provides for the actual process.
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
