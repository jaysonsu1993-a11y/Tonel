# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] - 2026-04-28

### Fixed (Deploy Tooling)
- **`Git/deploy/health.sh` WSS probe runs from server, not laptop.** The previous version curled WSS endpoints from wherever the deploy script was invoked, which meant a single ISP path issue between the operator and the production IP could mark a perfectly healthy deploy as failed (TLS reset by peer on `srv.tonel.io` / SNI-based filtering on direct-to-origin hosts). Now `check_wss_handshake` SSH-runs `curl` *on the server* — same network as nginx — so it tests the deploy, not the operator's connectivity. Added `strict` / `reachable` modes: direct endpoints (srv.tonel.io) require `101 Switching Protocols`; CF-Tunnel endpoints (api.tonel.io) only require any non-zero HTTP code, since `curl`'s RFC 6455 upgrade is unreliable through HTTP/2-speaking edges (real WS handshake is browser-tested). Also fixed a `${...} || echo 000` bug that produced `HTTP 101000` when curl printed the code and then exited non-zero on `--max-time`.
- **`Git/deploy/server.sh` cloudflared substitution preserves comments.** Used `sed s/.../.../g` globally, which replaced the literal `${TUNNEL_ID}` token in the template's docstring with the real id. Switched to an `awk` rule that skips lines starting with `#`, so the template's documentation stays intact when applied.
- **`Git/deploy/web.sh` uses `npm ci`, not `npm install`.** Plain `npm install` rewrites `package-lock.json` whenever transitive deps shift, leaving the working tree dirty after every web deploy. `npm ci` honors the lockfile strictly. Also passes `--commit-dirty=true` to silence the wrangler warning about the gitignored `dist/` directory (this is a build output, not actual uncommitted source).

### Context (v1.0.3 retrospective)
The v1.0.3 deploy infrastructure landed correctly but had three small wrinkles surface during the bootstrap of production: the WSS probe drift above, the cloudflared sed eating its own comment, and `npm install` lockfile drift. None affected runtime correctness (the migration to `/opt/tonel/` succeeded — PM2 stayed online on the new layout, nginx + cloudflared applied cleanly, `srv.tonel.io` and `api.tonel.io` continued to serve traffic). v1.0.4 closes the loop on the deploy tooling itself.

| File / Change | Detail |
|---------------|--------|
| `Git/deploy/health.sh` | WSS probe via SSH; `strict`/`reachable` modes; `100 + 000` concat bug fixed |
| `Git/deploy/server.sh` | cloudflared template substitution via `awk` (skip comments) |
| `Git/deploy/web.sh` | `npm ci` + wrangler `--commit-dirty=true` |

## [1.0.3] - 2026-04-28

### Added (Deploy Infrastructure)
- **`Git/deploy/`** — imperative deploy scripts (`web.sh`, `server.sh`, `health.sh`, `rollback.sh`, `bootstrap.sh`) plus `lib/common.sh` (logging, dry-run, drift detection, remote backups). All read configuration from `Git/deploy/.env.deploy` (gitignored). Replaces the manual `scp` / `pm2 restart` workflow that was previously documented inline in `DEVELOPMENT.md`.
- **`Git/ops/`** — declarative production configuration entered into source control: `pm2/ecosystem.config.cjs` (process definitions), `nginx/srv.tonel.io.conf` + `nginx/tonel.io.conf`, `cloudflared/config.yml.template`, `scripts/start-mixer.sh` + `scripts/start-signaling.sh`. Production now reflects the repo, not the other way around.
- **`Git/scripts/release.sh`** — release orchestrator: `release.sh <version>` runs the full pipeline (bump → CHANGELOG verify → commit → tag → push → server deploy → web deploy → health check). Modes: `--skip-deploy`, `--skip-push`, `deploy-only`.
- **`Git/docs/DEPLOYMENT.md`** — production topology, filesystem layout (`/opt/tonel/`, `/var/lib/tonel/`, `/var/log/tonel/`), port map, DNS, TLS, toolchain, drift policy, disaster recovery.
- **`Git/docs/RELEASE.md`** — canonical release flow, semver rules, CHANGELOG format, partial flows, hotfix workflow.

### Changed (Production Layout)
- **Migrated `/opt/tonel-server/` → `/opt/tonel/`** with clean separation:
  - `bin/` — compiled C++ servers
  - `proxy/` — Node.js WebSocket bridges
  - `scripts/` — PM2 launchers
  - `ops/ecosystem.config.cjs` — PM2 process definitions
  - `VERSION` + `DEPLOY_LOG` for "what's running right now?" lookups
  - Runtime data moved to `/var/lib/tonel/recordings/`
  - PM2 logs moved to `/var/log/tonel/`
- The legacy `/opt/tonel-server/` is preserved at `/opt/_archive/tonel-server-pre-bootstrap/` as a fallback, deletable after one week of stable operation.
- **PM2 process exec paths normalized to `bin/`** — previously `tonel-signaling` ran `/opt/tonel-server/signaling_server` (root) while `start-signaling.sh` referenced `bin/`, causing silent drift between manual restarts and binary swaps.

### Removed
- **`webrtc-mixer-proxy.js` (file + `tonel-webrtc-mixer` PM2 process)** — v1.0.0 changelog announced its removal but the file lingered in the repo and the process was still running on production. Cleaned up properly this release.
- **`mixer.tonel.io` cloudflared route** — dead since v1.0.0 (mixer audio uses `srv.tonel.io` direct, no Cloudflare).

### Fixed (Drift Reflow)
- **`Git/web/ws-proxy.js`** updated to match production version (HTTP server with upgrade routing for `/mixer-tcp` + `/mixer-udp`, noServer-mode `WebSocketServer`). The repo had been carrying a stale single-WS variant since v1.0.0 — every deploy from the repo would have downgraded the proxy.
- **`Git/scripts/bump-version.sh`** now respects `YES=1` env var to skip the interactive confirm prompt — required for `release.sh` orchestration.

### Repo policy
- Added `Git/.gitignore` rule for `deploy/.env.deploy` (SSH host / Cloudflare token / tunnel id) — these values stay local. The committed `.env.deploy.example` documents required keys.

| File / Change | Detail |
|---------------|--------|
| `Git/deploy/{web,server,health,rollback,bootstrap}.sh` | New deploy scripts, all `--dry-run` capable |
| `Git/deploy/lib/common.sh` | Shared helpers: logging, drift check, SSH wrappers, deploy log |
| `Git/deploy/.env.deploy.example` | Documented config keys (gitignored real `.env.deploy`) |
| `Git/ops/pm2/ecosystem.config.cjs` | PM2 single source of truth, replaces ad-hoc `pm2 start` flags |
| `Git/ops/nginx/{srv,tonel}.io.conf` | nginx site configs, applied by `server.sh --component=ops` |
| `Git/ops/cloudflared/config.yml.template` | Cloudflared tunnel config (only `api.tonel.io` ingress; mixer route removed) |
| `Git/ops/scripts/start-{mixer,signaling}.sh` | PM2 launchers, mixer cd's into `/var/lib/tonel/` for recordings |
| `Git/scripts/release.sh` | Release orchestrator |
| `Git/docs/DEPLOYMENT.md`, `Git/docs/RELEASE.md` | New canonical docs |
| `Git/docs/DEVELOPMENT.md` | Replaced inline deploy snippets with pointers to RELEASE.md / DEPLOYMENT.md |
| `Git/web/ws-proxy.js` | Reflow from production (HTTP+upgrade routing) |
| `Git/web/webrtc-mixer-proxy.js` | Deleted |
| `Git/scripts/bump-version.sh` | `YES=1` env var skips interactive prompt |
| `Git/.gitignore` | `+ /deploy/.env.deploy` |

## [1.0.2] - 2026-04-28

### Fixed (Build Tooling)
- **`Git/scripts/bump-version.sh` BSD-grep incompatibility** — the script used `grep -oP '...\K...'` (GNU-only) wrapped in `|| echo "unknown"`, so on macOS the regex flag was rejected, `CURRENT_VERSION` became `unknown`, all subsequent `sed` substitutions found no match, and the script exited 0 having changed nothing. Verified this had been silently broken since at least v1.0.0 (`Git/config.schema.json` `version.default` was stuck at `0.3.2`). Replaced `grep -oP` with `sed -nE` (BSD+GNU compatible) in both extraction and verification blocks, and added a hard-fail when current version cannot be detected — silent no-op is the worst failure mode for a release script.

### Changed (Repo Policy)
- **GitHub remote now mirrors only `Git/` + root `.gitignore`** — all other root-level paths (`local_docs/`, `Tonel-Desktop(Legacy)/`, `docs/`, `.claude/`, build artifacts) are local-only. The GitHub repo is purely for code version management of the `Git/` source tree.
- **Git history rewritten** via `git filter-repo --path Git/ --path .gitignore`: every commit hash from this point backward is new. All historical tags (`v0.1.0` through `v1.0.1`) now point to rewritten commit objects. Existing clones must be re-cloned.
- `.gitignore` extended with `/local_docs/`, `/Tonel-Desktop(Legacy)/`, `/.claude/` (root anchored) so the local-only paths stay untracked going forward.

| File / Change | Detail |
|---------------|--------|
| `Git/scripts/bump-version.sh` | `grep -oP` → `sed -nE`; hard-fail on undetected version |
| `.gitignore` | Added `/local_docs/`, `/Tonel-Desktop(Legacy)/`, `/.claude/` |
| Repo history | One-time rewrite via `git filter-repo`; force-pushed |

## [1.0.1] - 2026-04-28

### Fixed (Web Client)
- **GitHub link in App footer** — repo was renamed from `S1-BandRehearsal` to `Tonel` on 2026-04-27, but `Git/web/src/App.tsx` still pointed to the old URL, returning 404 to users who clicked through.

### Fixed (Config Schema)
- **`config.schema.json` `app.version.default` synced to `1.0.1`** — had been stuck at `0.3.2` because `scripts/bump-version.sh` silently no-ops on macOS (uses `grep -P`, unsupported by BSD grep), so prior bumps left this field behind. Updated this release manually; script fix tracked separately.

| File | Change |
|------|--------|
| `Git/web/src/App.tsx` | GitHub URL `S1-BandRehearsal` → `Tonel` |
| `Git/config.schema.json` | `app.version.default` `0.3.2` → `1.0.1` |
| (5 standard version-sync files) | `1.0.0` → `1.0.1` |

## [1.0.0] - 2026-04-27

### Added (Web Client)
- **End-to-end web audio streaming** -- web client can now capture, send, receive, and play audio through the mixer server
- ScriptProcessorNode audio capture (AudioWorklet had zero-data issues with MediaStreamAudioSourceNode)
- Direct frame sending from ScriptProcessor callback (no frameBuffer accumulation -- it caused zero-data bug)
- PCM16 codec: encode `Math.round(s * 32767)` LE, decode `getInt16 LE / 32768.0` (matches AppKit client)
- Level metering: linear RMS + 80/20 EMA smoothing, displayed via single-bar gradient LedMeter with dB scale (-60dB range)
- Playback via BufferSource scheduling with `src.start(0)` immediate play
- Input/output device selection via `getUserMedia` + `AudioContext.setSinkId`
- Auto-reconnect for audio WebSocket on close

### Changed (Architecture)
- **Web audio transport**: replaced WebRTC DataChannel with WebSocket (ws-mixer-proxy) via srv.tonel.io
- **srv.tonel.io**: direct A record to 8.163.21.207 (DNS only, grey cloud, no Cloudflare proxy) with Let's Encrypt SSL cert (certbot-dns-cloudflare)
- nginx on server proxies WSS for srv.tonel.io to ws-mixer-proxy
- ws-mixer-proxy only creates TCP connection for /mixer-tcp path (not /mixer-udp)
- Removed webrtc-mixer-proxy.cjs and WebRTC DTLS/SCTP ports (9007, 10000-10100)

### Changed (Server)
- Mixer server handles PING→PONG on TCP control channel
- start-mixer.sh uses `exec` to prevent zombie processes
- PM2 scripts run from `/opt/tonel-server/` (must cp there after updating)

### DNS
- tonel.io → Cloudflare Pages (orange cloud) -- web static hosting
- api.tonel.io → Cloudflare Tunnel (orange cloud) -- signaling only
- srv.tonel.io → 8.163.21.207 (grey cloud, DNS only) -- mixer audio direct

### Deployment
- Frontend: Cloudflare Pages via `wrangler` CLI with `CLOUDFLARE_API_TOKEN` env var
- Server scripts: cp to `/opt/tonel-server/` then `pm2 restart`
- Mixer binary: build on server, stop→cp→start

## [0.3.6] - 2026-04-26

### Added (AppKit Client)
- **MixerBridge**: 完整的 mixer 音频传输层，TCP:9002 控制通道 + UDP:9003 SPA1 音频收发
- AudioBridge 接入 MixerBridge：麦克风采集 stereo f32 → mono PCM16 → 240 样本/5ms SPA1 包发送
- 服务器混音数据通过 lock-free SPSC ring buffer 接收并播放
- 进入房间自动连接 mixer，离开房间自动断开
- SPA1 HANDSHAKE 握手注册 UDP 地址

### Fixed (AppKit Client)
- 进入房间后仍有本地音频回环 — 当 mixerBridge 已设置但未连接时输出静音，不再回环

## [0.3.5] - 2026-04-25

### Fixed (Web Client)
- **P0-1**: `initPlayback()` 异步无 await → 播放无声问题
- **P0-1 追加**: `initPlaybackWorklet()` 返回 `void` 而非 `Promise` → await 未真正等待 worklet 加载
- **P0-2**: `audioContextPlay` 未调用 `resume()` → 浏览器 autoplay 策略阻止播放
- **P0-3**: `useAudio` 创建独立 AudioContext 与 `audioService` 冲突 → 麦克风占用冲突
- **P0-4**: `parseSpa1Header` 缺少 dataSize 上限检查 → 潜在内存溢出风险

### Fixed (Server)
- **P0-1**: UDP/TCP 缓冲区竞争 — 分离为独立的 `tcp_slab` 和 `udp_slab`
- **P0-3**: Opus 解码未验证返回值 — `decoded <= 0` 时直接 return，避免使用未初始化数据
- **P0-4**: TCP 连接关闭后 use-after-free — 断开时清除所有 `UserEndpoint.tcp_client` 指针，防止 `broadcast_levels` 写入已关闭连接

### Fixed (WebRTC Proxy)
- Proxy 发送双重 MIXER_ANSWER（sync + onLocalDescription 回调）导致浏览器 `setRemoteDescription` 第二次调用失败 → 删除同步回退路径
- 浏览器增加 `answered` 标志防御重复 answer

### Security
- SPA1 packet dataSize 限制为 1356 字节（客户端+服务端双向校验）

## [0.3.4] - 2026-04-24

### Fixed
- 空房间不会自动销毁 — 新增房间闲置回收机制：房间变空后30分钟自动销毁，每5分钟扫描一次。修复了创建后无人加入的房间永久残留的问题。

### Changed
- `RoomManager::leave_room()` 不再立即销毁空房间，统一由 reaper 定时器处理
- `Room` 新增 `empty_since_` 时间戳，记录房间变空的时刻
- `SignalingServer` 新增 `room_reaper_timer_`（5分钟周期）

## [0.3.3] - 2026-04-22

### Security
- Server room passwords now use PBKDF2-HMAC-SHA256 hashing instead of plaintext storage
  - 16-byte random salt, 10000 iterations, 32-byte SHA-256 output
  - Storage format: `base64(salt):base64(hash)`
  - Constant-time comparison to prevent timing attacks

### Fixed
- `config.schema.json` field naming aligned with coding standards (camelCase → snake_case)
- Server and desktop config parsers synchronized to use new snake_case keys

### Changed
- `docs/server-mixer.md` rewritten to match actual implementation (v1.1)

## [0.3.2] - 2026-04-24

### Fixed
- WebRTC "Called in wrong state: stable" error on signal reconnect -- connectMixer() now cleans up existing PeerConnection before creating new one
- WebRTC answer SDP sent before ICE candidates ready -- proxy now uses onLocalDescription callback (node-datachannel)
- WebSocket frequent disconnects (~13s interval) -- browser signalService sends HEARTBEAT every 10s to prevent Cloudflare Tunnel idle timeout
- JUCE client build marked as Legacy, S1-Desktop-AppKit renamed to Tonel-Desktop-AppKit

### Added
- Google STUN server (stun.l.google.com:19302) as fallback for NAT traversal
- Signaling reliability section in architecture docs

## [0.3.1] - 2026-04-20

### Fixed
- WebRTC mixer proxy async SDP handling with node-datachannel
- Server-side WebRTC ICE candidate relay

## [0.3.0] - 2026-04-19

### Added
- WebRTC DataChannel-based mixer audio transport for web client
- webrtc-mixer-proxy (node-datachannel) bridging browser DataChannel to server TCP/UDP
- Cloudflare Tunnel for signaling (api.tonel.io)
- Cloudflare Pages for web hosting (tonel.io)
- Direct DTLS/SCTP audio path bypassing domain ICP restrictions

### Changed
- Web client signaling migrated from direct TCP to WebSocket via Cloudflare Tunnel
- Mixer audio path changed from WebSocket to WebRTC DataChannel for lower latency

## [0.2.0] - 2026-04-15

### Added
- Monochrome minimalist UI with animated instrument background
- Channel strip component with LED meter
- Room password protection
- Audio input device selection in web client

### Fixed
- AppKit UI button click handling
- AudioContext autoplay policy suspension

## [0.1.0] - 2026-04-01

### Added
- Initial release of Tonel
- AppKit native macOS client (zero license risk, MIT-only)
- Signaling server (TCP/JSON room management)
- Mixer server (UDP audio mixing with SPA1 protocol)
- Web client for trial/demo (React + TypeScript)
- SPA1 (Simple Protocol for Audio v1) -- custom 44-byte header binary protocol
- P2P mesh mode for 2-4 users (UDP direct)
- Mixer mode for 5+ users (server-mediated mixing)
- Opus codec support

[1.0.0]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.6...v1.0.0
[0.3.6]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jaysonsu1993-a11y/Tonel/releases/tag/v0.1.0
