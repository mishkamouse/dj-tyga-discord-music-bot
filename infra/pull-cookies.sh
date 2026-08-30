#!/bin/bash
# Optional: refreshes data/cookies.txt from the YTDLP_COOKIES field of the app secret,
# for playing age-restricted videos (see the README). No-op if that field isn't set.
set -euo pipefail
SECRET_ARN="$1"
REGION="$2"
COOKIES=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ARN" --query SecretString --output text | jq -r '.YTDLP_COOKIES // empty')
[ -z "$COOKIES" ] && exit 0
echo "$COOKIES" > /opt/dj-tyga/data/cookies.txt
