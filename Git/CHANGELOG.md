# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
