# Tonel System Architecture

## Goal

Ultra-low latency real-time audio for online band rehearsal. Every
architectural decision serves one metric: **minimizing end-to-end audio
latency**. Target on a Chinese intra-province network is **~30 ms
mouth-to-ear**.

## Topology — server-side mixer, always

```
  Client A (Web or Tonel-MacOS)
            │
            │  audio (SPA1, every 2.5 ms)
            ▼
  ┌─────────────────────────────┐
  │   Mixer Server (libuv)       │
  │   per 2.5 ms tick:           │
  │     for each user U in room: │
  │       mix = sum of all       │
  │             other users      │
  │       send mix → U           │
  └─────────────┬───────────────┘
                │
                ▼  same SPA1 packet stream (the N−1 mix for that user)
       ◀ Client B   Client C   Client N
```

Every client sends its mic upstream to the mixer; the mixer sends each client
a personalized **N−1 mix** (everybody else, but not their own voice — that
would create echo). One TCP control channel + one UDP-equivalent audio
channel per client. Topology is always a star, never a mesh.

**There is no P2P mode.** Earlier protocol drafts mentioned
P2P/WebRTC-mesh; that path was deprecated and the production architecture is
mixer-only. (The server still has unused `MIXER_OFFER`/`P2P_*` JSON message
handlers from that era — dead code, no live caller.)

## Clients

### Web client (`web/`)

React + TypeScript + Vite. Served as static assets from Cloudflare Pages
(`tonel.io`). Audio I/O is `getUserMedia` → `AudioWorklet` for capture, and a
custom playback worklet that does its own jitter buffer + drift adapter
(`audioService.ts`).

**Network paths:**

| Layer | URL | Backing |
|---|---|---|
| Static HTML/JS | `https://tonel.io/` | Cloudflare Pages |
| Signaling (control plane) | `wss://api.tonel.io/signaling` | Cloudflare Tunnel → signaling_server :9001 |
| Mixer control | `wss://srv.tonel.io/mixer-tcp` | nginx → ws-mixer-proxy :9005 → mixer_server :9002 |
| Mixer audio | `wss://srv.tonel.io/mixer-udp` | nginx → ws-mixer-proxy :9005 → mixer_server UDP :9003 |

The audio path **never touches Cloudflare** — `srv.tonel.io` is a DNS-only A
record (grey cloud) pointing directly at the mixer server. CF in the audio
path would add 10-20 ms of edge latency that we don't want.

The `tonel.io/new` URL prefix is a **fallback path** that points to the
secondary box (Aliyun). Same code, same protocol, different DNS — used as a
backup and for cross-region testing. Not the default.

### Desktop client (`Tonel-MacOS/`)

Native SwiftUI macOS app. **The only desktop client.** Speaks SPA1 directly
over raw TCP (control) + UDP (audio) — does not go through the WSS path the
web client uses. Hardcoded to point at the Aliyun box (8.163.21.207) for
historical reasons — the kufan box's network behavior with raw UDP has known
issues (`project_kufan_udp_burst`), so AppKit-equivalent native traffic stays
on Aliyun.

Pre-v5.0.5 there were two other macOS clients (`Tonel-Desktop` JUCE-based,
`Tonel-Desktop-AppKit` — both deleted in the v5.1.18 doc cleanup along with
their references in the build system). Anything you find in older
CHANGELOG entries referring to "AppKit client" is now Tonel-MacOS.

## Server (`server/`)

Two separate libuv processes:

```
┌── signaling_server (port 9001) ─────────┐
│  - Room create/join/leave                │
│  - Peer-list broadcast                   │
│  - Heartbeat / idle disconnect           │
│  - JSON over TCP, newline-delimited      │
└──────────────────────────────────────────┘

┌── mixer_server (port 9002 TCP, 9003 UDP) ─┐
│  - SPA1 audio packet handling             │
│  - 2.5 ms mix tick (timed mixing)          │
│  - Per-user jitter buffer + PLC fill      │
│  - PCM16 ↔ Opus codec                      │
│  - N−1 mix (excluding the listener)        │
│  - Soft-clip at 0.95 knee                  │
│  - Level computation (50 ms cadence)      │
└────────────────────────────────────────────┘
```

The two are intentionally separate processes — different traffic profiles,
different failure domains. Signaling is JSON, low-volume, latency-tolerant,
proxied through Cloudflare Tunnel (`api.tonel.io`). Audio is binary, very
high volume (~400 packets/sec/user × all users in a room, full duplex), and
must not go through CF.

In front of both, three Node.js proxies translate between WebSocket and the
native protocols for browser clients:

| Proxy | Path | Wraps |
|---|---|---|
| `tonel-ws-proxy` | `wss://api.tonel.io/signaling` (via cloudflared) | TCP :9001 |
| `tonel-ws-mixer-proxy` | `wss://srv.tonel.io/mixer-tcp` | TCP :9002 |
| `tonel-ws-mixer-proxy` | `wss://srv.tonel.io/mixer-udp` | UDP :9003 |
| `tonel-wt-mixer-proxy` (Go) | `https://srv.tonel.io:4433/mixer-wt` | UDP :9003 (WebTransport, /new path only) |

Native clients (Tonel-MacOS) skip the proxies entirely and speak SPA1 to
9002/9003 directly.

## Wire protocol — SPA1

76-byte binary header (network byte order) followed by PCM16 or Opus payload.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic = 0x53415031 ("SPA1") |
| 4 | 2 | sequence (u16) |
| 6 | 2 | timestamp (u16, 2.5 ms units) |
| 8 | 64 | userId (null-terminated, "roomId:userId" format) |
| 72 | 1 | codec (0=PCM16, 1=Opus, 0xFF=handshake) |
| 73 | 2 | dataSize (u16) |
| 75 | 1 | reserved (PLC-fired bit + padding) |
| 76+ | N | payload |

Frame size: **120 samples / 2.5 ms @ 48 kHz**. PCM16 payload = 240 bytes;
Opus is variable. Server mix tick matches at 2.5 ms.

Full spec: [SPA1_PROTOCOL.md](./SPA1_PROTOCOL.md).

## Latency budget

End-to-end on a Chinese intra-province network looks like:

| Component | Time | Source |
|---|---|---|
| Mic capture quantum | 2.5 ms | `FRAME_MS` |
| Network RTT (client → kufan) | 5-15 ms | depends on user network |
| Server jitter buffer | 3.75 ms | `(JITTER_TARGET_DEFAULT=2 - 0.5) × 2.5` |
| Server mix tick | 2.5 ms | mix half-period |
| Client playback ring | 12 ms | `primeTarget=576` samples / 48 kHz |
| Output device | 2-10 ms (wired); 60-200 ms (Bluetooth) | hardware-dependent |
| **Total (wired)** | **~30 ms** | |

The output-device term is the only thing that can blow up the figure;
the in-room latency display surfaces a banner if `outputLatency > 30 ms`
to flag Bluetooth headphones.

## Production deployment

```
                              INTERNET
                                 │
        ┌────────────────────────┼─────────────────────────┐
        │                        │                         │
   [Cloudflare Pages]    [Cloudflare Tunnel]      [Direct WSS / WT]
        │                        │                         │
   tonel.io                 api.tonel.io             srv.tonel.io
                            api-new.tonel.io         srv-new.tonel.io
        │                        │                         │
        └────────────────────────┼─────────────────────────┘
                                 │
              ┌──────────────────┴────────────────────┐
              │                                       │
    [酷番云广州 (primary)]                  [Aliyun ECS (fallback)]
    42.240.163.172                          8.163.21.207
    Debian 12 / Linux 6                     Debian 12 / Linux 6
    nginx :443  (TLS, certbot-DNS-CF)       nginx :443
    signaling_server  :9001                 signaling_server  :9001
    mixer_server      :9002 (TCP)           mixer_server      :9002 (TCP)
    mixer_server      :9003 (UDP)           mixer_server      :9003 (UDP)
    ws-proxy          :9004                 ws-proxy          :9004
    ws-mixer-proxy    :9005 / :9006         ws-mixer-proxy    :9005 / :9006
    wt-mixer-proxy    :4433 / :9007         wt-mixer-proxy    :4433 / :9007
    cloudflared (tonel-koufan)              cloudflared (tonel-tunnel)
```

Both boxes run identical code from the same `ops/` configs. DNS picks who
serves what hostname; switching primary/fallback is a single CF DNS edit.

### DNS records

| Hostname | Type | Target | CF proxy |
|---|---|---|---|
| `tonel.io` | CNAME | `tonel-web.pages.dev` | Orange (CF Pages) |
| `api.tonel.io` | CNAME | `<koufan-tunnel-id>.cfargotunnel.com` | Orange (CF Tunnel) |
| `api-new.tonel.io` | CNAME | `<aliyun-tunnel-id>.cfargotunnel.com` | Orange (CF Tunnel) |
| `srv.tonel.io` | A | `42.240.163.172` (酷番云) | **Grey (DNS-only)** |
| `srv-new.tonel.io` | A | `8.163.21.207` (Aliyun) | **Grey (DNS-only)** |

The `srv.*` records are deliberately DNS-only — CF orange-cloud would push
the audio through their edge and add latency. We put audio over WSS to a
direct IP behind the customer's own nginx/TLS instead.

### Why kufan is primary (and what's annoying about it)

The v5.0.0 (2026-04-30) migration moved primary `srv.tonel.io` from Aliyun
to 酷番云广州 because Aliyun's bandwidth tier was throttling concurrent
users. Kufan has more headroom.

The downside (documented in detail in the 2026-05-04 architectural
diagnosis): kufan's upstream network has a TLS-fingerprint-aware DPI
appliance that occasionally injects forged RST packets on TLS ClientHello
matching certain heuristics. Symptoms: 30-60% intermittent failure rate on
fresh WSS handshakes from some networks, and a near-100% failure rate from
foreign IPs and other Chinese cloud providers.

The web client mitigates this with:
- **3-attempt internal retry inside `connectMixer`** (v5.1.15)
- **Background infinite retry with exponential backoff** if the 3 attempts
  also fail (v5.1.16) — surfaced as a subtle "正在连接服务器…" line
  rather than a red banner; never blocks the user
- **Explicit pacing** between consecutive new TCP+TLS handshakes (v5.1.17)
  so the DPI doesn't see a burst pattern

These mitigate the symptom on the user side. Once a WSS handshake survives
the DPI window and gets `101 Switching Protocols`, the established
connection is unaffected — audio flows normally for the rest of the
session.

## Latency optimizations (chronological)

The v4.x release line was an explicit latency-reduction roadmap. Highlights:

1. **2.5 ms frame size** (v4.2.0) — halved from the original 5 ms. Server
   mix tick halved to match. Saves ~5 ms end-to-end.
2. **Client PCM PLC** (v4.2.0) — `primeTarget` could shrink from 30 ms
   to 12 ms because underruns are now papered over with a one-frame
   PLC fill instead of needing a fat cushion.
3. **Server N−1 mix** — listeners get everybody-except-themselves. Avoids
   a full duplex echo loop that would otherwise need echo cancellation.
4. **Direct WSS without CF in audio path** — see the deployment section
   above.
5. **Per-user jitter buffer with `JITTER_TARGET_DEFAULT = 2`** — absorbs
   ±5 ms of network jitter without adding more steady-state queue depth.
6. **Bandlimited interp playback rate adapter** — instead of pinning sample
   rate, the playback worklet drifts ±2.5% to keep the ring fill near the
   target without re-priming.

The current end-to-end target on prod is 30 ms; in-room display shows the
real measured value (`audioE2eLatency = capture + RTT + jitter + mixTick +
ring + outputLatency`).

## Port map (server)

| Port | Protocol | Process | Exposure |
|---|---|---|---|
| 9001 | TCP | signaling_server | proxied to api.tonel.io via cloudflared |
| 9002 | TCP | mixer_server (control) | proxied to /mixer-tcp via nginx + ws-mixer-proxy |
| 9003 | UDP | mixer_server (audio) | proxied to /mixer-udp via nginx + ws-mixer-proxy; also to /mixer-wt via wt-mixer-proxy |
| 9004 | WebSocket | tonel-ws-proxy | wraps TCP :9001 for browser |
| 9005 | WebSocket | tonel-ws-mixer-proxy | wraps TCP :9002 + UDP :9003 for browser |
| 9006 | UDP | tonel-ws-mixer-proxy | UDP receive port for /mixer-udp returns |
| 9007 | UDP | tonel-wt-mixer-proxy | WebTransport receive port |
| 4433 | UDP/QUIC | tonel-wt-mixer-proxy | WebTransport listening port |

## See also

- [SPA1_PROTOCOL.md](./SPA1_PROTOCOL.md) — wire format spec
- [DEVELOPMENT.md](./DEVELOPMENT.md) — local dev setup
- [RELEASE.md](./RELEASE.md) — release flow
- [../deploy/README.md](../deploy/README.md) — production deploy
- [../ops/README.md](../ops/README.md) — nginx + cloudflared + pm2 configs
