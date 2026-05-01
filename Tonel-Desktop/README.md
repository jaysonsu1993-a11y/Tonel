# Tonel-Desktop — JUCE Desktop Client

> **LEGACY / 参考实现** — 不再维护。生产环境请使用 `Tonel-Desktop-AppKit`。

This module uses the JUCE framework, which requires a GPLv3 open-source license or a paid commercial license. The audio logic is correct and serves as implementation reference.

## Historical Note

This was the **original** desktop client for the S1 project. It contains the first working implementations of:
- Audio routing and device management
- SPA1 protocol encoding/decoding
- P2P mesh management
- Opus codec integration
- STUN/NAT traversal

When the project was renamed from S1 to Tonel, this directory was kept as a reference archive. All active development moved to `Tonel-Desktop-AppKit` (AppKit + miniaudio) to eliminate the JUCE licensing burden.

## Related Clients

| Directory | Status | When to Use |
|-----------|--------|-------------|
| [Tonel-Desktop-AppKit](../Tonel-Desktop-AppKit/) | **Current** | Production builds |
| **Tonel-Desktop** | Legacy | Reference only |

## Dependencies

- JUCE (set `JUCE_PATH` environment variable)
- Opus
- CMake >= 3.21

## Build

```bash
export JUCE_PATH=/path/to/JUCE

mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

## S1-Mini Mode (miniaudio backend)

```bash
cmake .. -DS1_MINI_MODE=ON
# Also requires miniaudio (libs/miniaudio/)
```

## Directory Structure

```
Tonel-Desktop/
├── CMakeLists.txt
├── spa1.h              # Copied from S1-Protocol (do not modify here)
├── README.md           # This file
└── src/
    ├── main.cpp
    ├── audio/
    │   ├── AudioDeviceManager.cpp
    │   ├── AudioDeviceManager.h
    │   ├── AudioEngine.h
    │   ├── JuceAudioEngine.cpp
    │   ├── JuceAudioEngine.h
    │   ├── MiniaudioEngine.cpp     # S1-MINI_MODE only
    │   ├── MiniaudioEngine.h
    │   ├── OpusCodec.cpp
    │   └── OpusCodec.h
    ├── network/
    │   ├── AudioRouter.cpp
    │   ├── AudioRouter.h
    │   ├── MixerServerConnection.cpp
    │   ├── MixerServerConnection.h
    │   ├── NetworkSocket.cpp
    │   ├── NetworkSocket.h
    │   ├── P2PMeshManager.cpp
    │   ├── P2PMeshManager.h
    │   ├── SignalingClient.cpp
    │   ├── SignalingClient.h
    │   ├── StunClient.cpp
    │   └── StunClient.h
    └── ui/
        ├── AppState.cpp
        ├── AppState.h
        ├── HomeView.cpp
        ├── HomeView.h
        ├── MainComponent.h
        ├── RoomView.cpp
        ├── RoomView.h
        ├── SettingsView.cpp
        └── SettingsView.h
```

## Configuration

Server addresses are configured via the Settings UI. Default fallback is `127.0.0.1:9002`.

## Protocol

Uses **SPA1** (Simple Protocol for Audio v1) — see `../S1-Protocol/spa1.h`.
