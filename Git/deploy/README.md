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

## Quirks (known cosmetic, do not panic)

These are things the deploy scripts will produce that **look like errors but are not**.
Each one was confusing in its first encounter and is worth recognizing instantly.

- **`wrangler pages deploy` sometimes hangs after success.** The deploy
  itself is complete the moment you see `✨ Deployment complete! Take a
  peek over at https://...pages.dev` and the script's own
  `[deploy] web deploy complete (vX.Y.Z, <sha>)` line. wrangler's own
  process can then sit for several minutes in some teardown step before
  exiting. If you've already seen the success lines, killing the wrangler
  process (or the `web.sh` invocation) does **not** roll back the deploy
  — the artifact is already live on Cloudflare Pages. Verify by hitting
  the printed `pages.dev` URL.

- **`api.tonel.io/signaling` returns HTTP 426 to `curl`, even when healthy.**
  This is the ws-proxy's default response to non-WebSocket GETs. `curl`'s
  RFC 6455 upgrade headers don't reliably traverse Cloudflare's HTTP/2-
  speaking edge to trigger the upgrade path on the origin. The endpoint
  is healthy iff the browser-side `wss://` works, which is what
  `health.sh` actually checks via its `reachable` mode (any non-zero
  HTTP code from the server's vantage point). Don't try to "fix" the 426.

- **`srv.tonel.io` looks unreachable from a domestic ISP path but works
  for browsers.** Direct-to-origin TLS to non-CF-proxied IPs is
  occasionally subject to SNI-based filtering on certain ISP routes,
  producing `Connection reset by peer` during the TLS Client Hello. The
  loopback `https://127.0.0.1/` from inside the server returns 200; an
  `openssl s_client -connect srv.tonel.io:443 -servername srv.tonel.io`
  from many other vantage points succeeds; users on Wi-Fi / cellular /
  abroad are unaffected. This is *not* a deploy regression — it is the
  reason `health.sh` probes from the production server, not from the
  operator's laptop (R1 in [DEPLOY_SCRIPTING_STANDARDS.md](../docs/DEPLOY_SCRIPTING_STANDARDS.md)).

## Emergency recovery

If a `bootstrap.sh` or `server.sh --component=binary` run leaves PM2 in a
broken state and `rollback.sh` is not enough, you can fall back to the
preserved legacy install at `/opt/tonel-server/`. The directory is kept
intact specifically for this scenario for at least one week after a
successful migration.

```bash
ssh root@8.163.21.207 'set -e
pm2 delete all 2>/dev/null || true
cd /opt/tonel-server
pm2 start /opt/tonel-server/signaling_server     --name tonel-signaling      --interpreter none
pm2 start /opt/tonel-server/start-mixer.sh       --name tonel-mixer          --interpreter bash --cwd /root
pm2 start /opt/tonel-server/ws-proxy.js          --name tonel-ws-proxy       --cwd /opt/tonel-server
pm2 start /opt/tonel-server/ws-mixer-proxy.js    --name tonel-ws-mixer-proxy --cwd /root -- \
    9005 127.0.0.1 9002 127.0.0.1 9003 9006
pm2 save
'
```

After this, all four PM2 processes are running from the legacy paths
exactly as they did before v1.0.3. Verify with `health.sh` (which probes
listening ports and PM2 status, not paths). Once the situation is
investigated, you can re-attempt the new-layout migration via
`bootstrap.sh` (idempotent — it skips the snapshot step if already done).

The pristine snapshot taken at v1.0.3 bootstrap is at
`/opt/_archive/tonel-server-pre-bootstrap/`. If `/opt/tonel-server/` itself
becomes corrupted, restore from there with `cp -a`.

## Before writing or modifying a deploy script

Read these two — they are the distilled rules and the case files behind them:

- [DEPLOY_SCRIPTING_STANDARDS.md](../docs/DEPLOY_SCRIPTING_STANDARDS.md) —
  10 normative rules covering shell quoting across SSH, dry-run propagation,
  `npm ci` discipline, health-check vantage point, idempotency, drift
  detection, audit logging, and remote-expansion smoke testing.
- [LESSONS.md](LESSONS.md) — case files for the v1.0.3 / v1.0.4 release
  cycle (six real incidents, one production outage). Each case maps to a
  rule.
