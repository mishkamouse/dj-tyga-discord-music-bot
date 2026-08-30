#!/bin/sh
# /app/data is a bind mount (Docker/Podman locally, EFS on AWS) and starts out root-owned.
# Fix that, then drop to the non-root `node` user for the actual process.
set -e
mkdir -p /app/data
chown node:node /app/data
exec gosu node "$@"
