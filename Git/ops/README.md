# Tonel — Operational Artifacts

Declarative configuration for the production server. These files describe **what
the server should look like**, in contrast to `Git/deploy/` which describes
**how to get it there**.

## Layout

| Path | Applied to | Owner |
|---|---|---|
| `pm2/ecosystem.config.cjs` | `/opt/tonel/ops/ecosystem.config.cjs` (PM2 reads from here) | `deploy/server.sh --component=ops` |
| `nginx/srv.tonel.io.conf` | `/etc/nginx/sites-available/srv.tonel.io` (+ symlink in sites-enabled) | `deploy/server.sh --component=ops` |
| `nginx/srv-new.tonel.io.conf` | `/etc/nginx/sites-available/srv-new.tonel.io` (+ symlink in sites-enabled) | `deploy/server.sh --component=ops` |
| `nginx/tonel.io.conf` | `/etc/nginx/sites-available/tonel.io` (+ symlink in sites-enabled) | `deploy/server.sh --component=ops` |
| `cloudflared/config.yml.template` | `/root/.cloudflared/config.yml` (after `${TUNNEL_ID}` substitution) | `deploy/server.sh --component=ops` |
| `scripts/start-mixer.sh` | `/opt/tonel/scripts/start-mixer.sh` (called by PM2) | `deploy/server.sh --component=binary` |
| `scripts/start-signaling.sh` | `/opt/tonel/scripts/start-signaling.sh` (manual debug only) | `deploy/server.sh --component=binary` |

## v5.0.0+ dual-hostname architecture

Each production server's nginx serves **both** `srv.tonel.io` and
`srv-new.tonel.io` on `:443`, distinguished by SNI. Each server's
cloudflared has **both** `api.tonel.io` and `api-new.tonel.io` ingress
rules forwarding to the local `:9004`. Same `Git/ops/` deploys to
either box; **DNS picks who handles which hostname**:

```
                                primary    fallback
srv.tonel.io       (DNS-A) →    酷番云     ─        ⇒ ws-mixer-proxy/mixer on whichever box DNS resolves
srv-new.tonel.io   (DNS-A) →    ─          Aliyun
api.tonel.io       (CNAME) →    tonel-koufan tunnel ⇒ ws-proxy on 酷番云
api-new.tonel.io   (CNAME) →    tonel-tunnel tunnel ⇒ ws-proxy on Aliyun
```

This symmetry lets us flip primary↔fallback by swapping CF DNS
records (4 edits, < 5 min cutover, what we did at v5.0.0). It also
means **`Git/ops/` is the source of truth for both servers** — Aliyun
is no longer "managed manually". To re-align Aliyun to current
`Git/ops/`, override env inline:

```bash
TONEL_SSH_HOST=root@8.163.21.207 TONEL_SSH_PORT=22 \
TONEL_CF_TUNNEL_ID=339745d7-cb58-4e1d-acf4-e6b7198a2b8c \
  Git/deploy/server.sh --component=ops
```

## Production layout (`/opt/tonel/`)

```
/opt/tonel/
├── bin/                       compiled C++ servers
│   ├── signaling_server
│   └── mixer_server
├── proxy/                     Node.js WebSocket bridges
│   ├── ws-proxy.js
│   ├── ws-mixer-proxy.js
│   ├── package.json
│   └── node_modules/
├── scripts/                   PM2 launchers
│   ├── start-mixer.sh
│   └── start-signaling.sh
├── ops/
│   └── ecosystem.config.cjs   PM2 process definitions
├── VERSION                    plain text: e.g. "1.0.3"
└── DEPLOY_LOG                 append-only: timestamp + git SHA + version
```

Runtime data lives outside `/opt/tonel/`:

```
/var/lib/tonel/recordings/     mixer recordings
/var/log/tonel/                pm2 stdout/stderr (per-process)
```

## Drift policy

Before every deploy, `deploy/server.sh --component=ops` runs `diff` between the
live files on the server and the versions in `Git/ops/`. Any unexpected drift
aborts the deploy and asks the operator to either commit the change to git or
revert it on the server. Mismatch between this directory and production is
treated as a bug.
