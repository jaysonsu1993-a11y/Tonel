# Tonel for Windows

The native WPF + .NET 8 desktop client for Tonel — feature-parity port of
[`Tonel-MacOS`](../Tonel-MacOS) at **v6.5.1**. Built on **WASAPI Exclusive**
for the lowest-latency audio path Windows offers.

## Tech stack & licensing

100% MIT, free for commercial use:

| Component             | License                      |
| --------------------- | ---------------------------- |
| .NET 8                | MIT (Microsoft)              |
| WPF                   | MIT (Microsoft)              |
| NAudio 2.2.1          | MIT                          |
| WASAPI / Winsock      | Windows SDK (free)           |

No GPL / LGPL / commercial-only dependencies.

## Audio architecture

* **Wire format** — bit-exact match with macOS / web / mixer **at v6.0.0+**:
  PCM16 LE mono, **48 kHz**, **32-sample / 0.667 ms / 64-byte frames**,
  76-byte SPA1 header. (Frame size dropped from 120 → 32 in v6.0.0; jitter
  defaults raised to target=8 / cap=124 frames to keep ms-equivalent
  burst absorption.)
* **Capture** — WASAPI Exclusive event-driven via the `WasapiExclusiveCapture`
  helper (NAudio's built-in `WasapiCapture` is Shared-only). Format
  negotiated against device's `IsFormatSupported`; multi-channel + 24/32-bit
  hardware folded to mono in software.
* **Playback** — `WasapiOut` Exclusive event-driven, 3 ms requested latency.
* **Servers / transports** — multi-server picker in Settings:
  - 广州1 = Aliyun (8.163.21.207) — only fully-online location
  - 广州2 = 酷番云 — placeholder (greyed out; IDC ban pending resolution)

  Three transport modes — **all implemented** ✅:
  - **UDP** (direct UDP to mixer, lowest latency) — `MixerClient.cs`
  - **WS** (plain `ws://host:9005` to mixer-proxy, TCP fallback) — `WSMixerClient.cs`
  - **P2P** (UDP peer-to-peer mesh with hole-punch, v6.5+) — `P2PMixerClient.cs`

  Selection: *设置 → 服务器与传输模式*. Switching is explicit (no auto-
  fallback by design); a connection failure surfaces as an error and the
  user picks another mode.

* **Signaling** — `wss://api.tonel.io/signaling`.

## Identity model (v6.2.0+)

No login, no home page. App boots straight into a room.

* On first launch a persistent `userId` (long opaque) and `myRoomId`
  (6-character `[2-9A-HJKLMNPQRSTUVWXYZ]`, no 0/1/I/O for verbal-share
  unambiguity) are generated and stored in
  `%LOCALAPPDATA%\Tonel\identity.json`.
* The user's last-used room is sticky (`currentRoomId` in the same file).
  Re-launches drop you back where you were.
* Reset via *设置 → 重置身份*.
* Server / transport selection lives in `HKCU\Software\Tonel`.

## End-to-end latency target

```
WASAPI Exclusive 采集:  3-5ms
公网单程 (RTT 10ms):     5ms
client jitter (8 fr):    ~5ms
server jitter / mix:     ~6ms
WASAPI Exclusive 播放:   3-5ms
─────────────────────────────
总计:                   22-26ms
```

Tune jitter knobs live via the **3-tap on room id** debug sheet.

## Build

### Dev (F5 from IDE)

Open `Tonel-Windows.sln` in Visual Studio 2022 (17.8+) or Rider. F5 to run.
Or from a shell:

```powershell
cd Tonel-Windows
dotnet build -c Debug
dotnet run --project TonelWindows
```

### Installer (production distribution)

We ship as a self-contained single-file installer built with **Inno Setup**
(free for commercial use). The whole pipeline is one PowerShell command:

```powershell
# Prerequisites:
#   .NET 8 SDK            https://dot.net
#   Inno Setup 6.2+       https://jrsoftware.org/isdl.php
#                         (or set $env:INNO to ISCC.exe)

cd Tonel-Windows
powershell -ExecutionPolicy Bypass -File installer\build.ps1 -Version 6.5.11
# → installer\output\Tonel-Windows-v6.5.11.exe   (~50 MB)
```

The `-Version` flag aligns the installer's `AppVersion` (and the
output filename) with the global repo version. Without it,
`build.ps1` falls back to the `<Version>` in the `.csproj` (which
is pinned at `0.1.0` for local dev — see history of v6.5.4 ~
v6.5.11 in the root CHANGELOG for why).

What it does:
1. `dotnet publish -c Release` → produces a self-contained
   `Tonel.exe` with .NET 8 runtime + ReadyToRun pre-jit baked in.
2. Runs `ISCC.exe Tonel.iss` → wraps it into a one-click setup.exe.

The installer:
* Installs to `%LOCALAPPDATA%\Programs\Tonel\` by default (no admin
  required — `PrivilegesRequired=lowest`). Admin install is offered if
  the user wants it system-wide.
* Creates Start Menu + (opt-in) Desktop shortcuts.
* Registers an uninstaller in *添加或删除程序*.
* Leaves user data (`%LOCALAPPDATA%\Tonel\identity.json`,
  `HKCU\Software\Tonel`) untouched on uninstall — Windows convention.
  Use *设置 → 重置身份* in-app to wipe identity explicitly.
* Min Windows version: Windows 10 1809 (build 17763) — the WASAPI
  low-latency event-driven path is what we depend on; older builds
  don't have the same minimum-period guarantees.

### CI (GitHub Actions)

[`.github/workflows/build-installer.yml`](../.github/workflows/build-installer.yml)
runs on every PR (artifact only) and every `v*` tag push (artifact +
GitHub Release asset + Cloudflare R2 push). Free `windows-latest`
runner; Inno Setup 6 either preinstalled or `choco install`-ed at
runtime.

To cut a release:
```bash
git tag v6.5.X && git push origin v6.5.X
```

The workflow runs ~3 min and produces three things:

1. **Workflow artifact** — accessible from the Actions UI.
2. **GitHub Release asset** — at
   `https://github.com/<owner>/Tonel/releases/tag/v6.5.X` with
   `Tonel-Windows-v6.5.X.exe` attached. Requires
   `permissions: contents: write` (granted at the workflow level
   so the elevated token only applies to this workflow — see
   the workflow file's top-level `permissions:` block).
3. **Cloudflare R2 upload** — pushes both the versioned
   filename and a `Tonel-Windows-latest.exe` alias to the
   `tonel-downloads` bucket. Public URL:
   `https://download.tonel.io/Tonel-Windows-latest.exe`. Requires
   the `CLOUDFLARE_API_TOKEN` repo Actions secret with
   *Workers R2 Storage: Edit* permission.

The `Tonel-Windows-latest.exe` URL is what
[tonel.io](https://tonel.io)'s "⊞ Windows" home-page button
points at, so a successful tag push automatically makes the new
build downloadable from the home page.

### Code signing (recommended before public distribution)

Without a signature, SmartScreen and Defender will warn users on first
run. Once you have a `.pfx` cert from DigiCert / Sectigo / etc.:

```powershell
.\installer\build.ps1 -Sign C:\path\to\tonel.pfx -SignPassword "..."
```

In CI, store the cert as a base-64 secret (`CODE_SIGN_CERT_B64`) and the
password (`CODE_SIGN_PASSWORD`); the workflow can be extended to decode
it into a temp `.pfx` before invoking `build.ps1 -Sign`.

## Layout

```
Tonel-Windows/
  Tonel-Windows.sln
  TonelWindows/
    App/        AppEntry, AppState (auto-bootstrap), Identity, UserPrefs, Logger
    Audio/      AudioEngine, JitterBuffer, SPA1Packet, WasapiExclusiveCapture
    Network/    SignalClient, IMixerTransport, Endpoints,
                MixerClient (UDP), WSMixerClient (WS), P2PMixerClient (P2P)
    Models/     PeerVM, PeerInfo
    Views/      MainWindow, RoomView, ChannelStripView, InputChannelStripView,
                LedMeterView, VerticalFader, SettingsSheet, AudioDebugSheet,
                SwitchRoomSheet
    Resources/  app.manifest (DPI-aware, Win10/11)
  installer/
    Tonel.iss            Inno Setup script
    build.ps1            publish + iscc one-shot
    output/              Tonel-Setup-X.Y.Z.exe lands here (gitignored)
```

## Branching & versioning

Day-to-day work goes on the **`tonel-windows`** branch (parallel to
`tonel-macos`). Don't push version-bumping commits to `main` without going
through the standard release flow described in `/Tonel-MacOS/README.md`.

## Known limitations

* **No Opus** — only PCM16 codec wired up (handshake decoded but not
  Opus payload). Same scope as macOS client.
* **Single capture channel** — multi-channel mixing on the client side is
  UI-only (matches macOS).
* **No HW buffer override picker** — WASAPI Exclusive event mode commits
  to the device-period at init; macOS exposes this via CoreAudio HAL but
  on Windows it's effectively fixed by the driver.
