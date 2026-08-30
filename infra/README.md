# Deploying DJ Tyga to AWS

A single self-healing EC2 instance (Auto Scaling Group pinned at `min=max=desired=1`)
running the exact same three-container Docker Compose stack as local dev. No inbound
network access at all — the bot only ever makes outbound connections (Discord, YouTube,
Anthropic), so there's nothing to expose. Everything here assumes you already have an AWS
account and the AWS CLI configured locally (`aws configure` or SSO) for the one-time,
by-hand bootstrap steps below; routine deploys after that run entirely from GitHub Actions.

See the CloudFormation migration plan/design notes for *why* each piece is shaped this way
(EC2 over ECS/Fargate, SSM over SSH, EFS over S3-sync for `/radio`'s saved artist list,
etc.) — this file is just the runbook.

## 1. Create the one secret

One Secrets Manager secret holds everything sensitive the instance needs — the app's real
secrets, plus a short-lived-scope GitHub token the boot script uses once to clone the repo
(never handed to any container). Create it as a single JSON object:

```bash
aws secretsmanager create-secret --name dj-tyga --secret-string '{
  "DISCORD_TOKEN": "...",
  "DISCORD_CLIENT_ID": "...",
  "DISCORD_GUILD_ID": "",
  "ANTHROPIC_API_KEY": "...",
  "ANTHROPIC_WORKSPACE_ID": "",
  "GITHUB_TOKEN": "..."
}'
```

`GITHUB_TOKEN` needs only `repo` (read) scope on this one repository — a fine-grained
GitHub PAT scoped to just this repo is the better fit than a classic token. Note the
returned secret ARN; `infra/main.yaml`'s `SecretArn` parameter needs it. This secret is
deliberately **not** a CloudFormation resource — creating it out-of-band means its
plaintext never lands in a template or CloudFormation's parameter history.

## 2. Bootstrap OIDC + deploy roles (`infra/oidc.yaml`) — once, by hand

This has to come first: the roles GitHub Actions will use to deploy don't exist yet, so
the very first deploy can't come from a workflow.

```bash
aws cloudformation deploy \
  --stack-name dj-tyga-oidc \
  --template-file infra/oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubOrgRepo=mishkamouse/dj-tyga-discord-music-bot
```

Grab the three role ARNs and the CloudFormation service role ARN from the stack outputs:

```bash
aws cloudformation describe-stacks --stack-name dj-tyga-oidc --query 'Stacks[0].Outputs'
```

## 3. Set GitHub repo variables

Settings → Secrets and variables → Actions → **Variables** (these aren't secrets — role
ARNs and a repo name aren't sensitive):

| Variable | Value |
|---|---|
| `AWS_REGION` | e.g. `us-east-1` |
| `AWS_APP_DEPLOY_ROLE_ARN` | `AppDeployRoleArn` output from step 2 |
| `AWS_INFRA_DEPLOY_ROLE_ARN` | `InfraDeployRoleArn` output from step 2 |
| `AWS_CFN_SERVICE_ROLE_ARN` | `CfnServiceRoleArn` output from step 2 |
| `DJ_TYGA_SECRET_ARN` | the secret ARN from step 1 |
| `DJ_TYGA_GITHUB_ORG_REPO` | `mishkamouse/dj-tyga-discord-music-bot` |

## 4. First stand-up (`infra/main.yaml`) — once, by hand

After this, routine infra changes go through `deploy-infra.yml` (Actions tab → "Deploy
infra" → Run workflow) instead of repeating this by hand.

```bash
aws cloudformation deploy \
  --stack-name dj-tyga \
  --template-file infra/main.yaml \
  --role-arn <CfnServiceRoleArn from step 2> \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    SecretArn=<secret ARN from step 1> \
    GitHubOrgRepo=mishkamouse/dj-tyga-discord-music-bot
```

Takes a few minutes — the ASG has to launch the instance, which then runs the full boot
script (installs Docker, clones the repo, mounts EFS, pulls the secret, builds and starts
all three containers).

## 5. Verify

No SSH — everything below goes through SSM.

```bash
# Find the running instance (tagged Name=dj-tyga by the ASG):
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=dj-tyga" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

# Open an interactive shell (needs Session Manager plugin: aws.amazon.com/cli/session-manager-plugin):
aws ssm start-session --target "$INSTANCE_ID"

# Once inside:
cd /opt/dj-tyga && docker compose ps
```

All three containers should show healthy, and the bot should come online in Discord.
Confirm voice playback works end-to-end from the instance itself — the one genuinely new
behavioral unknown moving off local dev (EC2's normal bridge networking should handle
Discord's voice UDP fine; if it doesn't, add `network_mode: host` per service to
`infra/docker-compose.prod.yml`).

## Routine updates

- **App code** (anything outside `infra/`): push to `main` → `deploy-app.yml` runs
  automatically, `git pull`s and rebuilds on the instance via SSM, no manual step.
- **Infra** (`infra/main.yaml`, `infra/userdata.sh` — remember to paste `userdata.sh`'s
  content into `main.yaml`'s LaunchTemplate after editing it, see the comment in both
  files): Actions tab → "Deploy infra" → Run workflow. Deliberately manual, not automatic.

## Ad-hoc debugging

```bash
aws ssm start-session --target "$INSTANCE_ID"           # interactive shell, no SSH/keys
docker compose logs -f bot                                # or check CloudWatch Logs: /dj-tyga/app
```

## Testing self-healing / the EFS persistence fix

```bash
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
```

The ASG launches a replacement automatically within a minute or two — confirm the bot
reconnects on its own, **and** `/radio list` still shows whatever artists were saved before
the termination (this is the actual proof EFS persistence is working, not just that the ASG
replaces instances).

## Teardown

```bash
aws cloudformation delete-stack --stack-name dj-tyga
aws cloudformation wait stack-delete-complete --stack-name dj-tyga
aws cloudformation delete-stack --stack-name dj-tyga-oidc
aws secretsmanager delete-secret --secret-id dj-tyga   # not a CFN resource, delete separately
```

## Cost (rough)

`t4g.small` (~$12/mo) + 20GB gp3 root volume (~$1.50/mo) + EFS at this usage, a few KB
(~$0.10-0.30/mo) + Secrets Manager (~$0.40/mo) + CloudWatch Logs (~$1-2/mo) ≈ **$15-20/month**.
No ALB, NAT Gateway, or Elastic IP — nothing here needs them since the instance never
accepts inbound traffic.
