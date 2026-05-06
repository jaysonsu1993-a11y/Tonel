# SPA1 — Simple Protocol for Audio v1

> Authoritative implementations:
> - `server/src/mixer_server.h` — `struct SPA1Packet`
> - `web/src/services/audioService.ts` — `buildSpa1Packet()` / `parseSpa1Header()`
> - `Tonel-MacOS/TonelMacOS/SPA1.swift` — native client packing

## Overview

SPA1 is a lightweight binary audio protocol for real-time band rehearsal.
Audio frames travel over UDP (or its WebSocket / WebTransport equivalent for
browser clients); room control travels over TCP as JSON.

All multi-byte fields are network byte order (big-endian).

## Packet format — 76-byte header + payload

```
Offset  Size  Type      Field        Notes
─────────────────────────────────────────────────────────────────────
0       4     u32 BE    magic        0x53415031 ('SPA1')
4       2     u16 BE    sequence     packet sequence (incremented)
6       2     u16 BE    timestamp    sender's local ms low-16, server
                                     echoes back unchanged for RTT
                                     measurement (see below)
8       64    char[64]  userId       null-terminated "roomId:userId"
72      1     u8        codec        0=PCM16, 1=Opus, 0xFF=Handshake
73      2     u16 BE    dataSize     payload byte length (≤ 1356)
75      1     u8        reserved     bit 0 = PLC-fired (set by server
                                     on the broadcast packet when any
                                     track was filled by PLC this tick)
─────────────────────────────────────────────────────────────────────
76+     N     uint8[]   payload      audio data
─────────────────────────────────────────────────────────────────────
                       Total header: 76 bytes
```

| Field | Type | Offset | Notes |
|---|---|---|---|
| `magic` | u32 BE | 0 | Always `0x53415031`; rejects malformed packets |
| `sequence` | u16 BE | 4 | Per-stream incrementing; receiver detects gaps |
| `timestamp` | u16 BE | 6 | Client's send-time low-16 ms, mirrored by server for RTT |
| `userId` | char[64] | 8 | `"roomId:userId"`, null-terminated |
| `codec` | u8 | 72 | `0` = PCM16, `1` = Opus, `0xFF` = handshake |
| `dataSize` | u16 BE | 73 | `payload` size in bytes (max 1356) |
| `reserved` | u8 | 75 | Bit 0 = PLC-fired flag (server only) |

### PLC-fired flag (reserved bit 0)

Production clients ignore this byte. The mixer sets bit 0 of byte 75 to 1 on
broadcast ticks where any track was PLC-filled (the per-user jitter buffer
was empty for that user, so the mixer reused the previous frame instead of
mixing fresh audio). Used as a free debug channel by `audio_quality_e2e.js`
to count PLC events without a detection threshold.

## Codecs

| Value | Name | Format | Use |
|---|---|---|---|
| `0x00` | PCM16 | 48 kHz / 16-bit / mono / uncompressed | Default — minimum encode/decode latency |
| `0x01` | Opus | Variable bitrate | Bandwidth-constrained scenarios |
| `0xFF` | Handshake | (no payload) | UDP return-path registration; see below |

### Frame size

Server's `audio_frames_` parameter sets the canonical frame size. Production
config:

- **v6.0.0+ default — 32 samples / 0.667 ms @ 48 kHz** (PCM16)
- PCM16 payload = `32 × 2 = 64 bytes`
- Wire packet rate ≈ 1500 fps per direction
- Server mix tick (`mix_interval_us_`) is derived from `audio_frames_`,
  so the broadcast cadence stays locked to the wire frame size.

When Opus support is enabled (codec=1), libopus's minimum frame size of
120 samples (2.5 ms @ 48 kHz) forces that path back to 120-sample frames;
the PCM16 path stays at 32 samples regardless.

History:

| Release | Samples | Duration | PCM16 bytes | Reason |
|---------|---------|----------|-------------|--------|
| v3.x    | 240     | 5 ms     | 480         | Original Phase A baseline |
| v4.2.0  | 120     | 2.5 ms   | 240         | Phase B latency optimisation |
| v6.0.0  |  32     | 0.667 ms |  64         | UDP-default native client roadmap |

**Wire-protocol breaking change at v6.0.0:** v6 client must talk to v6
server. The SPA1 magic stays `'SPA1'`; what changes is the canonical
`dataSize` (240 → 64 for PCM16) and the server-side jitter buffer
constants (target 2 → 8, cap 33 → 124, scaled by 120/32 = 3.75× to keep
the ms-equivalent latency floor and burst headroom unchanged).

### Handshake packet

When a browser connects via the WSS audio path (`/mixer-udp`) or a native
client comes up, the first packet it sends is a `codec = 0xFF` handshake
with `dataSize = 0`. The proxy / mixer uses this to register the
`(userId → session)` mapping so subsequent audio packets and the return
broadcast know where to go.

```
SPA1Packet {
    magic     = 0x53415031
    sequence  = 0
    timestamp = 0
    userId    = "roomId:userId"
    codec     = 0xFF
    dataSize  = 0
    reserved  = 0
    payload   = (empty)
}
```

## Audio RTT measurement (zero-bandwidth)

`timestamp` is mirrored by the server, so each broadcast packet a client
receives carries the timestamp of whatever client packet caused that mix
tick. Round-trip latency:

```
RTT_ms = (now_ms_low16 - rxPacket.timestamp) & 0xFFFF
```

EMA-smoothed on the client. Values > 10000 are dropped as outliers. Costs
zero extra bytes (reuses an otherwise idle 16-bit field) and measures the
real audio-path latency, not just signaling RTT.

## Control plane — TCP JSON

The signaling server (TCP :9001) handles room create/join/leave + heartbeat.
The mixer's TCP control channel (port 9002, accessible via WSS to
`/mixer-tcp` for browsers) handles the per-session control flow.

All messages are single-line JSON terminated by `\n`.

### Signaling messages — client → server

#### `CREATE_ROOM`
```json
{ "type": "CREATE_ROOM", "room_id": "ABCD12", "user_id": "user_jane" }
```

#### `JOIN_ROOM`
```json
{ "type": "JOIN_ROOM", "room_id": "ABCD12", "user_id": "user_john" }
```

#### `LEAVE_ROOM`
```json
{ "type": "LEAVE_ROOM", "room_id": "ABCD12", "user_id": "user_john" }
```

#### `HEARTBEAT`
```json
{ "type": "HEARTBEAT", "user_id": "user_jane" }
```
Browser clients send every 5 s. Native clients send every 30 s. Required
to prevent CF Tunnel idle disconnect on the api.tonel.io path.

### Signaling messages — server → client

#### `CREATE_ROOM_ACK`, `JOIN_ROOM_ACK`
```json
{ "type": "CREATE_ROOM_ACK", "room_id": "ABCD12", "user_id": "user_jane", "success": true }
```

#### `PEER_LIST` / `PEER_JOINED` / `PEER_LEFT`
Currently broadcast by the signaling server but **not used by the production
clients for audio transport** — the architecture is mixer-only, so peer
addresses don't need to be exchanged for direct connection. Clients use the
peer list only for UI (showing who's in the room).

#### `ERROR`
```json
{ "type": "ERROR", "room_id": "ABCD12", "user_id": "user_john", "message": "Room is full" }
```

#### `SESSION_REPLACED`
Sent when a duplicate `userId` joins (typically: same user opening a second
tab / device). The earlier session is cleanly evicted; clients route the
user back to the home page with a notice.

### Mixer control messages — client → mixer (via /mixer-tcp)

#### `MIXER_JOIN`
```json
{ "type": "MIXER_JOIN", "room_id": "ABCD12", "user_id": "user_jane" }
```
Sent immediately after both /mixer-tcp and /mixer-udp WSS sockets are open
(or the WT session is up). Server replies with `MIXER_JOIN_ACK` containing
the current per-user tuning (`jitter_target`, `jitter_max_depth`).

#### `PING`
```json
{ "type": "PING" }
```
Sent every 3 s. Server replies with `PONG`. Used to measure control-channel
RTT for the in-room latency display.

#### `MIXER_TUNE`
```json
{ "type": "MIXER_TUNE", "user_id": "user_jane", "jitter_target": 2, "jitter_max_depth": 33 }
```
Sent from the in-room debug panel when the user drags the jitter sliders.
Server clamps + applies + acks.

#### `PEER_GAIN`
```json
{ "type": "PEER_GAIN", "user_id": "user_jane", "peer_id": "user_bob", "gain": 0.8 }
```
Per-listener gain on a specific peer's track in the mix.

### Mixer messages — mixer → client (via /mixer-tcp)

| Type | Notes |
|---|---|
| `MIXER_JOIN_ACK` | Includes `jitter_target`, `jitter_max_depth` defaults |
| `PONG` | Reply to `PING` |
| `MIXER_TUNE_ACK` | Reply to `MIXER_TUNE` (clamped values) |
| `LEVELS` | `{type:"LEVELS", levels:{user_id: 0.0–1.0, ...}}` — broadcast at ~20 Hz |
| `SESSION_REPLACED` | Same semantics as signaling-server's |

## Transport architecture

```
┌───────────────────┐    JSON over TCP/WSS    ┌──────────────────┐
│   Web client      │◄──────────────────────►│  signaling_server │
│   (tonel.io)      │   wss://api.tonel.io   │  :9001            │
│                   │                         └──────────────────┘
│   Tonel-MacOS     │
│   (native macOS)  │
└─────────┬─────────┘
          │  SPA1 binary frames (every 0.667 ms — v6.0.0)
          │
          │   wss://srv.tonel.io/mixer-tcp  (control)
          │   wss://srv.tonel.io/mixer-udp  (audio)  ─── browser
          │   raw TCP :9002, raw UDP :9003           ─── native
          ▼
   ┌─────────────────────────────────────┐
   │           mixer_server               │
   │   per 0.667 ms tick:                 │
   │     for each user U:                 │
   │       broadcast(N−1 mix excluding U) │
   └─────────────────────────────────────┘
```

There is no P2P / mesh / direct-client mode. The topology is always a star
through the mixer.

## Version history

| Version | Header size | Notes |
|---|---|---|
| v1.0 | 44 bytes | Initial 32-byte userId |
| v1.0a | 44 bytes | Added type + level fields (later removed) |
| **P1-1** | **76 bytes** | userId expanded to 64 bytes; type/level removed; level moved to JSON `LEVELS` message |
| P1-2 | 76 bytes | `timestamp` repurposed for RTT measurement (server echo) |

## Implementation references

- **Server**: `server/src/mixer_server.h` — `struct SPA1Packet` declaration
- **Server**: `server/src/mixer_server.cpp` — packet handling, mix tick, broadcast
- **Web**: `web/src/services/audioService.ts` — `buildSpa1Packet()`, `parseSpa1Header()`
- **Native**: `Tonel-MacOS/TonelMacOS/` — Swift packing
- **WSS proxy**: `server/proxy/ws-mixer-proxy.js` — wraps TCP :9002 + UDP :9003 for browser
- **WT proxy**: `wt-mixer-proxy/` (Go) — WebTransport bridge for `/new` path

### Constants

```
SPA1_MAGIC          = 0x53415031
SPA1_HEADER_SIZE    = 76         // (P1-1)
SPA1_CODEC_PCM16    = 0x00
SPA1_CODEC_OPUS     = 0x01
SPA1_CODEC_HANDSHAKE= 0xFF
MAX_PAYLOAD_SIZE    = 1356       // dataSize cap, prevents memory overflow
```
