# Tonel

**Low-latency real-time online band rehearsal platform.**

## Goal

Everything in this project is optimized for one thing: **ultra-low latency
audio**. End-to-end target on a Chinese intra-province network is **30 ms**
mouth-to-ear. Every design decision — protocol layout, codec choice, jitter
buffer depth, server tick interval — serves that goal.

## Modules

| Module | Path | Description |
|---|---|---|
| **Server** | `server/` | C++ signaling server (TCP, room management) + mixer server (UDP, server-side audio mixing). Built with libuv + Opus + nlohmann/json. |
| **Web client** | `web/` | React + TypeScript + AudioWorklet. Served on `tonel.io` via Cloudflare Pages. |
| **Desktop client** | `Tonel-MacOS/` | Native SwiftUI macOS client. The only desktop client. |
| **Deploy + ops** | `deploy/`, `ops/` | Production deployment scripts and nginx / cloudflared / pm2 configs. |
| **Libraries** | `libs/` | Third-party deps (miniaudio etc.). |
| **Docs** | `docs/` | Architecture, SPA1 protocol spec, development + release flow. |

## Quick start

```bash
# Server (signaling + mixer, native ELF)
brew install libuv opus nlohmann-json
cd server
cmake -S . -B build && cmake --build build
# → build/signaling_server, build/mixer_server

# Web client (dev server)
brew install node
cd web
npm install && npm run dev

# Desktop client
cd Tonel-MacOS
open TonelMacOS.xcodeproj
```

## Architecture in one paragraph

All audio runs through a **server-side mixer** — every client sends its mic to
the server, the server mixes everyone in the room minus the sender, and sends
each client a single back-stream. No P2P, no mesh; the topology is always a
star. The server is at **酷番云广州 (42.240.163.172)**, primary since v5.0.0.
A second box at Aliyun runs the same code and serves the `tonel.io/new`
fallback path. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
network diagram, port map, and DNS layout.

The wire protocol is **SPA1** (Simple Protocol for Audio v1) — a 76-byte
binary header followed by PCM16 or Opus payload. Full spec at
[docs/SPA1_PROTOCOL.md](docs/SPA1_PROTOCOL.md).

## Versioning

Single source of truth lives in the root `CMakeLists.txt`. Use
`scripts/bump-version.sh <version>` to sync to the other manifests
(`server/CMakeLists.txt`, `web/package.json`, `config.schema.json`). Releases
go through `scripts/release.sh <version>` — see
[docs/RELEASE.md](docs/RELEASE.md). `main` rejects bare commits; every commit
on `main` is a `release: vX.Y.Z`.

## License

Server and SPA1 protocol are MIT-licensed. See per-module files for details.
