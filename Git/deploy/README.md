# Tonel — Deploy Scripts

Imperative scripts that move artifacts from this repo onto the production
server. Counterpart to `Git/ops/`, which holds **declarative** configuration.

## First-time setup

```bash
# 1. Copy env file and fill in real values (SSH host, CF token, tunnel ID).
cp Git/deploy/.env.deploy.example Git/deploy/.env.deploy
$EDITOR Git/deploy/.env.deploy

# 2. Make sure SSH passwordless login works.
ssh "$TONEL_SSH_HOST" 'whoami'

# 3. Run bootstrap once to migrate /opt/tonel-server/ → /opt/tonel/.
Git/deploy/bootstrap.sh
```

## Daily commands

| Command | What it does |
|---|---|
| `Git/scripts/release.sh <version>` | Full release: bump → CHANGELOG → commit → tag → push → deploy → verify |
| `Git/deploy/server.sh` | Deploy server (binary + proxy + ops) without bumping version |
| `Git/deploy/server.sh --component=binary` | Just rebuild + swap C++ servers |
| `Git/deploy/server.sh --component=proxy` | Just rsync ws-proxy + ws-mixer-proxy |
| `Git/deploy/server.sh --component=ops` | Just sync PM2 / nginx / cloudflared configs |
| `Git/deploy/web.sh` | Build + deploy web frontend to Cloudflare Pages |
| `Git/deploy/health.sh` | Verify ports + PM2 + WSS handshake (used internally too) |
| `Git/deploy/rollback.sh --component=binary` | Restore most recent binary `.bak.*` |
| `Git/deploy/rollback.sh --component=proxy` | Restore proxy/ from `$TONEL_ARCHIVE_DIR/proxy-*` |

All scripts accept `--dry-run`. All scripts require a clean working tree
(no uncommitted changes) — exception: `health.sh` and `rollback.sh`.

## Conventions

- **No secrets in git.** SSH host, CF token, tunnel ID live in `.env.deploy`,
  which is gitignored.
- **Drift is a bug.** Before pushing, scripts md5-compare the live file against
  the repo. Mismatch aborts unless `ALLOW_DRIFT=1`.
- **Deploys are logged.** Each component append-writes
  `<timestamp>  <component>  v<version>  <commit>` to
  `$TONEL_DEPLOY_DIR/DEPLOY_LOG`. To answer "what's running right now?", `cat`
  that file or read `$TONEL_DEPLOY_DIR/VERSION`.
- **Backups before swap.** `server.sh --component=binary` writes `*.bak.<stamp>`
  before overwriting binaries. `rollback.sh --component=binary` reads them.
