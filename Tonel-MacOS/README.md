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
cd Tonel-MacOS
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

## Branching & versioning

The macOS client iterates on its own cadence — too fast for the
`release: vX.Y.Z` discipline that lives on `main`. Day-to-day work
happens on the long-lived **`tonel-macos`** branch, which forks from
`main` and gets folded back periodically.

```
main        ── v5.0.4 ─────── v5.x.y (next umbrella release)
                  │
                  └─ tonel-macos ── small commits, free-form, app-only
```

* **Day-to-day:** commit on `tonel-macos`, push to `origin/tonel-macos`.
  No version bump or CHANGELOG required for individual commits.
* **App-only "small release"**: bump `Tonel-MacOS/project.yml`'s
  `MARKETING_VERSION` (e.g. 0.1.x → 0.1.x+1). Independent from the
  umbrella `vX.Y.Z` on main; tag as `macos-0.1.x` if you want a
  marker, but no CHANGELOG entry is required until the merge.
* **When app changes ride along with a `main` release** (or affect
  web/server): merge `tonel-macos` → `main`, then run the standard
  pipeline — bump umbrella version, write `CHANGELOG.md` entry,
  commit as `release: vX.Y.Z`, tag, push. The pre-push hook
  (`scripts/hooks/pre-push`) blocks any non-`release:` commit
  on main; install with `scripts/install-hooks.sh` once per clone.
* **Pulling main back into `tonel-macos`**: `git merge main` — keeps
  app branch current with infra fixes shipped on main.

## Status

First-cut skeleton. See repo `CHANGELOG.md` for v5.0.x notes.
