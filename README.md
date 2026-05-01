# Tonel

**Low-latency real-time online band rehearsal platform.**

## Goal

Everything in this project is optimized for one thing: **ultra-low latency audio**.
Every design decision, protocol choice, and codec selection serves this goal.
Users in different locations can rehearse together in real time as if they were in the same room.

## Quick Start

### Prerequisites

| Module | Required | Install (macOS) |
|---|---|---|
| **Desktop (AppKit)** | CMake >= 3.21, Opus | `brew install opus` |
| **Server** | libuv, Opus, nlohmann/json | `brew install libuv opus nlohmann-json` |
| **Web** | Node.js >= 18 | `brew install node` |

### Build

Each module has its own build system. Choose what you need:

```bash
# Desktop app (AppKit + miniaudio -- recommended, no JUCE dependency)
cd Tonel-Desktop-AppKit
cmake -S . -B build && cmake --build build

# Desktop app (Legacy JUCE client -- requires JUCE license)
cd Tonel-Desktop
cmake -S . -B build -DJUCE_PATH=/path/to/JUCE && cmake --build build

# Server (signaling + mixer)
cd server
cmake -S . -B build && cmake --build build
# Outputs: build/signaling_server, build/mixer_server

# Web client
cd web
npm install && npm run dev
```

## Architecture

S1 supports two audio transport modes:

| Mode | People | Transport | Topology |
|---|---|---|---|
| **P2P** | 2-4 | UDP direct | Mesh |
| **Mixer** | 5+ or P2P unavailable | Server-mediated | Star |

```
              Clients                        Servers
        ┌──────────────┐              ┌──────────────────┐
        │  Desktop     │<─ TCP ──────>│  Signaling Server│
        │  (AppKit /   │  (JSON)      │  (port 9001)     │
        │   Web)       │              └────────┬─────────┘
        └─────┬────────┘                       │
              │                                │
              │  Desktop: UDP direct           │
              │  Web: WebRTC DataChannel       │
              │         (DTLS/SCTP)            │
        ┌─────┴────────┐              ┌────────┴─────────┐
        │  Client B    │<── audio ──>│  Mixer Server    │
        │              │             │  (port 9002/9003)│
        └──────────────┘              └──────────────────┘
```

**Protocol:** SPA1 (Simple Protocol for Audio v1) -- custom 44-byte header binary protocol. See [docs/SPA1_PROTOCOL.md](docs/SPA1_PROTOCOL.md) for full specification.

## Modules

| Module | Path | Status | Description |
|---|---|---|---|
| **Desktop (AppKit)** | `Tonel-Desktop-AppKit/` | Active | Native macOS client, AppKit + miniaudio. Zero license risk (MIT-only). Recommended build. |
| **Desktop (JUCE)** | `Tonel-Desktop/` | Legacy | Original JUCE-based client. Audio logic is correct and serves as implementation reference. Requires JUCE commercial/GPLv3 license. |
| **Server** | `server/` | Active | C++ signaling server (TCP/JSON room management) + mixer server (UDP audio mixing). Deployed on Alibaba Cloud. |
| **Web** | `web/` | Active | React + TypeScript web client. Signaling via WebSocket (CF Tunnel), mixer audio via WebRTC DataChannel (direct DTLS to server). |
| **Libraries** | `libs/` | -- | miniaudio (MIT), other third-party deps. |
| **Docs** | `docs/` | -- | Protocol specs, architecture, development guides. |

## Editions

免费版 (Mini) 与付费版 (Pro) 的核心区别在于**音质**和**多轨录音**功能。两个版本都追求行业最低延迟。

| 特性 | Tonel-Mini (免费) | Tonel-Pro (付费) |
|---|---|---|
| **音频引擎** | miniaudio (MIT) | JUCE 框架 (GPLv3) |
| **许可模式** | 闭源商用 (零风险) | 开源发布 (GPLv3) |
| **音质** | 标准 | 高保真 / 无损 |
| **延迟** | 极低 (优化级) | 极低 (优化级) |
| **录音** | 不支持 | 多轨录音 |
| **服务端处理** | 纯混音 | 混音 + 实时处理 (规划中) |

> **巧妙的设计：** Pro 版通过 GPLv3 协议开源，正好与 JUCE 的 GPL 许可条款匹配，**免去了 JUCE 昂贵的商业授权费**。社区开发者可以参与共建。Mini 版基于 miniaudio (MIT 许可证)，可以安全地进行**闭源商业分发**，完全免费。

## Versioning

This project uses [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH). See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for details.

## License

The SPA1 audio protocol and server code use permissive licensing. See individual module files for details.
