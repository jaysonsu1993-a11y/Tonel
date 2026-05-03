# Tonel Server

C++ low-latency signaling and audio mixing servers. Two binaries:

| Binary | Port | Description |
|---|---|---|
| `signaling_server` | 9001 (TCP JSON) | Room management, peer-list broadcast, heartbeat |
| `mixer_server` | 9002 (TCP) + 9003 (UDP) | Server-side N−1 mixing, SPA1 packet routing |

## Build (locally for dev)

```bash
cd server
cmake -S . -B build && cmake --build build
# → build/signaling_server, build/mixer_server
```

Dependencies (macOS):
```bash
brew install libuv opus nlohmann-json cmake
```

For production deploy, the build runs in a Linux container — see
[`.docker/Dockerfile`](.docker/Dockerfile) and [`../deploy/server.sh`](../deploy/server.sh).
Production hosts no longer need a C++ toolchain.

## Source layout

```
src/
├── main.cpp                 — signaling_server entry
├── signaling_server.h/.cpp  — TCP signaling
├── room.h/.cpp              — room state
├── user.h/.cpp              — session state
├── config.h/.cpp            — runtime config
├── audio_mixer.h/.cpp       — mixing engine
├── mixer_server.h/.cpp      — mixer entry (TCP + UDP)
├── AudioRecorder.h/.cpp     — server-side recording
└── mixer_server_test.cpp    — unit tests (run via mixer_server --test)
```

## See also

- [`../docs/SPA1_PROTOCOL.md`](../docs/SPA1_PROTOCOL.md) — wire-format spec (76-byte P1-1 header)
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — topology, port map, DNS, client connection points
- [`../deploy/README.md`](../deploy/README.md) — production deploy & ops
- [`test/`](test/) — Layer 1/1.5/integration test suites (driven by `../scripts/pretest.sh`)
