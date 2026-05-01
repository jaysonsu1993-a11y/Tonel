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
│  │ API         │  │  (Vite)     │  │  PCM16 Codec │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘  │
│         │                 │                │          │
│  ┌──────┴─────────────────┴────────────────┴───────┐  │
│  │  Signaling: WebSocket (CF Tunnel → ws-proxy)    │  │
│  │  Mixer:     WebSocket (direct → ws-mixer-proxy) │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Audio path: srv.tonel.io (direct to server, no CF)  │
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
│  │  ws-proxy.js         │  │ ws-mixer-proxy.js     │  │
│  │  (WS :9004 → TCP)    │  │ (WS :9005 → TCP/UDP) │  │
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
10. **Direct WebSocket for audio** -- srv.tonel.io bypasses Cloudflare, audio goes straight to domestic server
11. **SPA1 timestamp RTT** -- client embeds ms-low-16 in SPA1 header, server echoes back, client computes RTT with EMA smoothing

## Editions

The Mini (miniaudio, MIT) vs Pro (JUCE, GPLv3) edition matrix and licensing
rationale live in the project [README.md](../README.md#editions). Not duplicated here.

## Port Map

| Port | Protocol | Purpose |
|---|---|---|
| 9001 | TCP | Signaling server (room management + WebRTC SDP relay) |
| 9002 | TCP | Mixer control channel |
| 9003 | UDP | Mixer audio (SPA1 packets) |
| 9004 | WebSocket | Web signaling proxy (ws-proxy.js) |
| 9005 | WebSocket | Web mixer proxy (ws-mixer-proxy.js, TCP control + UDP audio relay) |
| 9006 | UDP | ws-mixer-proxy UDP receive port (server mixed audio return) |

## Deployment Architecture (2026-04)

```
                           INTERNET
                              │
     ┌────────────────────────┼───────────────────────┐
     │                        │                       │
[Cloudflare Pages]    [Cloudflare Tunnel]     [Direct WSS/UDP]
     │                        │                       │
  tonel.io             api.tonel.io            srv.tonel.io
 (Web static)        (WS signaling)      (Mixer audio: WSS 443)
     │                        │                       │
     └────────────────────────┼───────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │  Alibaba Cloud CN  │
                    │  (Debian 12)       │
                    │                    │
                    │  nginx :443 (SSL)  │
                    │  Let's Encrypt cert│
                    │  (certbot-dns-cf)  │
                    │  signaling :9001   │
                    │  mixer     :9002   │
                    │  audio     :9003   │
                    │  ws-proxy  :9004   │
                    │  ws-mixer  :9005   │
                    │  cloudflared       │
                    └────────────────────┘
```

### Why this architecture?

- **Web on Cloudflare Pages**: No ICP filing needed. Global CDN, zero cost.
- **Signaling via Cloudflare Tunnel**: Low-bandwidth control traffic goes through QUIC tunnel. Domain stays on 443. Beaver (ICP check) only sees Cloudflare IPs.
- **Mixer audio via direct WSS**: Web client connects to `srv.tonel.io` (DNS-only A record, grey cloud, not proxied by Cloudflare). Audio traffic goes directly to the Alibaba Cloud server via nginx WSS → ws-mixer-proxy → UDP mixer. **No Cloudflare in the audio path** — critical for low latency.
- **AppKit uses direct UDP**: Native client connects directly to server IP for both TCP control and UDP audio. Lowest possible latency.

### DNS Records

| Record | Type | Target | Proxy |
|---|---|---|---|
| tonel.io | CNAME | tonel-web.pages.dev | Orange (Proxied by CF Pages) |
| api.tonel.io | CNAME | `<tunnel-id>.cfargotunnel.com` | Orange (CF Tunnel, primary tunnel) |
| api-new.tonel.io | CNAME | `<tunnel-id>.cfargotunnel.com` | Orange (CF Tunnel, fallback ingress added v5.0.1) |
| srv.tonel.io | A | 42.240.163.172 (酷番云广州, **primary** since v5.0.0) | **Grey (DNS only, direct)** |
| srv-new.tonel.io | A | 8.163.21.207 (Aliyun, **fallback** post v5.0.0) | **Grey (DNS only, direct)** |

> **v5.0.0 server migration** (2026-05-01): primary mixer flipped from
> Aliyun → 酷番云广州. AppKit binaries built before that still hard-code
> the Aliyun IP and are routed via `srv-new.tonel.io`. Web traffic and
> new AppKit builds default to `srv.tonel.io` (酷番云). Same `ops/`
> deploys to either box; DNS picks who is primary.

### Client Connection Points

| Client | Web URL | Signaling | Audio (Mixer) |
|---|---|---|---|
| AppKit (current) | — | TCP direct 42.240.163.172:9002 (酷番云) | Direct UDP :9003 |
| AppKit (pre-v5.0) | — | TCP direct 8.163.21.207:9002 (Aliyun) | Direct UDP :9003 |
| Web (Trial) | https://tonel.io | wss://api.tonel.io/signaling (CF Tunnel) | **wss://srv.tonel.io/mixer-tcp + /mixer-udp (direct)** |
| JUCE (Legacy) | — | TCP direct to config host | Direct UDP/TCP |

### WebSocket Mixer Connection Flow (Web Client)

```
1. Browser connects to wss://srv.tonel.io/mixer-tcp (control) and /mixer-udp (audio)
   - srv.tonel.io: DNS-only A record to 8.163.21.207, Let's Encrypt SSL via certbot-dns-cloudflare
   - nginx on server terminates WSS and proxies to ws-mixer-proxy on :9005
2. ws-mixer-proxy creates TCP connection to mixer_server:9002 only for /mixer-tcp
3. /mixer-tcp WebSocket ↔ TCP:9002 (MIXER_JOIN, PING/PONG, level data)
4. /mixer-udp WebSocket ↔ UDP:9003 (SPA1 audio packets)
5. Audio capture: ScriptProcessorNode (AudioWorklet had zero-data issues with MediaStreamAudioSourceNode)
6. PCM16 codec: encode Math.round(s * 32767) LE, decode getInt16 LE / 32768.0 (matches AppKit)
7. Direct frame sending from ScriptProcessor (no frameBuffer accumulation - causes zero-data bug)
8. Playback: BufferSource scheduling with src.start(0) immediate play
9. Level metering: linear RMS + 80/20 EMA smoothing, single-bar gradient LedMeter with dB scale (-60dB)
10. Auto-reconnect on audio WebSocket close
```

### Signaling Reliability

- **Server heartbeat**: signaling_server checks client timeouts every 30s (TIMEOUT = 60s)
- **Browser heartbeat**: signalService sends HEARTBEAT every 10s to prevent CF Tunnel idle disconnect
- **Auto-reconnect**: signalService reconnects with 3s delay on WebSocket close
- **Mixer PING/PONG**: mixer_server handles PING on TCP control channel, responds with PONG
- **Audio WS auto-reconnect**: Web client auto-reconnects mixer WebSocket on close

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
