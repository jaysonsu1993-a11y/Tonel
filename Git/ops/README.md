# Tonel — Operational Artifacts

Declarative configuration for the production server. These files describe **what
the server should look like**, in contrast to `Git/deploy/` which describes
**how to get it there**.

## Layout

| Path | Applied to | Owner |
|---|---|---|
| `pm2/ecosystem.config.cjs` | `/opt/tonel/ops/ecosystem.config.cjs` (PM2 reads from here) | `deploy/server-ops.sh` |
| `nginx/srv.tonel.io.conf` | `/etc/nginx/sites-available/srv.tonel.io` (+ symlink in sites-enabled) | `deploy/server-ops.sh` |
| `nginx/tonel.io.conf` | `/etc/nginx/sites-available/tonel.io` (+ symlink in sites-enabled) | `deploy/server-ops.sh` |
| `cloudflared/config.yml.template` | `/root/.cloudflared/config.yml` (after `${TUNNEL_ID}` substitution) | `deploy/server-ops.sh` |
| `scripts/start-mixer.sh` | `/opt/tonel/scripts/start-mixer.sh` (called by PM2) | `deploy/server-binary.sh` |
| `scripts/start-signaling.sh` | `/opt/tonel/scripts/start-signaling.sh` (manual debug only) | `deploy/server-binary.sh` |

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

Before every deploy, `deploy/server-ops.sh` runs `diff` between the live files on
the server and the versions in `Git/ops/`. Any unexpected drift aborts the deploy
and asks the operator to either commit the change to git or revert it on the
server. Mismatch between this directory and production is treated as a bug.
