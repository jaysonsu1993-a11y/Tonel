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
cd Git/Tonel-Desktop-AppKit
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
│   ├── NetworkBridge.h / .mm  # SPA1 packet send/receive
│   └── S1SignalingClient.cpp  # TCP signaling client (JSON)
└── ui/
    ├── HomeViewController.h/.mm        # Home screen
    ├── CreateRoomViewController.h/.mm  # Create room form
    ├── JoinRoomViewController.h/.mm    # Join room form
    ├── RoomViewController.h/.mm        # Room view (active session)
    ├── SettingsViewController.h/.mm    # Settings
    └── S1RoundedButton.h/.mm           # Custom UI component
```

## Historical Note

- **Previous name**: `S1-Desktop-AppKit` (renamed during S1 → Tonel migration)
- **File prefixes**: Some files still have `S1` prefix (e.g., `S1RoundedButton`) — historical legacy, does not affect functionality.

## Related Clients

| Directory | Status | When to Use |
|-----------|--------|-------------|
| **Tonel-Desktop-AppKit** | **Current** | Production builds, commercial use |
| [Tonel-Desktop](../Tonel-Desktop/) | Legacy | Reference only (JUCE implementation) |

## Configuration

The SPA1 protocol header is at `Git/Tonel-Desktop/spa1.h`. See `docs/SPA1_PROTOCOL.md` for the protocol specification.

## macOS Deployment Target

Minimum: **macOS 12.0 (Monterey)**.

## Licensing

| Dependency | License | Commercial Use |
|---|---|---|
| AppKit (Apple) | MIT | Yes, free |
| miniaudio | MIT (Dual-licensed) | Yes, free |
| Opus | BSD | Yes, free |

**Zero GPLv3 or commercial license requirements.** This is the recommended build for all use cases.
