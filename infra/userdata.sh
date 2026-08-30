#!/bin/bash
# EC2 boot script for the dj-tyga instance (Amazon Linux 2023, arm64/t4g).
#
# This file is NOT executed directly. CloudFormation has no "include external file"
# mechanism, so infra/main.yaml's LaunchTemplate embeds this exact content inline via
# Fn::Sub, which treats dollar-brace text as ITS OWN substitution syntax rather than a
# shell variable. This copy exists so the script can be read and shellchecked on its own.
# If you edit boot behavior, edit here first, then paste the result into main.yaml's
# LaunchTemplate UserData block. The two must stay identical.
#
# IMPORTANT: because of that Fn::Sub wrapping, dollar-brace syntax anywhere below,
# including inside comments (Fn::Sub doesn't know what a comment is), is read as a
# CloudFormation reference, not a shell variable. Only the five CFN placeholders defined
# on the next few lines (region, secret ARN, repo, filesystem id, log group) may use that
# form; every other variable reference in this script (bash or prose) avoids it.
set -euxo pipefail

REGION="${AWS::Region}"
SECRET_ARN="${SecretArn}"
GITHUB_REPO="${GitHubOrgRepo}"
EFS_ID="${FileSystem}"
REPO_DIR=/opt/dj-tyga

dnf update -y
dnf install -y docker git jq amazon-efs-utils
systemctl enable --now docker

# Downloaded and made executable as root-owned CLI plugins, verified against each
# release's published checksums first so a compromised or tampered GitHub release (or any
# MITM between here and github.com) can't silently become code this box trusts.
mkdir -p /usr/libexec/docker/cli-plugins
COMPOSE_ARCH=$(uname -m)
cd /tmp
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$COMPOSE_ARCH" \
  -o "docker-compose-linux-$COMPOSE_ARCH"
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$COMPOSE_ARCH.sha256" \
  | sha256sum -c -
mv "docker-compose-linux-$COMPOSE_ARCH" /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

# Not a dnf package on AL2023. `docker compose build` needs BuildKit via this plugin
# (0.17.0+), and the base `docker` package doesn't include it. Hardcoded "arm64" (not
# `uname -m`'s "aarch64", unlike docker-compose above): buildx's release assets use Go's
# arch naming, docker-compose's use the kernel's. This template is arm64-only (t4g) anyway.
BUILDX_VERSION=$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | grep -m1 '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
curl -fsSL "https://github.com/docker/buildx/releases/download/v$BUILDX_VERSION/buildx-v$BUILDX_VERSION.linux-arm64" \
  -o "buildx-v$BUILDX_VERSION.linux-arm64"
curl -fsSL "https://github.com/docker/buildx/releases/download/v$BUILDX_VERSION/checksums.txt" \
  | grep -E "\*buildx-v$BUILDX_VERSION\.linux-arm64$" | sha256sum -c -
mv "buildx-v$BUILDX_VERSION.linux-arm64" /usr/libexec/docker/cli-plugins/docker-buildx
chmod +x /usr/libexec/docker/cli-plugins/docker-buildx
cd /

# `set -x` (on since the top of this script) traces every command after shell expansion.
# For an assignment like `SECRET_JSON=$(...)`, that means the actual value gets printed,
# not just the command. Left on, every credential in the secret would land in plaintext in
# /var/log/cloud-init-output.log and EC2 console output, the latter readable by any IAM
# principal with ec2:GetConsoleOutput, far beyond the deploy roles meant to see it. Off for
# this span; back on once nothing below touches secret material.
set +x

# One secret holds everything sensitive this app needs (see infra/README.md for its exact
# shape): GITHUB_TOKEN (this boot script's own clone credential, not passed to any
# container) plus the app's real secrets (DISCORD_TOKEN, ANTHROPIC_API_KEY, ...).
SECRET_JSON=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ARN" --query SecretString --output text)
GITHUB_TOKEN=$(echo "$SECRET_JSON" | jq -r .GITHUB_TOKEN)

if [ ! -d "$REPO_DIR/.git" ]; then
  # Plain $VAR, not dollar-brace; see the file header for why.
  git clone "https://x-access-token:$GITHUB_TOKEN@github.com/$GITHUB_REPO.git" "$REPO_DIR"
fi
cd "$REPO_DIR"

# /radio's saved artist list (data/radio-artists.json) needs to survive an ASG-driven
# instance replacement, which a fresh local EBS root volume never would. EFS is mounted
# directly at the same host path docker-compose.yml already expects (./data:/app/data),
# so no application or compose changes were needed.
mkdir -p "$REPO_DIR/data"
grep -q "$REPO_DIR/data" /etc/fstab || echo "$EFS_ID:/ $REPO_DIR/data efs _netdev,tls,iam 0 0" >> /etc/fstab
mount "$REPO_DIR/data"

# Everything the secret carries becomes an env var, except GITHUB_TOKEN (this script's
# own clone credential, the containers never see it), plus the handful of non-secret
# defaults this app expects. See .env.example in the repo root for what each one does.
echo "$SECRET_JSON" | jq -r 'to_entries | map(select(.key != "GITHUB_TOKEN")) | .[] | "\(.key)=\(.value)"' > .env
cat >> .env << ENVEOF
YTDLP_PATH=yt-dlp
QUEUE_IDLE_TIMEOUT_MS=300000
ALONE_TIMEOUT_MS=3600000
STRANDS_MODEL_PROVIDER=anthropic
STRANDS_MODEL_ID=claude-haiku-4-5-20251001
RADIO_DEFAULT_QUERY=Kanye West
AWS_REGION=$REGION
LOG_GROUP=${LogGroup}
ENVEOF
# Every credential this app has now sits in this file in plaintext, readable by anyone
# else with access to this box (a local process, or an SSM session under a different IAM
# principal than intended) unless restricted. env_file: .env only requires the docker
# daemon (root) to read it, so this doesn't affect anything that needs to work.
chmod 600 .env

set -x

docker compose -f docker-compose.yml -f infra/docker-compose.prod.yml up -d
