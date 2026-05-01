# Tonel-Desktop-AppKit (Current)

> **当前主力版本** — 生产环境唯一推荐的桌面客户端。

Native macOS desktop client for Tonel, built with AppKit and miniaudio.

## Overview

The AppKit client is the **recommended** desktop build. It uses only MIT-licensed dependencies (AppKit + miniaudio), so there are zero licensing risks for commercial or closed-source use.

## Tech Stack

- **UI**: AppKit (Apple native, C/Objective-C++)
- **Audio**: [miniaudio](https://miniaud.io) (single-header, MIT)
- **Codecs**: Opus (for compressed audio transport)
- **Network**: BSD sockets, SPA1 protocol
- **Build**: CMake >= 3.21

## Dependencies

Install system dependencies:

```bash
brew install opus
```

No other system libraries required. miniaudio is included in `libs/miniaudio/`.

## Build

```bash
cd Tonel-Desktop-AppKit
cmake -S . -B build && cmake --build build
```

The output app bundle is at `build/BandRehearsal.app`.

## Architecture

```
Tonel-Desktop-AppKit/src/
├── main.mm                    # Entry point
├── AppDelegate.h / .mm        # App lifecycle
├── MainWindowController.h/.mm # Main window management
├── AppState.h / .mm           # Shared application state
├── bridge/
│   ├── AudioBridge.h / .mm    # Audio device capture/playback (miniaudio)
│   ├── MixerBridge.h / .mm    # Mixer server transport (TCP control + UDP SPA1 audio)
│   ├── NetworkBridge.h / .mm  # Signaling bridge (ObjC wrapper)
│   └── S1SignalingClient.mm   # WebSocket signaling client
└── ui/
    ├── HomeViewController.h/.mm        # Home screen
    ├── CreateRoomViewController.h/.mm  # Create room form
    ├── JoinRoomViewController.h/.mm    # Join room form
    ├── RoomViewController.h/.mm        # Room view (active session)
    ├── SettingsViewController.h/.mm    # Settings
    └── S1RoundedButton.h/.mm           # Custom UI component
```

## Audio Transport

The client uses the **Mixer mode** for audio transport:

1. After creating/joining a room, `MixerBridge` connects to the mixer server (TCP:9002 for control, UDP:9003 for audio)
2. Sends `MIXER_JOIN` via TCP, receives `MIXER_JOIN_ACK` with UDP port
3. Sends SPA1 HANDSHAKE packet via UDP to register the client's address
4. `AudioBridge` captures mic audio (stereo f32 48kHz), converts to mono PCM16, accumulates 240 samples (5ms), and sends as SPA1 packets via UDP
5. Server mixes all participants' audio and returns mixed SPA1 packets via UDP
6. `AudioBridge` reads mixed audio from a lock-free ring buffer and plays it through speakers

```
Mic → AudioBridge → stereo f32 → mono PCM16 → SPA1 packet → UDP → Mixer Server
                                                                        ↓ (mix)
Speaker ← AudioBridge ← mono float ← ring buffer ← SPA1 packet ← UDP ←┘
```

When not connected to the mixer (e.g. before joining a room), AudioBridge falls back to local loopback mode.

## Historical Note

- **Previous name**: `S1-Desktop-AppKit` (renamed during S1 → Tonel migration)
- **File prefixes**: Some files still have `S1` prefix (e.g., `S1RoundedButton`) — historical legacy, does not affect functionality.

## Related Clients

| Directory | Status | When to Use |
|-----------|--------|-------------|
| **Tonel-Desktop-AppKit** | **Current** | Production builds, commercial use |
| [Tonel-Desktop](../Tonel-Desktop/) | Legacy | Reference only (JUCE implementation) |

## Configuration

The SPA1 protocol header is at `Tonel-Desktop/spa1.h`. See `docs/SPA1_PROTOCOL.md` for the protocol specification.

## macOS Deployment Target

Minimum: **macOS 12.0 (Monterey)**.

## Licensing

| Dependency | License | Commercial Use |
|---|---|---|
| AppKit (Apple) | MIT | Yes, free |
| miniaudio | MIT (Dual-licensed) | Yes, free |
| Opus | BSD | Yes, free |

**Zero GPLv3 or commercial license requirements.** This is the recommended build for all use cases.
