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

The single source of truth is [`CMakeLists.txt`](../CMakeLists.txt) at the
repo root: `project(Tonel VERSION X.Y.Z)`. All other version markers are
synchronized automatically by [`scripts/bump-version.sh`](../scripts/bump-version.sh)
during a release. Do not edit them by hand.

| Location | File | Sync method |
|---|---|---|
| Root project | `CMakeLists.txt` | (canonical) |
| AppKit client | `Tonel-Desktop-AppKit/CMakeLists.txt` | bump-version.sh |
| JUCE client | `Tonel-Desktop/CMakeLists.txt` | bump-version.sh |
| Server | `server/CMakeLists.txt` | bump-version.sh |
| Web | `web/package.json` | bump-version.sh |
| Schema | `config.schema.json` | bump-version.sh |

Tonel-MacOS (Swift package) tracks its own `MARKETING_VERSION` independently;
see [`Tonel-MacOS/README.md`](../Tonel-MacOS/README.md).

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
cd web
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
cd Tonel-Desktop-AppKit
cmake -S . -B build && cmake --build build

# Server
cd server
cmake -S . -B build && cmake --build build

# Web (dev)
cd web
npm install && npm run dev

# Web (deploy to Cloudflare Pages)
cd web
npm run build && npx wrangler pages deploy dist --project-name=tonel-web
```

## Troubleshooting

### "JUCE not found" warning
- Only appears for the legacy JUCE client (`Tonel-Desktop/`)
- Safe to ignore if you're building the AppKit client only
- Set `-DJUCE_PATH=/path/to/JUCE` to suppress

### SPA1 packet parsing errors
- Verify network byte order (big-endian) is preserved
- Check magic bytes: `0x53415031`
- Verify header size = 76 bytes (P1-1; legacy spa1.h uses 44 bytes)
- Verify dataSize ≤ 1356 bytes
### WebSocket mixer connection issues

- Verify srv.tonel.io resolves to 8.163.21.207 (DNS-only A record, grey cloud, NOT proxied by Cloudflare)
- Check nginx is running and proxying WSS for srv.tonel.io to ws-mixer-proxy on :9005
- Verify Let's Encrypt SSL cert is valid: `sudo certbot certificates`
- Check ws-mixer-proxy is running: `pm2 status tonel-ws-mixer-proxy`
- ws-mixer-proxy only creates TCP connection for /mixer-tcp path (not /mixer-udp)
- **Zero audio data from ScriptProcessorNode**: Do NOT accumulate frames in a buffer before sending -- send directly from the onaudioprocess callback
- **AudioWorklet zero-data bug**: MediaStreamAudioSourceNode produces zero-filled buffers in AudioWorklet; use ScriptProcessorNode instead
- **Input/output device selection**: Use getUserMedia for input, AudioContext.setSinkId for output

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
- Port 9004: ws-proxy.js (WebSocket signaling proxy, via CF Tunnel)
- Port 9005: ws-mixer-proxy.js (WebSocket mixer proxy, direct via srv.tonel.io)
- Port 9006: ws-mixer-proxy UDP receive (server mixed audio return)
- Check with: `lsof -i :9001 -i :9002 -i :9003 -i :9004 -i :9005 -i :9006`

### Deployment

The manual `scp` / `pm2 restart` workflow that used to live here is gone.
Deploys go through the scripts in [`deploy/`](../deploy/), orchestrated by
[`scripts/release.sh`](../scripts/release.sh). See:

- [RELEASE.md](RELEASE.md) — the canonical release flow (`release.sh <version>`)
- [../deploy/README.md](../deploy/README.md) — production topology, filesystem layout, ports
- [../deploy/STANDARDS.md](../deploy/STANDARDS.md) — R1-R10 rules for editing anything in `deploy/` or `ops/`

Quick reference:

```bash
# Full release (bump → CHANGELOG → tag → push → deploy → verify)
scripts/release.sh 1.0.4

# Just redeploy current HEAD without bumping
scripts/release.sh deploy-only

# Hot-fix one component
deploy/server.sh --component=binary   # C++ servers
deploy/server.sh --component=proxy    # ws-proxy / ws-mixer-proxy
deploy/web.sh                         # Cloudflare Pages
```

### Network architecture

- **Signaling**: browser → Cloudflare Tunnel (api.tonel.io) → ws-proxy → signaling_server
- **Mixer audio**: browser → **direct** (srv.tonel.io, DNS-only A record) → nginx WSS → ws-mixer-proxy → mixer_server UDP
- **AppKit audio**: direct TCP/UDP to server IP (no proxy)
- Audio traffic MUST NOT go through Cloudflare — adds 200-400ms of latency via overseas edge servers
