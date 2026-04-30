# Tonel for macOS (a.k.a. "macos app")

A from-scratch SwiftUI rebuild of the Tonel desktop client, replacing the legacy
ObjC++ `Tonel-Desktop-AppKit/`. Functional parity targets the **web client room
UI/interaction/audio**; transport follows **scheme A** (PCM16 / UDP direct to
酷番云 v5).

* macOS 14+, Swift 5.10, SwiftUI
* Pure Swift networking (Network.framework) and audio (AVFoundation /
  Core Audio)
* Server: 42.240.163.172 (Kufan v5), TCP:9002 control, UDP:9003 audio
* Signaling: `wss://api.tonel.io/signaling`
* Audio wire: PCM16 LE, mono, 48 kHz, **120 samples / 2.5 ms / 240-byte payload**,
  76-byte SPA1 header — bit-exact match with the web client (`audioService.ts`)
* Login: phone-number stub (mirrors web `LoginPage.tsx` — no real OTP yet)

## Build

```bash
brew install xcodegen          # one-time
cd Git/Tonel-MacOS
xcodegen generate
open TonelMacOS.xcodeproj
```

`Cmd+R` to build & run.

## Layout

```
TonelMacOS/
  App/        @main app, AppState (top-level glue)
  Audio/      AudioEngine, JitterBuffer, SPA1Packet
  Network/    SignalClient, MixerClient, Endpoints
  Models/     Peer, Room
  Views/      LoginView, HomeView, RoomView, ChannelStripView, LedMeterView
  Resources/  Info.plist, Assets
```

## Why a new project

The legacy `Tonel-Desktop-AppKit/` is kept as historical reference — see its
README. New work happens here.

## Status

First-cut skeleton. See repo `CHANGELOG.md` once a release is cut.
