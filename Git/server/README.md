# S1 Server

C++ low-latency signaling and audio mixing servers for Tonel.

## Overview

Two server components run on the same machine:

| Component | Port | Protocol | Description |
|---|---|---|---|
| **signaling_server** | 9001 | TCP JSON | Room management, P2P SDP exchange, heartbeat |
| **mixer_server** | 9002 (TCP) + 9003 (UDP) | TCP JSON + UDP SPA1 | Audio mixing, SPA1 packet routing |

## Dependencies

| Library | Purpose | Install (macOS) | Install (Ubuntu) |
|---|---|---|---|
| [libuv](https://libuv.org) | Async event loop | `brew install libuv` | `apt install libuv1-dev` |
| [Opus](https://opus-codec.org) | Audio codec | `brew install opus` | `apt install libopus-dev` |
| [nlohmann/json](https://github.com/nlohmann/json) | JSON parsing | `brew install nlohmann-json` | `apt install nlohmann-json3-dev` |
| **CMake** >= 3.14 | Build system | `brew install cmake` | `apt install cmake` |

## Build

```bash
cd Git/server
cmake -S . -B build && cmake --build build
```

Output binaries:
- `build/signaling_server`
- `build/mixer_server`

Binaries are also copied to `../bin/` for convenience.

## Run

### Signaling Server

```bash
./build/signaling_server
# Listens on TCP port 9001
```

### Mixer Server

```bash
./build/mixer_server
# TCP control on port 9002, UDP audio on port 9003
```

Both servers use libuv for event-driven I/O and can run concurrently on the same machine.

## Protocol

### Signaling (TCP JSON)

Text messages, `\n` delimited. Supports: `CREATE_ROOM`, `JOIN_ROOM`, `LEAVE_ROOM`, `PEER_JOINED`, `PEER_LEFT`, `HEARTBEAT`, `P2P_OFFER/ANSWER/ICE`. See [docs/SPA1_PROTOCOL.md](../docs/SPA1_PROTOCOL.md) for full message format.

### Mixer (TCP + UDP)

- **TCP control** (port 9002): `MIXER_JOIN`, `MIXER_LEAVE` messages
- **UDP audio** (port 9003): SPA1 binary packets (44-byte header + audio payload)

## Deployment

### Alibaba Cloud Deployment

```bash
# Copy binaries to server
scp -i <your-key> build/signaling_server root@<server-ip>:~/s1/
scp -i <your-key> build/mixer_server   root@<server-ip>:~/s1/

# SSH in and run
ssh -i <your-key> root@<server-ip>
cd ~/s1
# Start signaling server
nohup ./signaling_server > signaling.log 2>&1 &
# Start mixer server
nohup ./mixer_server > mixer.log 2>&1 &
```

### Web Proxy

The web client connects through WebSocket proxies:
- `ws-proxy.js` -- bridges WebSocket to TCP signaling (port 9001)
- `ws-mixer-proxy.js` -- bridges WebSocket to UDP mixer (port 9003)

Run on the server:

```bash
node ws-proxy.js 9004 127.0.0.1 9001
node ws-mixer-proxy.js
```

## Configuration

Server ports are compiled-in defaults. Override via config file if needed:

```json
{
  "signalingPort": 9001,
  "mixerPort": 9002,
  "mixerUdpPort": 9003
}
```

## Source Structure

```
server/src/
├── main.cpp                 # Signaling server entry point
├── signaling_server.h/.cpp  # TCP signaling server
├── room.h/.cpp              # Room management
├── user.h/.cpp              # User/session management
├── config.h/.cpp            # Server configuration
├── audio_mixer.h/.cpp       # Audio mixing engine
├── mixer_server.h/.cpp      # Mixer server (TCP + UDP)
├── AudioRecorder.h/.cpp     # Server-side audio recording
└── mixer_server_test.cpp    # Mixer server tests
```
