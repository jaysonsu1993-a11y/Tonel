# S1 System Architecture

## Goal

Ultra-low latency real-time audio for online band rehearsal.

Every architectural decision in this project serves one metric: **minimizing end-to-end audio latency**. Users in different locations should be able to hear each other's instruments in near real-time as if playing in the same room.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          S1 BAND REHEARSAL                           │
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐           │
│  │  Desktop A   │    │  Desktop B   │    │  Desktop N   │           │
│  │  (AppKit)    │    │  (AppKit)    │    │  (Web trial)  │           │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘           │
│         │                   │                   │                    │
│  ┌──────┴───────────────────┼───────────────────┴──────┐            │
│  │                       Transport                     │            │
│  │                                                     │            │
│  │  P2P Mode (2-4 people):  ── UDP Mesh ──             │            │
│  │  Mixer Mode (5+ or fail):── UDP via Server ──        │            │
│  │  Signaling:               ── TCP JSON ──             │            │
│  └──────┬───────────────────┼───────────────────┬──────┘            │
│         │                   │                   │                    │
│  ┌──────┴───────┐    ┌──────┴───────┐    ┌──────┴───────┐           │
│  │ Signaling    │    │ Mixer Server  │    │ Web Proxy    │           │
│  │ Server       │    │ (Audio Mix)   │    │ (WS→TCP/UDP) │           │
│  │ TCP :9001    │    │ TCP:9002      │    │ WS :9004/9005│           │
│  │              │    │ UDP :9003     │    │              │           │
│  └──────────────┘    └──────────────┘    └──────────────┘           │
│                                                                      │
│                         Server (Alibaba Cloud)                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Audio Transport

### SPA1 Protocol

S1 uses a custom binary protocol called **SPA1 (Simple Protocol for Audio v1)**.

- 76-byte fixed header (P1-1: userId 64 bytes), network byte order (big-endian)
- Magic: `0x53415031` ('SPA1')
- Supports PCM16 (uncompressed, low latency) and Opus (compressed, bandwidth-efficient)
- Frame size: 5ms = 240 samples @ 48kHz (PCM16: 480 bytes, Opus: ~20-60 bytes)
- dataSize upper bound: 1356 bytes (prevents memory overflow)

Full specification: [SPA1_PROTOCOL.md](./SPA1_PROTOCOL.md)

### P2P Mode (2-4 people)

- Direct UDP mesh between all clients
- No server in the audio path -- lowest possible latency
- STUN for NAT traversal (ICE candidates exchanged via signaling server)
- Each peer sends its audio to all other peers

### Mixer Mode (5+ or P2P failure)

- All audio goes through the server
- Server mixes all incoming audio streams into one
- Returns the mixed stream to each client
- Slightly higher latency but scales to more users

### Mode Switching

Automatic: P2P is preferred, switches to Mixer when:
- Number of P2P peers exceeds `maxPeers` (default: 4)
- P2P connection fails (STUN timeout, NAT blocking)

## Client Architecture

### AppKit Client (Production)

```
┌─── Tonel-Desktop-AppKit ───────────────────────────────┐
│                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │  miniaudio  │  │   AppKit    │  │  SPA1 Codec  │  │
│  │  (Audio I/O)│  │  (UI/Views) │  │  (PCM16)     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘  │
│         │                 │                │          │
│  ┌──────┴─────────────────┴────────────────┴───────┐  │
│  │              Bridge Layer                        │  │
│  │  AudioBridge | MixerBridge | NetworkBridge       │  │
│  │  (capture/   | (TCP ctrl + | (WS signaling)     │  │
│  │   playback)  |  UDP audio) |                     │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│     License: MIT only (zero licensing risk)          │
└──────────────────────────────────────────────────────┘
```

### Web Client (Trial/Demo)

```
┌─── Tonel-Web (React + TypeScript) ─────────────────────┐
│                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │ Web Audio   │  │  React UI   │  │  SPA1 in JS  │  │
│  │ API         │  │  (Vite)     │  │  Encoder     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘  │
│         │                 │                │          │
│  ┌──────┴─────────────────┴────────────────┴───────┐  │
│  │  Signaling: WebSocket (CF Tunnel → ws-proxy)    │  │
│  │  Mixer:     WebRTC DataChannel (direct DTLS)    │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│     ~20-50ms more latency than native client          │
└──────────────────────────────────────────────────────┘
```

### Client Version History

| 目录 | 框架 | 状态 | 说明 |
|---|---|---|---|
| **Tonel-Desktop-AppKit** | AppKit + miniaudio | **当前主力** | MIT 许可证，零风险，原生 macOS。唯一推荐的桌面生产版本。 |
| **Tonel-Desktop** | JUCE | **Legacy** | GPL/商业双许可。保留原因：音频路由、SPA1、Opus 的参考实现。不再维护。 |
| ~~S1-Desktop-AppKit~~ | — | **已删除** | 源码已迁移到 `Tonel-Desktop-AppKit`。原目录仅有 Xcode 构建残留。 |

> **文件名前缀残留**：`Tonel-Desktop-AppKit/src/ui/S1RoundedButton.h` 等文件仍保留 `S1` 前缀，是项目更名（S1 → Tonel）的历史遗留，不影响功能。

## Server Architecture

```
┌─── Server (Alibaba Cloud) ──────────────────────────┐
│                                                      │
│  ┌─────────────────────┐  ┌───────────────────────┐  │
│  │  signaling_server    │  │  mixer_server          │  │
│  │  (libuv, TCP :9001)  │  │  (libuv, TCP:9002     │  │
│  │                      │  │         UDP :9003)    │  │
│  │  - Room management   │  │  - Audio mixing       │  │
│  │  - P2P SDP exchange  │  │  - SPA1 routing       │  │
│  │  - WebRTC SDP relay  │  │  - Opus decode/mix    │  │
│  │  - Heartbeat/check   │  │  - Level computation  │  │
│  └─────────────────────┘  └───────────────────────┘  │
│                                                      │
│  ┌─────────────────────┐  ┌───────────────────────┐  │
│  │  ws-proxy.js         │  │ webrtc-mixer-proxy.cjs│  │
│  │  (WS :9004 → TCP)    │  │ (WebRTC DC → TCP/UDP) │  │
│  │  Web client signaling│  │ Web client mixer audio│  │
│  └─────────────────────┘  └───────────────────────┘  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## Latency Optimizations

1. **5ms frames** -- 240 samples @ 48kHz, ultra-low latency (server configurable)
2. **PCM16 by default** -- zero encode/decode latency (no Opus compression)
3. **P2P first** -- server is not in the audio path for small groups
4. **UDP transport** -- connectionless, no TCP handshake latency
5. **miniaudio** -- minimal audio stack, no GUI framework blocking audio thread
6. **libuv** -- efficient async I/O on server side
7. **Disabled browser "enhancements"** -- echo cancellation, noise suppression, auto gain all OFF in web client for raw audio
8. **Big-endian network byte order** -- no endian conversion on ARM server/client
9. **Browser WebSocket heartbeat** -- 10s interval HEARTBEAT prevents Cloudflare Tunnel idle timeout disconnects

## Editions (免费版 vs 付费版)

两个版本的核心区别在于**音质**和**多轨录音**功能。两个版本都追求行业最低延迟。

| 特性 | Tonel-Mini (免费) | Tonel-Pro (付费) |
|---|---|---|
| **音频引擎** | miniaudio (单头文件，纯 C) | JUCE C++ 框架 |
| **许可模式** | 闭源商用 (MIT 许可证 = 零风险) | 开源发布 (GPLv3，兼容 JUCE 条款) |
| **音质** | 标准 | 高保真 / 无损 |
| **延迟** | 极低 | 极低 |
| **录音** | 不支持 | 多轨录音 (规划中) |
| **服务端处理** | 纯混音 | 混音 + 实时效果处理 (规划中) |

> **许可架构巧妙设计：** Pro 版采用 GPLv3 开源，恰好匹配 JUCE 的免费版 GPL 条款，**完全免去了 JUCE 昂贵的商业授权费**。社区开发者可以参与 Pro 版的迭代，降低开发成本并提升技术壁垒。Mini 版采用 miniaudio (MIT 许可证)，允许**完全闭源的商业分发**，没有传染性风险。

## Port Map

| Port | Protocol | Purpose |
|---|---|---|
| 9001 | TCP | Signaling server (room management + WebRTC SDP relay) |
| 9002 | TCP | Mixer control channel |
| 9003 | UDP | Mixer audio (SPA1 packets) |
| 9004 | WebSocket | Web signaling proxy (ws-proxy.js) |
| 9007 | UDP | WebRTC mixer proxy receive port (webrtc-mixer-proxy.cjs) |
| 10000-10100 | UDP | WebRTC DTLS/SCTP (browser ↔ mixer proxy) |

## Deployment Architecture (2025-04)

```
                           INTERNET
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
    [Cloudflare]        [Cloudflare]         [Direct DTLS/UDP]
         │                    │                    │
   Pages CDN            Tunnel (QUIC)       WebRTC DataChannel
         │                    │                    │
    tonel.io          api.tonel.io          8.163.21.207
   (Web static)      (WS signaling)     (Mixer: UDP 10000-10100)
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │  Alibaba Cloud CN  │
                    │  (Debian 12)       │
                    │                    │
                    │  nginx (localhost) │
                    │  signaling :9001   │
                    │  mixer     :9002   │
                    │  audio     :9003   │
                    │  ws-proxy  :9004   │
                    │  webrtc-proxy      │
                    │  cloudflared       │
                    └────────────────────┘
```

### Why this architecture?

- **Web on Cloudflare Pages**: No ICP filing needed. Global CDN, zero cost.
- **Signaling via Cloudflare Tunnel**: WebSocket traffic goes through QUIC tunnel to domestic server. Domain stays on 443 (no exposed ports). Beaver (ICP check) only sees Cloudflare IPs, not domestic server.
- **Mixer audio via WebRTC DataChannel**: Browsers connect directly to the server IP via DTLS/SCTP. Self-signed certs with fingerprints exchanged through signaling — no domain or CA cert needed. Bypasses the `.io` domain ICP filing restriction entirely.
- **Mixer on domestic server**: Critical for ultra-low latency for Chinese users. No hairpin through overseas Cloudflare edges.

### DNS Records

| Record | Type | Target | Proxy |
|---|---|---|---|
| tonel.io | CNAME | tonel-web.pages.dev | Orange (Proxied) |
| api.tonel.io | CNAME | `<tunnel-id>.cfargotunnel.com` | Orange (Proxied) |

### Client Connection Points

| Client | Web URL | Signaling | Audio (Mixer) |
|---|---|---|---|
| AppKit (Production) | https://tonel.io | wss://api.tonel.io/signaling | Direct UDP 9003 |
| Web (Trial) | https://tonel.io | wss://api.tonel.io/signaling | WebRTC DataChannel (direct DTLS to server IP) |
| JUCE (Legacy) | - | TCP direct to config host | Direct UDP/TCP |

### WebRTC Mixer Connection Flow (Web Client)

```
1. Browser creates RTCPeerConnection + DataChannels ("control", "audio")
   - ICE servers: stun.qq.com:3478 (primary), stun.l.google.com:19302 (fallback)
   - connectMixer() cleans up any existing PC before creating new one
2. Browser sends SDP offer via signaling WS -> CF Tunnel -> signaling:9001
3. Signaling server relays offer to webrtc-mixer-proxy (registered as __mixer__)
4. Proxy uses onLocalDescription callback (node-datachannel) to send answer SDP
   (single answer only — no sync fallback, prevents duplicate setRemoteDescription)
5. Browser <- -> Server: direct DTLS/SCTP over UDP (port 10000-10100)
6. "control" DataChannel (reliable) -> TCP:9002 (MIXER_JOIN, etc.)
7. "audio" DataChannel (unreliable, maxRetransmits=0) -> UDP:9003 (SPA1 packets)
```

### Signaling Reliability

- **Server heartbeat**: signaling_server checks client timeouts every 30s (TIMEOUT = 60s)
- **Browser heartbeat**: signalService sends HEARTBEAT every 10s to prevent CF Tunnel idle disconnect
- **Auto-reconnect**: signalService reconnects with 3s delay on WebSocket close
- **PC cleanup**: connectMixer() closes existing PeerConnection before creating new one,
  preventing "Called in wrong state: stable" errors during signal reconnect

### Room Lifecycle

- Rooms are created via `CREATE_ROOM` and start empty (creator does not auto-join)
- Users join via `JOIN_ROOM` and leave via `LEAVE_ROOM` or TCP disconnect
- **Idle room reaper**: a timer runs every 5 minutes and destroys any room that has been empty for ≥30 minutes. This handles rooms where the creator never joined, or rooms that became empty due to disconnects without proper cleanup.

### Monthly Cost

| Service | Provider | Cost |
|---|---|---|
| Web hosting | Cloudflare Pages | **$0** |
| Signaling tunnel | Cloudflare Tunnel | **$0** |
| Audio server | Alibaba Cloud ECS | Existing |
| Bandwidth | Cloudflare | **$0** (unlimited) |
