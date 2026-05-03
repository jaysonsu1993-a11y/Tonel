# Tonel — Deploy Scripts

Imperative scripts that move artifacts from this repo onto the production
server. Counterpart to `ops/`, which holds **declarative** configuration.

## First-time setup

```bash
# 1. Copy env file and fill in real values (SSH host, port, CF token, tunnel ID).
cp deploy/.env.deploy.example deploy/.env.deploy
$EDITOR deploy/.env.deploy

# 2. Make sure SSH passwordless login works.
#    v5.0.0+: production is 酷番云广州, SSH port 26806 (non-standard).
ssh -p "$TONEL_SSH_PORT" "$TONEL_SSH_HOST" 'whoami'

# 3. Run bootstrap once to migrate /opt/tonel-server/ → /opt/tonel/.
#    (No-op on a server already at the new layout — bootstrap is idempotent.)
deploy/bootstrap.sh
```

## Daily commands

| Command | What it does |
|---|---|
| `scripts/release.sh <version>` | Full release: bump → CHANGELOG → commit → tag → push → deploy → verify |
| `deploy/server.sh` | Deploy server (binary + proxy + ops) without bumping version |
| `deploy/server.sh --component=binary` | Just rebuild + swap C++ servers |
| `deploy/server.sh --component=proxy` | Just rsync ws-proxy + ws-mixer-proxy |
| `deploy/server.sh --component=ops` | Just sync PM2 / nginx / cloudflared configs |
| `deploy/web.sh` | Build + deploy web frontend to Cloudflare Pages |
| `deploy/health.sh` | Verify ports + PM2 + WSS handshake (used internally too) |
| `deploy/rollback.sh --component=binary` | Restore most recent binary `.bak.*` |
| `deploy/rollback.sh --component=proxy` | Restore proxy/ from `$TONEL_ARCHIVE_DIR/proxy-*` |

All scripts accept `--dry-run`. All scripts require a clean working tree
(no uncommitted changes) — exception: `health.sh` and `rollback.sh`.

## Two-server architecture

`tonel.io/` traffic hits **酷番云广州 (42.240.163.172)** — that is the
default deploy target of these scripts. A second box at Aliyun
(8.163.21.207) runs the same code from this repo and serves the
`tonel.io/new` fallback path; it stays alive but is **not** part of
the standard deploy flow.

```
            ┌── srv.tonel.io       (DNS-A → 42.240.163.172, 酷番云) ─── nginx → ws-mixer-proxy
tonel.io/ ──┤
            └── api.tonel.io       (CNAME → tonel-koufan tunnel) ────── cloudflared → ws-proxy

                ┌── srv-new.tonel.io   (DNS-A → 8.163.21.207, Aliyun) ── nginx → ws-mixer-proxy
tonel.io/new ───┤
                └── api-new.tonel.io   (CNAME → tonel-tunnel tunnel) ─── cloudflared → ws-proxy

Tonel-MacOS desktop client ───► 8.163.21.207:9002/9003 (raw TCP+UDP, Aliyun)
                                 (kufan UDP path has known burst issues; native
                                  client stays on Aliyun, see project_kufan_udp_burst)
```

To touch the Aliyun box from these scripts, override env inline:

```bash
TONEL_SSH_HOST=root@8.163.21.207 TONEL_SSH_PORT=22 \
TONEL_CF_TUNNEL_ID=339745d7-cb58-4e1d-acf4-e6b7198a2b8c \
  deploy/health.sh
```

## Cert renewal

LE certs auto-renew via the `certbot.timer` systemd unit on each box.

| Cert | Server | Authenticator | Notes |
|---|---|---|---|
| `srv.tonel.io` | 酷番云 (primary) | `nginx` (HTTP-01) | Standard, no manual setup. |
| `srv-new.tonel.io` | Aliyun (fallback) | `dns-cloudflare` (DNS-01) | **MUST stay DNS-01.** Aliyun's cloud WAF (`Server: Beaver`) blocks HTTP-01 challenges for new hostnames. Token credentials at `/root/.secrets/cf-dns-token.ini` (perms 600). |
| `tonel.io` | 酷番云 (primary) | `nginx` | Used by the legacy origin-direct fallback paths. |
| `api*.tonel.io` | n/a | (Cloudflare-managed edge cert) | No origin cert needed; CF terminates TLS. |

To dry-run a renewal manually:

```bash
ssh -p 26806 root@42.240.163.172 'certbot renew --dry-run'
ssh root@8.163.21.207        'certbot renew --cert-name srv-new.tonel.io --dry-run'
```

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
  operator's laptop (R1 in [STANDARDS.md](STANDARDS.md)).
  The same quirk applies to `srv-new.tonel.io` post-v5.0 (Aliyun box).

- **Aliyun cloud WAF rejects HTTP-01 ACME for new hostnames** with
  `Server: Beaver` 403 responses, *before* the request reaches nginx.
  This is why `srv-new.tonel.io`'s renewal config on the Aliyun box
  uses `dns-cloudflare` instead of the default `nginx` authenticator.
  Don't try to switch it back. (See "Cert renewal" section above.)

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

- [STANDARDS.md](STANDARDS.md) — 10 normative rules covering shell quoting
  across SSH, dry-run propagation,
  `npm ci` discipline, health-check vantage point, idempotency, drift
  detection, audit logging, and remote-expansion smoke testing.
- [LESSONS.md](LESSONS.md) — case files for the v1.0.3 / v1.0.4 release
  cycle (six real incidents, one production outage). Each case maps to a
  rule.
