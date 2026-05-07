# Changelog

All notable changes to this project will be documented in this file.

> **Notes:**
> - **2026-05-02:** Entries before v4.0.0 archived to [`CHANGELOG-archive.md`](CHANGELOG-archive.md) to keep this file readable. The cut point is the start of the v4.x latency-optimization era.
> - **2026-05-01:** The repo was flattened — `Git/` prefix removed. Paths in entries below dated before this change still reference `Git/X`; read those as `X` (e.g. `Git/server/src/...` → `server/src/...`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.5.11] - 2026-05-07

### Fixed — R2 push step's path was doubled

v6.5.10 finally produced a valid Windows installer + GitHub
Release, but the R2 push step errored with:

```
Cannot find path 'D:\a\Tonel\Tonel\Tonel-Windows\Tonel-Windows\installer\output'
```

The workflow has `defaults.run.working-directory: Tonel-Windows`,
so `run:` blocks already start in the subdir. My step then
prepended `Tonel-Windows\` to the path, doubling it.

Subtlety: the same path key is repo-root-relative for the
`actions/upload-artifact@v4` `path:` and `softprops/action-gh-release@v2`
`files:` parameters (those steps don't use `defaults.run.working-directory`
because they aren't `run:` scripts). Different conventions for
the same workflow file — easy mistake.

Fix: drop the `Tonel-Windows\` prefix from the `Get-ChildItem`
in the R2 push step.

### Manual recovery

While waiting for v6.5.11 CI, downloaded
`Tonel-Windows-v6.5.10.exe` from the v6.5.10 GitHub Release and
ran `deploy/upload-r2.sh` locally. As of this commit:

- `https://download.tonel.io/Tonel-Windows-v6.5.10.exe` → live
- `https://download.tonel.io/Tonel-Windows-latest.exe` → live

So tonel.io's "⊞ Windows" pill button is functional **right
now**, even before v6.5.11 CI catches up.

## [6.5.10] - 2026-05-07

### Fixed — GitHub Release step 403 (read-only GITHUB_TOKEN)

v6.5.9's CI got past every previous failure point — Inno Setup
compiled cleanly, the artifact uploaded fine — and then the
`softprops/action-gh-release` step 403'd:

```
GitHub release failed with status: 403
{"message":"Resource not accessible by integration"}
```

The repo's Actions defaults to a read-only `GITHUB_TOKEN`
(Settings → Actions → General → Workflow permissions →
"Read repository contents and packages permissions"). Creating
a release needs `contents: write`.

Fix: add a workflow-level `permissions:` block:

```yaml
permissions:
  contents: write
```

Workflow-level (not job-level, not repo-wide) so the elevated
token only applies to this single workflow file. Other
workflows in the future stay read-only by default; the repo
setting doesn't change.

The R2 push step had its own `if: startsWith(github.ref,
'refs/tags/v')` gate so it was skipped (the previous step
failed). With the fix, both steps run on the next tag push.

## [6.5.9] - 2026-05-07

### Fixed — `iscc /DAppVersion=...` not overriding the in-script `#define`

v6.5.8's CI got past iscc parse + language-pack errors and
successfully produced an installer — but with the wrong version
in the filename:

```
Successful compile (51.937 sec). Resulting Setup program filename is:
D:\a\Tonel\Tonel\Tonel-Windows\installer\output\Tonel-Windows-v0.1.0.exe
                                                              ^^^^^
                                       expected v6.5.8 (from /DAppVersion=6.5.8)
```

build.ps1 then threw "Setup not produced" because it was looking
for the expected `Tonel-Windows-v6.5.8.exe`.

Cause: Tonel.iss declares `#define AppVersion "0.1.0"`. Inno's
preprocessor processes `#define` after `/D` flags from the
command line, so the in-script value always wins regardless of
what the CI passes.

Fix: guard the local define with `#ifndef`:

```ini
#ifndef AppVersion
  #define AppVersion   "0.1.0"
#endif
```

Now `iscc /DAppVersion=6.5.9` sets the macro before the script
is read, and the `#ifndef` check skips the local default. Local
dev still gets the 0.1.0 fallback when no `/D` is passed.

## [6.5.8] - 2026-05-07

### Fixed — Inno Setup ChineseSimplified.isl missing on CI runner

`iscc` aborted with:

```
Error on line 70 in installer/Tonel.iss:
  Couldn't open include file
  "C:\Program Files (x86)\Inno Setup 6\Languages\ChineseSimplified.isl":
  The system cannot find the file specified.
```

ChineseSimplified.isl ships with the official Inno Setup installer's
`Languages\` subfolder, but **Chocolatey's `choco install innosetup`
distribution doesn't include it** — and that's what the GitHub
Actions runner uses (the workflow falls back to choco when the
preinstalled Inno Setup isn't found).

Fix: drop the Chinese language entry from `[Languages]`. The
installer wizard is English-only for internal distribution; the
app's own UI is Chinese (independent of the installer wizard's
language).

Future fix when going public:
- Option A: commit a copy of `ChineseSimplified.isl` into
  `Tonel-Windows/installer/` and reference it via relative path
  instead of `compiler:Languages\...`.
- Option B: replace `choco install innosetup` in the workflow
  with a direct download of the official Inno Setup .exe (which
  bundles all language packs).

## [6.5.7] - 2026-05-07

### Fixed — Inno Setup line-54 parse error blocking CI

`iscc` was failing with `Parsing [Setup] section, line 54` and
exit code 2. Tonel.iss line 54:

```ini
MinVersion=10.0.17763   ; Windows 10 1809 (WASAPI low-latency baseline)
```

Inno Setup's `[Setup]` section directive parser does **not**
accept inline `;` comments — the entire RHS, including the `;`
and trailing text, is taken as the value. So the version string
became `"10.0.17763   ; Windows 10 ..."`, which doesn't match the
expected `Major.Minor[.Build]` format and aborts compilation.

Fix: hoist the comment onto its own line. Block comments only.

`iscc` exit code 2 = "compile error". Annotation surfaced as a
generic step failure (no `*.cs` line number to attach to), which
is why it didn't show up in the v6.5.6 check-runs annotations
that solved the previous round.

## [6.5.6] - 2026-05-07

### Fixed — Tonel-Windows compile errors blocking CI

The v6.5.4 / v6.5.5 GitHub Actions runs failed at `dotnet publish`
with two distinct compile errors. Surfaced via the public
check-runs annotations API; logs themselves require admin auth so
we couldn't see them in v6.5.4 / 6.5.5 directly.

#### `AllowUnsafeBlocks` not enabled

`AudioEngine.cs` has two `unsafe { fixed (byte* p = buf) ... }`
blocks (lines 310 and 655) that decode `byte[]` capture buffers
into `float*` / `short*` for the per-sample mono-fold + gain
application. CSC's default policy refuses unsafe code without an
opt-in.

Fix: `<AllowUnsafeBlocks>true</AllowUnsafeBlocks>` in
`TonelWindows.csproj`. The conversion loops run at
48 kHz × N channels per capture period; the `unsafe` route is
~3× faster than `Buffer.BlockCopy` + marshalling, which is the
honest reason to keep them.

#### `AudioClient.GetDevicePeriod` renamed in NAudio 2.x

NAudio 2.x dropped the `GetDevicePeriod(out long, out long)`
method in favour of two read-only properties on the same class:
`DefaultDevicePeriod` and `MinimumDevicePeriod`. Same 100-ns
ticks. Three call-sites were on the old API:
- `AudioEngine.cs:276` (capture latency display)
- `AudioEngine.cs:282` (render latency display)
- `WasapiExclusiveCapture.cs:53` (exclusive-mode buffer sizing)

Fix: replace with the property accessors.

#### CI auth note

`actions/runs/<id>/logs` is admin-only. Public callers can pull
error positions + messages from
`/repos/<owner>/<repo>/check-runs/<id>/annotations`, which is
exactly what surfaced the errors above. Worth remembering for
future un-debuggable CI failures.

## [6.5.5] - 2026-05-07

### Fixed — fresh-launch / reconnect surfaces 房间不存在

`Room::add_user` (server) was returning the boolean from
`std::set::insert` (`false` for duplicate). `RoomManager::join_room`
forwarded that to `process_join_room`, which surfaced it as
`make_error("Room not found")`. Wildly misleading — the actual
condition was "user_id already in this room's user set".

That's exactly what happens after the session-takeover path in
`process_join_room`: if a previous TCP context for the same
`user_id` is alive when a new one arrives, we mark the old ctx
`displaced` and short-circuit its `on_close` leave-cascade (so
the live session keeps its slots). Side-effect: `room->users_`
permanently retains the old uid until the new ctx successfully
re-joins. With non-idempotent `add_user`, that re-join failed
loudly with "Room not found".

The race fires reliably when:
- The previous app instance hard-quit (SIGPIPE in v6.3.0, force-
  quit in dev, app-update relaunch, etc.).
- The user installs the .dmg on a machine where a debug build
  previously ran — UserDefaults are bundle-id-scoped, so
  `Identity.userId` carries over and matches what the server
  still has in `users_`. Looks like "first launch fails" from
  the user's POV but is actually "second launch with stale
  server-side state".

#### Fix

`Room::add_user` is now idempotent:

```cpp
bool Room::add_user(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    users_.insert(user_id);   // discard the inserted-flag
    return true;              // logically a join succeeds whether or
                              // not we were already members
}
```

`process_create_room`'s use of `add_user` was already
return-value-ignored (it always treats the creator as a member),
so this change is safe for the create path too. Only
`process_join_room` consumed the boolean, and "user already in
room" → success is the correct semantic.

Server-side only. Tonel-MacOS / Web clients unchanged. Deployed
to both 广州1 (Aliyun) and 广州2 (Kufan).

## [6.5.4] - 2026-05-07

### Added — Tonel-Windows source + CI installer build

The Tonel-Windows WPF client (developed by user, previously
untracked locally) is now committed. Mirrors Tonel-MacOS
structure: `App/AppState.cs` + `Identity.cs` + `UserPrefs.cs`,
`Network/{MixerClient,WSMixerClient,P2PMixerClient,Endpoints,
SignalClient}.cs`, `Audio/{AudioEngine,JitterBuffer,SPA1Packet,
WasapiExclusiveCapture}.cs`, plus matching XAML views.

#### CI: GitHub Actions builds + ships the Windows installer

`.github/workflows/build-installer.yml` (also previously
untracked, now committed) runs on `windows-latest` for tag
pushes (`v*`), PRs that touch `Tonel-Windows/**`, and manual
dispatch:

1. `dotnet publish` → self-contained single-file Tonel.exe
2. Inno Setup `iscc Tonel.iss` → installer
3. Upload as workflow artifact (always)
4. Publish to GitHub Release (only on `v*` tag)
5. **Push to Cloudflare R2** (only on `v*` tag) — uploads both
   the versioned filename and the `Tonel-Windows-latest.exe`
   alias so `https://download.tonel.io/Tonel-Windows-latest.exe`
   stays current

To enable step 5 the user must add `CLOUDFLARE_API_TOKEN` to
the repo's Actions secrets (Settings → Secrets and variables →
Actions → New repository secret). Same token used for the
local `deploy/upload-r2.sh` flow; needs the
"Workers R2 Storage: Edit" permission.

#### Filename convention aligned

`Tonel.iss`'s `OutputBaseFilename` changed from
`Tonel-Setup-X.Y.Z` → `Tonel-Windows-vX.Y.Z`. This matches the
`Tonel-(MacOS|Windows)-vX.Y.Z` pattern that
`deploy/upload-r2.sh` regex-matches to auto-publish the
`*-latest` alias. `build.ps1`'s success message updated to
match.

#### Version sourcing

CI now reads the global version from the repo-root
`CMakeLists.txt` (`project(Tonel VERSION X.Y.Z ...)`) and passes
it as `-Version` to `build.ps1`. This way the Windows installer
filename + Inno's `AppVersion` track the global tag instead of
the per-file `csproj` Version (which was hardcoded `0.1.0`).
The csproj `<Version>` is a fallback for local dev builds only.

#### Other

- `deploy/upload-r2.sh` now reads `CLOUDFLARE_API_TOKEN` from
  `deploy/.env.deploy` if not already set in the env. Failing
  for the lack of an env-var prompted the v6.5.3 attempted
  upload to error out before this autoload was added.
- `.gitignore` adds `**/obj/` and `**/.vs/` for .NET build
  intermediates.

#### Rollout

- Tagging `v6.5.4` triggers the CI workflow on GitHub. The first
  run from a fresh runner takes ~5 min (downloads .NET SDK +
  Inno Setup + wrangler).
- After CI succeeds: `https://download.tonel.io/Tonel-Windows-latest.exe`
  serves the installer; tonel.io home-page "⊞ Windows" pill
  links straight at it.

## [6.5.3] - 2026-05-07

### Changed — 广州2 (Kufan) re-enabled

The Kufan box (42.240.163.172) was banned by its IDC in v5.1.22
for hosting the .io TLD without ICP filing. The ban has been
lifted; the box is back online. Tonel-MacOS's
`Endpoints.guangzhou2.isAvailable` flips from `false` → `true`,
so the picker entry is now selectable instead of greyed out.

#### Server side

- Cross-compiled v6.5.2 binary deployed to Kufan via
  `TONEL_SSH_HOST=root@42.240.163.172 TONEL_SSH_PORT=26806
  deploy/server.sh --component=binary`.
- Verified live banner: mixer reports
  `0.666ms interval, 32 samples/packet` (v6.0+ wire) and signaling
  reports `UDP discovery listening on port 9001` (v6.5+ P2P
  discovery), so feature parity with 广州1 is real.
- All needed ports externally reachable (probed with `nc -z`):
  9001/tcp+udp, 9002/tcp, 9003/udp, 9005/tcp.
- UFW is inactive on Kufan; cloud-side security group is the only
  filter and it's already open.

#### Client side

`Endpoints.swift` two-line flip + comment refresh:

```swift
// before:
isAvailable: false   // IDC ban, see memory reference_kufan_test_server
// after:
isAvailable: true    // ban lifted, v6.5.2 binary deployed, parity with 广州1
```

#### What didn't change

- DNS for `srv.tonel.io` still points wherever v5.1.22 left it —
  the macOS client doesn't use DNS for either server selection
  (both 广州1 / 广州2 are literal IPs in `Endpoints.swift`), so
  this works regardless. Web client behaviour unchanged.
- `/new` fallback path on web still routes to 广州1 (Aliyun) —
  not touched in this release.

## [6.5.2] - 2026-05-07

### Added — desktop client distribution via Cloudflare R2

Tonel-MacOS and Tonel-Windows installers can now be downloaded
directly from the home page. Buttons live under the primary CTA
cluster on both desktop and mobile heros — `⌘ macOS` and
`⊞ Windows` pills point at:

- `https://download.tonel.io/Tonel-MacOS-latest.dmg`
- `https://download.tonel.io/Tonel-Windows-latest.exe`

Both are stable "latest" aliases — `deploy/upload-r2.sh` rolls them
forward on every release without needing the user-facing URL to
change.

#### Infrastructure

- **R2 bucket**: `tonel-downloads` (APAC region)
- **Custom domain**: `download.tonel.io` (CF-managed CNAME +
  auto-issued TLS cert)
- **Free tier**: 10 GB storage / 1M Class A / 10M Class B ops per
  month — multiple orders of magnitude headroom for 内测 traffic.

#### Internal-distribution caveats (called out on the page)

- macOS .dmg is **ad-hoc signed** (no Apple notarization). First
  launch shows "无法验证开发者"; user right-clicks → 打开 →
  确认 once per install. Apple Developer Program ($99/yr) +
  notarization is the proper fix when going public.
- Windows .exe is **unsigned**. SmartScreen shows the blue panel;
  user clicks 更多信息 → 仍要运行 once. Real fix is a code-signing
  cert (~¥800-3000/yr depending on OV vs EV).

#### New files

- `deploy/package-macos.sh` — Release-config xcodebuild → ad-hoc
  codesign verify → `hdiutil create` UDZO. Output:
  `deploy/dist/Tonel-MacOS-v<version>.dmg`.
- `deploy/upload-r2.sh` — wrangler-based R2 upload. Auto-publishes
  a `*-latest.{dmg,exe}` alias when the filename matches
  `Tonel-(MacOS|Windows)-vX.Y.Z.{dmg,exe}`.

#### Web changes

- `App.tsx`: `Placeholder` no longer handles `'download'`; new
  inline `DownloadPage` renders the install-instructions page at
  `#download` with platform-specific tiles + 内测 caveats notes.
- `pages/HomePage.tsx`: hero CTA cluster gains a "下载桌面客户端"
  pill row — both desktop (`v1-actions`) and mobile (`v1m-actions`)
  variants.
- `styles/globals.css`: `.v1-downloads` / `.v1-dl-pill` / `.tn-download`
  styles. Pills use the same dark-on-dark + green-accent palette as
  the rest of the v1 layout.
- `wrangler` v4.88 installed globally on the dev machine for R2
  push.

`.gitignore` adds `deploy/dist/`, `.playwright-mcp/`, and the
playwright screenshot file so they don't accidentally get
committed.

## [6.5.1] - 2026-05-07

### Fixed — P2P bind() failed with "Operation not permitted"

Switching to P2P surfaced "P2P UDP bind: Operation not permitted"
in the connection-failure alert. Cause: the macOS App Sandbox
entitlements only listed `com.apple.security.network.client`. A
client-initiated UDP socket that's also expected to receive
inbound packets from peers needs `com.apple.security.network.server`
— EPERM on `bind()` is the sandbox refusing without it.

Fix: add `com.apple.security.network.server: true` to
`project.yml` (so xcodegen writes it into the entitlements file
on every regen, mirroring the v6.1.1 Info.plist lesson).

The UDP/WS modes never tripped this because they use NWConnection
(client-only) or URLSessionWebSocketTask, both of which the
sandbox classifies as outbound. POSIX `bind(SOCK_DGRAM)` for
inbound packets is the only path that needs `network.server`.

## [6.5.0] - 2026-05-07

### Added — P2P transport (third Tonel-MacOS mode, full mesh)

`TransportMode.p2p` joins `.udp` and `.ws` as the third option in
the Settings 协议 picker. With P2P selected, the central mixer is
out of the audio path entirely: each peer sends SPA1 audio frames
directly to every other peer over UDP, and mixes incoming streams
locally. The signaling server is involved only for room
membership + peer-address exchange.

Designed for 同城线上排练 — typical residential broadband NAT.
Works for cone NAT (the common case) via UDP hole-punching;
symmetric NAT will fail without TURN (no relay fallback in
v6.5.0, matching SonoBus's posture).

#### Protocol additions

**TCP signaling (`:9001`):**

- Client → server: `REGISTER_AUDIO_ADDR` (room_id, user_id,
  public_ip, public_port, local_ip, local_port). Sent after the
  client completes UDP NAT discovery (below).
- Server → registrar: `REGISTER_AUDIO_ADDR_ACK` plus one
  `PEER_ADDR` per already-registered peer in the same room.
- Server → other room members (broadcast): `PEER_ADDR` for the
  newly-registered peer.

**UDP discovery (`:9001/udp` — new listener):**

- Client → server: `{"type":"DISCOVER","user_id":"..."}` UDP
  packet, sent on the same socket the client will use for audio.
- Server → client: `{"type":"DISCOVER_REPLY","public_ip":"...",
  "public_port":N}` echoed back to the source (so the client
  learns its NAT-mapped public endpoint).

**P2P UDP control (peer ↔ peer, SPA1 codec extensions):**

- `SPA1.codec = 0xFE` (peerHello): hole-punch packet, sprayed at
  both `localAddr` and `publicAddr` of a fresh peer at 100 ms
  intervals until first inbound from that peer arrives. The first
  inbound's source address is locked in as the steady-state route.
- `SPA1.codec = 0xFD` (peerPing): keepalive every 5 s. Carries a
  100-ms-unit timestamp so peers can EMA an audio RTT figure
  even when the mic is muted.

#### Implementation

- New `P2PMixerClient.swift` (~480 lines) implements
  `MixerTransport`. POSIX UDP socket (random port), recvfrom
  loop on a dedicated thread, hole-punch + keepalive timers on
  main RunLoop, fan-out send to all peers, per-peer working-addr
  resolution.
- `SignalClient` parses `PEER_ADDR` / `REGISTER_AUDIO_ADDR_ACK`
  and exposes `registerAudioAddr(...)`.
- `Endpoints.ServerLocation.p2pDiscoveryUDPPort` (defaults to
  9001, same as the TCP signaling port). `mixerHost` is reused
  as the discovery host.
- Server `signaling_server.cpp` adds the UDP listener and
  `process_register_audio_addr` handler.
- ATS exception was already in place for the WS path's plain
  `ws://` to the box's IP — same allowlist covers the P2P UDP
  socket since macOS only ATS-restricts URL-loaded resources,
  not POSIX sockets, but the existing exception is no harm.

#### UI

- 协议 picker now shows three options:
  `UDP（低延迟）` / `WS（兼容）` / `P2P（直连）`.
- Switching to P2P triggers tear-down + reconnect + UDP
  discovery + register, just like the WS swap path.
- 返回我的房间 button gated additionally on `!isJoining` and
  `!currentRoomId.isEmpty` so it doesn't flash mid-swap.

#### Known limitations (v6.5.0 accepts)

- Symmetric NAT (rare on home broadband, common on mobile +
  some corporate) — peers simply can't reach each other.
  Surfaces as a missing peer in the UI; future TURN fallback
  would be v6.6.0+.
- N-1 client-side decode + mix gets CPU-heavy past ~8 peers.
  Designed for ≤6-person band rehearsals.
- P2P RTT readout uses peerPing timestamp echo, less accurate
  than the mixer modes' TCP PING/PONG (only 100 ms-grained).

#### Server-side ops

- UFW: `ufw allow 9001/udp` on Aliyun (done at deploy).
- Aliyun ECS Security Group: 9001/UDP inbound 0.0.0.0/0
  (operator action — done).

## [6.4.0] - 2026-05-07

### Changed — JOIN_ROOM auto-creates on missing; client drops CREATE_ROOM

The signaling server's `process_join_room` now auto-creates the
room (with empty password) when it doesn't exist, instead of
returning "Room not found". Tonel-MacOS's `AppState.enterRoom`
correspondingly drops the `preferCreate` parameter and always
calls `signal.joinRoom` — never `createRoom`. The "Room already
exists" alert that used to surface on every transport switch /
reconnect (because v6.2.0+ retried CREATE on rooms that lived
through the previous tear-down) is gone — server can no longer
emit it on the JOIN path.

Web client unaffected: it uses explicit CREATE_ROOM for
password-protected rooms; that path is unchanged.

#### Server change

`server/src/signaling_server.cpp::process_join_room`:

```cpp
Room* room = room_manager_.get_room(room_id);
if (!room) {
    room = room_manager_.create_room(room_id, user_id, "");
    // ... continue as if the room already existed
}
```

The auto-created room has no password. To create a
password-protected room the explicit CREATE_ROOM path is still
the only option.

#### Client change

`AppState.enterRoom(_:preferCreate:)` → `enterRoom(_:)`. Single
JOIN call, no CREATE-then-fallback dance, no spurious error
swallowing. ~25 lines simpler.

#### Rollout

Server-side change is the critical one — must deploy before any
v6.4.0 client tries to connect (a v6.4.0 client to a v6.3.x
server would hit "Room not found" on first launch when the
personal room hadn't been pre-created). Server v6.4.0 deploy
done at release time.

## [6.3.1] - 2026-05-07

### Fixed — Tonel-MacOS hard exit on UDP → WS transport switch (SIGPIPE)

Switching 协议 from UDP to WS reliably killed the app. Cause: the
v6.2.0 `applyTransportSelection` flow tears the old `MixerClient`
down (`closeTCPSocket`) while a queued POSIX `send()` may be
inflight on `tcpWriteQueue`. macOS sends `SIGPIPE` to the process
when `send()` runs on a closed TCP socket, and Swift apps don't
install a default handler — so the process dies with no useful
crash report (TonelMacOS launchd log: `exited due to SIGPIPE |
sent by TonelMacOS, ran for 64360ms`).

Fix: install `signal(SIGPIPE, SIG_IGN)` in `TonelMacOSApp.init()`.
The failed `send()` now returns `-1` with `errno=EPIPE`; the
existing `tcpSocket >= 0` guards in `MixerClient`'s write paths
already skip cleanly when the socket is closed. This is how
`Network.framework` / `URLSession` handle the same problem
internally; macOS doesn't have Linux's `MSG_NOSIGNAL` flag, so
ignoring globally is the standard idiom.

The bug was latent since v6.2.0 (when `applyTransportSelection`
started swapping mixers mid-session); v6.3.0 reproduced it more
reliably because the user actually had a working WS path to
switch to.

## [6.3.0] - 2026-05-07

### Changed — Tonel-MacOS WS-fallback now goes plain `ws://` directly to the box

The fallback transport (was 协议 = WSS) now talks **plain
WebSocket** straight to the mixer's `tonel-ws-mixer-proxy` port
(9005/TCP), bypassing the DNS + TLS + nginx chain that v6.1.0
introduced. The native client gets the same direct-to-Aliyun
philosophy as the UDP path — no `srv-new.tonel.io` lookup, no
cert renewal, no proxy hop. Web clients still go through nginx
+ TLS as before; this change is Tonel-MacOS-only.

The original v6.1.0 design assumed `srv-new.tonel.io` had a DNS
record; v6.2.2's investigation found it never did. Rather than
fix DNS we changed the architecture: a native client doesn't need
TLS to a hostname for what is fundamentally a "use TCP not UDP"
fallback.

#### Concrete changes

- `TransportMode.wss` → `.ws`. Old `wss` raw values from
  pre-v6.3.0 `@AppStorage` slots collapse to nil → `AppState`
  defaults to `.udp` on first launch of v6.3.0. (Acceptable; the
  transport picker is right there in Settings if the user wants
  WS again.)
- `ServerLocation.wssMixerHost` → `wsMixerURL` (full
  `URL("ws://<ip>:<port>")`); the per-path `wsMixerTCPURL` /
  `wsMixerUDPURL` derive `/mixer-tcp` and `/mixer-udp` from it.
- `WSSMixerClient.swift` → `WSMixerClient.swift` (file + class
  rename; same SPA1 wire path internals).
- `Info.plist` `NSAppTransportSecurity.NSExceptionDomains` adds
  the two server IPs (8.163.21.207, 42.240.163.172) with
  `NSExceptionAllowsInsecureHTTPLoads = true`. `NSAllowsArbitraryLoads`
  stays `false` so this only whitelists those specific hosts.
- UI label: 协议 picker option renamed `WSS（兼容）` → `WS（兼容）`;
  alert text and Settings helper updated.

#### Server-side

- UFW: `ufw allow 9005/tcp` (done at deploy-time).
- Aliyun ECS Security Group: must add 9005/TCP inbound from
  `0.0.0.0/0` — UFW alone isn't enough on Aliyun
  (`reference_aliyun_security_group` memory rule). Operator-action.

#### Trade-off accepted

ws:// is plaintext. The PCM stream + `roomId:userId` are visible
to any in-path observer between the user and Aliyun. This is
the same posture as the UDP path on 9003 (also plaintext), so
the change is internally consistent. Future encryption work
should target both transports together (DTLS on UDP, wss:// or
TLS-wrapped on TCP) — better than retrofitting wss:// alone.

## [6.2.2] - 2026-05-07

### Fixed — WSS transport switch hangs the app indefinitely

Switching the Settings 协议 picker from UDP → WSS on Tonel-MacOS made
the app appear frozen. Root cause: `URLSessionWebSocketTask`'s async
`send` / `receive` honour neither `URLSessionConfiguration
.timeoutIntervalForRequest` nor `for resource:` reliably, so an
unreachable target (typically NXDOMAIN — see infrastructure note
below) hangs the connect flow forever with no error surfaced.

Fix: `WSSMixerClient.connect()` now wraps the entire connect
sequence (control-WS upgrade + MIXER_JOIN + audio-WS upgrade +
SPA1 handshake) in a single 8-second deadline via a new
`withDeadline(_:host:_:)` TaskGroup-race helper. On timeout the
half-open WS tasks are cancelled cleanly; the user sees the
existing 连接失败 alert ("WSS 连接超时（DNS 或握手不通）：<host>")
and can switch back to UDP.

### Infrastructure — `srv-new.tonel.io` DNS is missing

While debugging the freeze the WSS endpoint was found to have no
DNS record at all (`nslookup srv-new.tonel.io` → "No answer"). The
v6.1.0 design assumed this hostname pointed at the Aliyun mixer's
nginx; it apparently never got a DNS record (or one was removed).
Until DNS is set up, **the WSS transport on 广州1 will always fail**.

Workarounds the user can pursue (none of which are code changes):
1. Add an A record for `srv-new.tonel.io` → `8.163.21.207` in the
   tonel.io DNS provider, install matching cert in Aliyun's nginx.
2. Or switch the WSS host in `Endpoints.swift` to a different
   already-working hostname that proxies to Aliyun's mixer.

Today's release just makes the failure visible and recoverable
instead of hanging the app — the WSS option still appears in the
Settings picker but selecting it surfaces the timeout error.

## [6.2.1] - 2026-05-07

### Changed — UI tidy-up (per user feedback)

- 服务器选择 picker 的显示名简化：`广州1（阿里云）` / `广州2（酷番云
  · 暂不可用）` → `广州1` / `广州2`. 用户偏好简短标签；广州2 的
  unavailable 状态仍由 `.foregroundStyle(.secondary)` 灰显呈现。
- 删除 设置 → 身份 里的 "重置身份" 按钮 + `AppState.resetIdentity()`
  方法。Identity 文件里的 `Identity.reset()` 静态方法保留为内部 API
  （未来可能从命令行 / 调试入口需要）但 UI 不再暴露。

`Endpoints.guangzhou1.displayName` / `guangzhou2.displayName` 是
唯一的真改动；其它都是删除。无运行时行为变化。

## [6.2.0] - 2026-05-07

### Changed — Tonel-MacOS: no more home page, auto-bootstrap into a room

The macOS client launches **directly into a room**. The home page,
login page, and room-list flow are gone. On first launch the app
generates a persistent `userId` (opaque, internal) plus a personal
`myRoomId` — a 6-character uppercase short id from a verbal-friendly
alphabet (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, no `0/1/I/O`) so users
can read it to bandmates over a phone call. Both ids are stored in
UserDefaults; subsequent launches re-use them and re-enter the
last-used room.

Joining someone else's room: header has a **切换房间** button
(replacing 离开房间) opening a sheet to type a 6-char room id. After
a successful switch the user can hit **返回我的房间** to come back
to their personal room in one click. **重置身份** in Settings wipes
both ids and starts fresh — useful when bandmates' clients are
stuck on the old uid.

### Added — `Identity` helper

New `App/Identity.swift` owns first-launch generation, persistence,
and reset. The room-id alphabet excludes `0/1/I/O` to remove the
verbal-share ambiguity ("zero or oh", "one or el"). Three
UserDefaults keys: `tonel.identity.userId`,
`tonel.identity.myRoomId`, `tonel.identity.currentRoomId`.

### Changed — AppState

- `Screen` enum gone — there's only one screen now (Room).
- `userId`/`myRoomId`/`currentRoomId` are `@Published` properties
  reflecting the persistent identity.
- `bootstrap()` runs from `init()` via `Task` to auto-join the room
  on launch. Tries `CREATE_ROOM` first, falls back to `JOIN_ROOM` on
  "already exists" (handles both first-launch and re-launch
  transparently).
- `applyTransportSelection(...)` now tears down + re-enters the
  current room instead of refusing while connected. The Settings
  picker is therefore live at all times — switching UDP↔WSS feels
  like a brief reconnect blip, not a hard error.
- New `switchToRoom(_:)`, `returnToMyRoom()`, `resetIdentity()` for
  the new UI flows.
- Removed: `screen`, `phone`, `isLoggedIn`, `login(_:)`, `logout()`,
  `joinRoom(_:password:create:)`, `leaveRoom()`, `fetchRoomList()`,
  `rooms`, `roomId` (renamed → `currentRoomId`).

### Removed — `HomeView.swift` + `LoginView.swift`

Both deleted. Kept dead code is technical debt; clearing now since
the new Identity-based flow doesn't need either.

### UI

- Settings sheet adds a **身份** section showing userId (truncated),
  myRoomId (with copy button), and the **重置身份** action.
- Server / transport pickers no longer grey out while in a room
  (since transport change auto-reconnects). Helper text updated.

### Migration

Existing users who installed v6.0.x – v6.1.x had no persistent
identity beyond the ephemeral phone-stub uid. On first launch of
v6.2.0 they'll be assigned a fresh `userId` and `myRoomId`. The
old ephemeral uid is silently discarded — there's nothing on the
server tied to it.

## [6.1.1] - 2026-05-07

### Fixed — Tonel-MacOS hard crash on 创建房间 (regression from v6.1.0)

`xcodegen generate` (re-run during v6.1.0 to wire `MixerTransport.swift`
and `WSSMixerClient.swift` into the project) regenerated
`TonelMacOS/Resources/Info.plist` from its template and **silently
dropped** `NSMicrophoneUsageDescription` (and a few other keys —
`CFBundleDisplayName`, `LSMinimumSystemVersion`, `NSAppTransportSecurity`,
`NSHumanReadableCopyright`, `NSHighResolutionCapable`,
`LSApplicationCategoryType`).

Without `NSMicrophoneUsageDescription`, macOS' privacy enforcement
(TCC) sends `SIGABRT` the moment the app touches `AVCaptureDevice` —
which is exactly what `AudioEngine.start()` does when the user clicks
**创建** in `CreateRoomSheet`. Crash signature confirmed in the
diagnostic report:

```
EXC_CRASH (SIGABRT)  TCC: This app has crashed because it attempted
to access privacy-sensitive data without a usage description.
```

Fix: hoist the lost keys into `project.yml`'s `info.properties`
(rather than relying on `INFOPLIST_KEY_*` build settings, which
xcodegen doesn't merge into the file it writes). Future `xcodegen
generate` runs now produce a complete Info.plist. Verified by
reading the regenerated file before relaunch.

No code change. Existing v6.1.0 binaries are still broken — anyone
who pulled tag `v6.1.0` should rebuild from `v6.1.1` or later.

## [6.1.0] - 2026-05-07

### Added — Tonel-MacOS multi-server selection + WSS-fallback transport

The Settings sheet now exposes two pickers under
**服务器与传输模式**:

- **服务器**: 广州1（阿里云）/ 广州2（酷番云 · 暂不可用）
- **协议**: UDP（低延迟） / WSS（兼容）

Both pickers are greyed out while the user is in a room — switching
servers or transport mid-session is intentionally disallowed. The
deferred-from-v6.0.0 design lands here.

**No auto-fallback**, by design. Connection failures surface as a
modal alert on the Home screen ("连接失败 — 如果当前网络封锁直连
UDP，可在 设置 → 服务器与传输模式 切换到 WSS 兜底重试") and the
user picks the other transport manually. The reasoning is captured
in earlier conversation notes and matches the user-explicit intent
to keep the failure mode visible rather than silently re-routing.

#### Architecture

- New `MixerTransport` protocol (`Tonel-MacOS/.../Network/`) defines
  the surface that `AppState` and `AudioEngine` use, decoupling the
  audio path from the underlying transport class.
- `MixerClient` (existing UDP-direct path) now conforms to
  `MixerTransport` and accepts a `ServerLocation` at construction —
  references to `Endpoints.mixerHost` / `mixerTCPPort` /
  `mixerUDPPort` are read from the server bundle instead.
- New `WSSMixerClient` parallel implementation. Talks the **same**
  SPA1 wire format over `URLSessionWebSocketTask` to
  `wss://<host>/mixer-tcp` (control, JSON text frames) and
  `wss://<host>/mixer-udp` (audio, binary SPA1). The proxy on the
  other side is the unchanged `web/ws-mixer-proxy.js`
  (`tonel-ws-mixer-proxy` PM2 service) — no server-side change
  needed; we just plug a native client into the same pipe the
  browser already uses.
- `Endpoints.swift` rewritten as a multi-server registry. Two
  `ServerLocation` entries today: `guangzhou1` (Aliyun, fully
  online) and `guangzhou2` (Kufan, marked `isAvailable=false` while
  the IDC ban is unresolved). Default selection: 广州1 / UDP.
  `@AppStorage` keys: `tonel.server.id`, `tonel.transport.mode`.
- `AppState.mixer` is now an `@Published` `any MixerTransport`.
  `applyTransportSelection(server:transport:)` recreates the mixer
  from a static factory and re-attaches it to the audio engine.
  Refuses to swap while in a room.

#### Other Tonel-MacOS fixes

- Connection-failure alert wired to `state.lastError` on `HomeView`.
  Previously errors went into `lastError` but no UI surfaced them.
- AudioDebugSheet jitter sliders' ranges scaled to match v6's
  larger jitter constants — `jitterTarget` 1...16 → 1...60,
  `jitterMaxDepth` 1...64 → 1...240. The v6 server defaults
  (target=8, cap=124) were OFF the old slider scale, so the
  sliders snapped to the max and pushed the wrong number back to
  the server on first open.
- Stale "120-sample" / "2.5 ms" comment cleanup absorbed into
  `Endpoints.swift` rewrite (file is now generated fresh).

#### Deferred from v6.1.0

- Live transport-swap **without leaving the room** would require
  draining + re-encoding the audio stream across the swap; not
  worth it for a setting users typically pin once.
- Health probe that pre-flights the selected transport against the
  selected server (so the user finds out it won't work *before*
  trying to join) — straightforward but not in scope here.

## [6.0.2] - 2026-05-07

### Docs / comments — RTT/latency review follow-up

User-requested audit of the macOS client's RTT and e2e-latency
algorithms found the math correct (all components scale via
`AudioWire.frameMs`, so v6's drop from 2.5 ms → 0.667 ms applies
uniformly), but turned up two cosmetic issues. No runtime change.

**SPA1 `timestamp` field unit clarified — was wrong in the spec.**
Code (both web `audioService.ts` and macOS `AudioEngine.swift:560`)
encodes timestamps in **100 ms units** (`(now_ms / 100) & 0xFFFF`).
SPA1_PROTOCOL.md and ARCHITECTURE.md previously said "low-16 ms",
which never matched the implementation. Both docs now say 100 ms
units, and SPA1_PROTOCOL.md's "Audio RTT measurement" section
clarifies that production clients use TCP PING/PONG (not the
SPA1 timestamp echo) — the field is filled but ignored on receive.
The 100 ms quantisation is the reason: useless for the typical
5–30 ms RTT range.

**Stale "120 sample / 2.5 ms" comments swept** in
`Tonel-MacOS/TonelMacOS/Audio/AudioEngine.swift` (4 sites) and
`Tonel-MacOS/TonelMacOS/Network/MixerClient.swift` (1 site). These
comments described the v5 wire format; the code already used
`AudioWire.frameSamples` / `AudioWire.frameMs`, so behaviour was
correct, but the comments would mislead a future reader.

## [6.0.1] - 2026-05-07

### Docs

Frame-size sweep for stragglers that didn't make the v6.0.0 commit:

- `docs/ARCHITECTURE.md` — topology diagram tick (2.5 → 0.667 ms),
  mixer_server bullet, latency budget table (Mic capture, Server
  jitter buffer, Server mix tick), SPA1 frame-size paragraph,
  timestamp-units row.
- `docs/SPA1_PROTOCOL.md` — bottom topology diagram tick.

No code change. Tonel-local docs (`STANDARDS_WEB_AUDIO.md`,
`STANDARDS_NETWORK.md`) and memory entries also updated, but they live
outside this repo.

## [6.0.0] - 2026-05-07

### Changed — SPA1 wire frame size 120 → 32 samples (BREAKING)

The PCM16 wire frame drops from **120 samples / 2.5 ms** to
**32 samples / 0.667 ms** at 48 kHz. This is a wire-protocol breaking
change: a v6 client must talk to a v6 server. The SPA1 magic stays
`'SPA1'`; what changes is the canonical PCM16 `dataSize` (240 → 64
bytes) and the broadcast cadence (400 → 1500 fps). Driver: prepares
the codebase for the upcoming UDP-default native client roadmap by
pushing packetisation latency to the floor.

When Opus support lands later, the codec=1 path will revert to
120 samples (libopus minimum); PCM16 stays at 32 regardless.

### Changed — Server: derived mix interval, scaled jitter constants

`mixer_server.h` no longer carries a `constexpr MIX_INTERVAL_US = 2500`.
The interval is now a per-instance member (`mix_interval_us_`) computed
in the constructor as `audio_frames_ * 1'000'000 / 48000`, so the
broadcast cadence stays locked to the wire frame size for any future
adjustment without another constant edit.

Per-user jitter constants scaled by `120 / 32 = 3.75×` to keep the
ms-equivalent latency floor and burst headroom unchanged:

| Constant                     | Before | After |
|------------------------------|--------|-------|
| `JITTER_TARGET_DEFAULT`      | 2      | 8     |
| `JITTER_MAX_DEPTH_DEFAULT`   | 33     | 124   |
| `JITTER_TARGET_MAX`          | 16     | 60    |
| `JITTER_MAX_DEPTH_MAX`       | 64     | 240   |

The level-broadcast tick counter (`>= 20` at the 2.5 ms tick → ~20 Hz)
is now `>= 75` to maintain ~20 Hz at the new 0.667 ms tick.

### Changed — Tonel-MacOS

- `AudioWire.frameSamples`: 120 → 32. PCM16 payload: 240 → 64 bytes.
  `AudioWire.frameMs` updated to `32 / 48 = 0.6667`.
- `JitterBuffer.maxDepth`: 33 → 124 (`primeMin` 2 → 8, `targetDepth`
  2 → 8) to keep ~82 ms burst headroom at the smaller frame size.
- `AudioEngine.serverJitterTarget`: 2 → 8 placeholder; `serverJitterMaxDepth`:
  8 → 124 placeholder. Both still get overwritten by `MIXER_JOIN_ACK`
  values via `syncServerTuningFromMixer()`.

### Changed — Web

- `audioService.ts FRAME_SAMPLES`: 120 → 32; `FRAME_MS`: 2.5 → 0.6667.
- `DEFAULT_SRV`: `(jitterTarget=2, jitterMaxDepth=33)` →
  `(jitterTarget=8, jitterMaxDepth=124)`.
- `TUNING_SCHEMA_VERSION`: 7 → 8. Existing user `localStorage` slots
  with `v: 7` are discarded on next load and current defaults applied,
  so a v5 user's saved `jitterMaxDepth=33` is not carried into v6
  (33 frames × 0.667 ms = 22 ms cap → would `drop_oldest` under normal
  WSS burst). State-migration test (`server/test/browser/state_migration_test.js`)
  parameterises off `TUNING_SCHEMA_VERSION` and so picks up the bump
  automatically; no new scenario needed.

### Audio quality regression test

| Metric | v5 (120 samples) | v6 (32 samples) | Threshold |
|--------|------------------|-----------------|-----------|
| Broadcast rate | 401.02 / s | 1503.66 / s | ±5000 ppm ✅ |
| SNR    | 63.60 dB | 55.39 dB | ≥ 40 ✅ |
| THD    | 0.066 % | 0.170 % | ≤ 1.00 ✅ |
| PLC fires | 4.18 / s | 10.16 / s | (no threshold) |
| Click rate | 4.18 / s | 12.00 / s | (no threshold) |

Both pass the audio-quality-e2e thresholds. The PLC/click increase is
partly a synthetic-sender artefact under libuv's 1 ms timer granularity
at the new 0.667 ms tick — real production audio engines are properly
paced.

### Deferred to v6.1.0

The original v6 ask included a multi-server selector
(广州1 = Aliyun / 广州2 = 酷番云) and a transport-mode selector
(UDP default / WSS user-selectable fallback) on Tonel-MacOS. Those
are substantial Swift work and did not ship in v6.0.0; the wire-protocol
change alone justifies the major-version bump. v6.1.0 plan:
`Endpoints` becomes a list, `TransportMode` enum drives mixer client
selection, new `WSSMixerClient.swift` parallel to `MixerClient.swift`
talking SPA1 over `wss://srv.tonel.io/mixer-{tcp,udp}`, Settings UI
sheet adds the two pickers. No auto-fallback — connection failure
shows an error dialog and the user manually switches.

### Rollout order

Server first, then client. v6 client ↔ v5 server is broken silently
(mismatched `dataSize`); v5 client ↔ v6 server is broken loudly
(jitter buffer overflows because client sends at 400 fps but server
expects 1500 fps).

## [5.2.0] - 2026-05-06

### Changed — Tonel-MacOS branch reconciliation

The `tonel-macos` long-lived branch (last bump 0.1.10) and `main`
(0.1.3 after v5.1.27) had diverged: `tonel-macos` carried v4.x audio
optimizations that were never merged back, while `main` accumulated
the v5.1.26/27 fixes (POSIX MixerClient, bare HALOutput AU, Settings
persistence) that `tonel-macos` never got. Selective merge — taking
each file from whichever branch had the better version, then a
manual interface adapter — instead of a wholesale merge that would
clobber one side's work.

### Added — JitterBuffer: PLC, target-trim, RT-safe rewrite

`Tonel-MacOS/TonelMacOS/Audio/JitterBuffer.swift` is now the 242-line
elaborate version from `tonel-macos`. Concretely:

- `PopResult` enum (`.real` / `.plc(decay)` / `.silence`) replaces
  the previous `[Float]?` return. PLC mirrors web client's
  `concealDecay = [1.0, 0.7, 0.4, 0.15]`: after a brief gap, hand
  back the last real frame at progressively decaying gain so the
  listener hears a soft tail instead of a click.
- `targetDepth` + `trimMargin` layered on top of the `maxDepth`
  hard cap. At room-join the OS UDP recv buffer can flush ~370 ms
  of self-loopback in one burst; without target-trim the buffer
  fills to `maxDepth=33` and `drop_oldest` fires once per excess
  packet (real-log evidence: `drop=908` in the first second = 908
  audible clicks). With target-trim it's ONE concentrated trim
  per burst, then steady-state at the latency floor.
- `maxDepth` raised 8 → 33 (matches web's `JITTER_MAX_DEPTH` after
  v4.3.7). 8-deep at 2.5 ms/frame = 20 ms headroom; CF/WSS bursts
  delivering 8+ frames at once were dropping the oldest = audible
  click. 33 absorbs typical burst patterns silently.
- Pre-allocated fixed-size ring + `os_unfair_lock` for RT-thread
  safety. `pop()` no longer allocates; the lock is sub-microsecond
  uncontended (one-writer, one-reader contention pattern).
- `static var primeMin` / `static var targetDepth` so the
  AudioDebugSheet sliders tune them live across all per-peer
  buffers; `trimMargin` is now computed off `targetDepth` so the
  `target + margin + 1 == maxDepth` invariant holds during tuning.

### Added — MixerClient dedicated network queue

`Tonel-MacOS/TonelMacOS/Network/MixerClient.swift` from `tonel-macos`
adds `networkQueue` — a userInitiated background DispatchQueue that
hosts UDP receive callbacks. Previously these landed on `.main` and
buried the main thread under ~400 packets/sec of PCM16 decode +
JitterBuffer push. Visible symptom: opening Settings froze the app
because AVAudioEngine's reconfigure also ran on main and competed
with the audio firehose. With the dedicated queue, main is freed
entirely; SwiftUI updates that need main hop via `Task { @MainActor
in ... }` from inside the handlers.

### Adapter — AudioEngine.fillPlayback now consumes PopResult

`fillPlayback`'s peer-mix loop previously did
`if let frame = sink.jitter.pop() { mix }`. With the new JitterBuffer
returning `PopResult`, the loop is a `switch` over `.real` /
`.plc(frame, decay)` / `.silence`. PLC frames are mixed at
`outputGain × decay` so the listener hears the last real frame
attenuated rather than a click during transient gaps.

### Files

| File | Change |
|------|--------|
| `Tonel-MacOS/TonelMacOS/Audio/JitterBuffer.swift` | wholesale from `tonel-macos`; primeMin/targetDepth → `static var`; trimMargin → computed |
| `Tonel-MacOS/TonelMacOS/Network/MixerClient.swift` | wholesale from `tonel-macos`; gains `networkQueue` |
| `Tonel-MacOS/TonelMacOS/Audio/AudioEngine.swift` | `fillPlayback` peer-mix loop migrated to `PopResult` switch |
| `Tonel-MacOS/project.yml` | `MARKETING_VERSION` 0.1.3 → 0.1.11 (catches up to `tonel-macos`) |

### Note

`tonel-macos` branch is now effectively merged into `main`. Future
desktop work continues on `main` via `release: vX.Y.Z` commits per
the standard pipeline; `tonel-macos` is left as a historical
reference but no longer the primary working branch.

## [5.1.27] - 2026-05-06

### Fixed — Tonel-MacOS output device picker actually works now

The Settings sheet's output device Picker called
`audio.setOutputDevice()` which in turn poked
`kAudioOutputUnitProperty_CurrentDevice` on
`AVAudioEngine.outputNode.audioUnit`. macOS rejected this with
`-10851` (`kAudioUnitErr_InvalidPropertyValue`) — and earlier with
`-19851` from AUHAL — even after `engine.stop()` and an explicit
`AudioUnitUninitialize` round-trip. The reason: AVAudioEngine's
internal HAL unit on macOS does not actually release ownership of
its `CurrentDevice` slot when the engine is paused; AVAudioEngine
keeps re-asserting it through KVO, so the SetProperty either
never lands or lands on a re-initialized AU and gets rejected.

The fix: stop using AVAudioEngine for output entirely. Output is
now driven by a standalone `kAudioUnitSubType_HALOutput` AU
(`AudioEngine.outputAU`) that we own outright. Capture stays on
AVAudioEngine — only the playback half is migrated.

| File | Change |
|------|--------|
| `Tonel-MacOS/TonelMacOS/Audio/AudioEngine.swift` | `setupOutputAU` / `teardownOutputAU` build a bare HALOutput; `setOutputDevice` swaps via `Stop → Uninit → Set → Init → Start` on the bare AU; `currentOutputDeviceID`, `bufferFrameRange`, `readDeviceLatencies`, and the HW-buffer-set loop all read from `outputAU` with AVAudioEngine fallback |

Render callback is an `AURenderCallback` trampoline that reuses the
existing `fillPlayback` mix logic verbatim — peers + monitor +
selfLoop logic is unchanged. Wire format (48 kHz mono Float32) is
set on the AU's input scope bus 0; AUHAL's internal AudioConverter
handles the device-side format conversion (e.g. 44.1 / 96 kHz
output devices).

### Fixed — Sample rate Picker now persists across Settings reopens

`setInputDeviceSampleRate` was previously a stub that only updated
the displayed `actualSampleRate` field — and the SettingsSheet's
`requestedRate` reset to nil on every `.onAppear`, so the picker
always showed "自动" when reopened. Now writes a real
`kAudioDevicePropertyNominalSampleRate` to the input device's HAL,
reads back the actual rate (drivers may clamp), persists the
choice in `UserDefaults` (`tonel.audio.sampleRate`), and the sheet
seeds `requestedRate` from that key on appear.

### Added — Output device choice persisted across launches

`setOutputDevice` writes the selected device ID to
`UserDefaults` (`tonel.audio.outputDeviceID`). `setupOutputAU`
reads it on `start()` and routes the bare HALOutput AU there
directly. If the saved ID is no longer present (e.g. AirPods
disconnected since last run), falls back to the system default
output via `kAudioHardwarePropertyDefaultOutputDevice`.

### Added — Settings sheet shared between Home and Room

`HomeSettingsSheet` was a placeholder ("占位 — 后续接入..."). Both
the home and room settings buttons now present the same
full-featured `SettingsSheet`, so users can configure output
device / sample rate / HW buffer size before joining a room. The
audio engine instance lives on `AppState` regardless of room
state, so the persistence path works identically from either
entry point.

### Added — Hardware IO buffer size in Settings

New "硬件缓冲块大小" section. Lets the user pick from typical
low-latency buffer sizes (32 / 64 / 96 / 120 / 128 / 240 / 256 /
480 / 512 / 1024 / 2048 / 4096 frames), filtered against the
device's actual `kAudioDevicePropertyBufferFrameSizeRange`.
Default 120 frames (2.5 ms = 1 wire frame) for USB pro
interfaces; MacBook builtin typically clamps to 256+. The choice
is persisted (`tonel.audio.hwBufferFrames`) and re-applied on
the next `start()`. Live-readback of the actual applied value
shown so users can see clamping behaviour.

| File | Change |
|------|--------|
| `Tonel-MacOS/TonelMacOS/Views/RoomView.swift` | `SettingsSheet` adds buffer-size + sample-rate persistence + sample-rate-pick logic; `.onAppear` seeds picker state from `UserDefaults` |
| `Tonel-MacOS/TonelMacOS/Views/HomeView.swift` | drops `HomeSettingsSheet` placeholder, presents `SettingsSheet` from home too |
| `Tonel-MacOS/project.yml` | `MARKETING_VERSION` 0.1.2 → 0.1.3 |

## [5.1.26] - 2026-05-06

### Fixed — Tonel-MacOS regression: NWConnection blocked by Clash-style proxies

`Tonel-MacOS/TonelMacOS/Network/MixerClient.swift` on `main` was using
`NWConnection` (Apple Network framework) for the mixer TCP control
channel. On any Mac running Clash / mihomo / similar transparent
proxies (PF/utun-based traffic interception), the connection silently
timed out — the proxy black-holes / re-routes Network framework
flows but lets BSD raw sockets through. Web users were unaffected
because their TLS WSS path is on the proxy whitelist; desktop users
saw "服务器错误: connect timeout" with no other diagnostic.

Restored the POSIX raw-socket implementation that was on the
`tonel-macos` branch (`Darwin.socket(AF_INET, SOCK_STREAM, 0)` +
`Darwin.send` / `Darwin.recv` on a dedicated `Thread`). UDP audio
transport stays on `NWConnection` for now — if the same proxy issue
shows up there, it'll need the same treatment.

Also restored the desktop `Endpoints.mixerHost = "8.163.21.207"`
(Aliyun) per `project_desktop_client` memory; main had it pointing
to the kufan box (`42.240.163.172`) which is unreachable from the
typical CN home-broadband path.

### Added — Audio Debug panel: live tunable knobs (3-tap room id)

The macOS `AudioDebugSheet` was readout-only, while web has had
slider tuning since v4.x. Brought it to feature parity for the
knobs that actually map to the desktop pipeline:

- `clientPrimeMin` (1…16 fr) — `JitterBuffer` cold-start prime
  threshold. Backed by `static var` on `JitterBuffer` so live
  edits apply across all per-peer buffers without recreating them.
- `serverJitterTarget` (1…16 fr) — server per-user jitter buffer
  depth target. Sends `MIXER_TUNE` over TCP 9002.
- `serverJitterMaxDepth` (1…64 fr) — server per-user jitter buffer
  cap. Same `MIXER_TUNE` plumbing.

Web's three rate-scaling knobs (`maxScale`/`minScale`/`rateStep`)
have no destination on desktop because CoreAudio drives the output
clock — they're intentionally not exposed.

`AppState.joinRoom` calls `AudioEngine.syncServerTuningFromMixer()`
once after `MIXER_JOIN_ACK` so sliders open at the actual server
defaults; the sheet's `onAppear` does NOT re-sync, which avoids
clobbering user edits when the panel is reopened mid-session.

### Changed — e2e latency formula aligned with web `audioE2eLatency`

Two of the seven terms in `AudioEngine.computeE2eLatencyMs()` were
off-by-half-frame relative to the web client, and the client-jitter
term was a static `primeMin × frameMs = 5 ms` constant that never
moved regardless of actual buffer fill.

| Term         | Before                      | After                                          |
|--------------|-----------------------------|------------------------------------------------|
| server-jitter | `target × frameMs`          | `(target − 0.5) × frameMs` (avg wait)          |
| server-tick   | `frameMs / 2` (half tick)   | `frameMs` (full tick)                          |
| client-jitter | `primeMin × frameMs` static | `currentJitterDepthFrames() × frameMs` live    |

Sum of `server-jitter + server-tick` is unchanged — the split is
just relabeled to match web. The client-jitter change is the one
that matters: the reported e2e number now floats with real buffer
depth instead of staying linear in RTT alone, so the desktop number
behaves like web's (still differs in absolute value because device
HAL latency is included on desktop and not on web).

### Removed — Top-right login chip in HomeView

`CornerLoginView` was a phone-stub that only ever set an ephemeral
userId — the same userId that `joinRoom` mints on demand. It added
a side-effect (UI flips to "已登录") that confused debugging when
join failed silently. Removed; `joinRoom` still mints uid so phone
login is not required to enter rooms.

### Changed — POSIX `sendPing` timestamps RTT after `Darwin.send`

`MixerClient.sendPing` was stamping `pingSentAt` before the
`tcpWriteQueue.async` hand-off, so the measured RTT included the
queue wakeup latency. Moved the timestamp into the dispatched
block, immediately after `Darwin.send` returns (kernel has
accepted the bytes). Sub-millisecond improvement under typical
load, larger under contention.

### Memory

New: `project_macos_posix_socket.md` — records the POSIX-vs-
NWConnection failure mode and the hard rule that desktop must
not switch back to Network.framework. Index entry added to
`MEMORY.md`.

### Files

| File | Change |
|------|--------|
| `Tonel-MacOS/TonelMacOS/Network/MixerClient.swift` | NWConnection → POSIX socket impl |
| `Tonel-MacOS/TonelMacOS/Network/Endpoints.swift` | `mixerHost` → 8.163.21.207 (Aliyun) |
| `Tonel-MacOS/TonelMacOS/Audio/AudioEngine.swift` | e2e formula align + tuning Published mirrors + `currentJitterDepthFrames` |
| `Tonel-MacOS/TonelMacOS/Audio/JitterBuffer.swift` | `primeMin` `static let` → `static var` |
| `Tonel-MacOS/TonelMacOS/Views/RoomView.swift` | `AudioDebugSheet` rebuilt with sliders |
| `Tonel-MacOS/TonelMacOS/Views/HomeView.swift` | Drop `CornerLoginView` chip |
| `Tonel-MacOS/TonelMacOS/App/AppState.swift` | call `syncServerTuningFromMixer` after join + diagnostic AppLogs |
| `Tonel-MacOS/project.yml` | `MARKETING_VERSION` 0.1.1 → 0.1.2 |

## [5.1.25] - 2026-05-05

### Fixed — `/hk` couldn't enter rooms (signaling on dead host)

After v5.1.24 fixed the URL-stays-on-`/hk` issue, room entry still
failed because `signalService.ts` only knew about `/new` for picking
the signaling host — `/hk` fell through to `api.tonel.io`, which is
the CF Tunnel CNAME for the now-banned 酷番云 box. Connection 530
on every WS open.

Fix in three parts:

1. **Web client.** `signalService.ts` extended to a three-way path
   table mirroring audioService.ts / mixerRttProbe.ts:
     - `/`    → `api.tonel.io`
     - `/new` → `api-new.tonel.io`
     - `/hk`  → `api-hk.tonel.io`

2. **HK box nginx.** New `ops/nginx/api-hk.tonel.io.conf` proxies
   `/signaling` directly to `127.0.0.1:9004` (ws-proxy → signaling
   :9001). HK doesn't run cloudflared, so this serves the role the
   CF Tunnel ingress plays on Aliyun/kufan.

3. **TLS cert.** `srv.tonel.io` SAN cert expanded to also cover
   `api-hk.tonel.io` (now: srv + srv-hk + api-hk; one renewal updates
   all three).

#### DNS (operator action)

Added `api-hk.tonel.io  A  38.76.186.215` (DNS only / grey cloud).
Without this the cert presents fine but the browser can't resolve.

## [5.1.24] - 2026-05-05

### Fixed — `/hk` URL got immediately rewritten to `/` on first paint

v5.1.22 added `/hk` to `audioService.ts` + `mixerRttProbe.ts` host
routing, but missed the URL-sync logic in `App.tsx`:

- `pathPrefix()` only knew about `/new` — for `/hk` it returned `''`.
- `parseRoomPath` regex only matched `(?:\/new)?\/room\/<id>`, not
  `\/hk\/room\/<id>`.

Result: visiting `tonel.io/hk` triggered the `useEffect` at
`App.tsx:180` on mount, which computed `targetPath = '/'` (since
prefix was empty and roomId was '') and `pushState`'d the URL back
to `/` within milliseconds. UX: **browser appeared to redirect to
home immediately**.

Fix: extend `pathPrefix` return type to `'/new' | '/hk' | ''` and
extend `parseRoomPath` regex to `(?:\/(?:new|hk))?\/room\/...`.
Symmetric with how `/new` was handled before.

## [5.1.23] - 2026-05-05

### Fixed — v5.1.22 deploy aborted on the fresh HK box

Two real bugs in the v5.1.22 `deploy/server.sh` `deploy_ops()`
rewrite, both surfaced on the very first deploy to the HK box:

1. **`warn` is a local function, not a remote command.** The remote
   ssh_exec heredoc invoked `warn '[ops] nginx -t failed ...'` which
   only existed in `deploy/lib/common.sh` on the operator's machine,
   not on the box. Replaced with `echo "[ops] WARN: ..."`.

2. **Blind symlink for all four nginx sites.** The fresh HK box only
   has the `srv.tonel.io` SAN cert (covers `srv.tonel.io` +
   `srv-hk.tonel.io`), not the certs `srv-new.tonel.io` (Aliyun)
   or `tonel.io` (legacy CF Pages origin) reference. `nginx -t`
   immediately failed when those symlinks pointed at config files
   whose `ssl_certificate` paths didn't exist.

   Fix: `deploy_ops` now self-heals — for each of the four known
   nginx confs, it parses out the `ssl_certificate` path, checks
   whether that file exists on the remote, and only enables the
   symlink if so (or if the conf has no ssl_certificate line at
   all). Boxes auto-converge to the right subset.

This also unblocks future first-time deploys to any new region,
not just HK — the same self-heal logic applies regardless.

## [5.1.22] - 2026-05-05

### Changed — primary backend moved from 酷番云广州 to HK (cognetcloud)

The previous primary at 酷番云 (`42.240.163.172`) was banned by the
IDC's compliance scan on 2026-05-04: all TCP ports were RST'd from
the public internet while ICMP stayed up — the classic 中国 IDC
封禁 signature for hosting a non-备案 foreign TLD (`.io`). Rather
than wait 1-2 weeks for `tonel.cc` ICP filing, this release moves
the primary backend to a new HK box (`38.76.186.215`). HK doesn't
require ICP filing; estimated end-to-end latency increase for
mainland users is +15-30 ms (跨境 link, no further amplification
since traffic stays out of GFW filter chains).

Aliyun (`8.163.21.207`) keeps serving the `/new` fallback path AND
the Tonel-MacOS desktop client (raw UDP 9003) — no change.

#### New `/hk` URL path for staged validation

Added a third routing tier to the web client (mirrors the
`/`+`/new` pattern from v5.0.0):

  | path  | host                  | server     |
  | ----- | --------------------- | ---------- |
  | `/`   | `srv.tonel.io`        | 酷番云 (DNS still here, will flip to HK) |
  | `/new`| `srv-new.tonel.io`    | Aliyun fallback |
  | `/hk` | `srv-hk.tonel.io`     | HK new prod (validation) |

`/hk` lets users opt into the HK box explicitly before `srv.tonel.io`
DNS is flipped. After validation clears, DNS flips and `/hk` becomes
redundant (will be removed in a follow-up release).

`audioService.ts` and `mixerRttProbe.ts` updated symmetrically.

#### Deploy tooling — HK-aware

- `deploy/.env.deploy` re-pointed to HK (was 酷番云). The kufan
  target is now reachable only via inline override.
- `deploy/lib/common.sh`: `ENV_FILE` is now overridable from the
  environment (`ENV_FILE=deploy/.env.deploy.aliyun deploy/server.sh`).
- `deploy/server.sh` `deploy_ops()`:
  - Picks up `ops/nginx/srv-hk.tonel.io.conf` automatically.
  - `TONEL_CF_TUNNEL_ID` empty → entire cloudflared block is
    skipped (HK doesn't use CF Tunnel; nginx terminates 80/443).
  - `nginx -t` failure on first deploy now warns instead of aborts
    (certs may not yet exist on a fresh box).
- New `ops/nginx/srv-hk.tonel.io.conf` — mirror of
  `srv.tonel.io.conf` with `server_name srv-hk.tonel.io`. Uses the
  same `srv.tonel.io` cert lineage (SAN cert covers both names) so
  one certbot renewal updates both.

#### Pretest skipped (justified)

Pretest was `SKIP_PRETEST=1` for this release because its Layer 3
health check pings the production endpoint, which is the very thing
this release is fixing — there's no useful state to validate against.
Layer 1/1.5/2 audio tests remain run-locally and are clean.

## [5.1.21] - 2026-05-04

### Fixed — homepage hero RTT showing ~2× the in-room RTT

After v5.1.20 swapped the homepage probe to WSS PING/PONG (identical
algorithm to the in-room RTT strip), the displayed homepage number
was still ~10 ms above the in-room number — e.g. in-room 8 ms →
homepage 18 ms, in-room 12 ms → homepage 22 ms. User noticed it
looked roughly **twice** the in-room reading on fast networks and
asked why.

Cause: a leftover `kAudioPathOffsetMs = 10` constant in
`HomePage.tsx`. v5.1.5 added it on top of the (then-network-only)
RTT to make the hero figure approximate "end-to-end minus output
device". v5.1.20 switched the underlying probe to be the **same**
algorithm as the in-room RTT strip but kept the +10. Result: hero
displayed RTT + 10, which is no longer what the user wants.

Fix: remove the `+10` offset. Display the raw mixer PING/PONG round
trip, exactly as in-room does. The two numbers will now agree within
network jitter (~±2 ms), never differ by a fixed +10.

#### Files

| File | Change |
|---|---|
| `web/src/pages/HomePage.tsx` | `LiveLatency`: drop `kAudioPathOffsetMs` constant + every `+ kAudioPathOffsetMs` term in the `setMs` calls |

## [5.1.20] - 2026-05-04

### Changed — homepage hero RTT now uses the same algorithm as in-room

User asked for the homepage's giant latency number to match the in-room
RTT shown in `RoomPage`'s latency strip — same algorithm, same wire
protocol, same number — but **independently measured** (not by reading
in-room state).

#### Implementation

* `mixerRttProbe.ts` switched back from `fetch('/')` (v5.1.10–.19) to
  WSS PING/PONG against `/mixer-tcp`, which is exactly what
  `audioService` uses for its in-room RTT (see `startPing` and the
  `PONG` handler in `audioService.ts`). Send `{type:"PING"}\n` every
  3 s, time the `{type:"PONG"}` reply with `performance.now()`.
* The probe owns its own WebSocket; in-room code owns its own. No JS
  data-flow link between them — they just happen to send identical
  frames over identical URLs and so produce identical RTT numbers.
* `mixerRttProbe.stop()` returns `Promise<void>` that resolves only
  when the WebSocket has actually reached `CLOSED` (with a 500 ms
  safety timeout). This was the v5.1.7 fix; we needed it again because
  going back to WSS-based probe brings back the kufan upstream DPI's
  "two concurrent WSS handshakes to /mixer-tcp from same IP" trip
  wire if probe and audioService races.
* `App.tsx`'s `handleCreateRoom`, `handleJoinRoom`, and `submitDeepLink`
  now `await mixerRttProbe.stop()` *before* calling `setPage('room')`,
  so the homepage probe socket is fully off the wire before
  `RoomPage`'s mount triggers `audioService.connectMixer`. (This
  was the missing step that v5.1.6 → v5.1.8 each tried in vain — they
  hooked the stop inside `connectMixer` itself, which is too late.)

The result: same number on home and in-room, identical algorithm,
no race.

### Changed — hero RTT number colour: white → green

User-facing tweak: the giant `.v1-num` (desktop) and `.v1m-num`
(mobile) numbers are now `#4ade80` (the "good" latency tier colour
already used elsewhere on the page and in the in-room latency strip),
making the visual story "low number = green = good" consistent across
the whole app.

### Files

| File | Change |
|---|---|
| `web/src/services/mixerRttProbe.ts` | Replaced fetch-based implementation with WSS PING/PONG; `stop()` returns Promise resolving on WS CLOSED |
| `web/src/App.tsx` | `handleCreateRoom` / `handleJoinRoom` / `submitDeepLink` `await mixerRttProbe.stop()` before `setPage('room')` |
| `web/src/styles/globals.css` | `.v1-num` and `.v1m-num` colour `#fff` → `#4ade80` (green) |

## [5.1.19] - 2026-05-04

### Removed — dead WebRTC / P2P code paths across server, web, and macOS

Sweep companion to v5.1.18 (which deleted the legacy desktop client
dirs and rewrote docs to drop P2P narrative). v5.1.19 removes the
matching dead code that was still in the source tree.

#### Server (`signaling_server`)

* **Deleted handlers**: `MIXER_REGISTER`, `MIXER_OFFER`, `MIXER_ICE`,
  `MIXER_ANSWER`, `MIXER_ICE_RELAY` — these were the relay endpoints
  for a discontinued `webrtc-mixer-proxy` architecture (last touched
  early 2026, never live in production for years). No active client
  sends these messages.
* **Removed `mixer_ctx_` member** + the `WebRTC mixer proxy disconnected`
  branch in `on_close`. The whole "mixer proxy registers itself" flow
  is gone.
* **Removed `User::ip` and `User::udp_port`** — they were "client's
  advertised IP/port for P2P punch-hole". The mixer-only architecture
  doesn't use them. `process_join_room` no longer takes `ip`/`port`
  arguments. `SimpleJson::ip`, `SimpleJson::port`, and
  `SimpleJson::extract_int` are gone.
* **Simplified `make_peer_list`** — now takes `vector<string>` instead
  of `vector<tuple<string,string,int>>`; serialized PEER_LIST now emits
  `[{"user_id":"..."}]` instead of `[{"user_id":"...","ip":"...","port":N}]`.
* **Simplified `make_peer_joined`** — drops `ip`/`port` arguments;
  emitted PEER_JOINED is now `{type, room_id, user_id}` only.
* Trimmed unused `<memory>` and `<vector>` includes from the header.

#### Web client

* **Deleted `signalService` mixer-relay senders**: `sendMixerOffer()`,
  `sendMixerIce()` removed. Their wire types `MIXER_ANSWER` /
  `MIXER_ICE_RELAY` removed from the `SignalMessage` union.
* **`signalService.joinRoom` signature**: dropped `ip` and `port`
  parameters. Callers in `App.tsx` (`handleJoinRoom`, `submitDeepLink`)
  and `useSignal.joinRoom` updated accordingly.
* **`PeerInfo` type cleaned**: dropped `ip` and `port` fields. Also
  deleted the unused exported types `IceCandidateMessage`, `RTCConfig`,
  `RoomMember`, `SignalingMessage`, `JoinRoomMessage`,
  `PeerListMessage`, `PeerJoinedMessage`.
* **`useSignal` hook**: removed type-cast boilerplate that worked
  around the now-gone polymorphic `SignalingMessage` interface; the
  `SignalMessage` discriminated-union is enough for TypeScript to
  narrow each branch correctly.
* **Stale TODO comment removed** from `audioService.handleMixerMessage`
  ("RTT measurement disabled — Will re-implement"). RTT IS in fact
  measured on the control channel via `startPing`/PONG; the TODO was
  about a different historical attempt, no longer accurate.

#### macOS client (`Tonel-MacOS`)

* `PeerInfo` struct dropped `ip` and `port` fields.
* `joinRoom()` and the reconnect-replay JOIN_ROOM no longer send
  `ip: "0.0.0.0"`, `port: 9003` placeholders.
* `parsePeer` and the PEER_JOINED parser no longer read `ip`/`port`
  from the wire.

#### Wire-protocol compatibility

A long-running deployed server gracefully ignores `ip`/`port` fields
on incoming `JOIN_ROOM` messages — older clients (if any) keep working.
A long-running deployed client gracefully tolerates missing `ip`/`port`
fields on PEER_LIST / PEER_JOINED — older servers (if any) also keep
working. Therefore: **no coordinated client/server upgrade required**.

### Files

| File | Change |
|---|---|
| `server/src/signaling_server.{h,cpp}` | Dropped `mixer_ctx_`, all `MIXER_*` relay handlers, `extract_int` JSON helper, `ip`/`port` from `SimpleJson` and `process_join_room`/`make_peer_*`. Tightened includes. |
| `server/src/user.h` | Dropped `ip` / `udp_port` from `User`. |
| `web/src/types/index.ts` | Trimmed `PeerInfo`; deleted unused `SignalingMessage` / `JoinRoomMessage` / `PeerListMessage` / `PeerJoinedMessage` / `IceCandidateMessage` / `RTCConfig` / `RoomMember` exports. |
| `web/src/services/signalService.ts` | Trimmed `SignalMessage` union; dropped `sendMixerOffer`/`sendMixerIce`; `joinRoom` no longer takes `ip`/`port`; reconnect replay drops the placeholder fields. |
| `web/src/hooks/useSignal.ts` | Dropped `SignalingMessage` import + the polymorphic-cast boilerplate. `joinRoom` signature updated. |
| `web/src/App.tsx` | `handleJoinRoom` / `submitDeepLink` no longer pass `'0.0.0.0'`/`9003`. |
| `web/src/services/audioService.ts` | Stale TODO comment about disabled RTT measurement reworded to describe the actual current setup. |
| `Tonel-MacOS/TonelMacOS/Network/SignalClient.swift` | `PeerInfo` shrunk; `joinRoom` and reconnect replay no longer send `ip`/`port`; PEER_JOINED + PEER_LIST parsers simplified. |

No runtime change visible to users.

## [5.1.18] - 2026-05-04

### Removed — legacy desktop clients + outdated documentation

`Tonel-Desktop/` (the JUCE-based original client) and
`Tonel-Desktop-AppKit/` (the ObjC++ rewrite) deleted entirely. The
SwiftUI **`Tonel-MacOS/`** is now the only desktop client and has
been since v5.0.x — these dirs were stale, took up space, and
multiple docs still claimed `Tonel-Desktop-AppKit` was "current
production". With this release, the repo's reality matches what's
actually shipping.

`bump-version.sh` no longer syncs to the deleted `Tonel-Desktop-AppKit/CMakeLists.txt`
(removed). Root `CMakeLists.txt` no longer prints "build via
Tonel-Desktop-AppKit" hint (replaced with current per-module build
commands).

### Documentation rewrite

A complete sweep of all top-level Markdown to remove three classes
of outdated content:

1. **References to multiple desktop clients** — replaced with the
   single Tonel-MacOS narrative.
2. **P2P / WebRTC mesh as an active mode** — production has been
   mixer-only since v3.x. Remaining server-side `MIXER_OFFER`/`P2P_*`
   handlers are documented as dead-code; no active client opens
   `RTCPeerConnection`. Architecture is **always a star through the
   mixer**.
3. **Aliyun as primary** — wrong since v5.0.0 (2026-04-30). Primary
   is **酷番云广州 (42.240.163.172)**; Aliyun is the `tonel.io/new`
   fallback path running the same code from this same repo.

### Files

| File | Change |
|---|---|
| `Tonel-Desktop/` (whole dir) | **Deleted** |
| `Tonel-Desktop-AppKit/` (whole dir) | **Deleted** |
| `CMakeLists.txt` | Build-hint comments updated to current modules |
| `scripts/bump-version.sh` | Removed `Tonel-Desktop-AppKit/CMakeLists.txt` from sync set |
| `deploy/.env.deploy{,.example}` | Comments no longer claim Aliyun is "AppKit接入点" |
| `README.md` (root) | Rewrote module table, removed P2P/Mixer mode matrix, removed Mini/Pro JUCE editions table |
| `docs/ARCHITECTURE.md` | Full rewrite — mixer-only topology, two-server architecture, kufan-as-primary, kufan-DPI mitigations summary, v5 latency-roadmap recap |
| `docs/SPA1_PROTOCOL.md` | Full rewrite — removed `P2P_OFFER`/`P2P_ANSWER`/`P2P_ICE`/`MIXER_REGISTER`/`MIXER_OFFER`/`MIXER_ANSWER`/`MIXER_ICE_RELAY` sections; current frame size 2.5 ms (was documented as 5 ms); added PLC-fired flag, in-room mixer control messages |
| `docs/DEVELOPMENT.md` | Bump-version table dropped AppKit/JUCE rows; build instructions point at Tonel-MacOS; AppKit code-style section dropped; network-arch line says "Tonel-MacOS" instead of "AppKit" |
| `deploy/README.md` | "AppKit接入点" wording dropped; Tonel-MacOS naming used for the native client |
| `ops/README.md` | "v5.0.0+ migration" section reframed as steady-state two-server architecture |
| `server/README.md` | `signaling_server` description no longer mentions P2P SDP exchange |
| `web/README.md` | Updated tech stack table (AudioWorklet, not ScriptProcessor; HTTPS-fetch RTT probe), point at `server/proxy/` for proxies |
| `libs/README.md` | JUCE section deleted; miniaudio repurposed as "available for future cross-platform work, not used by Tonel-MacOS" |
| `Tonel-MacOS/README.md` | Now described as "the only desktop client"; legacy-AppKit cross-references dropped |

No code/runtime change.

## [5.1.17] - 2026-05-04

### Changed — explicit pacing between consecutive new connections to kufan

Belt-and-suspenders against the kufan upstream DPI's burst-detection
heuristics. Two existing back-to-back new-connection sites had only a
few-ms or one-RTT gap between them — well within the window most
"too many new connections from this IP" rules look at. Adding small
explicit delays so each new TCP+TLS handshake lands in a clearly
separate evaluation window:

* **`mixerRttProbe.stop()` → `new WebSocket(controlUrl)`**: 100 ms.
  When the user clicks 创建房间 from the homepage, the probe's last
  `fetch('/')` may have hit `srv.tonel.io` within the prior 0-5 s and
  its underlying HTTP/2 connection is still in the browser's pool.
  `connectMixer` previously opened the WSS upgrade within a few ms of
  `mixerRttProbe.stop()`. The 100 ms gap gives the lingering connection
  a chance to actually drain before the new TLS handshake hits the
  wire. WT path (only `/new`) skips this delay — `tryWebTransport`
  there already burns tens-to-hundreds of ms doing its own handshake.

* **`controlWs.onopen` → `audioWs` open**: 80 ms. v5.1.10 split these
  by sequencing audio after control's `onopen`, but that meant the
  audio TLS handshake hit the wire one network RTT (~10 ms) after
  the control one. 80 ms keeps them clearly separate.

Total room-entry overhead: +180 ms (only on `/`, not `/new`).
Imperceptible to the user; well below any audio-latency budget; pure
upside if the DPI's heuristic actually has a sliding-window component.

#### Files

| File | Change |
|---|---|
| `web/src/services/audioService.ts` | `connectMixer`: 100 ms wait before `new WebSocket(controlUrl)` on WSS path; `controlWs.onopen` → `openAudioWs` deferred 80 ms |

## [5.1.16] - 2026-05-04

### Removed — "混音服务器连接失败" red banner; replaced with silent
### infinite-retry + subtle "正在连接服务器…" indicator

User feedback after v5.1.15: the 3-attempt-internal retry covers most
intermittent kufan-DPI hits, but when all 3 fail the user still saw the
alarming red banner. Clicking 启用麦克风 always worked because by then
the DPI rule had passed — i.e. the banner is purely a side effect of
the failure path, not actionable. The user explicitly asked: "能取消
这样的错误提示吗？"

Today's pcap-evidenced architectural diagnosis (also recorded as the
basis for this change):

* The kufan VM is **internally completely clean** — `iptables`,
  `nftables`, `ipset`, `eBPF`/XDP, `tc`, no cloud-provider security
  agents. Single `nf_tables` kernel module loaded but zero rules.
* RSTs are injected at a **device upstream of the VM** (machine room
  switch / hypervisor / edge firewall — somewhere in kufan's network
  before our kernel gets the packet). The smoking-gun signature: an
  RST arrives ~4 µs after the VM ACKs the client's TLS ClientHello,
  bearing the client's source IP but with **TCP options
  `[nop,nop,nop,eol]` and no TCP timestamp**, which no real Linux/
  macOS TCP stack would produce.
* A multi-vantage curl test (kufan-self / Aliyun-cross-cloud /
  US-laptop) showed: kufan-self 10/10 OK, Aliyun-curl 10/10 RST after
  ClientHello, US-laptop 10/10 SYN never even reached the VM (L3
  block at GFW or kufan edge).
* Banner CODE has been there since v3.3.0 — what changed is the
  v5.0.0 (2026-04-30) production migration from Aliyun (no DPI) →
  kufan (this DPI). AppKit is unaffected because it's hardcoded to
  the Aliyun box and uses raw TCP/UDP, not WSS.

#### What this release changes

* `RoomPage.runInit` now wraps `audioService.connectMixer` in an
  **unbounded retry loop** with exponential backoff capped at 30 s.
  The loop bails out only on component unmount (`cancelledRef`).
* While that loop is dialing, the page shows a subtle slate-blue
  status line `● 正在连接服务器…` (pulsing yellow dot) at the top —
  one CSS line, no buttons, no jarring red.
* The red banner is **only** shown for mic-permission failures
  (`NotAllowedError` etc.) — those genuinely require user action.

#### Files

| File | Change |
|---|---|
| `web/src/pages/RoomPage.tsx` | `runInit` mixer-connect path becomes a silent retry loop with exp backoff. New `mixerConnecting` state + `cancelledRef`. New subtle "正在连接服务器…" status line; red banner now reserved for mic-permission failures only |

The kufan upstream RST issue itself is **not** fixed by this release —
that requires either a kufan-side ticket to disable their TLS DPI
appliance, or DNS-A switch back to Aliyun (the v5.2.0 plan, on hold
pending operator decision). v5.1.16 just makes sure the user never
sees it again.

## [5.1.15] - 2026-05-03

### Fixed — silent same-host retry on transient WSS Upgrade drops

User on `tonel.io/` (kufan path) reported `Control WebSocket 连接失败`
intermittently. Server-side investigation:

```
Server time 23:19:54
User IP /mixer-tcp attempts since 21:48:
  21:48:15  101 ✅
  22:19:04  101 ✅
  22:19:29  101 ✅
  22:19:34  101 ✅
  22:38:38  101 ✅
  23:16:50  101 ✅ (8KB session — real audio activity)
```

100% of WS Upgrades that **reached** nginx in the last ~90 minutes
were upgraded successfully (status 101). At the same time the user
was clearly seeing failures in the browser. Conclusion: occasional
WS Upgrade requests are dropped in transit between the client ISP
and the kufan public IP — the browser surfaces an `onerror` Event
with no HTTP status, and nginx never sees the request to log it.
Plain HTTPS to the same host (e.g., the homepage RTT probe's
`fetch('/')`) keeps working through the same network path,
suggesting the drop is specific to the WS Upgrade pattern (or
intermittent enough that it correlates with whichever request
happens to be in flight when the network blip occurs).

This is not something we can fix server-side (the request never
arrives) and per v5.1.14 we are not adding cross-host failover
(operator decision — kufan and Aliyun are separate products).
The user-visible mitigation that fits the constraint is a
**silent same-host retry**: `connectMixer` now wraps its
single-attempt body in a 3-attempt loop with 800 ms backoff,
re-targeting the same host each time. A user transiently dropped
on attempt 1 sees attempt 2 succeed and never knows. Only if all
three attempts fail does the red banner appear.

#### Files

| File | Change |
|---|---|
| `web/src/services/audioService.ts` | `connectMixer` becomes a retry loop around `connectMixerOnce`. Up to 3 attempts, 800 ms delay between, same host throughout |

## [5.1.14] - 2026-05-03

### Reverted — auto-fallback (v5.1.12 + v5.1.13)

Operator decision: the kufan and Aliyun mixer servers are independent
products with different intended audiences. `/` traffic is allocated
to kufan and `/new` traffic to Aliyun on purpose; transparent
cross-host failover would mix the two segments. Reverting the
v5.1.12 host-picker + v5.1.13 retry-on-WSS-error so each path stays
on its assigned server, full stop.

When kufan blocks a client IP at its hypervisor layer (the recurring
issue we tried to paper over), the right fix lives in the kufan
console (DDoS thresholds, IP allow-list, connection-rate limits) —
not in the web client.

#### Files

| File | Change |
|---|---|
| `web/src/services/mixerHost.ts` | **Deleted** (added v5.1.12) |
| `web/src/services/audioService.ts` | `connectMixer` reverted to a single attempt; host comes from the URL path (`/new` → Aliyun, else kufan). No retry on WSS error |
| `web/src/services/mixerRttProbe.ts` | Probe host comes from the URL path (same rule); no host-picker |
| `web/src/pages/RoomPage.tsx` | Drop the fallback-engaged hint banner (no longer reachable) |

The good v5.1.11 fixes — probe target `/` instead of `/mixer-tcp`, and
the v5.1.10 sequential `controlWs → audioWs` open — both stay.

## [5.1.13] - 2026-05-03

### Fixed — auto-fallback now retries on the OTHER host on WSS error

v5.1.12 picked the host via a `fetch('/')` probe and then opened the
WSS — but probing GET / and probing WSS Upgrade are different requests
through the kufan hypervisor, and `GET /` could succeed when the WSS
upgrade was still being dropped. Test runs showed 1/3 sessions
landing on a probe-good but WSS-bad cached choice, surfacing the
same red banner the v5.1.12 fallback was supposed to prevent.

#### Fix

`audioService.connectMixer` now treats the host as a per-attempt
choice rather than a one-shot pick:

1. Try `pickMixerHost()` (cached or freshly probed).
2. If `controlWs.onerror` or `audioWs.onerror` fires, invalidate the
   cache and **retry once on the other host** within the same
   `connectMixer` call — the user never sees the failure.
3. Once a host actually succeeds (both transports ready), call
   `recordWorkingHost(host)` so subsequent connects + the homepage
   RTT probe head straight there.

The probe is now an optimisation (skip the dead host on the first
try where possible), not the source of truth — actual WSS health is.

`?host=kufan` / `?host=aliyun` query overrides still bypass the
fallback for explicit testing.

#### Files

| File | Change |
|---|---|
| `web/src/services/audioService.ts` | Split `connectMixer` into a wrapper that loops over `[primary, fallback]` hosts, plus `_connectMixerToHost(host)` that opens against a single host and rejects cleanly on either `*WebSocket 连接失败` |
| `web/src/services/mixerHost.ts` | `recordWorkingHost(host)` to persist a host that actually completed a WSS handshake |

## [5.1.12] - 2026-05-03

### Added — auto-fallback from kufan to Aliyun on connect failure

User reported that even after v5.1.11 the homepage probe + WSS
handshake to `srv.tonel.io` were both failing with `net::ERR_CONNECTION_RESET`.
Server-side investigation confirmed:

* OS layer is identical between kufan and Aliyun (same Debian 12,
  nginx 1.22.1, sysctl, srv.tonel.io.conf, certs, and PM2 process
  set). The only differences are benign (Aliyun has ufw active +
  aliyun-assist, neither RSTs traffic).
* No iptables / nft rules, no fail2ban, no nginx limit_req on
  either box. Nothing on the kufan VM is rejecting the user's IP.
* nginx access.log on kufan shows the user's IP IP getting **no
  recent connections at all** — the TLS handshake never reaches the
  OS. The RST is happening above the VM, in 酷番云's hypervisor /
  virtual network layer (which the v4.3.11 UDP-burst incident
  already established has its own quirky behaviour).

We have no inside-the-VM knob for that block. The earlier v5.1.10
fetch probe to `/mixer-tcp` (which hung server-side) most likely
tripped the kufan auto-block by leaking half-open connections every
3 seconds for several minutes. The block is timer-based; it expires
on its own in tens of minutes.

Without app-level fallback, every kufan-side block makes `tonel.io/`
totally unusable for affected users until kufan's timer expires.

#### Fix

* New `web/src/services/mixerHost.ts` — `pickMixerHost()` probes
  `srv.tonel.io` first via a short `fetch('/')`; if it errors out at
  the TLS layer, returns `srv-new.tonel.io` instead. The choice is
  cached in `localStorage` for 10 minutes so subsequent connects
  within a session don't pay the probe cost. When the cache expires,
  we re-probe and organically flip back to kufan if it's healthy.
* `audioService.connectMixer` now uses `pickMixerHost()` instead of
  hardcoding the host. Both `controlWs` and `audioWs` (and the WT
  URL) follow the picked host. On a `controlWs.onerror`, the cache
  is invalidated so the user-driven retry re-probes.
* `mixerRttProbe` uses the same picker — homepage hero RTT and
  in-room WSS handshake never disagree about which box they're
  talking to.
* `RoomPage` shows a soft blue hint when the fallback host is in
  use ("已自动切换至备用服务器") so the user knows what's happening
  without seeing a red error banner.

`?host=kufan` and `?host=aliyun` query overrides bypass the picker
for explicit testing.

#### Files

| File | Change |
|---|---|
| `web/src/services/mixerHost.ts` | New — host picker with probe + 10-min cache |
| `web/src/services/audioService.ts` | `connectMixer` calls `await pickMixerHost()`; `controlWs.onerror` invalidates the cache |
| `web/src/services/mixerRttProbe.ts` | Probe URL host comes from `pickMixerHost()` |
| `web/src/pages/RoomPage.tsx` | Soft hint banner when `isUsingFallbackHost()` is true |

## [5.1.11] - 2026-05-03

### Fixed — v5.1.10's probe was leaking hung connections to kufan

User reported `Control WebSocket 连接失败` was still happening on
`tonel.io/` (Chrome and Safari both) after v5.1.10. Diagnosis:

```
$ curl --max-time 5 -w "code=%{http_code} time=%{time_total}s\n" \
       https://srv-new.tonel.io/mixer-tcp
curl: (28) Operation timed out after 5003 milliseconds with 0 bytes received
code=000 time=5.003568s

$ curl --max-time 5 -w "code=%{http_code} time=%{time_total}s\n" \
       https://srv-new.tonel.io/
code=200 time=0.037328s
```

The v5.1.10 probe target — `GET /mixer-tcp` — **hangs forever
server-side**. The nginx site config forces `Connection: upgrade`
upstream for the `/mixer-tcp` location, and a plain GET (no Upgrade
header) leaves `tonel-ws-mixer-proxy` waiting for a WebSocket
handshake that never comes. Each 3-second probe tick leaked one
half-open TCP connection on the kufan box. After a few ticks the
酷番云 hypervisor saw a flood of stuck connections from the same
client IP and started rejecting fresh WSS handshakes from it —
which is exactly the "Control WebSocket 连接失败" the user reported.

The local Playwright probe didn't catch this because:
1. `mode: 'no-cors'` made the hung response indistinguishable from a
   slow response — the abort fired at 5 s but the homepage placeholder
   animation kept ticking, masking the fact that *no real RTT was
   ever measured*.
2. The Aliyun fallback box doesn't exhibit the same connection-flood
   sensitivity, so the room-entry probe still passed 10/10.

#### Fix

* **Probe target**: `/` instead of `/mixer-tcp`. nginx serves a static
  200 in tens of ms with no upstream proxy. RTT measurement is from
  the same physical server, so the displayed figure is ~equivalent.
* **First tick deferred 600 ms**: gives the page a beat to settle so
  the probe never competes with an immediate-click 创建房间.
* **Tick interval 3 s → 5 s**: less wire traffic on a number that's
  cosmetic.
* **Abort timeout 5 s → 2.5 s**: bounds any pathological hang to a
  much tighter window.

#### Files

| File | Change |
|---|---|
| `web/src/services/mixerRttProbe.ts` | Probe target `/`, defer first tick, slower interval, tighter abort |

## [5.1.10] - 2026-05-03

### Fixed — "Audio WebSocket 连接失败" on room entry

After v5.1.9 collapsed the `mixerRttProbe` second socket, the user
still hit `Audio WebSocket 连接失败` on `tonel.io/`. Root cause: even
within `audioService.connectMixer` itself, the control WS (/mixer-tcp)
and the audio WS (/mixer-udp) were created back-to-back synchronously
inside the same Promise constructor — two concurrent WSS handshakes
to the same nginx upstream from the same client IP within a single
millisecond. The酷番云 hypervisor sometimes dropped the second one,
which surfaced as either banner depending on which socket lost the
race.

Fix: open `controlWs` first, and only kick off `audioWs` from
`controlWs.onopen`. The two handshakes are now sequential — adds one
network RTT (~5-15 ms in China) to room-entry time, which is invisible
next to the cost of a failed join. `checkBothReady()` still gates the
final `MIXER_JOIN`/handshake on whichever socket finishes last.

### Re-added — homepage RTT display, this time without a WebSocket

User asked for the live RTT figure on the home page back, but
explicitly **independent** of any room session ("不调用房间的RTT").
The constraint that broke v5.0.3 → v5.1.8 was that the probe opened
a /mixer-tcp WebSocket from the home page that conflicted with
audioService's own /mixer-tcp the moment the user entered a room.

`mixerRttProbe` is back, but it now uses **plain HTTPS `fetch()`**
against `/mixer-tcp` instead of opening a WebSocket. The endpoint
returns nginx's `426 Upgrade Required` on a non-WebSocket GET — fast,
cheap, no upgrade negotiated. Round-trip time of that request is the
displayed value (plus the +10 ms audio-path offset, same as v5.1.5).
Because there is no WebSocket from the home page anymore, there is
literally nothing for `audioService.connectMixer` to race against on
room entry.

#### Files

| File | Change |
|---|---|
| `web/src/services/audioService.ts` | `connectMixer` opens `controlWs` first, then `audioWs` from inside `controlWs.onopen` |
| `web/src/services/mixerRttProbe.ts` | New (replaces the deleted v5.1.9 file). Fetch-based, 3 s tick, abortable, no WebSocket |
| `web/src/pages/HomePage.tsx` | `LiveLatency` re-subscribes to `mixerRttProbe.onLatency`, displays `rtt + 10` |

## [5.1.9] - 2026-05-03

### Removed — `mixerRttProbe` (the real fix for "Control WebSocket 连接失败")

The chain of fixes through v5.1.6 → v5.1.7 → v5.1.8 each tried a
narrower workaround for the same bug: `mixerRttProbe` — a homepage
singleton that opened its **own** WSS to the mixer's `/mixer-tcp`
just to display a more "realistic" RTT figure on the home page —
overlapped with `audioService.connectMixer`'s `/mixer-tcp` socket on
every room entry. The酷番云 hypervisor / WAF in front of nginx saw
two concurrent WSS handshakes to the same path from the same client
and dropped one. v5.1.6 added a synchronous `mixerRttProbe.stop()`
that didn't actually wait for the close. v5.1.7 made it await the
close. v5.1.8 awaited the close on retry-cleanup too. None of them
ever fully eliminated the race window, and v5.1.8's added
complexity made the symptoms worse rather than better — the user
reported "无论怎么点启用麦克风都没办法正常工作" right after it shipped.

The real fix is to delete the second socket. `mixerRttProbe` was a
cosmetic add to the homepage hero figure (introduced in v5.0.3) and
worth far less than reliable room entry. The hero number is now
animated around a static baseline (~22 ms — the typical Tonel
end-to-end latency on a Chinese network); the **real** latency a
user cares about — their own current network, on their own current
device — already lives in the in-room latency strip. After this
release there is exactly one /mixer-tcp socket per client, opened by
audioService when the user joins a room, with nothing to race against.

The `connectMixer` cleanup goes back to the v5.1.5 form: a plain
synchronous `ws.close()` for any leftover transports from a previous
attempt. The await-CLOSED ceremony added in v5.1.8 is unnecessary
once there is no concurrent socket from another part of the app.

#### Files

| File | Change |
|---|---|
| `web/src/services/mixerRttProbe.ts` | **Deleted** (was added v5.0.3, restored v5.1.4) |
| `web/src/pages/HomePage.tsx` | `LiveLatency` no longer subscribes to a probe — plain animated placeholder around a static baseline |
| `web/src/services/audioService.ts` | Drops `mixerRttProbe` import + `await mixerRttProbe.stop()`; reverts v5.1.8's `awaitClose` cleanup ceremony to a plain synchronous `close()` |

## [5.1.8] - 2026-05-03

### Fixed — "click 启用麦克风 twice" on first room entry

User reported that joining a room from the home page consistently
required clicking the 🔄 启用麦克风 retry button **twice** before audio
came up. Banner sequence: navigate to `/room/:id` → see
`麦克风/音频初始化失败:...` → click 启用麦克风 → banner changes to
`混音服务器连接失败：Control WebSocket 连接失败` → click again → finally
clears.

Root cause: same TCP-drain race v5.1.7 fixed for `mixerRttProbe`, on a
different socket. `audioService.connectMixer` cleans up its own
`controlWs` / `audioWs` from a previous attempt with synchronous
`ws.close()` calls, then immediately opens new ones.
`WebSocket.close()` only flips state to CLOSING; the underlying
TCP/TLS takes another 50-200 ms to drain. On the retry-click path the
old socket from the auto-init attempt is still in CLOSING when the
new one opens. The酷番云 hypervisor / WAF in front of nginx sees two
overlapping handshakes to `/mixer-tcp` from the same client and drops
the second — `controlWs.onerror` fires on click 1, banner switches to
the mixer error. Click 2 runs after the old socket has fully drained
and goes through.

Fix: cleanup now awaits both old WS sockets actually reaching CLOSED
(via their `onclose`/`onerror` handlers, with a 500 ms safety timeout)
before any `new WebSocket(...)` runs. Mirrors the v5.1.7 mixerRttProbe
fix exactly.

Note: this does not eliminate the *first*-click need on browsers where
`audioContext.resume()` rejects without a user gesture (the auto-init
in `RoomPage`'s `useEffect`). That gate is a separate browser autoplay
policy interaction and is now what the single retry click is for. The
fix collapses two clicks → one.

#### Files

| File | Change |
|---|---|
| `web/src/services/audioService.ts` | `connectMixer` cleanup awaits old `controlWs` + `audioWs` reaching CLOSED before opening new ones |

## [5.1.7] - 2026-05-03

### Fixed — "Control WebSocket 连接失败" still firing on every room entry

v5.1.6 added `mixerRttProbe.stop()` to `audioService.connectMixer` to
collapse the dual-`/mixer-tcp` overlap, but the fix was racy and the
red banner kept appearing on essentially every join. User confirmed it
fires every time on `tonel.io/`.

Root cause: `mixerRttProbe.stop()` was synchronous, but
`WebSocket.close()` is not — it only flips the socket to CLOSING and
sends a close frame; the underlying TCP/TLS connection takes another
50-200 ms to drain. On `tonel.io/` (kufan, no WebTransport leg), there
is no awaited work between the synchronous `stop()` call and the next
`new WebSocket(controlUrl)` — so the new control socket opens while
the probe's old socket is still in CLOSING state on the wire. Two
in-flight WSS sessions to `/mixer-tcp` from the same client through
the酷番云 hypervisor / WAF: the second handshake gets dropped,
`controlWs.onerror` fires, the user sees the banner. After clicking
the retry, the probe socket has fully drained and the second
`connectMixer` succeeds — which is exactly the always-fail-then-retry
pattern the user reported.

Fix: `mixerRttProbe.stop()` now returns a Promise that resolves only
when the WS reaches CLOSED (via `onclose`/`onerror`), with a 500 ms
safety timeout so a stuck close never deadlocks the join. `connectMixer`
awaits it. Now there is exactly one `/mixer-tcp` socket on the wire at
any given moment, and the WAF has nothing to chew on.

#### Files

| File | Change |
|---|---|
| `web/src/services/mixerRttProbe.ts` | `stop(): void` → `stop(): Promise<void>` resolving on CLOSED |
| `web/src/services/audioService.ts` | `connectMixer` does `await mixerRttProbe.stop()` |

## [5.1.6] - 2026-05-03

### Fixed — "Control WebSocket 连接失败" on slow / VPN'd networks

After v5.1.4 restored `mixerRttProbe`, users on a global VPN started
seeing the room's connect step fail with "Control WebSocket 连接失败"
right after clicking 创建房间.

Root cause: `mixerRttProbe` is a singleton that HomePage's
`LiveLatency` starts via `useEffect`. When React navigates from `/`
to `/room/:id`, HomePage unmounts and the effect's cleanup runs —
**but the cleanup only unsubscribes the callback; it never calls
`mixerRttProbe.stop()`**. The probe's WebSocket stays open. Then
RoomPage's `audioService.connectMixer` opens its OWN `/mixer-tcp`
socket. Two concurrent WSS sessions to the same path from the same
origin.

On a clean network this is fine (browsers allow many parallel
WebSockets per host). On a global VPN with stateful middleboxes the
second concurrent WSS handshake to the same path sometimes drops —
which surfaces as `controlWs.onerror` and the toast above.

Fix: `audioService.connectMixer` now calls `mixerRttProbe.stop()` at
the start, so only one `/mixer-tcp` socket exists at a time. When the
user navigates back to the home page, `LiveLatency`'s `useEffect`
calls `mixerRttProbe.start()` again, so the probe resumes
transparently.

#### Files

| File | Change |
|---|---|
| `web/src/services/audioService.ts` | Imports `mixerRttProbe`; `connectMixer` calls `mixerRttProbe.stop()` before opening its own control socket |

## [5.1.5] - 2026-05-03

### Changed — homepage hero number is now `RTT + 10 ms` (audio-path total)

Per user feedback after v5.1.4 went live: the hero digit jumping from
the 12 ± 2 ms mock placeholder up to the user's real RTT (~30 ms over
their VPN) was misleading — visually the page felt like it was
"discovering" the user's connection mid-paint.

Fix: the displayed number is `mixerRttProbe.rtt + 10 ms` instead of
just the raw RTT. The `+10 ms` represents the network-independent
audio-path overhead (client jitter buffer ~5 ms, server jitter target
~5 ms, server mix half-tick ~1 ms, IO buffers ~2 × 2.5 ms). This
makes the headline figure represent the **end-to-end audible latency**
rather than the network leg alone — what users actually hear in a
room. The placeholder mock also gets the `+10 ms` so the
pre-connect → real-measurement jump stays small.

#### Files

| File | Change |
|---|---|
| `web/src/pages/HomePage.tsx` | `LiveLatency` adds `kAudioPathOffsetMs = 10` to both the placeholder and the real reading |

In-room latency display unchanged (it shows the full e2e breakdown
already and is sourced from `audioService.audioLatency`).

## [5.1.4] - 2026-05-03

### Re-applied — `mixerRttProbe` (the v5.0.3 homepage RTT fix)

v5.1.3 over-reverted: the user asked to put web back to v5.0.0 state,
which I read as "drop everything since". But of the v5.0.x → v5.1.x
band, **v5.0.3 was the only purely-beneficial web change** —
`mixerRttProbe` makes the homepage hero RTT show the same low number
the in-room debug panel shows (mixer-direct PING/PONG, ~8 ms to Kufan)
instead of `signalService.onLatency`'s reading (signaling RTT through
Cloudflare's AMS edge, ~400 ms for China users).

After v5.1.3 the homepage hero displayed **387 ms** instead of the
real ~8 ms audio path. User reported this as a regression in
displayed latency. Restoring the v5.0.3 files brings the display
back to reality. No other v5.0.x / v5.1.x web change is touched.

#### Files

| File | Change |
|---|---|
| `web/src/services/mixerRttProbe.ts` | **Restored** from v5.0.3 (`fc6d1bf`) |
| `web/src/pages/HomePage.tsx` | Restored from v5.0.3 — homepage hero RTT now sourced from `mixerRttProbe.onLatency` again |

In-room display was never affected (it uses `audioService.audioLatency`
from the `/mixer-tcp` PONG, which v5.1.3 didn't touch).

## [5.1.3] - 2026-05-03

### Reverted — web frontend rolled back to v5.0.0 state

User asked to put the web frontend back to its v5.0.0 (`08175b1`)
configuration. The v5.0.x → v5.1.x band of releases was largely infra
(server migration, repo flatten, deploy plumbing, doc cleanup); only
**v5.0.3** added a substantive runtime change to web — the
`mixerRttProbe` service that replaced `signalService.onLatency` as
the source of the homepage live-RTT display. That single addition is
the only thing reverted here.

#### Files

| File | Change |
|---|---|
| `web/src/services/mixerRttProbe.ts` | **Deleted** (added in v5.0.3) |
| `web/src/pages/HomePage.tsx` | Restored to v5.0.0 contents — homepage live RTT now sourced from `signalService.onLatency` again |

No server, ops, or deploy-pipeline reverts. The migrated server
infrastructure (酷番云 primary, Aliyun fallback) and the WSS-default
on `/` transport selection from v5.0.0 are unchanged.

## [5.1.2] - 2026-05-02

### Changed — documentation consolidation pass

A full audit of every doc in the repo + `Tonel-local/local_docs/`
identified ~12 files of bloat, duplication, and stale content. This
release lands the cleanup. **No code or runtime change.**

#### CHANGELOG split

The active changelog was 5851 lines / 119 versions, dominated by
single-day churn from the v1.0.x and v3.x.x eras. Entries before
**v4.0.0** (the start of the latency-optimization roadmap) moved to
`CHANGELOG-archive.md`. Live file shrank to ~2120 lines / 30 versions.
Cut point matches the v4 latency roadmap boundary, where most
references that survive into the v5 era begin.

#### Public-repo docs promoted from `Tonel-local/`

The flatten in v5.1.0 moved internal-looking docs to
`Tonel-local/local_docs/Git-docs/`. Two of those don't actually contain
internal-only material — they're engineering policy referencing files
already public — so they came back into the repo:

* `local_docs/Git-docs/RELEASE.md` → `docs/RELEASE.md` (release flow)
* `local_docs/Git-docs/DEPLOY_SCRIPTING_STANDARDS.md` → `deploy/STANDARDS.md`
  (R1-R10 rules for editing `deploy/` or `ops/`)

Cross-references in `deploy/README.md`, `deploy/LESSONS.md`, and
`docs/DEVELOPMENT.md` updated to the new paths.

#### Stale facts fixed

* `docs/DEVELOPMENT.md` — version note still said "All versions in sync
  at `1.0.0`"; current is v5.1.2. Replaced with explicit "single source
  of truth = root `CMakeLists.txt`, sync via `bump-version.sh`" and
  added the `config.schema.json` row that was missing.
* `docs/ARCHITECTURE.md` — DNS table reflected only the pre-v5 single
  Aliyun box. Added `srv.tonel.io` (酷番云广州, primary since v5.0.0)
  and `srv-new.tonel.io` (Aliyun fallback) plus the v5 migration note.
  Client-connection-points table updated to match.
* `docs/ARCHITECTURE.md` — duplicated "Editions" block (also in
  `README.md`) trimmed to a back-reference.
* `server/README.md` — full rewrite. Old version had wrong header size
  (44 vs current 76 bytes) and `nohup ./signaling_server &` deploy
  instructions superseded by `deploy/server.sh` four releases ago. New
  version is a stub that defers to `docs/SPA1_PROTOCOL.md`,
  `docs/ARCHITECTURE.md`, `deploy/README.md`, and the `.docker/`
  cross-compile pipeline.
* `web/README.md` — said "AudioWorklet (fallback ScriptProcessorNode)"
  which contradicts `STANDARDS_WEB_AUDIO.md`'s "ScriptProcessorNode is
  authoritative" rule. Rewrote to match reality and defer to the docs/.

#### Files

| File | Change |
|---|---|
| `CHANGELOG.md` | Trimmed 5851 → ~2120 lines (~64% smaller). Added archive cross-link in header. |
| `CHANGELOG-archive.md` | New — pre-v4.0.0 entries (89 versions). |
| `docs/RELEASE.md` | New (promoted from local_docs). Strip `Git/` prefix. |
| `deploy/STANDARDS.md` | New (promoted). Strip `Git/` prefix. |
| `deploy/README.md` | Cross-link updated to local `STANDARDS.md`. |
| `deploy/LESSONS.md` | Cross-link updated to local `STANDARDS.md`. |
| `docs/DEVELOPMENT.md` | "Current version" + deployment cross-links refreshed. |
| `docs/ARCHITECTURE.md` | DNS / client matrix now v5-aware; Editions block trimmed. |
| `server/README.md` | Rewrote — defers to docs/, removes stale facts. |
| `web/README.md` | Rewrote — defers to docs/, fixes AudioWorklet ordering claim. |

### Local-only doc cleanup (not in this commit, recorded for traceability)

Same audit pass, applied to `~/project-s/Tonel-local/local_docs/`
(outside the repo). Net effect: `local_docs/` root went from 25+ items
to 14 essentials.

* **Deleted** (fully redundant or stale): `STANDARDS_DEPLOY.md` (pre-v1.0.3 layout); `Git-docs/DEPLOYMENT.md` (pre-v5 single-box); `Git-docs/server-mixer.md` (2026-04-25 design doc, now historical); `Git-docs/OPTIMIZATION_LATENCY.md` and `root-docs/OPTIMIZATION_LATENCY.md` (older drafts of the v0.3.2 optimization doc).
* **Merged** `STANDARDS_LIBUV.md` into `STANDARDS_CODE.md` as Appendix A.
* **Trimmed** `STANDARDS_NETWORK.md` §2 to a one-paragraph redirect to `docs/SPA1_PROTOCOL.md` (the deprecated v1.0/v1.0a description was 40+ lines of dead spec).
* **Trimmed** `STANDARDS_VERSIONING.md` §7 to remove the v1.0→v0.3.2 mapping table (git history covers it).
* **Marked historical** `PRD.md` (technical params now superseded; product vision still valid) and `ROADMAP.md` (v0.x roadmap, real path diverged into v4 latency + v5 server migration).
* **Archived** to `_archive/`: `inventory-2026-04-28/` (one-time bootstrap snapshot), `bootstrap-*.log`, `audit_issues.json`, `gen_audit_*.py`, `wip-stash`, standalone `deploy*.sh` scripts (canonical lives at `deploy/`).
* **Updated** `local_docs/README.md` — current index reflecting all of the above.

## [5.1.1] - 2026-05-01

### Changed — deploy: cross-compile C++ binaries locally instead of on prod

`deploy/server.sh --component=binary` no longer rsyncs source to the
production server and runs `cmake` there. Instead, it builds inside a
local Docker container (`debian:12`, mirrors prod's glibc 2.36 / x86-64)
and rsyncs only the resulting ELF binaries.

This was uncovered while deploying v5.1.0: the production box (酷番云
广州) has no `cmake` installed — and never had, going back several
releases. The previous binary deploy step was silently failing on
every release; the binaries on `/opt/tonel/bin/` were stale (the
`/opt/tonel/VERSION` marker still read `v1.0.3`). Production kept
working only because no recent release had touched the C++ source.

Mirrors the wt-proxy approach in spirit (cross-compile locally, ship
binary, no remote toolchain). Side benefits:

* Production needs no `cmake`, `g++`, `pkg-config`, or `-dev` packages.
* Build is reproducible w.r.t. the dev machine — the apt snapshot baked
  into the builder image, not whatever happens to be on prod today.
* Deploy is faster (no remote compile, just rsync ~2 MB ELF).
* Failures surface at build time on the dev machine, before any rsync
  to prod, so a broken build can't half-deploy.

### Files

| File | Change |
|---|---|
| `server/.docker/Dockerfile` | New — debian:12 builder with libuv/opus/openssl/json3 + cmake |
| `deploy/server.sh` `deploy_binary()` | Rewrote: docker build + docker run + rsync ELF |
| `ops/cloudflared/cloudflared.service.d/timeout.conf` | New — systemd drop-in extending timeouts to 180s |
| `deploy/server.sh` `deploy_ops()` | rsync drop-in + daemon-reload before cloudflared restart |

### Notes

* First-time builders: the `tonel-server-builder:debian12` image is
  ~200 MB and takes ~3 min to build (one-time, cached afterwards). Pull
  paths use the daocloud mirror (`docker.m.daocloud.io`) and the apt
  install uses TUNA's Debian mirror; both are CN-network workarounds
  baked into the Dockerfile so the operator does not need to configure
  `~/.docker/daemon.json`.
* Operators must have Docker Desktop (or an OCI-compatible runtime)
  running locally before invoking `deploy/server.sh --component=binary`.
  The deploy script verifies `docker info` succeeds and aborts with a
  clear message otherwise.

### Fixed — cloudflared service timeout regression

`/etc/systemd/system/cloudflared.service` ships with `TimeoutStartSec=15`,
which is too short for re-establishing connections to all four CF edge
regions during a `systemctl restart`. The v5.1.0 deploy hit this and
aborted (`set -e` in `deploy_ops`).

Added `ops/cloudflared/cloudflared.service.d/timeout.conf`, a systemd
drop-in extending `TimeoutStartSec` and `TimeoutStopSec` to 180s.
`deploy/server.sh deploy_ops()` now installs the drop-in and runs
`systemctl daemon-reload` before `systemctl restart cloudflared`. Drop-in
survives `cloudflared service install` upgrades — unlike editing the
upstream unit file.

## [5.1.0] - 2026-05-01

### Changed — repo flattened to standard git layout

The `Git/` subdirectory was removed; the repo root is now the working
tree root. All source directories — `server/`, `web/`, `scripts/`,
`deploy/`, `ops/`, `libs/`, `docs/`, `Tonel-Desktop*/`, `Tonel-MacOS/`,
`user-service/` — moved up one level. 372 renames; `git follow-renames`
preserves blame.

Local-only content (internal docs, legacy desktop client, design
hand-offs, analytics-service, mock recordings) was relocated to the
sibling directory `~/project-s/Tonel-local/`, outside the git working
tree entirely. The workspace inside the repo now contains only files
intended for version control.

### Why

The previous nested layout forced `.gitignore` to use brittle whitelist
patterns relative to the repo root. `web/node_modules/` did not match
`Git/web/node_modules/`, which is how 1196 files of nested
`node_modules/`, `.wrangler/cache/`, plus three root-level dirs that
had bypassed the local-only rule, leaked into version control. (Cleaned
up in `chore: enforce GitHub-only-Git policy + repo structure cleanup`,
included in this release.)

### New defenses against future leakage

* **`scripts/hooks/pre-commit`** — actively rejects staged paths
  matching `node_modules|.wrangler|dist|build|build_*|.DS_Store|.cache|wt-mixer-proxy`.
  Belt-and-suspenders alongside `.gitignore`; catches `git add -f`
  bypasses too. Installed via `scripts/install-hooks.sh` (sets
  `core.hooksPath`).
* **`.gitignore`** rewritten with standard recursive patterns
  (`**/node_modules/`, `**/dist/`, `**/.wrangler/`) — no more
  whitelist maintenance.
* **Local content is outside the worktree**, so a forgotten
  `git add /some-new-dir/` cannot capture material that was never
  meant to be tracked.

### Path reference updates

* All scripts (`release.sh`, `pretest.sh`, `install-hooks.sh`,
  `deploy/*.sh`, `hooks/*`) had `Git/` prefix stripped from comments,
  usage strings, and string literals.
* `deploy/lib/common.sh` — `REPO_ROOT` resolves correctly post-flatten;
  `GIT_DIR` retained as back-compat alias.
* `scripts/release.sh` and `scripts/pretest.sh` had self-referencing
  `REPO_ROOT="$(cd "$REPO_ROOT/.." && pwd)"` lines from a too-broad
  rename pass; fixed to derive cleanly from `$SCRIPT_DIR/..`.
* `README.md`, `deploy/README.md`, `deploy/LESSONS.md`, ops nginx
  configs, `server/test/*` — all `Git/X` references collapsed to `X`.
* `CHANGELOG.md` — pre-2026-05-01 entries still reference `Git/X`; a
  transition note at the top explains the rule for reading them.

### Public docs split

`docs/` was pruned to three files intended for outside readers:
`ARCHITECTURE.md`, `DEVELOPMENT.md`, `SPA1_PROTOCOL.md`. Internal
operational docs (`DEPLOYMENT.md`, `RELEASE.md`,
`DEPLOY_SCRIPTING_STANDARDS.md`, `OPTIMIZATION_LATENCY.md`,
`server-mixer.md`, `web/UI-REQUIREMENTS.md`) moved to
`Tonel-local/local_docs/Git-docs/`.

### Files

| File | Change |
|---|---|
| `.gitignore` | Standard patterns, single source of truth |
| `scripts/hooks/pre-commit` | New — forbidden-pattern fence |
| `scripts/release.sh`, `scripts/pretest.sh` | Path resolution fix |
| `deploy/lib/common.sh` | `REPO_ROOT` semantics post-flatten |
| 372 source files | Renamed `Git/X → X` (git follows renames) |

### Migration notes for anyone with a local clone

* Pull and reset your worktree; do not try to merge by hand.
* Run `scripts/install-hooks.sh` to pick up the new `pre-commit`.
* If you had local-only files at the repo root, move them to
  `~/project-s/Tonel-local/` (or any sibling location of your
  choosing) — the worktree is no longer the right place for them.
* Pre-flatten paths in older `CHANGELOG.md` entries are read as
  `Git/X → X`.

### Notes

* No runtime behavior changed. Server binaries, web bundle, and SPA1
  protocol are byte-identical to v5.0.5. This release is bumped to
  MINOR (not PATCH) because the repository structure visible to
  contributors changed.
* Production deployment is unchanged: `/opt/tonel/` layout, port map,
  cert lineage, PM2 process names — all same.

## [5.0.5] - 2026-05-01

### Added — branching infra for the macOS client

The macOS client iterates faster than the umbrella `release: vX.Y.Z`
discipline allows. Established a long-lived **`tonel-macos`** branch
off v5.0.4 for day-to-day app work, with a clear merge-back protocol.

* `Git/scripts/hooks/pre-push` — refuses any commit on `main` whose
  subject does not match `^release: v\d+\.\d+\.\d+`. Branch protection
  on GitHub requires Pro for private repositories; this hook is the
  fence in lieu of paying.
* `Git/scripts/install-hooks.sh` — sets `core.hooksPath` to the in-repo
  hook directory, run once per clone.
* `Tonel-MacOS/README.md` — documents the branch + version policy
  (`MARKETING_VERSION` ticks independently in `Tonel-MacOS/project.yml`;
  umbrella `vX.Y.Z` only bumps on merge-to-main).

### Notes

The hook can only enforce the rule when it lives on `main` itself —
this commit is what gets it there. Until merged, attempts to push
non-release commits to `main` from a tonel-macos checkout (where the
hook IS present) are blocked locally; from a `main` checkout without
this commit the rule was unenforced (which is what slipped two empty
test commits onto `origin/main` during initial setup; `--force-with-lease`
back to v5.0.4 cleaned them up before this release).

## [5.0.4] - 2026-05-01

### Fixed — `Tonel-MacOS` (new SwiftUI client) audio path

Several latency / correctness fixes after end-to-end testing the SwiftUI
client against the酷番云 mixer.

* **Capture: `installTap` → `AVAudioSinkNode`.** AVAudioEngine's tap
  aggregates ~100 ms regardless of HW IO buffer size — kills the whole
  point of a 2.5 ms wire frame. Replaced with `AVAudioSinkNode`, which
  delivers per HW IO buffer (now 120 frames / 2.5 ms). Capture-side
  latency dropped from ~100 ms to ~2.5 ms.
* **Voice processing forced off.** macOS auto-promoted the input node to
  `VoiceProcessingIO` (`AVAUVoiceIOChatFlavor` in the unified log),
  which silently applied AGC + echo cancellation — wrong DSP for
  rehearsal, and EC was actively muting the local self-monitor by
  classifying the speaker return as an echo. `setVoiceProcessingEnabled(false)`
  before `prepare()`.
* **Tap/connection conflict.** A graph connection on `inputNode` bus 0
  silently disabled the tap on the same bus. Local self-monitor now
  flows mic → ring buffer → realtime playback callback, instead of
  mic → mixerNode → mainMixerNode (which was killing the tap).
* **HW IO buffer pinned to 120 frames.** `kAudioDevicePropertyBufferFrameSize`
  set on both input and output devices via Core Audio HAL — every
  sinkNode callback produces exactly one SPA1 packet, and monitor
  latency stays at one buffer period.
* **Drift trim on capture rings.** `monitorRing` and `selfLoopRing`
  used to grow up to 200 ms before being clipped — any network burst
  permanently inflated listening latency. Both now trim to a 5 ms
  target depth on every push (drop-oldest, same strategy as
  `JitterBuffer`).
* **Alone-vs-peer monitor switch.** Mirrors web `updateMonitorGain`:
  when `peers.isEmpty`, the user hears themselves through the server's
  fullMix loopback (proves the round-trip is alive). When peers join,
  the local mic-tap → playback path takes over for low-latency
  self-hear and the server runs N-1.

### Fixed — `Tonel-MacOS` latency display

* **RTT was the wrong number.** Header was showing signaling RTT
  (`wss://api.tonel.io/signaling`, which routes through Cloudflare AMS
  ≈ 500 ms RTT and is irrelevant for audio). Replaced with
  `MixerClient.audioRttMs` — `{"type":"PING"}` / `PONG` over the
  TCP-direct mixer control channel (port 9002), same path the SPA1 UDP
  stream takes. Now reads ~8 ms direct-to-Kufan, matching ICMP. Web
  parity (`audioService.audioLatency`).
* **e2e formula now includes device-reported HW latency.** Old formula
  was missing ADC/DAC + USB transport + AU-internal buffers — all read
  from Core Audio HAL (`kAudioDevicePropertyLatency` + `SafetyOffset`
  + `StreamLatency`). Component breakdown surfaced in the room debug
  bar.
* **Heartbeat RTT measurement off-main.** `pingSentAt` stamped in the
  URLSession send-completion handler; ACK time captured at the top of
  the receive callback, before any `Task { @MainActor in ... }` hop.
  Without this, RTT was smeared with whatever else main was doing
  (SwiftUI re-renders driven by `pollPub` at 100 ms cadence).
* **Parse `jitter_target` / `jitter_max_depth` from `MIXER_JOIN_ACK`.**
  The server tells us its jitter buffer config; the e2e calculation
  uses the actual target instead of a hardcoded guess.

### Notes

`Tonel-MacOS/project.yml` MARKETING_VERSION 0.1.0 → 0.1.1. The legacy
`Tonel-Desktop-AppKit/` is untouched (preserved as reference).

## [5.0.3] - 2026-05-01

### Changed — homepage live latency now reflects mixer-server RTT

The hero/axis/stats latency figure on `tonel.io` previously came from
`signalService` PING/PONG (api.tonel.io control WS). That number was
honest for the signaling path but not the figure users care about —
the audio mixer round-trip is what they hear in a room, and is what
the in-room debug panel surfaces as "RTT".

Added a small [mixerRttProbe](web/src/services/mixerRttProbe.ts)
service that opens a WebSocket to `wss://srv.tonel.io/mixer-tcp`
(or `srv-new.tonel.io` under `/new`) and runs the same
`{"type":"PING"}` / `PONG` cadence as `audioService`. The mixer's
PING handler does not require `MIXER_JOIN`, so the probe is
read-only — it does not register a UDP endpoint, take a slot, or
broadcast LEVELS. `LiveLatency` in `HomePage.tsx` swapped its
subscription from `signalService.onLatency` to
`mixerRttProbe.onLatency`; the giant hero number, the axis row, and
the bottom stats cell all share the same value.

Behaviour preserved: 200 ms UI throttle, < 50 ms green / 50–99 ms
yellow / ≥ 100 ms red, animated 12 ± jitter placeholder until the
first PONG arrives.

## [5.0.2] - 2026-05-01

### Fixed — `/new` was silently falling back from WT to WSS

After v5.0.0/v5.0.1 cutover, the browser on `tonel.io/new` was
choosing **WT** per `chooseAudioTransport()` but `audioWS` ended up
populated and `audioWT` remained null in the debug snapshot. Root
cause:

`wt-mixer-proxy` (Go binary) loads exactly one TLS cert at startup
via `tls.LoadX509KeyPair`. On Aliyun the cert was
`/etc/letsencrypt/live/srv.tonel.io/fullchain.pem` — single-name,
CN=srv.tonel.io. But /new browsers connect to UDP 4433 with
`SNI=srv-new.tonel.io`, so the QUIC TLS handshake gets a cert that
doesn't match the SNI, fails verification, and the client's
`tryWebTransport()` returns false → `audioService` falls back to
WSS. The fallback masked the underlying SNI mismatch.

**Fix on each production server**: re-issue the cert as a SAN cert
covering both `srv.tonel.io` AND `srv-new.tonel.io` via DNS-01:

```
certbot certonly --dns-cloudflare \
    --dns-cloudflare-credentials /root/.secrets/cf-dns-token.ini \
    --domain srv.tonel.io --domain srv-new.tonel.io \
    --cert-name srv.tonel.io --expand
```

Path (`/etc/letsencrypt/live/srv.tonel.io/`) doesn't change, so the
ecosystem's cert path stays `srv.tonel.io` — no `Git/ops/` change
needed. SAN validates against either SNI.

**Renewal post_hook** updated on both boxes to also reload the
WT proxy (the Go binary loads cert once at startup):

```
post_hook = systemctl reload nginx && pm2 reload tonel-wt-mixer-proxy
```

Standalone `srv-new.tonel.io` renewal config removed on both boxes
(the SAN cert in `srv.tonel.io` lineage now covers it). Verified
end-to-end: `audio_quality_e2e.js --mode wt --wtHost srv-new.tonel.io`
returns SNR 71 dB / click 0.59/s / 400 fps.

### Fixed — `deploy/lib/common.sh load_env` clobbered inline env overrides

`README.md` documents `TONEL_SSH_HOST=root@8.163.21.207 ... server.sh`
as the way to address the Aliyun fallback box without editing
`.env.deploy`. But `load_env`'s `source "$ENV_FILE"` line ran
unconditionally after env vars were already set on the command line,
overwriting them with the .env.deploy values. Net effect: every
"override" attempt silently went to whatever was in `.env.deploy`
(now 酷番云). Caught when an "ops deploy to Aliyun" actually
deployed to 酷番云 a second time.

`load_env` now snapshots `TONEL_SSH_HOST`, `TONEL_SSH_PORT`,
`TONEL_CF_TUNNEL_ID`, and the four directory vars before sourcing,
then restores any var that was already set. Inline override now
works as documented; `.env.deploy` defaults still apply when nothing
is overridden.

### Files changed

- `Git/deploy/lib/common.sh` — load_env preserves inline overrides
- `Git/CHANGELOG.md` — this entry

Server-side changes (out-of-band, no repo touch):

- Both servers: SAN cert issued for `srv.tonel.io` + `srv-new.tonel.io`
- Both servers: renewal post_hook updated to reload wt-mixer-proxy
- Both servers: standalone `srv-new.tonel.io.conf` renewal removed
- New server: also added DNS-01 renewal for `tonel.io` cert (failover)

This is an infra/docs-only release; no server binaries or web bundle
behavior change in 5.0.2.

## [5.0.1] - 2026-05-01

### Fixed — three v5.0.0 followups, all infra hygiene

#### `Git/ops/` ↔ live drift resolved (dual-hostname symmetric configs)

`Git/ops/nginx/srv-new.tonel.io.conf` added (mirror of `srv.tonel.io.conf`),
`Git/ops/cloudflared/config.yml.template` extended with a second
`api-new.tonel.io` ingress block. `deploy/server.sh deploy_ops()` syncs
the new file and creates the sites-enabled symlink. The same `Git/ops/`
deploys to either production server now; whichever machine actually
handles each hostname is decided entirely by DNS in Cloudflare.

This means Aliyun is no longer "managed manually" — to re-align it to
the canonical configs in `Git/ops/`, override env inline:

```bash
TONEL_SSH_HOST=root@8.163.21.207 TONEL_SSH_PORT=22 \
TONEL_CF_TUNNEL_ID=339745d7-cb58-4e1d-acf4-e6b7198a2b8c \
  Git/deploy/server.sh --component=ops
```

#### `.env.deploy` switched to 酷番云 + new `TONEL_SSH_PORT` variable

After v5.0.0 cutover, `.env.deploy` still pointed `TONEL_SSH_HOST` at
the old Aliyun box — which would have silently sent the next server
deploy to the wrong machine. Updated to:

```
TONEL_SSH_HOST=root@42.240.163.172
TONEL_SSH_PORT=26806    # new var, defaults to 22
TONEL_CF_TUNNEL_ID=6fb5a319-7aaa-4f77-9e12-214eb4bfb1d8
```

`deploy/lib/common.sh` (`ssh_exec`, `ssh_quiet`, `rsync_to_remote`,
`check_remote_drift`) and `deploy/health.sh` all now thread the port
through every ssh / rsync invocation. Existing setups that never set
`TONEL_SSH_PORT` keep working — it defaults to 22.

#### Aliyun's `srv-new.tonel.io` cert renewal switched to DNS-01

The cert was tar-piped from the new server during v5.0.0 cutover
because Aliyun's cloud WAF (`Server: Beaver`) blocks HTTP-01
challenges for any new hostname before nginx ever sees the request.
Renewal therefore must use DNS-01:

- `python3-certbot-dns-cloudflare` installed on Aliyun
- `/root/.secrets/cf-dns-token.ini` stores the same Cloudflare API
  token already used for Pages deploys (verified to have
  Zone:DNS:Edit on the tonel.io zone)
- `/etc/letsencrypt/renewal/srv-new.tonel.io.conf` flipped from
  `authenticator = nginx` → `authenticator = dns-cloudflare`
- `certbot renew --cert-name srv-new.tonel.io --dry-run` passes
- `certbot.timer` systemd unit handles auto-renewal 30 days before
  expiry — no operator action required

Documented in `Git/deploy/README.md` "Cert renewal" section + a new
quirks-list entry explaining the Beaver WAF behaviour.

### Files changed

- `Git/deploy/.env.deploy` — TONEL_SSH_HOST + TONEL_SSH_PORT + TUNNEL_ID
- `Git/deploy/.env.deploy.example` — same, with v5 commentary
- `Git/deploy/lib/common.sh` — TONEL_SSH_PORT support
- `Git/deploy/health.sh` — ssh -p threading
- `Git/deploy/server.sh` — deploy_ops() pushes srv-new.tonel.io.conf
- `Git/deploy/README.md` — v5 architecture section, cert renewal table, Beaver quirk
- `Git/ops/README.md` — dual-hostname architecture explainer
- `Git/ops/nginx/srv.tonel.io.conf` — header comment v5
- `Git/ops/nginx/srv-new.tonel.io.conf` — new file
- `Git/ops/cloudflared/config.yml.template` — second ingress for api-new

Server-side, Aliyun also got the certbot-dns-cloudflare install and
renewal config rewrite (out-of-band — Aliyun isn't on the standard
deploy flow). Documented in the migration memory.

This is an infra/docs-only release; no server binaries or web bundle
behavior change in 5.0.1.

## [5.0.0] - 2026-04-30

### Changed — production server migration: Aliyun → 酷番云广州

`tonel.io/` now talks to the Guangzhou server (42.240.163.172) instead
of the Aliyun ECS in eastern China. Reason: Aliyun bandwidth tier
became the bottleneck (mixer's broadcast scales linearly with
concurrent users; ~100 Mbps cap on the Aliyun plan was insufficient
for current growth). 酷番云 plan is ~100 Mbps up/down, sufficient
headroom.

`tonel.io/new` is now the **Aliyun fallback path**: the URL is
preserved (so old links / bookmarks don't break), but DNS for the
hostnames behind /new (`srv-new.tonel.io`, `api-new.tonel.io`) is
swapped to point at the old Aliyun box. This is the inverse of v4.3.x
where /new was the test deployment on the new server.

### Implementation

DNS-A swap (manual via CF dashboard at cutover):

| Hostname | v4.3.11 → | v5.0.0 → |
|---|---|---|
| `srv.tonel.io` (DNS-only) | 8.163.21.207 (Aliyun) | **42.240.163.172** (酷番云) |
| `srv-new.tonel.io` (DNS-only) | 42.240.163.172 (酷番云) | **8.163.21.207** (Aliyun) |
| `api.tonel.io` (CNAME) | old tunnel `339745d7-...` | **new tunnel** `6fb5a319-...` |
| `api-new.tonel.io` (CNAME) | new tunnel | **old tunnel** |

Both servers' nginx now serve both hostnames; both servers'
cloudflared route both api hostnames. Whichever server gets traffic is
determined entirely by DNS, so the swap is the only "moment" of
cutover. Pre-staged config means a single DNS edit promotes the new
production with ~2 min for HTTP-01 cert issuance window.

### Web transport-selection inversion

`audioService.chooseAudioTransport()` flipped: `/` now force-selects
WSS (because the 酷番云 UDP path bursts datagrams — see
[project_kufan_udp_burst memory] / v4.3.11 entry), and `/new` now
gets the WT default (because Aliyun's UDP path is clean — that's
where WT used to live in production).

Trade-off: `/` users now pay TCP HOL blocking penalty during loss
events (~50–200 ms latency spike, drained over 2 s by rate adjuster).
This violates the literal letter of the latency-first principle, but
on the new server's UDP path the alternative is persistent 破音, which
is worse for the rehearsal use case. If the cloud provider eventually
offers SR-IOV / clean UDP egress, this flips back to WT default for
/.

### AppKit unchanged

`MixerBridge.mm` still hardcodes `kMixerHost = "8.163.21.207"`. AppKit
users keep talking to the Aliyun box (which stays running as the /new
fallback). AppKit refactor (host configurability, frame-size 240 →
120 alignment with v4.2.0+ server tick, optional WSS transport) is a
separate roadmap item — a v5.x.x minor version, not in 5.0.0.

### Breaking changes

- `srv-new.tonel.io` and `api-new.tonel.io` DNS targets swap. Anything
  outside this repo that depended on those names pointing at 酷番云
  will silently start hitting Aliyun.
- WT path on `/` is no longer available (force-WSS). External tooling
  that relied on WT to `/` (e.g., browser tests pinned to WT against
  the production hostname) will need `?transport=wt` override OR a
  switch to `/new`.

### Files changed

- `Git/web/src/services/audioService.ts` — chooseAudioTransport inversion
- `Git/CHANGELOG.md` — this entry

Server-side configs (nginx server blocks on each box, cloudflared
ingress on each box) were updated out-of-band as pre-staging — they
are not in `Git/ops/` because the dual-hostname setup is transitional;
once the migration stabilizes (~2 weeks of observation), one of the
hostnames will be retired and the canonical config will collapse back
to a single hostname per server. `Git/ops/` will be updated to match
at that point.

## [4.3.11] - 2026-04-30

### Fixed — `/new` users hearing 破音 over WebTransport on Guangzhou test mixer

User reported persistent audible 破音 on `tonel.io/new` that no
AudioDebugPanel slider combination could mitigate, while
`tonel.io/new?transport=wss` was clean. Investigation:

- **Server-side ruled out**: loopback A/B (`audio_quality_remote_ab.sh`,
  127.0.0.1 → 127.0.0.1) on prod and new produced bit-near-identical
  metrics. mixer/ws-mixer-proxy code paths are clean on both.
- **WSS A/B ruled out**: from-Mac WSS A/B was within run-to-run noise.
- **WT A/B reproduced the symptom**: built a Node WebTransport test
  client (`spa1_wt_client.js`, `audio_quality_e2e.js --mode wt`) and
  ran the same scenario suite over WT against both servers. New
  server showed **4–15× higher click_rate / norm_energy on sine
  signals** vs production, while WSS A/B was within noise.
- **Network path probes don't differ**: ping RTT and stddev to both
  servers are within 5%.
- **Server kernel/UDP config identical** (MTU 1500, rmem/wmem
  212992, qdisc fq_codel, congestion cubic — verified via sysctl/tc).

Suspected root cause is the new cloud provider's hypervisor egress
behavior: TCP gets virtual-switch hardware offload, UDP 4433 walks a
software path that bursts datagrams unevenly. QUIC datagrams arrive
clustered → audible discontinuity at frame boundaries → 破音. The WSS
path on the same server is unaffected because TCP retransmit + reorder
reconstructs an even byte stream.

This is not a tonel-side bug — same `wt-mixer-proxy` binary, kernel
config, room state on both servers. Cannot be fixed from the tonel
codebase. The workaround until the new server's UDP egress is
addressed (or it moves to a provider with TCP-class UDP path):

`audioService.chooseAudioTransport()` now force-selects WSS when
`location.pathname.startsWith('/new')`, regardless of WebTransport
availability. Production users on `/` are unaffected — they keep
the WT default and its lower-latency benefits.

#### New automation in this release

- `Git/server/test/spa1_wss_client.js` — WSS-mode SPA1 client (used
  for the WSS A/B that ran earlier this session).
- `Git/server/test/spa1_wt_client.js` — WebTransport-mode SPA1 client
  via `@fails-components/webtransport`. Caveat: WT control still flows
  over the WSS `/mixer-tcp` channel (mirrors the browser architecture
  — WT is audio-only, JOIN/ACK is over the WSS control side).
- `audio_quality_e2e.js --mode wss --wssHost X` (added v4.3.something)
  and `--mode wt --wtHost X` (new in v4.3.11). The raw TCP/UDP mode
  remains the default for the local-mixer test path.
- `Git/server/test/remote_ab.sh --mode wss|wt --hostA --hostB` runs
  the scenario sweep against two production-style servers and prints
  side-by-side metrics. Used here to reproduce the symptom; future
  "is server X regressing?" investigations can re-use it.

This is a web-only fix; server binaries are unchanged in 4.3.11.

## [4.3.10] - 2026-04-30

### Fixed — `/new` audio path was silently routing to production again

v4.3.2 added `audioService.ts` host selection so the `/new` test path
would talk to `srv-new.tonel.io`. A v4.3.5 audio refactor reverted
that line to `const host = 'srv.tonel.io'` — the hardcoded production
host — without the test infra noticing (no test exercises the host
selection, only the wire format). signalService.ts kept its
equivalent conditional, so /new users were getting:

  signaling → api-new.tonel.io  (Guangzhou test signal server)
  audio     → srv.tonel.io      (Aliyun production mixer)

Net effect: /new could not actually exercise the new mixer at all
for audio. Confirmed by inspecting the published v4.3.9 bundle —
`srv-new.tonel.io` was absent.

Re-applied the conditional, with an in-source note pointing at
App.tsx pathPrefix() / signalService apiHost so the next refactor
notices the three call sites belong together.

This is a web-only fix; server binaries are unchanged in 4.3.10.

## [4.3.9] - 2026-04-30

### Fixed — `/new` test-deployment URL was clobbered to `/` on first paint

`tonel.io/new` is the path used to route audio + signaling at the
Guangzhou test mixer (audioService.ts / signalService.ts read
`location.pathname.startsWith('/new')` to pick `srv-new.tonel.io` /
`api-new.tonel.io`). v4.3.2 wired the host selection but missed the
URL-sync layer — App.tsx's room-state→URL effect ran on first paint
with `roomId === ''`, computed `targetPath = '/'`, and `pushState`'d
`/new` away to `/` *before* any service had a chance to read pathname.
Net effect: `/new` always resolved to the production hosts.

Three changes in App.tsx, all additive:

- `parseRoomPath` regex now accepts an optional `/new` prefix, so
  `/new/room/<id>` parses to the same room id as `/room/<id>`.
- A new `pathPrefix()` helper centralizes the `/new`-vs-`''`
  decision. The URL-sync effect uses it to compute `targetPath`
  (`${prefix}/room/<id>` or `${prefix || '/'}`) instead of hard-
  coding `/`.
- `cancelDeepLink` uses `pathPrefix() || '/'` for the post-cancel
  home URL so the test prefix survives a cancelled deep link.

When pathname doesn't start with `/new`, `pathPrefix()` returns `''`
and every `targetPath` formula is byte-identical to v4.3.8 — the
production code path has no behavior change.

This is a web-only fix; server binaries are unchanged in 4.3.9.

## [4.3.8] - 2026-04-30

### Fixed — debug panel slider drag no longer "听觉上的叠加"

User reported on v4.3.7 that adjusting AudioDebugPanel sliders
produced an audible stacking / echo build-up in playback. Two
distinct mechanisms were in play; both are addressed here.

#### Mechanism 1 — trim splice clicks during slider drag

Each `tune` postMessage from the panel triggered a hard splice in
the playback ring (`readPos` jumped forward by `count - target`
samples). For a 1 kHz 0.3-amp sine the splice produced a
sample-to-sample step of up to 0.58 — vs. 0.04 for the natural
signal derivative, **>10× over click threshold**.

A slider drag emits ~60 mousemove events/sec → up to 60 trims/sec
→ a "tick storm" perceptually grouped as ratcheting / breaking-up
audio. The new offline harness `panel_tune_offline.js` measured 6
clicks per realistic 400↔800 wiggle.

**Fix:** trim now schedules a 32-sample (0.67 ms, sub-perceptual)
linear crossfade in the next quantum, blending `lastBlock[127]`
(the just-played sample, held DC) toward post-trim ring content.
Plus a 16-sample deadband so sub-quantum count drift around target
no longer triggers spurious trim+crossfade events.

Post-fix offline measurements (1 kHz 0.3-amp, 5 s):
```
                       BEFORE              AFTER
                       clicks  maxJump     clicks  maxJump
wiggle 400↔800 × 5         6   0.544           0   0.047
drag down 1000→400        11   0.380           0   0.039
spam-no-change             1   0.277           0   0.039
```

#### Mechanism 2 — primeTarget below safety floor → PLC stacking

When the user dragged primeTarget into the [48..208] range, every
post-trim quantum mid-callback-underran (count = primeTarget,
process consumes 128, count drops below primeMin). Each underrun
fired PLC, which replays `lastBlock` decayed up to 4× per
"episode". Successive panel adjustments stacked these PLC events:
**169 PLC events in a 1-second drag from 1600 to 144** — the same
audio fragment audible at multiple decay levels = the "叠加"
effect.

**Fix:**

1. AudioDebugPanel slider lower bound: `max(240, primeMin + 192)`
   (= one 128-sample quantum + 64-sample jitter cushion). User
   physically cannot reach the PLC-stacking zone.
2. `setPlaybackTuning` enforces the same floor as a runtime clamp,
   so non-UI paths (saved tunings from older builds, future API
   surfaces) cannot bypass it either.
3. `TUNING_SCHEMA_VERSION` 6 → 7 to discard any v4.3.7-era saved
   slot the user may have explored down to 144 with. New
   migration scenario asserts sub-floor values get clamped.

#### Latency impact

Zero — the fixes preserve the trim's instant latency-reduction
behaviour (slider feels equally responsive). The crossfade
extends into the same quantum that the trim affects, no
additional buffering. Slider lower bound 240 vs. previous 48
removes a region of the explore-space the user wasn't using
productively anyway (PLC stacking made it audibly broken).

#### Test coverage added

- `Git/server/test/panel_tune_offline.js` — extracts the
  production worklet and drives it with simulated tune-message
  schedules (drag/wiggle/spam). Permanent regression guard for
  click-density and PLC-event counts during panel adjustment.
- New scenario in `state_migration_test.js`: sub-floor primeTarget
  in a current-schema slot must be clamped, not preserved verbatim.

## [4.3.7] - 2026-04-30

### Tuning — adopt user-validated post-rollback sweet spot as defaults

User iterated on debug-panel sliders against v4.3.6 (= v4.2.3 audio
code, Phase C removed) and reported these values as the right
combination of latency AND audio quality:

```
primeTarget    672 → 576  (14 ms → 12 ms)   [client]
primeMin        16 →  48  (0.3 ms → 1.0 ms) [client]
jitterTarget    1  →   2  (2.5 ms → 5 ms)   [server]
jitterMaxDepth 13  →  33  (32.5 ms → 82.5 ms cap) [server]
```

Live data from the user's session at these values:
```
ring=369 (steady, well below the 576 target — controller has slack)
rate=+5239 ppm (sub-rail; clock drift fully absorbable)
reprime=6 (essentially zero hard glitches)
plc=289
```

#### What this combination buys

- **Bigger jitterMaxDepth (33 fr ≈ 83 ms cap)** is the most
  important change. Production WSS-burst-pattern occasionally
  stuffs 8+ frames at once; the previous cap=8 dropped them
  audibly. cap=33 gives the server room to absorb without
  cap-drop clicks.
- **jitterTarget=2** (vs v1.0.38's =1) gives the controller a
  slightly larger steady-state cushion, trading 2.5 ms more
  server-side latency for less marginal-state oscillation.
- **primeTarget=576 (12 ms)** vs v5's 14 ms — minor latency win
  while keeping plenty of ring depth.
- **primeMin=48** vs v5's 16 — slightly more PLC-trigger
  sensitivity, but trades that for fewer ring excursions to
  absolute-zero (which previously could audibly snap before
  PLC took over).

#### Slider ranges in debug panel

User also requested wider/narrower ranges to match the practical
tuning space:

- `primeTarget` slider: max 4800 → **1600** (was overshoot —
  no real session needs > 1600 = 33 ms cushion)
- `primeMin` slider: max 1440 → **512** (similarly narrowed)

Both keep their min and step. Existing saved values outside the
new ranges still load correctly (the slider just clamps the
visible position).

#### Schema bumped 5 → 6

Existing v5 saved-tuning slots (carrying primeTarget=672 +
jitterMaxDepth=13) are discarded on next room join, falling back
to the new v6 defaults so users don't have to re-tune manually.
Users who DID re-tune on v4.3.6 to these exact values would get
no change either way (their saved primeTarget=576 etc. matches
the new default).

Layer 6 state-migration test self-updates (it reads
`TUNING_SCHEMA_VERSION` at runtime and tests v=current-1 → v=current
discard); confirmed v5 → v6 PASS via Preview MCP scripted check.

#### Server defaults synced

`mixer_server.h` `JITTER_TARGET_DEFAULT` 1 → 2 and
`JITTER_MAX_DEPTH_DEFAULT` 8 → 33. Sent to clients via
`MIXER_JOIN_ACK` so a fresh client without saved tuning sees the
same values the server is using.

### Validation done

- typecheck — clean
- server build (cmake) — clean
- Preview MCP scripted: 3/3 scenarios PASS (defaults match,
  v5→v6 discard, v6 preserve)
- pretest 6/6 PASS

## [4.3.6] - 2026-04-30

### Reverted — audio path further rolled back to v4.2.3 (Phase C removed)

User requested rollback to v4.2.3 after v4.3.5 (which restored
v4.3.0's Phase-C-with-adaptive). Strict v4.2.3 audio behaviour =
no adaptive jitter at all, server uses static `jitter_target`
exactly as v4.2.3 shipped.

#### Files restored to v4.2.3 content

Diff between v4.3.5 and v4.2.3 audio code is contained — Phase C
only ever touched server-side files:

- `Git/server/src/mixer_server.h` — removes `JitterEstimator`
  struct declaration; `UserEndpoint::jitter_estimator` field gone
- `Git/server/src/mixer_server.cpp` — removes `JitterEstimator::on_packet_arrived`
  implementation; mix tick reverts to reading `uep.jitter_target`
  directly; UDP receive no longer calls `estimator.on_packet_arrived`

Web-side audio code (`audioService.ts`, `AudioDebugPanel.tsx`,
`wt-mixer-proxy/main.go`) is **already at v4.2.3 content** post-v4.3.5
rollback — verified by `git diff v4.2.3 HEAD` returning no changes
for those files. v4.3.5 brought them back via a v4.3.0 checkout,
and v4.3.0's web == v4.2.3's web (Phase C never touched the
client).

#### Phase B preserved

Frame size 2.5 ms (`audio_frames=120`, `MIX_INTERVAL_US=2500`)
stays — v4.2.3 already had it. Only Phase C (adaptive) removed.

#### What stayed forward (same kept set as v4.3.5)

- CHANGELOG full history
- .gitignore D.0 hygiene
- health.sh D.0.1 retry
- signalService.ts `/new` URL routing branch (user-added)

#### Why this rollback might or might not work

If v4.3.6 sounds clean → v4.2.3 was indeed the last good state,
and Phase C in any form (with or without audit fixes) introduced
the regression. Phase C goes on the shelf pending a control-law
redesign; we proceed to Phase D (native client / edge nodes)
without re-attempting adaptive jitter.

If v4.3.6 still sounds bad → the regression isn't from Phase C
at all; something else in the v4.3.x lineage (e.g. the LEVELS
broadcast format extension we kept-then-rolled-back, the WT
proxy's session-takeover diff that was rolled back, or a build
environment shift) is responsible. Investigation continues.

### Validation

- typecheck — clean
- server build (cmake) — clean (now compiles smaller, no JitterEstimator)
- pretest 6/6 PASS

## [4.3.5] - 2026-04-30

### Reverted — full rollback of audio path to v4.3.0 source

User requested rollback to v4.3.0 after reporting v4.3.3 acoustic
regression and v4.3.4's surgical bypass not addressing the
underlying confidence gap. Per-Phase validation was supposed to be
the rule (per `feedback_jitter_test_blind_spot`); v4.3.0 (Phase C
shipping) → D.0 → audit got piled in too quickly without a baseline
listening pass on Phase C alone. This rollback gives that pass.

#### What got reverted (4 files, content checked out from `v4.3.0`)

- `Git/server/src/mixer_server.cpp` — un-does:
  - v4.3.1's LEVELS broadcast `jitter` map field
  - v4.3.2's P0-1 hysteresis fix
  - v4.3.2's P0-2 user-floor on eff_target
  - v4.3.2's P0-5 catch-up cap
  - v4.3.4's bypass (eff_target = uep.jitter_target)
  → mix tick reads `std::max(0, uep.jitter_estimator.target())` again
- `Git/server/wt-mixer-proxy/main.go` — un-does v4.3.2's P0-6
  WT session takeover (sessionMap.set no longer closes displaced
  sessions)
- `Git/web/src/components/AudioDebugPanel.tsx` — un-does v4.3.1's
  liveJitterTarget display + new "live adaptive" line
- `Git/web/src/services/audioService.ts` — un-does:
  - v4.3.1's LEVELS jitter map parsing + liveJitterTarget field
  - v4.3.2's P0-3 PLC xfLen=0 guard
  - v4.3.2's P0-4 lastBlock save during PLC quantum
  - v4.3.2's RING_SIZE_HALF refactor
  - v4.3.2's peerLevelCallback try/catch

#### What stayed forward (kept post-v4.3.0 changes)

- `Git/CHANGELOG.md` — full version history retained (additive)
- `Git/.gitignore` — D.0 hygiene (clangd `.cache/` + Go binary
  paths)
- `Git/deploy/health.sh` — D.0.1 retry on transient WSS
  handshake failures (purely an ops bugfix, unrelated to audio)
- `Git/web/src/services/signalService.ts` — user's `/new` URL
  routing branch (added independently of any v4.x phase)
- Version files (CMakeLists / package.json) — re-bumped to 4.3.5
  by bump-version.sh; not "kept", just normal release flow

#### Why this isn't a force-push

`v4.3.5` is a normal forward release: new commit on top of
HEAD with new tag. Git history shows every step of v4.3.1–4.3.4
that we then rolled back. Anyone reviewing the log can see the
sequence and the reasoning in this entry. v4.3.0's effective
audio path is restored without rewriting any prior commits.

#### Next steps (deliberate, no piling)

1. User validates v4.3.5 listening — should match the v4.3.0
   audio behaviour they wanted to validate originally.
2. If clean: that's the new baseline. Phase C is "shipped but
   needs improvements before adding to it".
3. If still bad: Phase C itself (adaptive jitter) is the
   regression and we revert to v4.2.3 audio path next.

### Validation

- typecheck — clean
- server build (cmake) — clean
- pretest 6/6 PASS, no retries needed (Layer 6 self-updates to
  test current schema; no schema bump in this release)

## [4.3.4] - 2026-04-30

### Reverted — Phase C adaptive jitter target (acoustic regression)

User reported v4.3.3 sounding "significantly worse" than v4.2.3 in
real-session validation. Live data confirmed:

```
v4.2.3 (good):    ring=429  rate=-1599  reprime=3   plc=911
v4.3.3 (bad):     ring=840  rate=+5219  reprime=18  plc=755
```

`reprime` 6× and `ring` 2× is a real regression, not network
noise. The user never got to validate v4.3.0 (Phase C alone)
before D.0/audit work piled on top.

#### Diagnosis

Phase C v4.3.0 introduced adaptive `jitter_target` server-side.
The mix tick reads `jitter_estimator.target()` and trims the
queue when target shrinks. Combined with the audit's P0-1
(hysteresis fix made adaptive *more* responsive) and P0-2
(tightened user-floor → adaptive can't go to 0), `eff_target`
likely oscillates frequently under realistic network noise. Each
oscillation triggers a queue trim — drops the oldest frame — and
each trim is an audible discontinuity. Multiple per second → the
buzzy distortion the user heard.

The Layer 1.5 jitter sweep in pretest doesn't catch this because
it injects synthetic noise patterns that the test framework
correlates with click events at the broadcast boundary, not at
the queue-trim boundary inside the mix tick.

#### Fix

`mixer_server.cpp` `handle_mix_timer`: `eff_target` now reads
`uep.jitter_target` directly (the static / MIXER_TUNE value,
default 1) instead of the estimator's adaptive output.
Effectively restores v4.2.3's mix tick behaviour.

The `JitterEstimator` itself is left in place — it still records
IATs on every UDP receive, so the data is there for a future
re-enablement once we figure out a control law that doesn't
oscillate under realistic conditions. To re-enable, change one
line back to:
```cpp
const int eff_target = std::max(uep.jitter_target, uep.jitter_estimator.target());
```

#### Lessons recorded

This is the second time in v4.x that an "obvious correctness fix"
turned out to make audio worse:
- v4.1.x: tighter primeMin made PLC fire more often → buzz
- v4.3.x: adaptive jitter trim → discontinuity buzz

The Layer 1.5 jitter sweep test passes for both regressions
because the test grades on click rate at packet-boundaries, not
on subtle queue-state discontinuities. **Real-user testing
remains the only way to catch acoustic regressions in this code
path.** Future Phase C re-enablement attempts must be A/B'd
against v4.2.3 baseline by an actual ear before shipping.

#### Validation

- Server build clean
- pretest 6/6 PASS
- Phase C estimator code path remains exercised (Layer 1.5 still
  feeds IATs to the estimator), only the consumer is bypassed

## [4.3.3] - 2026-04-30

### Fixed — wt-mixer-proxy Go binary leaking into release commits

`Git/deploy/server.sh` `--component=wt-proxy` cross-compiles the
WebTransport proxy at `Git/server/wt-mixer-proxy/wt-mixer-proxy`
(no extension). That path wasn't gitignored, so every release.sh
run swept the 10 MB ELF into the v4.x.y commit via `git add -A`.
v4.3.2 surfaced this as a 10 MB diff which made me audit the
working tree before commit — confirmed it was a release-flow
hygiene gap, not anything anyone needs in the tree.

Fix:
- `.gitignore` adds `server/wt-mixer-proxy/wt-mixer-proxy`
- `git rm --cached` to drop it from the index (history retains the
  v4.3.2 blob, but no future release picks it up)

Same class of fix as v4.3.1's `git rm --cached server/.cache`
clangd-index untracking. Bundle these and review the gitignore
once we're past Phase D's bigger questions.

## [4.3.2] - 2026-04-30

### Fixed — code-review audit findings (6 P0 bugs + 3 P1 polish)

A subagent code-reviewer pass over all v4.0–v4.3.1 changes flagged
6 real bugs and a handful of code-quality items. None were
visible in pretest because the existing layers don't exercise the
specific edge cases these touch — they're surfaced only by code
inspection. All P0s fixed; P1 polish bundled in.

#### P0 — correctness bugs

**P0-1** `JitterEstimator` hysteresis reset bug
(`mixer_server.cpp` `on_packet_arrived`). When a recompute landed
on the current `adaptive_target`, the old code reset `agree_count`
to 0 — defeating in-progress hysteresis toward a different target.
A noisy sequence like `propose=2, propose=2, propose=1 (=current),
propose=2, propose=2, propose=2` would require 3 *fresh* agreements
after the noise. Fix: early-return on `new_proposed == adaptive_target`
without disturbing the in-progress counter. Now the same noisy
sequence commits to 2 after 4 recomputes (correct) instead of 6
(stale behaviour).

**P0-2** `eff_target` floor in mix tick (`mixer_server.cpp`
`handle_mix_timer`). The comment promised the user-saved
`jitter_target` would be the floor of the adaptive computation,
but the code did `std::max(0, estimator.target())` — a `>= 0`
clamp, not a user-floor. Two consequences:
- Power users who set `jitter_target=4` could be silently dropped
  back to estimator's adaptive value of 1.
- Adaptive target=0 made `queue.size() >= 0` trivially true, priming
  the gate even when the queue was empty.
Fix: `std::max(uep.jitter_target, estimator.target())`. Code now
matches the comment and the user-floor semantic.

**P0-3** Mid-callback PLC `xfLen=0` edge (`audioService.ts` worklet
template literal). When ring underrun fired on the very last
sample of a quantum (`i == out0.length - 1`), `xfLen = Math.min(16,
out0.length - i - 1) = 0`. Crossfade and PLC-tail loops both
no-op'd, but `concealQuanta` still incremented — desyncing the
decay schedule for the next quantum (next PLC would use `decay[1]`
instead of `decay[0]`). Fix: `decay > 0 && i + 1 < out0.length`
guard around the PLC branch; falls through to cosine fade when
no room for crossfade.

**P0-4** PLC `lastBlock` compounding via mid-callback save
(`audioService.ts` worklet). Top-of-callback PLC `return`s
without saving lastBlock; mid-callback PLC `break`s and falls
through to `lastBlock.set(out0.subarray(0, 128))`. Net effect:
during a sustained underrun episode, mid-callback PLC's lastBlock
was being overwritten with already-decayed PLC content, and the
next PLC quantum would decay it AGAIN. After 4 quanta the energy
schedule was nonlinear (1.0 × 0.7 × 0.4 × 0.15 ≈ 0.04) instead
of the intended `[1.0, 0.7, 0.4, 0.15]` per-quantum. Fix: only
save lastBlock when `concealQuanta === 0` (this quantum was real
audio, not PLC fill).

**P0-5** Mix-timer catch-up runaway (`mixer_server.cpp`
`handle_mix_timer`). After a long event-loop stall (GC pause, OS
pre-emption, debugger), `now_us >> mix_next_deadline_us_` could
trigger 40+ broadcasts in a single timer callback, flooding every
client's UDP recv queue with stale audio in milliseconds. Defeats
client-side jitter buffers and triggers reprime cascade.
Fix: catch-up cap at 100 ms — if `now - deadline > 100ms`, snap
forward to `now + MIX_INTERVAL_US` and log how many ticks were
dropped. Trade: ≤100 ms of audio loss after a stall, vs. an
audible 100 ms burst that breaks every client.

**P0-6** WebTransport session takeover leak
(`wt-mixer-proxy/main.go` `sessionMap.set`). When a user joined
twice as the same uid (tab reload, second device), the new
session replaced the map entry but the old session's read goroutine
kept running and forwarding datagrams to the mixer. Both sessions
streamed simultaneously until the displaced one TCP-disconnected,
confusing the mixer's per-recipient mix-minus path. Fix: on
`sm.set` with a different existing session, spawn a goroutine to
`prev.CloseWithError(0, "replaced...")`. Goroutine because
`CloseWithError` can briefly block on QUIC frame send and we
don't want to hold the sessionMap lock during it.

#### P1 — polish

- Stale "200/s broadcast rate" comment in mixer_server.cpp →
  updated to "400/s (post-Phase-B 2.5 ms tick)" with the doubled
  relative jitter rationale.
- `peerLevelCallback` invocation in LEVELS handler now wrapped in
  per-uid try/catch — same pattern as `fireTuningChanged()` and
  the latency callbacks list. A throwing callback no longer aborts
  the rest of the LEVELS update.
- Magic number `24000` (= RING_SIZE / 2) in `setPlaybackTuning`
  promoted to a class static `RING_SIZE_HALF` with a comment
  explicitly tying it to the worklet ring constant — kept as a
  separate symbol because the ring is local to the worklet
  template literal.

#### Validation

- Full server build (cmake) — clean
- Cross-compile of WT proxy (Go) — clean
- typecheck — clean (caught one more backtick-in-template-literal
  comment, fixed)
- pretest 6/6 PASS, no retries needed
- All 4 state-migration scenarios PASS

## [4.3.1] - 2026-04-30

### Phase D.0 — release-flow cleanup (3 small fixes accumulated across v4.x)

Cleanup pass of issues that surfaced during the Phase A-C release
sequence and were noted as "fix later". None individually warrant
a MINOR; bundled here to clear the backlog before Phase D's
larger architectural questions.

#### D.0.1 — `health.sh` retry on transient WSS handshake failures

`Git/deploy/server.sh --component=binary` sequentially restarts
`tonel-mixer` and `tonel-signaling` via pm2 stop+start. There's a
~0.5–1.5s window between the mixer's stop and start where
`tonel-ws-mixer-proxy` can't reach upstream `127.0.0.1:9002`,
returning HTTP 000 to a WSS handshake probe. Health check fired
inside that window 3 of the last 7 deploys (false-positive rate
> 40%) — visible as `wss srv.tonel.io/mixer-tcp HTTP 000` in
release.sh's tail before re-running health manually.

Fix: `check_wss_handshake` now retries up to 3× with 1.5s spacing
(total ~4.5s probe window, comfortably covering the race).
Configurable via `TONEL_HEALTH_ATTEMPTS` env. Successful retries
log `(after N attempts)` so a real underlying flake doesn't get
hidden — we still see when retries were needed.

#### D.0.2 — untrack `Git/server/.cache/clangd/`

clangd's local index files (`.cache/clangd/index/*.idx`) were
slipping into release commits because they had been committed
once long ago. v4.1.0 added `.cache/` to `Git/.gitignore` (so new
ones don't get tracked), but the existing tracked files kept
showing up as "modified" on every local build → kept entering
release commits as binary diffs.

`git rm -r --cached Git/server/.cache` untracks the existing
files; combined with the v4.1.0 .gitignore entry, the dir is now
fully invisible to git. Saves ~50 KB of binary diff per release.

#### D.0.3 — surface adaptive jitter target in debug panel

Phase C v4.3.0 made `jitter_target` adaptive server-side, but the
client's debug panel still displayed the static configured value
(`serverTuning.jitterTarget` from MIXER_TUNE_ACK). The slider was
silently a no-op and the displayed number could be stale by 8x
under bursty network.

Server (`broadcast_levels`): LEVELS broadcast extended with a
`jitter` block — `{user_id: adaptive_target}`. Carries each user's
current estimator output, sent at the existing 20 Hz cadence.

Client (`audioService.ts`): `liveJitterTarget` field; LEVELS
handler picks out our own `userId` from the `jitter` map.
Initial value −1 means "no LEVELS received yet"; first one
typically arrives within ~50 ms of MIXER_JOIN.

Panel (`AudioDebugPanel.tsx`): legacy slider relabelled
"jitterTarget (saved, ignored by mix)" with a new "live adaptive"
line beneath showing `N fr · M ms` from the live value (or
`— (no LEVELS yet)` before first message).

#### Validation

- typecheck — clean
- Preview MCP smoke: `liveJitterTarget` field exists on
  `audioService` with initial value −1 (correct: no LEVELS yet
  on a fresh page that hasn't joined a room)
- Server build — clean
- pretest 6/6 PASS, no retries needed

## [4.3.0] - 2026-04-30

### Phase C — 自适应 jitter buffer (NetEQ-style adaptive target)

Third MINOR of the v4.x latency-optimisation roadmap. Server-side
change: replaces the static `jitter_target=1` with a per-user
adaptive target that tracks observed inter-arrival-time (IAT)
jitter over a rolling 500 ms window. Good network → target
auto-shrinks toward 0 (saves up to 2.5 ms e2e). Burst-y network
→ target grows up to `jitter_max_depth` (avoids reprime/PLC
escalation that the static cap would otherwise hit).

#### Algorithm — `MixerServer::JitterEstimator` (in mixer_server.h)

Per-user state, ~1.6 KB (200 × uint64 ring + scalars).

```
on UDP recv:
    iat = now − last_arrival
    push iat into ring[200]
    every 20 packets (≈50 ms @ 400 fps), once we have ≥20 samples:
        sort copy
        p95 = sorted[len * 0.95]
        excess = max(0, p95 − 2500us)
        proposed = ceil(excess / 2500us)         # frames of buffer needed
        clamp proposed to [0, jitter_max_depth]
        if proposed == current_target: hold
        else if proposed == previous_proposed: agree_count++
                                                (commit if agree_count ≥ 3)
        else: reset hysteresis with new proposed
```

Hysteresis (3 consecutive agreeing recomputes ≈ 150 ms of
consistent jitter measurement) prevents single bursts from
bouncing the target.

#### Mix tick changes (mixer_server.cpp `handle_mix_timer`)

Before:
```cpp
if (queue.size() >= uep.jitter_target) primed = true;
```

After:
```cpp
const int eff_target = uep.jitter_estimator.target();
if (queue.size() >= eff_target) primed = true;
// Trim queue if adaptive target SHRANK while we were primed.
while (queue.size() > eff_target + 1) queue.pop_front();
```

The trim-on-shrink is one-time discontinuity (samples lost) when
the network suddenly improves, accepted because the alternative
is multi-second drain that the listener would perceive as latency
regressing.

#### Per-user, not global

Each `UserEndpoint` owns its own estimator. In a multi-user room
(C user A on great wifi + B on flaky 4G), they get independent
targets — A drops to 0, B holds at 3, neither pays for the other's
network. Mirrors the existing per-user `jitter_target` /
`jitter_max_depth` knobs.

#### MIXER_TUNE / debug panel slider

The legacy `jitter_target` field on `UserEndpoint` is still
accepted via MIXER_TUNE for backward compat, but the mix tick now
ignores it — the estimator's adaptive value wins. Power users who
want manual control would need a separate "disable adaptive" flag,
which we're not adding in v4.3.0 (no demonstrated need; debug
panel remains useful for `jitter_max_depth` which still binds the
adaptive estimator's upper end).

#### Validation

- Server build: clean
- Layer 1.5 jitter sweep (12 scenarios from clean to jitterSd=20):
  ALL PASS. Sweep injects synthetic IAT noise spanning 4 orders of
  magnitude; the estimator scaled target appropriately for each
  scenario without test failures.
- pretest 6/6 PASS, no retries needed
- Layer 6 state migration: 4/4 PASS (no client-schema change in
  this release; ran for regression coverage)

#### Expected real-world effect

- Clean wired LAN sessions: target settles to 0 → save ~2.5 ms
  e2e vs the v4.2.x default of 1
- Wifi / 4G with burst patterns: target floats 1-3 dynamically,
  reprime/PLC counts should drop further
- Stress events (sudden congestion): target spikes up within
  ~150 ms hysteresis window, absorbing the burst before it reaches
  the cap-drop ceiling

#### Roadmap status

[`local_docs/ROADMAP_V4_LATENCY.md`](local_docs/ROADMAP_V4_LATENCY.md)
Phase C marked done. Phase D (native client / edge nodes) remains
the only pending work — both gated on demonstrated need (native
audio stack required for sub-25 ms; edge nodes only if user
distribution warrants it). Phase A+B+C delivered the bulk of the
browser-floor latency reduction.

## [4.2.3] - 2026-04-30

### Tuning — adopt user-validated empirical sweet spot (primeTarget 6→14 ms, primeMin 1.3→0.3 ms)

User reported v4.2.2's `primeTarget=288` (6 ms) still produced
some PLC artifacts on continuous voice. After manual sweeping in
the debug panel they landed on a counter-intuitive but
significantly cleaner combination:

```
primeTarget    288 → 672  (6 ms → 14 ms)     ← BIGGER ring
primeMin        64 →  16  (1.3 ms → 0.3 ms)  ← MUCH SMALLER trigger
jitterMaxDepth   8 →  13  (20 ms → 32.5 ms cap)
```

Verified live data (v4.2.3-equivalent on user's session):
```
ring=429       (under target — controller has slack, not pegged)
rate=-1599 ppm (NOT at rail — clock drift fully absorbable)
reprime=3      (essentially zero hard glitches)
plc=911        (still many PLC events, but inaudible — see below)
seqGap=0
```

#### Why this configuration sounds clean despite still-frequent PLC

PLC events haven't disappeared (911 vs 2012 in v4.2.1), but the
**audible character** has. The mechanism is the small primeMin:

- v4.2.0/v4.2.1 (primeMin=32, primeTarget=144): PLC fires when
  ring drops below 32. Ring spends most of its time around the
  small 144 target, so PLC kicks in *during* a drain cycle —
  while the natural audio is still loud. The lastBlock-with-decay
  output sounds like a buzzing repeat at that energy level.
- v4.2.3 (primeMin=16, primeTarget=672): PLC only fires when ring
  is **almost completely empty** (16 samples = 0.3 ms left).
  By that point the natural drain has run far enough that any
  audio just before underrun was already trailing off. The
  lastBlock-with-decay output is correspondingly low-energy →
  imperceptibly merges into the natural fadeout.

In other words: the bigger primeTarget "buys altitude" so the
controller has more headroom to coast through bursts; the tiny
primeMin "shifts PLC to the natural quiet zone" where its
artifacts stop being audible.

#### Trade

- **+8 ms client buffer** vs v4.2.2 (3 ms more vs Phase B's
  theoretical floor)
- **e2e**: ~28-35 ms (v4.2.2) → ~36-43 ms — still ~10 ms below
  v4.1.x's ~40-50 ms range, so we keep most of the Phase B win
- **Audio**: markedly cleaner (per user empirical validation)

For low-latency users who want to push back toward 3-6 ms target,
the debug panel's tuning sliders + per-room save still work — they
just stop being the system default.

#### Layer 6 self-update

The state-migration test reads `TUNING_SCHEMA_VERSION` at runtime
and tests "v=CURRENT-1 → discarded". Bumping 4 → 5 auto-extends
coverage to v4 → v5 migration without changing test code.
Confirmed all 4 scenarios PASS post-bump (including Preview MCP
spot-checks of v4 saved-tuning discard + v5 saved-tuning preserve).

### Validation done

- typecheck — clean
- Preview MCP — 3 scripted scenarios PASS
- pretest 6/6 PASS (Layer 2 first-run clean, no retry needed)

## [4.2.2] - 2026-04-30

### Tuning — primeTarget 3 ms → 6 ms (v4.2.0's target was too aggressive)

User reported audible distortion ("破音失真") on v4.2.1. Debug
data:

```
v4.2.1 (5-min session):  reprime=8  plc=2012  ring=457  rate=+24999ppm
```

PLC working correctly (8 reprime is great vs v4.2.0's 2020), but
firing **2012 times in ~5 min = 6+/sec sustained** = 1.8% of audio
is PLC-filled lastBlock content. Each PLC quantum is a held-then-
decayed snippet of prior audio — at >5/sec on continuous voice
that produces a buzzing / robotic artifact. PLC was designed as an
**emergency** mechanism (ride out a brief loss without click), not
a continuous-mode synthesiser.

Root cause: control-loop oscillation. The v4.2.0 `primeTarget=144`
(3 ms) buffer is just barely above Web Audio's 128-sample (~2.7 ms)
output quantum. The cycle:
1. Server bursts → ring spikes to ~3× target
2. rate controller pegs at MAX (+25000 ppm = 2.5%)
3. Drains in ~0.4 s
4. Ring underruns → PLC fires
5. PLC ends, ring fills back to 3× target from server bursts
6. Repeat at ~2.5 Hz

`rate=+24999ppm` sustained at the rail also tells us the controller
**can't actually settle** — there's no equilibrium where production
matches consumption inside the band, so we live at the rail and
oscillate.

#### Fix

`DEFAULT_PB.primeTarget` 144 → 288 (3 ms → 6 ms), `primeMin`
32 → 64 (proportional). Schema bumped 3 → 4 so existing v3 saved
slots (carrying primeTarget=144) get discarded on next room join.
6 ms is the sweet spot:
- Still 5× smaller than v4.1.x's 30 ms (so we keep most of the
  Phase B latency win)
- Big enough to absorb server tick burst pattern without daily
  PLC firing
- PLC stays available as actual emergency

Trade-off vs v4.2.1: **+3 ms e2e latency** (back to ~28-35 ms
range) for clean audio. Worth it.

#### Layer 6 auto-updates with the bump

The state-migration test (added v4.1.3) was deliberately written
to read `mod.AudioService.TUNING_SCHEMA_VERSION` at runtime and
test "v=CURRENT-1 → discarded". So it self-updates to test
v3→v4 migration without code changes — confirmed all 4 scenarios
PASS post-bump.

### Validation done

- typecheck — clean
- Preview MCP scripted test — 3 scenarios PASS:
  - v4.2.2 defaults match expectation (schemaVer=4, pt=288, pm=64)
  - v3 saved slot → discarded + v4 defaults applied
  - v4 saved slot with custom values → preserved + custom applied
- pretest 6/6 PASS (Layer 2 needed one auto-retry on 44.1k playback,
  second pass clean)

#### What to look for in next real session

- `plc=N` should drop dramatically (target: < 30/min, was 6+/sec)
- `reprime=N` should stay near zero (PLC still catches occasional
  underruns)
- `ring=N` should sit close to 288 (target), not 3× it
- `rate=N ppm` should leave the rail and float in ±5000 ppm
- Audible distortion should be gone

If `plc` is still in the hundreds-per-minute range, we're
fundamentally bandwidth-mismatched (server producing > client can
drain) and need server-side investigation, not more buffer.

## [4.2.1] - 2026-04-30

### Fixed — v4.2.0 PLC only covered top-of-callback; mid-callback bypassed it

User reported v4.2.0 was producing `reprime=2020` and `plc=0` in
a 5-min session — i.e. PLC never fired despite ~2k underrun
events. Root cause: B.2's PLC was added to the **start-of-callback**
underrun path (`if (!this.primed || this.count < this.primeMin)`
at the top of `process()`), but the **mid-callback** underrun path
(detected during the per-sample render loop) was untouched and
still went straight to cosine fade-out + reprime.

This was invisible in v4.1.x because the old `primeTarget=1440`
(30 ms) made mid-callback underruns rare — the ring almost always
drained between quanta, so top-of-callback was the dominant path.
v4.2.0's `primeTarget=144` (3 ms) flipped this: the ring drains
within a single output quantum (128 samples = 2.7 ms), so
mid-callback underruns now dominate. They went straight to reprime,
defeating the entire B.2 PLC win.

**Fix**: extend the PLC algorithm to the mid-callback branch.
Same `concealDecay = [1.0, 0.7, 0.4, 0.15]` envelope. New behaviour
on mid-callback underrun:

1. Hold the last real sample (`out0[i]`) and crossfade over 16
   samples into the lastBlock-derived PLC content.
2. Fill the remainder of the quantum from lastBlock × decay.
3. Don't reset `primed` — next quantum either continues PLC or
   resumes normal output (with the existing wasConcealing ramp-in).
4. Increment `concealCount` (stat: `playPlcCount`); only fall
   through to the original cosine + reprime path if the PLC
   budget is exhausted (4 quanta × ~2.67 ms ≈ 10 ms).

Expected delta vs v4.2.0 in real session: `reprime` count drops
sharply (only sustained drops escalate now), `plc` count rises
proportionally. Net audio quality should be markedly smoother.

### Fixed — debug panel jitter labels stuck on 5 ms (was 2.5 ms after v4.2.0)

`AudioDebugPanel.tsx` had `jitterTargetMs = s.jitterTarget * 5`
hardcoded — same display-vs-runtime drift class as v4.1.2's
DEFAULT_PB bug, just smaller blast radius (cosmetic only).
Server tick is 2.5 ms post-v4.2.0, so jitterTarget=1 frame =
2.5 ms not 5 ms. New `FRAME_MS = 2.5` constant used in the
calc; `totalAddedMs` (the headline "added latency budget"
display) also fixed.

### Validation done

- typecheck — clean (caught two backtick-in-comment bugs inside
  the worklet template literal that would have blown up
  `addModule()`; fixed by stripping backticks)
- Preview MCP — loaded the modified worklet via dynamic import +
  `audioContext.audioWorklet.addModule()` against a real Chromium
  context. PASS — worklet code parses cleanly.
- pretest 6/6 PASS (Layer 2 needed one auto-retry on 44.1k
  playback test, second pass clean — known flake)
- Layer 6 state migration: 4/4 PASS

## [4.2.0] - 2026-04-30

### Phase B — 压管线缓冲（PCM PLC + primeTarget 30→3 ms + frame 5→2.5 ms）

Second MINOR of the v4.x latency-optimisation roadmap. Three
client-and-server changes that together shrink the e2e latency
budget by ~8-10 ms and largely eliminate audible reprimes.

**Headline numbers (expected, vs v4.1.3 on the same hardware):**
- Steady-state e2e: ~32-40 ms → ~25-32 ms (-7 ms)
- reprime / 5-min session: single digits → ~0
- Click events / minute: rare → essentially never

#### B.1 — primeTarget default 1440 → 144 samples (30 ms → 3 ms)

The client playback ring's "depth target" used to be 30 ms — a
generous cushion against burst arrival, jitter, and clock drift,
but a flat ~30 ms tax on every user's e2e latency. Phase B's PLC
(B.2 below) makes underruns recoverable without a click + ring
reset, so the cushion can shrink dramatically. 3 ms is just above
Web Audio's 128-sample (~2.7 ms) output quantum — the physical
floor.

`primeMin` also tightened from 128 → 32 samples (~0.67 ms) since
PLC now activates at 32 instead of triggering full reprime.

`audioService.ts` `DEFAULT_PB.primeTarget` and `primeMin` updated;
`tuning` initialiser now spreads from `DEFAULT_PB` (single source
of truth) so future bumps can't have the v4.1.2 drift bug again.

`TUNING_SCHEMA_VERSION` bumped 2 → 3 — saved-tuning slots from
v4.1.x carry primeTarget=1440 and would silently keep users on the
v4.1.x latency floor without this discard.

#### B.2 — Client PCM PLC (Packet Loss Concealment)

Replaces the start-of-callback "ring drained → silence + reprime"
behaviour with progressive concealment using the last emitted
quantum. Algorithm:

```
0–1 quanta of underrun: full lastBlock energy
2 quanta:               70% energy
3 quanta:               40% energy
4 quanta:               15% energy
≥5 quanta (~10 ms):     give up → silence + reprime + reset
```

When the ring refills mid-concealment and we resume normal output,
a 32-sample (~0.67 ms) linear ramp-in crossfades from the last
concealed sample to the new audio — keeps the transition below
perceptual click threshold.

State cost: one Float32Array(128) (~512 B). CPU cost: same as the
silence path (one fill loop) plus a multiply.

The mid-callback underrun path (cosine fade-out + zero-fill the
remainder of the quantum) is unchanged — it handles the rarer case
of underrun discovered partway through rendering.

New stat `playPlcCount` exposed on `audioService` and rendered in
the debug panel as `plc=N` next to `reprime=N`. Healthy ratio:
many `plc`, near-zero `reprime` = controller riding small jitter
gracefully. Many `reprime` relative to `plc` = sustained drops PLC
couldn't mask (network or server died for >10 ms).

#### B.3 — Frame size 5 ms → 2.5 ms (client + server, breaking)

The capture frame and server mix tick both halved from 5 ms (240
samples @ 48 k) to 2.5 ms (120 samples). Saves 2.5 ms each side =
~5 ms of e2e budget. Cost: packet rate 200 fps → 400 fps; SPA1
header overhead share doubles (76 B / 240 B = 32% vs the old
76 B / 480 B = 16%). Total bandwidth still well under 1 Mbps for
PCM16, no concern.

`audioService.ts`: new `FRAME_MS = 2.5` constant; `FRAME_SAMPLES`
now derives from it (was the literal 240). The e2e formula updated
to use `FRAME_MS` for the capture / mix-tick / jitter terms so it
auto-tracks the constant.

`mixer_server.h`: `MIX_INTERVAL_US = 5000 → 2500`; `audio_frames`
default 240 → 120. Constructor signature updated (the only caller
in production passes the default).

`mixer_server.cpp`: first-fire timer delay 5 → 2 (libuv granularity
is 1 ms; the absolute-deadline scheduler absorbs the alternating
2/3 ms rounding so average tick is exactly 2.5 ms). Level-broadcast
throttle bumped from "every 10 ticks" to "every 20 ticks" so the
~20 Hz LEVEL message rate is preserved.

**Breaking change for native AppKit clients**: they assume 240-sample
frames (5 ms) and will mis-decode the new 120-sample broadcasts.
Native clients are currently in `Tonel-Desktop(Legacy)` directory
and not in active use; updating them is a separate task. **If you
are running native AppKit clients in production, do not deploy
v4.2.0 yet** — fall back to v4.1.3 until native is updated.

#### Test infrastructure updates

Layer 1 (`audio_quality_e2e.js`): `FRAME_SAMPLES` 240 → 120,
`FRAME_INTERVAL_MS` 5 → 2.5, voice-test carrier frequency 200 Hz →
400 Hz (preserving the "period == one frame" PLC-detection
invariant). Broadcast-rate assertion now uses `1000 / FRAME_INTERVAL_MS`
as the nominal target so it tracks the constant.

Layer 2 (`browser_audio_test.js` + `test_page.html`): `FRAME_SAMPLES`
mirror updated. `test_page.html`'s embedded test-only worklet kept
on its old defaults (it's a synthetic-input quality test, not a
production worklet mirror).

Layer 6 (`state_migration_test.js`): added v:2 → v:3 prev-schema
discard scenario. Existing scenarios refactored to read live
`DEFAULT_PB` so they self-update across future Phase bumps.

Pretest result on dev machine: all 6 layers PASS clean (no
retries needed for Layer 2 this run).

#### Validation done

- `npx tsc --noEmit` — clean
- C++ build (`cmake --build`) — clean
- `Git/scripts/pretest.sh` — all 6 layers PASS
- `state_migration_test.js` — 4/4 scenarios PASS (stale, prev,
  current, no-slot)

#### Roadmap status

[`local_docs/ROADMAP_V4_LATENCY.md`](local_docs/ROADMAP_V4_LATENCY.md)
Phase B section will be marked `**已完成**`. Phase B's "B.1 must
precede B.3" sequencing was honoured (B.2 PLC enabled → B.1
primeTarget reduction safe → B.3 frame size halving last). Next:
Phase C v4.3.x — adaptive jitter buffer (NetEQ-style).

## [4.1.3] - 2026-04-30

### Added — pretest Layer 6: state migration test (固化 v4.1.1/v4.1.2 教训)

The two consecutive hotfixes (v4.1.1 schema-version + v4.1.2
DEFAULT_PB) were both invisible to the existing pretest layers
because Layer 2 (browser audio) launches a fresh Chromium profile
with empty localStorage every time — there's no "user upgrading
from prior version with saved state" coverage anywhere in the
release pipeline.

Both bugs were also invisible to code review (a stale constant
hidden 1300 lines from the live initializer). They only surfaced
once a real user with a populated localStorage joined the
deployed page and reported "didn't change". That's the worst
feedback loop possible — round-trip cost ~30 minutes per
iteration vs. ~10 seconds for an automated test.

#### `Git/server/test/browser/state_migration_test.js`

New standalone Node + Playwright test that:
1. Spawns Vite dev server on port 5174 (port-probe readiness, ~3s)
2. Launches headless Chromium
3. Navigates to the dev server URL
4. Inside the page, dynamic-imports `audioService.ts`, plants
   synthetic localStorage blobs at known schemas, calls the
   private `loadRoomTuningIntoState()` migration entry point,
   reads back state, and asserts.

Three baseline scenarios:
- **Stale slot** (no `v` field) → discarded + CURRENT defaults
  applied (`maxScale === 1.025`, `primeTarget === 1440`).
  Catches the v4.1.2 regression class.
- **Current schema slot** (`v: 2`) with user-customised values →
  preserved, user values overlay. Catches "schema check too
  aggressive, eats valid current-schema slots" regression.
- **No slot at all** → defaults applied. Sanity baseline.

#### Wired into pretest as Layer 6

`Git/scripts/pretest.sh` extended:
- New `6/6 state migration` step at the end (after Layer 2)
- `SKIP_MIGRATION=1` env to skip (e.g. dev iteration on an
  unrelated subsystem); not for release flow
- Step labels renumbered `1/6`...`6/6` throughout

Total cost: ~10 s wall-clock added to pretest. Critical for any
future change that touches `DEFAULT_PB` / `DEFAULT_SRV` /
`TUNING_SCHEMA_VERSION`.

#### Memory entry: `feedback_state_migration_test`

Added a permanent rule in this project's auto-memory:
- Bumping `DEFAULT_PB` or `DEFAULT_SRV` MUST be paired with a
  `TUNING_SCHEMA_VERSION` bump (otherwise stale slots silently
  pin users to old defaults — exactly what v4.1.2 caught).
- Bumping `TUNING_SCHEMA_VERSION` MUST add a scenario to
  `state_migration_test.js` planting the previous schema and
  asserting it's discarded.
- Pre-existing scenarios stay as regression coverage.

Phases B / C / D ahead each likely bump `TUNING_SCHEMA_VERSION`
once (B: smaller `primeTarget` default; C: maybe new server
tuning fields; D: probably no localStorage change). The test
infra now ensures none of those silently strands users on stale
saved state.

## [4.1.2] - 2026-04-30

### Fixed — v4.1.1 schema migration discarded stale slot but reapplied OLD defaults

v4.1.1 added the schema-version gate to discard stale `tonel.tuning.*`
localStorage slots and "fall back to current defaults". The discard
side worked correctly — slots were wiped, the migration log line
fired. **But the "current defaults" being reapplied were the v3.x
constants** (`maxScale: 1.012`, `minScale: 0.988`), not the v4.1.0
new values (`maxScale: 1.025`, `minScale: 0.975`).

Root cause: `tuning` (the live in-memory state, used by the
worklet on construction) was bumped to ±2.5% in v4.1.0. But there
is a **second copy** of these defaults — `private static readonly
DEFAULT_PB` — that the discard-and-reset path in
`loadRoomTuningIntoState()` (and `resetRoomTuning()`) calls
through. That static constant still held `maxScale: 1.012`
because v4.1.0's edit only touched the live initializer.

Two sources of truth, drifted out of sync. Discovered via Preview
MCP automation: spawned the dev server in a Chromium-based
preview, planted a fake stale tuning blob into `localStorage`,
called `loadRoomTuningIntoState()` manually, and observed
`tuning.maxScale` come back as `1.012` after the supposedly-clean
migration. The migration log line fired (proving the discard ran);
the value was wrong (proving the reset side was wrong).

**Fix**: update `DEFAULT_PB` to the v4.1 values (1.025 / 0.975).
Comment block on `DEFAULT_PB` now explicitly tags it as the
single source of truth and says any future bump must also bump
`TUNING_SCHEMA_VERSION`.

**Validation done**: re-ran the same Preview MCP test after the
fix. Two scenarios verified:
1. Stale (no `v` field) blob → discarded, defaults applied with
   correct v4.1 values (`maxScale: 1.025` ✓, `primeTarget: 1440` ✓,
   slot wiped ✓).
2. Current (`v: 2`) blob with user's custom aggressive values
   (`primeTarget: 144`) → preserved, user values overlay correctly.
   Doesn't accidentally discard valid current-schema slots.

### Process note — automated test caught the regression cleanly

This bug was invisible to `pretest.sh` (Layer 2 Playwright runs
in a fresh browser profile, no stale localStorage to load). It
also wasn't visible from a code review of v4.1.1 alone — the
migration logic looked right; the trap was a stale constant
hidden 1300 lines away.

Caught by Preview MCP scripted test that:
1. Started the local Vite dev server
2. Loaded `audioService.ts` via dynamic import
3. Planted a synthetic stale blob in `localStorage`
4. Manually invoked the prototype's private migration method
5. Read out the post-migration `tuning` state
6. Asserted on expected values

This is the kind of state-migration test that should live
permanently — added as a follow-up TODO. For Phase B onward, the
combination of "stale-state replay test" + the bumped
`TUNING_SCHEMA_VERSION` rule should prevent this class of
regression.

## [4.1.1] - 2026-04-30

### Fixed — v4.1.0 Phase A.1 silently overridden by stale localStorage tuning

v4.1.0 raised the playback rate controller's `maxScale` 1.012 →
1.025 to give the proportional fast-adjust enough headroom to
drain server mix-tick burst patterns. **Real-user validation
revealed the change took no effect** for users with a saved
per-room tuning slot (the "📍 saved for ROOM:USER" indicator in
the debug panel). Their `rate=` still pegged at +12000ppm — the
OLD 1.012 rail — because `loadRoomTuningIntoState()` reads
`localStorage[tonel.tuning.${roomId}:${userId}]` and overlays
the persisted client-side knobs verbatim. Saved blobs from v3.x
days carry `maxScale: 1.012` and silently overwrote the new
1.025 default.

**Fix**: schema-version the saved tuning blob.
- New `TUNING_SCHEMA_VERSION = 2` constant (was implicitly 1 / no
  version pre-v4.1.1).
- Save path writes `{ v: 2, client, server }`.
- Load path: if `parsed.v` is missing or `< current schema`,
  treat the slot as stale → `localStorage.removeItem` + reapply
  current defaults. One log line per discard so the user / engineer
  can see migrations happening.

**Migration behaviour**: every existing user who saved tuning
pre-v4.1.1 has their slot wiped on next room join, falls back to
v4.1.0's new defaults (the ones they actually wanted). If they
had genuinely valuable per-room tuning, they'll need to re-set
it via the debug panel; cost is acceptable because the previous
tuning was actively hurting them (rate stuck at rail).

**Future schema bumps**: any further change to `DEFAULT_PB` /
`DEFAULT_SRV` defaults that would silently regress saved-tuning
users should bump this constant. Phase B / C / D will likely
each bump it once.

### Process note — caught by mandated post-release validation

Per the new pre-release rule (memory: `feedback_pre_release_browser_test`),
v4.1.0 was put through the full pretest.sh sweep before release
— all 5 layers passed. **The localStorage migration gap was
invisible to those tests** because Layer 2 (Playwright Chromium)
runs in a fresh browser profile with empty localStorage every
time. The bug only surfaced once a real user with a populated
localStorage joined the deployed page. This is a known coverage
hole in our testing setup (pretest doesn't model "user upgrading
from prior version with saved state").

Mitigation for future Phase releases: when changing default
tuning values, **always bump TUNING_SCHEMA_VERSION**. Long-term
fix: add a Layer 2 scenario that pre-populates localStorage with
a known-stale blob and verifies the load path discards it. Tracked
as a follow-up; not blocking Phase B.

## [4.1.0] - 2026-04-30

### Phase A — 解锁底（rate controller + outputLatency UI + sample-rate auto-align）

First MINOR of the v4.x latency-optimisation roadmap (see
`local_docs/ROADMAP_V4_LATENCY.md`). Three independent client-side
fixes that together unlock the rest of the roadmap by removing
artificial floors in the playback control loop and in browser→OS
audio plumbing.

#### A.1 — Rate controller proportional fast-adjust + ±2.5% rail

**Problem**: post-WT (v4.0.1) users observed `rate=+12000ppm`
saturating the maxScale rail for entire sessions, with `ring`
sitting at 2-3× `primeTarget` and `reprime` counting up to 500+
per 5-min session. Cause was twofold: the ±1.2% rail wasn't enough
headroom for server mix-tick scheduling jitter that periodically
delivers small bursts (gap=0 confirms it's not network re-ordering),
and the integrator's fixed step (20 ppm/quantum) couldn't drain a
2-3× target overflow before the next burst piled on.

**Fixes** (both in `audioService.ts`):

1. `maxScale` 1.012 → **1.025**, `minScale` 0.988 → **0.975** —
   doubles the headroom to ±25000 ppm. 2.5% pitch shift is
   audible on critical music listening but sub-perceptual on
   speech and only manifests on burst-recovery transients (steady
   state still converges to whatever tiny scale matches actual
   clock drift, typically <500 ppm).

2. **Proportional fast-adjust** in the playback worklet's
   integrator. The old fixed step gives way to a 5-band
   piecewise-linear gain on `rateStep`:

   ```
   count > 2.0× target → step × 8   (catastrophic burst recovery)
   count > 1.5× target → step × 4   (large burst)
   count > 1.3× target → step × 1   (normal slow drift)
   count in deadband   → 0          (hold; no oscillation)
   count < 0.7× target → step × 1
   count < 0.5× target → step × 4   (about to underrun)
   ```

   Steady-state behaviour and pitch jitter are unchanged (the
   ×1 band still applies near target). Burst-recovery time drops
   from ~12 s (rail-bound at fixed step) to <1 s (8× step takes
   rate to rail in ~0.4 s, then rate at 1.025 drains 25
   samples/quantum × 375 quanta/s = 9375 samples/s).

**Expected effect**: `rate` no longer pegs at +12000 for whole
sessions; `ring` converges to within ±2× `primeTarget`;
`reprime`/5-min drops from 500+ to single digits.

#### A.2 — outputLatency UI hint

**Problem**: `audioContext.outputLatency` is the largest single
opaque variable in the e2e budget. Bluetooth headphones
(particularly AirPods, generic AAC) routinely report
100-200 ms here, which silently negates every server-side
optimisation we've shipped. Users had no way to see this — the
debug panel surfaces ring fill and reprime but not the OS-side
output latency.

**Fix**:

- New `audioService.outputLatencyMs` getter reading
  `audioContext.outputLatency * 1000` (returns 0 on Safari which
  often omits this field).
- `RoomPage` polls it on the existing 150 ms fast timer; when
  > 30 ms (safely above wired/USB DAC range of 5-10 ms),
  renders a dismissible amber banner: "检测到高延迟输出设备
  (~XX ms)…建议改用有线耳机或 USB 声卡".
- Dismissal persisted in `sessionStorage` — banner stays gone
  for the rest of the browser session but reappears next reload.

**Threshold rationale**: 30 ms cleanly separates wired (5-10 ms)
from Bluetooth (60-200 ms). USB DACs land at 3-8 ms, well below
threshold. False-positive risk is essentially nil; false-negative
risk only exists on aptX-LL (~30-40 ms) which is rare on
consumer hardware.

#### A.3 — mic ↔ AudioContext sample-rate auto-alignment

**Problem**: the v4.0.x init flow always asked getUserMedia for
48 kHz and built the AudioContext at 48 kHz. On hardware whose
native rate is 44.1 kHz (most built-in laptop mics, many
Bluetooth headsets at 16 kHz), this forced Chrome's internal
mic→ctx polyphase resampler, adding ~5-10 ms of capture-side
latency.

**Fix** (in `audioService.ts` init flow):

- If user hasn't pinned a rate via Settings → 采样率 (the
  `tonel.audio.sampleRate` localStorage key remains null):
  1. Acquire mic with **no rate constraint** → browser picks
     the device's native rate.
  2. Read what we actually got via
     `track.getSettings().sampleRate`.
  3. Build the AudioContext at that exact rate → mic and ctx
     match → Chrome skips the resampler.
- If user *has* pinned a rate, behaviour is unchanged (their
  explicit choice wins over auto-alignment).

**Logging**: init now prints either
"AudioContext rate XXXXX Hz aligned with mic native XXXXX Hz —
no resampler" (good case) or the previous warning about
mismatch (forced override or fallback path).

**Expected effect**: -0 to -10 ms on capture side, depending
on hardware. Built-in MacBook mic (44.1 k native) sees the full
benefit; external 48 k USB mics see nothing change because they
were already aligned.

### Validation done before release

Per the new pre-release rule:
- `npx tsc --noEmit` — clean
- `Git/scripts/pretest.sh` full suite (Layer 1 SNR/THD, Layer 1.5
  jitter sweep × 12 scenarios, signaling integration, Layer 2
  Playwright + Chromium browser audio) — all 5 layers passed
  (Layer 2 needed one auto-retry for first-run flake; second
  pass clean)
- Chrome MCP live-load: skipped — no browser currently
  connected to the MCP extension. Real-world rate-controller
  validation needs a multi-minute session with mic + audio
  output, which exceeds what we can drive headlessly.

### Next phase

`Phase A → v4.1.0` boxes are checked. Next: Phase B (v4.2.x) —
primeTarget 6→3 ms, client PCM PLC, frame size 5→2.5 ms.
Per the roadmap, B can only start after A is validated in real
users for at least one session — verify in production that
`rate` no longer pegs and `reprime` drops sharply before
opening v4.2.x branch.

## [4.0.1] - 2026-04-30

### Fixed — WT proxy missing `ConfigureHTTP3Server` call (HTTP/3 datagrams disabled)

v4.0.0 shipped with the WT proxy listening on UDP 4433 but
**rejecting every WebTransport handshake** with the client-side
error `server didn't enable HTTP/3 datagram support`. Caught during
post-deploy validation: once Aliyun security group opened UDP 4433
and packets actually reached the OS (iptables ACCEPT counter went
0 → 3), the QUIC handshake completed but the H3 layer's SETTINGS
frame never advertised the `H3_DATAGRAM` capability that the
WebTransport client requires.

Root cause: `webtransport-go` v0.10's documented setup requires
calling `webtransport.ConfigureHTTP3Server(s.H3)` BEFORE
`ListenAndServe`. The library auto-configures the QUIC layer's
`EnableDatagrams = true` inside its own `Serve()`, but the HTTP/3
layer's SETTINGS frame needs the explicit helper to add the
WebTransport SETTINGS keys + `H3.EnableDatagrams`. v4.0.0's main.go
called `wtServer.ListenAndServe()` directly without this helper,
so the QUIC handshake worked but H3 negotiation rejected datagram
support → client always falls back to WSS.

Fix: one line in `wt-mixer-proxy/main.go`, calling
`webtransport.ConfigureHTTP3Server(wtServer.H3)` between server
struct construction and `ListenAndServe`. Both the QUIC layer (was
already correct) and the H3 SETTINGS frame (was the gap) now
advertise datagram support, and a probe from the dev machine
completes the full WT handshake.

User-visible effect: any browser that visits a v4.0.0 page after
the Aliyun security group rule was added would still see
`transport=wss` because the server-side handshake silently failed.
After v4.0.1, capable browsers (Chrome / Edge / Firefox desktop)
should land on `transport=wt` automatically.

No client-side change. The web bundle from v4.0.0 is unchanged in
v4.0.1 — only the server proxy binary swaps.

## [4.0.0] - 2026-04-30

### Added — WebTransport audio path with WSS fallback (major)

The browser → server audio leg now runs over **HTTP/3 WebTransport
datagrams** (UDP / QUIC) for capable browsers, with the existing
WSS-over-TCP path retained as fallback for Safari and older
browsers. This is the architectural change that's been blocking
sub-30 ms end-to-end latency: the WSS path's TCP head-of-line
blocking and Nagle-induced bursts were the root cause of the
ring=6920 / reprime=1525 oscillation pattern visible in the v3.7.9
debug panel even on a 10 ms RTT link.

#### Server: new `tonel-wt-mixer-proxy`

`Git/server/wt-mixer-proxy/` — Go binary built on `quic-go` +
`webtransport-go`. Listens on UDP `:4433` with the existing
`srv.tonel.io` LetsEncrypt cert (no nginx in front; nginx HTTP/3
support isn't mature enough for WT upgrade). Serves WebTransport
sessions at path `/mixer-wt`.

For each session: client `SendDatagram(SPA1 packet)` is forwarded
to the mixer at `127.0.0.1:9003` from a single bound UDP port
(`:9007`). Reverse path reads from that bound port, parses the
`userId` field out of each SPA1 header, and routes the datagram to
the matching WT session. Same demux pattern as
`ws-mixer-proxy.js`'s `wsByUid` map, just with QUIC datagrams
instead of WebSocket frames.

The Go binary is **statically linked, CGO disabled** — drops in to
the production host with no libc-version concerns. Cross-compiled
on the operator's macOS box during deploy, only the resulting
Linux/amd64 ELF lands on the server.

PM2 entry: `tonel-wt-mixer-proxy`, autorestart, logs to
`/var/log/tonel/wt-mixer-proxy.{out,err}.log`.

#### Web: transport abstraction in `audioService.ts`

New helpers — `sendAudioPacket()`, `tryWebTransport()`,
`runAudioWTReadLoop()`, `chooseAudioTransport()` — let the four
SPA1 send sites (capture worklet, capture script-processor, initial
handshake, reconnect handshake) be transport-agnostic.

`connectMixer()` now:
1. Decides transport via `chooseAudioTransport()`:
   - `?transport=wss` forces WSS (useful for A/B testing)
   - `?transport=wt` forces WT (fails loudly if unsupported)
   - default: WT if `'WebTransport' in window`, otherwise WSS
2. If WT chosen: `await new WebTransport(url).ready` — on success
   spawn the datagram read loop; on any failure (cert mismatch,
   UDP 4433 blocked by user's network, server not running) fall
   through to WSS automatically with one warning line.
3. WSS audio socket is **only** created when WT is the inactive
   path. No double-connect, no idle WS holding a TCP slot.
4. Control channel (`/mixer-tcp`) stays WSS regardless — control
   traffic isn't latency-sensitive and the WS path is battle-tested.

The same SPA1 handshake packet works for both transports — the
proxy uses `userId` from the header to register the session. No
protocol-level changes; only the wire envelope differs.

#### Debug panel

LIVE section now shows `transport=wt|wss` colour-coded so an
engineer can confirm at a glance which path is active. Cyan = WT,
yellow = WSS, grey = pre-handshake.

#### Why WebTransport over WebRTC DataChannel

Tonel is a client-server architecture: the mixer has a public IP,
no NAT involved. WebRTC's ICE/STUN/SCTP overhead exists to enable
P2P NAT traversal — none of it buys us anything in this topology,
and ~5-10 RTT of ICE handshake delays room entry meaningfully on
high-RTT connections.

WebTransport is the standard the spec authors built specifically
for this case: 1-RTT QUIC handshake, datagrams as a first-class
primitive, standard HTTPS cert verification, single connection.
Cost is Safari unsupported (no roadmap commitment as of 2026 Q2).
Tonel's Safari users already accept reduced functionality
(speaker-mode reverted in v3.7.7, earpiece-only routing on iPhone)
so deferring WT to "Safari Y+1" is acceptable.

#### Operational notes for first deploy

1. **UDP 4433 must be reachable** from the public internet.
   Check with `ufw allow 4433/udp` (or equivalent) on the server.
   If the port is firewall-blocked, all WT clients fall back to
   WSS — no outage, just no latency improvement until fixed.

2. **TLS cert read access**: the proxy runs as root (under PM2)
   and reads `/etc/letsencrypt/live/srv.tonel.io/{fullchain,privkey}.pem`
   directly. Cert auto-renewal will require a manual
   `pm2 reload tonel-wt-mixer-proxy` on the next renewal — TODO
   to wire a certbot deploy hook for this in v4.0.x.

3. **Cross-compile dependency**: the operator's machine needs Go
   installed (`brew install go` on macOS). Only the resulting
   binary lands on the production server.

#### What did NOT change

- Wire format: SPA1 packets unchanged (76 B header + payload).
- Mixer server: unchanged. Still listens on UDP 9003 for SPA1
  packets from any source. The WT proxy is a transparent bridge,
  same as the WSS proxy.
- Native AppKit / Desktop clients: unchanged. They still use raw
  UDP 9003 directly.
- Control channel: still WSS to `/mixer-tcp`.
- Existing WSS audio path: still works, still deployed,
  automatically used by Safari and any browser without WT.

#### Risk profile

Low. The fallback chain is exhaustive — any failure in the WT
path (server down, firewall blocking, browser unsupported, cert
problem, network UDP throttling) lands the user back on the v3.7.9
WSS audio path with a single warning line in console. There is no
state in the WT proxy that can corrupt the mixer; bridge mode only.

Mid-session WT close currently does not auto-fall to WSS — the
existing WT-only reconnect logic kicks in instead. If WT becomes
permanently unavailable mid-session, the user has to refresh.
TODO for v4.0.x: graceful WT → WSS demotion mid-session.


---

## Older entries

Versions <v4.0.0 (35 v3.x.x + 54 v1.0.x = 89 entries) archived to [CHANGELOG-archive.md](CHANGELOG-archive.md) on 2026-05-02. The active changelog now starts at v4.0.0, where the latency optimization roadmap (Phase A → D) began.
