# Tonel — Deployment

The truthful description of what's running where, and how to change it. This
document is normative — if production diverges from this, that's a bug to fix,
not a fact to document.

## Topology

```
                         ┌──────────────────────────────────────────────┐
                         │  Cloudflare (edge)                            │
                         │                                               │
   tonel.io  ─────CNAME─→│  Pages: tonel-web.pages.dev   (orange cloud) │
   api.tonel.io ──CNAME─→│  Tunnel → 8.163.21.207:9004   (orange cloud) │
                         │                                               │
                         └──────────────────────────────────────────────┘
                                          │
                                          │ (signaling only)
                                          ▼
   srv.tonel.io ───A────────────→ 8.163.21.207   (grey cloud, NO Cloudflare)
                                          │
                                          ▼
                         ┌──────────────────────────────────────────────┐
                         │  Alibaba Cloud ECS — Debian 12 / x86_64       │
                         │                                               │
                         │   nginx :80,:443                              │
                         │     ↓ /signaling     → 127.0.0.1:9004         │
                         │     ↓ /mixer-tcp     → 127.0.0.1:9005         │
                         │     ↓ /mixer-udp     → 127.0.0.1:9005         │
                         │                                               │
                         │   cloudflared (tunnel 339745d7-...)           │
                         │     ↓ api.tonel.io   → 127.0.0.1:9004         │
                         │                                               │
                         │   PM2 processes:                              │
                         │     tonel-signaling     bin/signaling_server  │
                         │                          :9001/TCP             │
                         │     tonel-mixer         bin/mixer_server      │
                         │                          :9002/TCP :9003/UDP   │
                         │     tonel-ws-proxy      proxy/ws-proxy.js     │
                         │                          :9004                 │
                         │     tonel-ws-mixer-proxy                       │
                         │                          proxy/ws-mixer-proxy.js
                         │                          :9005, :9006/UDP      │
                         └──────────────────────────────────────────────┘

   AppKit desktop ──direct UDP/TCP──→ 8.163.21.207:9002 (TCP), :9003 (UDP)
```

## Filesystem layout (production)

```
/opt/tonel/                       # canonical install (v1.0.3+)
├── bin/                          # compiled C++ binaries
│   ├── signaling_server
│   └── mixer_server
├── proxy/                        # Node.js WebSocket bridges
│   ├── ws-proxy.js
│   ├── ws-mixer-proxy.js
│   ├── package.json
│   └── node_modules/
├── scripts/                      # PM2 launchers
│   ├── start-mixer.sh
│   └── start-signaling.sh
├── ops/
│   └── ecosystem.config.cjs      # PM2 process definitions (single source of truth)
├── build-src/                    # rsynced server/ source for remote builds
├── VERSION                       # plain text, current version
└── DEPLOY_LOG                    # append-only, one line per component deploy

/var/lib/tonel/                   # runtime data (survives re-deploys)
└── recordings/

/var/log/tonel/                   # PM2 stdout/stderr per process
├── signaling.{out,err}.log
├── mixer.{out,err}.log
├── ws-proxy.{out,err}.log
└── ws-mixer-proxy.{out,err}.log

/opt/_archive/                    # snapshots before destructive deploys
└── tonel-*-YYYYMMDD-HHMMSS/
```

The legacy `/opt/tonel-server/` directory (pre-v1.0.3) is preserved at
`/opt/_archive/tonel-server-pre-bootstrap/` as a fallback. After one week of
stable operation it can be deleted manually.

## Ports

| Port | Proto | Bound by | Purpose |
|---|---|---|---|
| 22 | TCP | sshd | SSH |
| 80 | TCP | nginx | HTTP (redirects to 443) |
| 443 | TCP | nginx | HTTPS, terminates WSS |
| 9001 | TCP | signaling_server | Native client signaling |
| 9002 | TCP | mixer_server | Mixer control channel |
| 9003 | UDP | mixer_server | Mixer SPA1 audio |
| 9004 | TCP | ws-proxy.js | Web signaling WS (also bridges /mixer-tcp /mixer-udp internally) |
| 9005 | TCP | ws-mixer-proxy.js | Mixer WS proxy |
| 9006 | UDP | ws-mixer-proxy.js | Mixer return audio relay |
| 20242 | TCP | cloudflared | Tunnel metrics (localhost only) |

## DNS (Cloudflare)

| Record | Type | Target | Cloud |
|---|---|---|---|
| `tonel.io` | CNAME | `tonel-web.pages.dev` | Orange (CF Pages) |
| `api.tonel.io` | CNAME | `<tunnel>.cfargotunnel.com` | Orange (CF Tunnel) |
| `srv.tonel.io` | A | `8.163.21.207` | **Grey (DNS only)** |

The grey cloud on `srv.tonel.io` is intentional: mixer audio must not traverse
Cloudflare. Latency-critical path. See [ARCHITECTURE.md](ARCHITECTURE.md).

## TLS

Three certificates issued by Let's Encrypt via certbot, auto-renewed:

| Domain | Path |
|---|---|
| `tonel.io` | `/etc/letsencrypt/live/tonel.io/` |
| `srv.tonel.io` | `/etc/letsencrypt/live/srv.tonel.io/` (issued via `certbot-dns-cloudflare`) |
| `logicdesaudio.com` | unrelated tenant on the same box |

Renewal config: `/etc/letsencrypt/renewal/*.conf`.

## Toolchain (production)

| | Version | Where |
|---|---|---|
| Node | 20.20.1 | `/usr/bin/node` (via `nodesource`) |
| PM2 | 6.0.14 | `/usr/bin/pm2` |
| cmake | 3.25.1 | `apt` |
| g++ | 12.2.0 (Debian) | `apt` |
| nginx | 1.22.1 | `apt` |
| cloudflared | 2026.3.0 | `cloudflare apt` repo |
| certbot | 5.5.0 | `apt` (with `certbot-dns-cloudflare`) |

Server-side build deps: `libuv1-dev`, `libopus-dev`, `nlohmann-json3-dev`.

## How to change something

| Want to change… | Where to edit | Apply with |
|---|---|---|
| C++ server logic | `Git/server/src/*.cpp` | `Git/deploy/server.sh --component=binary` |
| WebSocket proxy logic | `Git/web/ws-proxy.js`, `ws-mixer-proxy.js` | `Git/deploy/server.sh --component=proxy` |
| PM2 process args / env | `Git/ops/pm2/ecosystem.config.cjs` | `Git/deploy/server.sh --component=ops` |
| Nginx site config | `Git/ops/nginx/*.conf` | `Git/deploy/server.sh --component=ops` |
| Cloudflared tunnel routes | `Git/ops/cloudflared/config.yml.template` | `Git/deploy/server.sh --component=ops` |
| Web frontend | `Git/web/src/**` | `Git/deploy/web.sh` |
| Anything else (manual fix on server) | **Don't** — bring it back into the repo first |

## Drift policy

The directories `Git/ops/` and the `proxy/` files are **the source of truth**.
Production reflects them, not the other way around. If you discover that
production has a file the repo doesn't, that's a drift bug — copy the change
into the repo, commit it, then re-deploy. Never edit files on the server
directly. The deploy scripts check md5 before overwriting and will refuse to
clobber unexpected changes unless `ALLOW_DRIFT=1`.

## Disaster recovery

The ECS box dying is the one scenario the deploy scripts cannot handle on their
own. To bring up a fresh server:

1. Provision Debian 12 / x86_64 ECS, point `srv.tonel.io` and the cloudflared
   tunnel at it.
2. Install toolchain: `apt install nodejs npm libuv1-dev libopus-dev nlohmann-json3-dev cmake g++ nginx certbot python3-certbot-dns-cloudflare`. Install pm2: `npm i -g pm2`. Install cloudflared from the official repo.
3. Issue Let's Encrypt certs for `srv.tonel.io` and `tonel.io` (DNS-01 via cloudflare creds).
4. Set `TONEL_SSH_HOST` to the new box in `.env.deploy`.
5. Run `Git/deploy/bootstrap.sh` — it creates `/opt/tonel/` from scratch and
   pushes everything fresh.

This is the kind of scenario where having `ops/` in the repo pays for itself.
