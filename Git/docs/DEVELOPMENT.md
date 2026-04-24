# Development Guide

## Version Management

This project uses **Semantic Versioning** (SemVer): `MAJOR.MINOR.PATCH`

### Rules

| Part | When to Increment | Example |
|---|---|---|
| **MAJOR** | Incompatible changes (SPA1 protocol v2, API breaking) | `0.x.x` → `1.0.0` |
| **MINOR** | New features, backward compatible | `0.1.x` → `0.2.0` |
| **PATCH** | Bug fixes, performance improvements | `0.1.0` → `0.1.1` |

### Tagging

```bash
# Create and push a tag for each release
git tag -a v0.1.0 -m "Initial release"
git push origin v0.1.0
```

### Current Version

All versions are in sync at `0.3.2`. Update all version numbers together when releasing:

| Location | File |
|---|---|
| Root project | `Git/CMakeLists.txt` → `project(Tonel VERSION X.Y.Z)` |
| AppKit client | `Git/Tonel-Desktop-AppKit/CMakeLists.txt` → `MACOSX_BUNDLE_VERSION` |
| JUCE client | `Git/Tonel-Desktop/CMakeLists.txt` |
| Server | `Git/server/CMakeLists.txt` |
| Web | `Git/web/package.json` → `version` |

### Changelog

Add a `CHANGELOG.md` before each release:

```markdown
## [0.2.0] - 2026-04-18

### Added
- AppKit native client

### Fixed
- Button click handling in AppKit client
```

## Git Branch Strategy

### Branches

| Branch | Purpose |
|---|---|
| `main` | Stable, tagged releases only |
| `dev` | Ongoing development (merge source) |
| `feature/xxx` | New features (branched from `dev`) |
| `fix/xxx` | Bug fixes (branched from `dev` or `main`) |

### Workflow

```bash
# Start a new feature
git checkout dev
git checkout -b feature/opus-codec-improvement

# Commit your work
git add .
git commit -m "feat: improve Opus codec latency by 2ms"

# Push and create PR (when you have collaborators)
git push origin feature/opus-codec-improvement

# Merge back to dev after review/confirm it works
git checkout dev
git merge feature/opus-codec-improvement

# Release: tag and push to main
git tag -a v0.2.0 -m "v0.2.0 release"
git checkout main
git merge dev
git push origin main --tags
```

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>: <description>

# Types:
#   feat     - New feature
#   fix      - Bug fix
#   docs     - Documentation only
#   refactor - Code restructuring (no behavior change)
#   chore    - Build, config, tooling
#   perf     - Performance improvement

# Examples:
#   feat: add Opus codec support for server mixer
#   fix: restore button click handling in AppKit client
#   docs: add architecture documentation
```

## Code Style

### C++ (Desktop + Server)

- Standard: C++17
- Format: **clang-format** (LLVM style, 4-space indent)
- Create `.clang-format` at project root:

```yaml
BasedOnStyle: LLVM
IndentWidth: 4
UseTab: Never
ColumnLimit: 100
AllowShortFunctionsOnASingleLine: Inline
```

- Run after code changes:

```bash
clang-format -i src/**/*.cpp src/**/*.h
```

### Objective-C++ (AppKit)

- Same as C++ style
- Use ARC (already enabled in CMakeLists.txt)
- `.mm` files for Objective-C++ code, `.h` for headers

### TypeScript (Web)

- **ESLint** + **Prettier**
- Strict mode enabled in `tsconfig.json`
- React Hooks rules enforced
- Run:

```bash
cd Git/web
npx eslint src --ext .ts,.tsx
npx prettier --write 'src/**/*.{ts,tsx}'
```

### Build Configurations

- **Never commit secrets** (SSH keys, API keys, passwords)
- Server deployment keys stay local only
- Use `.env` (not committed to git) for local configuration
- Add sensitive files to `.gitignore`

## Testing

### Current Status

Test coverage is minimal. The following test types need to be added:

### Planned Test Strategy

1. **Unit Tests** (C++ server)
   - Room creation/joining logic
   - SPA1 packet encoding/decoding
   - Audio mixer mixing correctness
   - Use Google Test or Catch2

2. **Integration Tests** (Client-Server)
   - Full connection flow: create room → join → audio send → receive

3. **E2E Tests** (Web)
   - Browser audio capture pipeline
   - SPA1 packet construction
   - WebSocket connection to signaling

### Priority Order

1. SPA1 packet roundtrip (encode → decode → verify)
2. Server room management (create, join, leave, list)
3. Audio mixer correctness (mix multiple streams)

## Build All Components

```bash
# Clone
git clone https://github.com/jaysonsu1993-a11y/Tonel.git
cd Tonel

# Desktop (AppKit -- recommended)
cd Git/Tonel-Desktop-AppKit
cmake -S . -B build && cmake --build build

# Server
cd Git/server
cmake -S . -B build && cmake --build build

# Web
cd Git/web
npm install && npm run dev
```

## Troubleshooting

### "JUCE not found" warning
- Only appears for the legacy JUCE client (`Tonel-Desktop/`)
- Safe to ignore if you're building the AppKit client only
- Set `-DJUCE_PATH=/path/to/JUCE` to suppress

### SPA1 packet parsing errors
- Verify network byte order (big-endian) is preserved
- Check magic bytes: `0x53415031`
- Verify header size = 44 bytes
### WebRTC connection issues

- Ensure UDP 10000-10100 is open in both ufw AND Alibaba Cloud security group
- Check STUN server reachability from China (`stun:stun.qq.com:3478`)
- Verify webrtc-mixer-proxy is registered: check signaling server logs for `[Mixer] WebRTC mixer proxy registered`
- Browser DevTools -> `chrome://webrtc-internals` for detailed ICE/DTLS diagnostics
- **"Called in wrong state: stable"**: Browser's RTCPeerConnection was not cleaned up before receiving new answer. Fixed in connectMixer() -- old PC is closed before creating new one.
- **"Failed to set remote answer sdp"**: Proxy sent answer before ICE candidates were ready. Fixed by using `onLocalDescription` callback in node-datachannel.

### WebSocket frequent disconnects (every ~13s)

**Cause**: Cloudflare Tunnel idle timeout on WebSocket connections without traffic.
**Fix**: Browser signalService now sends HEARTBEAT every 10s. Server responds with HEARTBEAT_ACK.
**Verify**: Check browser console for `[Signal] Disconnected` -- should no longer appear every 13s.

### Room already exists error

- Rooms persist after all users leave (server does not auto-destroy empty rooms)
- Use a new unique room ID, or wait for server restart
- This is intentional: room creator may disconnect and reconnect

### Server port conflicts

- Port 9001: signaling_server (TCP)
- Port 9002: mixer_server TCP control
- Port 9003: mixer_server UDP audio
- Port 9004: ws-proxy.js (WebSocket signaling proxy)
- Port 9007: webrtc-mixer-proxy UDP receive
- Port 10000-10100: WebRTC DTLS/SCTP (browser <-> mixer proxy)
- Check with: `lsof -i :9001 -i :9002 -i :9003 -i :9004 -i :9007`
