# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] - 2026-04-28

### Fixed (AppKit Audio)
- **`AudioBridge` split from one duplex `ma_device` into two independent `ma_device`s — capture and playback.** The previous duplex configuration was the reason `setInputDeviceIndex` / `setOutputDeviceIndex` looked broken from the Settings UI: switching to an input or output device that the system can't fold into a single `ma_device_init()` call (different sample-rate clocks, devices that don't expose a duplex direction) silently failed and left the device unchanged. Now each direction has its own miniaudio device and its own callback (`captureCallback`, `playbackCallback`); changing one direction tears down and re-inits only that device, and the other keeps streaming so audio never drops out on the speaker just because the user picked a different microphone. If a re-init fails, the bridge falls back to the system default and logs the failure to the system console. ([Git/Tonel-Desktop-AppKit/src/bridge/AudioBridge.mm:1](Git/Tonel-Desktop-AppKit/src/bridge/AudioBridge.mm:1))
- **`MixerBridge` ring buffer: prime threshold + slide-window overflow.** The RX ring used to drain on every callback as long as `count > 0`, which meant a partial read followed by zero-fill mid-callback whenever a packet ran late — audible as the "电流静电" floor noise the v1.0.8 web fix had eliminated. The web client's smoother playback path was masking the same ring-buffer-design bug that AppKit was hitting head-on. RX ring now refuses to drain until it holds `kPrimeTarget` samples (10 ms cushion), drops back to "primed=false" the moment it would underrun on the next read, and on overflow advances `readPos` (slide window) instead of dropping the whole 5 ms slab. The AppKit pipeline now has the same smoothness characteristics as the web client. ([Git/Tonel-Desktop-AppKit/src/bridge/MixerBridge.mm:38](Git/Tonel-Desktop-AppKit/src/bridge/MixerBridge.mm:38))
- **Local mic loopback dropped.** The home-screen "hear yourself" feature only worked because the old duplex callback had both input and output buffers in the same call. With separate devices it would need a dedicated ring between callbacks; the feature also encouraged users to leave the mic open into the speakers and discover the feedback loop by accident. The home screen now outputs silence and the input level meter remains live. (Same file)
- **Settings UI re-enumerates devices on each appearance and highlights the current selection.** Previously the popups were populated once in `viewDidLoad` and never refreshed — newly-plugged devices wouldn't appear, and the popup always showed item 0 even after the user had picked a different device. ([Git/Tonel-Desktop-AppKit/src/ui/SettingsViewController.mm:23](Git/Tonel-Desktop-AppKit/src/ui/SettingsViewController.mm:23))

### Fixed (Web Audio Quality)
- **Capture `ScriptProcessorNode` buffer size 256 → 512.** v1.0.8 set 256 to perfectly match the server's 5 ms broadcast cadence (one frame per callback), but `ScriptProcessorNode` at 256 turns out to be unreliable across browsers — the API is deprecated and at the lower edge of buffer sizes some implementations occasionally drop callbacks under main-thread load, audible as fresh noise. 512 (~10.67 ms, ~2 frames per callback with leftover carried over) keeps the pacing close enough to the server's mixer (no loss to the 5 ms slot overwrite) while staying inside the reliable region of the API. ([Git/web/src/services/audioService.ts:373](Git/web/src/services/audioService.ts:373))

### Why this is a release
Two surfaces, one root theme: the AppKit pipeline had drifted from the web pipeline's correctness without anyone noticing because nobody had compared them head-to-head. The AppKit bug was twofold — duplex device fragility on macOS for device switching, and missing jitter-prime in the RX ring — and v1.0.8's web-side fix exposed both by making web noticeably smoother. v1.0.9 lifts AppKit to the same quality bar and rolls back v1.0.8's overly-aggressive web capture buffer.

The server-side OPUS channel-count mismatch (Bug 3 from the original investigation) and the suspected hard-clip on the mixer (the "音量稍大爆破音" report) remain deferred to v1.0.10 — both need server changes and the audio-path quality issues here are independent.

| File / Change | Detail |
|---------------|--------|
| `Git/Tonel-Desktop-AppKit/src/bridge/AudioBridge.{h,mm}` | Split duplex `ma_device` into separate capture + playback devices; per-direction teardown/re-init in `setInputDeviceIndex` / `setOutputDeviceIndex`; default-fallback on init failure; expose current selection via `currentInputDeviceIndex` / `currentOutputDeviceIndex` |
| `Git/Tonel-Desktop-AppKit/src/bridge/MixerBridge.mm` `RingBuffer` | Prime threshold (480 samples / 10 ms), re-prime on near-underrun, slide-window on overflow |
| `Git/Tonel-Desktop-AppKit/src/ui/SettingsViewController.mm` | `viewWillAppear` re-enumerates devices; popups highlight `AudioBridge`'s current selection |
| `Git/web/src/services/audioService.ts` `startCaptureWithScriptProcessor` | bufferSize 256 → 512 |

## [1.0.8] - 2026-04-28

### Fixed (Web Audio Quality — v2)
- **Playback reverted from `AudioWorkletNode` ring buffer to a continuously-scheduled `AudioBufferSourceNode` timeline.** v1.0.7's worklet path drained on every `process()` call as long as `count > 0` — with internet jitter, `count` regularly dipped to 0 mid-buffer and the worklet output zeros for the rest of that 128-sample frame, producing sub-millisecond discontinuities that summed into the constant "电流静电" floor noise the user reported. The worklet also bypassed Web Audio's automatic resampling: the wire format is 48 kHz, but `new AudioContext({ sampleRate: 48000 })` is only a hint — Bluetooth output and some desktop audio stacks force 44.1 kHz, in which case the worklet was being fed 48 k samples/sec but read at 44.1 k samples/sec, the ring overran continuously, and `readPos` skipped samples in a chaotic pattern that sounded like noise. The new path uses `audioContext.createBuffer(channels, n, 48000)` (Web Audio resamples on connect, so the context's actual rate doesn't matter) and schedules each 5 ms frame at `playTime`, advancing `playTime += duration` so consecutive frames concatenate sample-exact. When a network gap pushes `playTime` into the past, the next frame re-anchors at `currentTime + 40 ms`, restoring a jitter cushion. ([Git/web/src/services/audioService.ts:601](Git/web/src/services/audioService.ts:601))
- **Capture `ScriptProcessorNode` buffer size 1024 → 256.** v1.0.7 left the buffer at 1024 (~21 ms), so each callback shipped ~4 SPA1 frames in a burst. The server mixer is single-buffered per track (`addTrack()` overwrites), and its 5 ms broadcast timer only fires on `pending_mix`. With 4 frames packed into a 21 ms window, multiple frames landed in the same 5 ms slot and only the last survived — losing 50–75 % of upstream audio in a way that sounded like garbled noise on the return path. 256 samples = 5.33 ms per callback, so each callback ships ~1 frame (240 samples) and the leftover lands in the next callback, naturally pacing the wire to match the server's 5 ms cadence. ([Git/web/src/services/audioService.ts:373](Git/web/src/services/audioService.ts:373))
- **Diagnostic: log `audioContext.sampleRate` after init.** Surfaces the Bluetooth/system-rate-override case in the browser console (`[Audio] AudioContext rate is 44100 Hz, expected 48000.`) so the next "audio sounds wrong" report can be triaged in one console line.

### Fixed (Deploy Tooling)
- **`Git/deploy/server.sh` excludes `build/` + `.cache/` from the source rsync.** v1.0.7's first `release.sh` run failed at `[binary] remote build (cmake)` because `rsync_to_remote "$GIT_DIR/server/" "$TONEL_DEPLOY_DIR/build-src/"` blasted the laptop's local `Git/server/build/` (gitignored, so `git status` is clean — but rsync doesn't honor `.gitignore`) up to the remote, baking the laptop's source path into the remote `CMakeCache.txt`. Remote `cmake -B build` then refused to use the cache because the embedded source path no longer matched. Fixed by passing `RSYNC_FLAGS="--delete --delete-excluded --exclude=build/ --exclude=.cache/"` for the source-tree push; `--delete-excluded` makes the rule self-healing so any remote tree that already received the bad artifacts gets cleaned on the next deploy. Captured as [Incident 7 in `Git/deploy/LESSONS.md`](../deploy/LESSONS.md). ([Git/deploy/server.sh:48](Git/deploy/server.sh:48))

### Why this is a release
Two-part story:
1. **v1.0.7 didn't fully fix the reported audio quality issue.** The diagnosis nailed the per-packet `BufferSource.start(0)` overlap and the 64-sample tail drop, but moving to the worklet ring buffer unmasked two subtler issues (no fill threshold, no resampling) that produced a worse symptom — constant "电流静电" floor noise. v1.0.8 reverts to the canonical scheduled `BufferSource` streaming pattern, which is the well-tested approach for this exact problem and handles AudioContext sample-rate mismatch by leaning on Web Audio's built-in resampler.
2. **`server.sh` deploy bug surfaced during the v1.0.7 release attempt.** Folded into this release per discipline (no bare commits to main), with a new LESSONS case file linking back to the rule it produced.

The v1.0.7 audio code that did land (the capture leftover preservation) is retained — it's still the right thing.

The server-side OPUS channel-count mismatch (Bug 3 from the original investigation) remains deferred — it's dormant for web-only traffic and will ship in v1.0.9 with the `tonel-mixer` redeploy.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `playPcm16` | Scheduled `BufferSource` on continuous `playTime` timeline + 40 ms re-anchor cushion; `createBuffer(_, _, 48000)` for built-in resampling |
| `Git/web/src/services/audioService.ts` `startCaptureWithScriptProcessor` | bufferSize 1024 → 256 to pace SPA1 packets at ~5 ms cadence |
| `Git/web/src/services/audioService.ts` `init` | Warn when AudioContext sample rate ≠ 48 kHz |
| `Git/web/src/services/audioService.ts` | Removed dead `updateAdaptiveBufferDepth` + worklet target-depth state |
| `Git/deploy/server.sh` | rsync excludes `build/` + `.cache/`, `--delete-excluded` for self-healing |
| `Git/deploy/LESSONS.md` | New Incident 7 case file |

## [1.0.7] - 2026-04-28

### Fixed (Web Audio Quality)
- **Playback no longer creates a new `BufferSource` per packet.** The previous `playPcm16` path immediately called `src.start(0)` for every received 5ms PCM16 frame. With network jitter this meant overlapping playback during bursts (chorus / metallic distortion) and silent gaps when packets arrived late, plus an audible discontinuity at every 5ms boundary because nothing tied consecutive frames together. The `AudioWorkletNode` ring buffer that `initPlaybackWorklet` builds (1-second capacity, drains continuously on the audio thread) was already wired to `masterGain` but was never receiving samples — `updateAdaptiveBufferDepth` was even computing a target depth and posting it to a worklet that ignored the message. Mixed audio is now `postMessage`'d (transferable `ArrayBuffer`) into the worklet, which then plays the ring continuously, so frame boundaries become inaudible. ([Git/web/src/services/audioService.ts:591](Git/web/src/services/audioService.ts:591))
- **Capture no longer drops the 64-sample tail of every `ScriptProcessor` callback.** `onAudioFrame` received 1024 samples per callback, sliced them into 4×240 (5ms) frames, and threw away the trailing 64 (1.33ms). That was a steady ~6.25% audio loss with a periodic micro-cut every 21.3ms — perceptually a fast clicking artifact stacked on top of the playback discontinuities above. The remainder is now stashed in `captureLeftover` and prepended to the next callback so no samples leak. `stopCapture()` clears the leftover so a stop/start cycle never carries stale samples across sessions. ([Git/web/src/services/audioService.ts:391](Git/web/src/services/audioService.ts:391))

### Why this is a release
Two pure-client audio path bugs that together produced the "very low quality on returned audio" symptom users heard when listening to themselves through the mixer. No server, proxy, or protocol change — only `Git/web/src/services/audioService.ts`. The server-side OPUS channel-count mismatch flagged during this investigation is a separate dormant bug (web only ever sends/receives PCM16, so it doesn't trigger today); it will be fixed in a follow-up release that also touches the C++ mixer + needs `tonel-mixer` redeploy.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `playPcm16` | Route received PCM16 → `playbackWorklet.port.postMessage` (transferable), drop per-packet `BufferSource.start(0)` |
| `Git/web/src/services/audioService.ts` `onAudioFrame` | Stash 64-sample remainder in `captureLeftover`, prepend on next callback, clear in `stopCapture` |

## [1.0.6] - 2026-04-28

### Added (Documentation)
- **`Git/docs/RELEASE.md` "Before you start any release" section** — five-step pre-flight checklist (clean tree, on main, in sync with origin, **`health.sh` baseline green**, `/opt/tonel/VERSION` matches latest tag). Established because the most expensive class of release-time mistake is "deploy something while the baseline is already broken, then mis-attribute the breakage to your own change". Single most important step: running `health.sh` before touching anything.
- **`Git/deploy/README.md` "Quirks (known cosmetic, do not panic)" section** — captures three failure modes that look like real errors but are not, so future readers can recognize them in seconds rather than minutes:
  - `wrangler pages deploy` hangs in cleanup *after* the deploy is already live (kill is safe)
  - `api.tonel.io/signaling` returns HTTP 426 to `curl` even when healthy (curl can't reliably WS-upgrade through HTTP/2 edges; browser is the real test)
  - `srv.tonel.io` looks unreachable from some domestic ISP routes due to SNI filtering, but works for browsers / cellular / international (this is the reason `health.sh` probes from the server, not the laptop — R1)
- **`Git/deploy/README.md` "Emergency recovery" section** — exact PM2 commands to fall back to the legacy `/opt/tonel-server/` install if a future migration leaves the new path broken. Preserves the institutional knowledge from the v1.0.3 outage as a runbook rather than scattered through commit messages.
- **`Git/deploy/.env.deploy.example` CF token permissions** — explicit list of the three permissions wrangler 4.x checks (`Pages: Edit` + `User Details: Read` + `Memberships: Read`), with the failure signature (`Authentication error [code: 10000]` on `/memberships`) so the next operator who hits it doesn't go through the same diagnostic dance.

### Why this is a release
Documentation-only release. Same reason as v1.0.5: "no bare commits to main" applies to docs. The new content captures three categories of know-how that previously only lived in the head of whoever shipped v1.0.3:
1. The discipline of running `health.sh` before any change
2. Three benign-but-confusing failure modes that look like real errors
3. The exact emergency recovery procedure if the new layout ever fails again

| File / Change | Detail |
|---------------|--------|
| `Git/docs/RELEASE.md` | "Before you start any release" pre-flight checklist |
| `Git/deploy/README.md` | "Quirks" + "Emergency recovery" sections |
| `Git/deploy/.env.deploy.example` | CF token permissions enumerated |

## [1.0.5] - 2026-04-28

### Added (Documentation)
- **`Git/docs/DEPLOY_SCRIPTING_STANDARDS.md`** — 10 normative rules (R1–R10) for everything in `Git/deploy/` and `Git/ops/`. Distilled from the v1.0.3 → v1.0.4 release cycle, where six distinct shell-scripting bugs surfaced (one caused a real ~1-minute production outage). Rules cover: where health probes run (R1), `npm ci` discipline (R2), boolean flag propagation via dedicated helpers rather than `${VAR:+...}` (R3), template substitution that respects comment lines (R4), shell quoting across the SSH boundary (R5), `$()` capture of remote stdout with `; true` and empty-fallback (R6), idempotency (R7), drift detection (R8), audit logging (R9), and remote-expansion smoke testing with `echo` (R10).
- **`Git/deploy/LESSONS.md`** — case files for each of the six v1.0.3 / v1.0.4 incidents, in **Symptom / What we thought / What it actually was / Impact / Fix / Lesson** format. Rules above link back to specific case files; case files link back to the rule each one produced.
- Cross-reference links added in `Git/deploy/README.md` and `Git/docs/RELEASE.md` so contributors hit the standards before writing or modifying a deploy script.

### Fixed (Release Tooling)
- **`Git/scripts/release.sh` no longer rejects a dirty working tree at entry.** The previous `require_clean_git`-style guard contradicted the project's own release discipline: a dirty tree was the *normal* state when running `release.sh`, since the operator just authored the feature change + CHANGELOG entry. Forcing a separate "feature changes" commit on main before running release.sh would have meant a bare main commit, violating the very rule release.sh was supposed to encode. The script's existing `git add -A && git commit -m "release: vX.Y.Z"` already collects everything into one atomic commit, which is what we want. (Discovered while preparing this v1.0.5 release; the bug shipped with v1.0.3 but had not been triggered until now because earlier releases did not have user-authored changes alongside the bump.) The branch check (`must be on main`) stays.

### Why this is a release
Documentation-only release with no runtime delta vs. v1.0.4 (the small `release.sh` fix above is dev-tooling only). We're shipping it as a tagged version because the project's release discipline forbids bare commits to `main`: every change goes through bump → CHANGELOG → tag → push. That rule is what produced the well-organized history we now have, and it applies to documentation too.

| File / Change | Detail |
|---------------|--------|
| `Git/docs/DEPLOY_SCRIPTING_STANDARDS.md` | New — 10 rules |
| `Git/deploy/LESSONS.md` | New — 6 case files |
| `Git/deploy/README.md` | Cross-reference to standards + lessons |
| `Git/docs/RELEASE.md` | Cross-reference to standards |
| `Git/scripts/release.sh` | Drop entry-time `require_clean_git` (contradicted release flow) |

## [1.0.4] - 2026-04-28

### Fixed (Deploy Tooling)
- **`Git/deploy/health.sh` WSS probe runs from server, not laptop.** The previous version curled WSS endpoints from wherever the deploy script was invoked, which meant a single ISP path issue between the operator and the production IP could mark a perfectly healthy deploy as failed (TLS reset by peer on `srv.tonel.io` / SNI-based filtering on direct-to-origin hosts). Now `check_wss_handshake` SSH-runs `curl` *on the server* — same network as nginx — so it tests the deploy, not the operator's connectivity. Added `strict` / `reachable` modes: direct endpoints (srv.tonel.io) require `101 Switching Protocols`; CF-Tunnel endpoints (api.tonel.io) only require any non-zero HTTP code, since `curl`'s RFC 6455 upgrade is unreliable through HTTP/2-speaking edges (real WS handshake is browser-tested). Also fixed a `${...} || echo 000` bug that produced `HTTP 101000` when curl printed the code and then exited non-zero on `--max-time`.
- **`Git/deploy/server.sh` cloudflared substitution preserves comments.** Used `sed s/.../.../g` globally, which replaced the literal `${TUNNEL_ID}` token in the template's docstring with the real id. Switched to an `awk` rule that skips lines starting with `#`, so the template's documentation stays intact when applied.
- **`Git/deploy/web.sh` uses `npm ci`, not `npm install`.** Plain `npm install` rewrites `package-lock.json` whenever transitive deps shift, leaving the working tree dirty after every web deploy. `npm ci` honors the lockfile strictly. Also passes `--commit-dirty=true` to silence the wrangler warning about the gitignored `dist/` directory (this is a build output, not actual uncommitted source).

### Context (v1.0.3 retrospective)
The v1.0.3 deploy infrastructure landed correctly but had three small wrinkles surface during the bootstrap of production: the WSS probe drift above, the cloudflared sed eating its own comment, and `npm install` lockfile drift. None affected runtime correctness (the migration to `/opt/tonel/` succeeded — PM2 stayed online on the new layout, nginx + cloudflared applied cleanly, `srv.tonel.io` and `api.tonel.io` continued to serve traffic). v1.0.4 closes the loop on the deploy tooling itself.

| File / Change | Detail |
|---------------|--------|
| `Git/deploy/health.sh` | WSS probe via SSH; `strict`/`reachable` modes; `100 + 000` concat bug fixed |
| `Git/deploy/server.sh` | cloudflared template substitution via `awk` (skip comments) |
| `Git/deploy/web.sh` | `npm ci` + wrangler `--commit-dirty=true` |

## [1.0.3] - 2026-04-28

### Added (Deploy Infrastructure)
- **`Git/deploy/`** — imperative deploy scripts (`web.sh`, `server.sh`, `health.sh`, `rollback.sh`, `bootstrap.sh`) plus `lib/common.sh` (logging, dry-run, drift detection, remote backups). All read configuration from `Git/deploy/.env.deploy` (gitignored). Replaces the manual `scp` / `pm2 restart` workflow that was previously documented inline in `DEVELOPMENT.md`.
- **`Git/ops/`** — declarative production configuration entered into source control: `pm2/ecosystem.config.cjs` (process definitions), `nginx/srv.tonel.io.conf` + `nginx/tonel.io.conf`, `cloudflared/config.yml.template`, `scripts/start-mixer.sh` + `scripts/start-signaling.sh`. Production now reflects the repo, not the other way around.
- **`Git/scripts/release.sh`** — release orchestrator: `release.sh <version>` runs the full pipeline (bump → CHANGELOG verify → commit → tag → push → server deploy → web deploy → health check). Modes: `--skip-deploy`, `--skip-push`, `deploy-only`.
- **`Git/docs/DEPLOYMENT.md`** — production topology, filesystem layout (`/opt/tonel/`, `/var/lib/tonel/`, `/var/log/tonel/`), port map, DNS, TLS, toolchain, drift policy, disaster recovery.
- **`Git/docs/RELEASE.md`** — canonical release flow, semver rules, CHANGELOG format, partial flows, hotfix workflow.

### Changed (Production Layout)
- **Migrated `/opt/tonel-server/` → `/opt/tonel/`** with clean separation:
  - `bin/` — compiled C++ servers
  - `proxy/` — Node.js WebSocket bridges
  - `scripts/` — PM2 launchers
  - `ops/ecosystem.config.cjs` — PM2 process definitions
  - `VERSION` + `DEPLOY_LOG` for "what's running right now?" lookups
  - Runtime data moved to `/var/lib/tonel/recordings/`
  - PM2 logs moved to `/var/log/tonel/`
- The legacy `/opt/tonel-server/` is preserved at `/opt/_archive/tonel-server-pre-bootstrap/` as a fallback, deletable after one week of stable operation.
- **PM2 process exec paths normalized to `bin/`** — previously `tonel-signaling` ran `/opt/tonel-server/signaling_server` (root) while `start-signaling.sh` referenced `bin/`, causing silent drift between manual restarts and binary swaps.

### Removed
- **`webrtc-mixer-proxy.js` (file + `tonel-webrtc-mixer` PM2 process)** — v1.0.0 changelog announced its removal but the file lingered in the repo and the process was still running on production. Cleaned up properly this release.
- **`mixer.tonel.io` cloudflared route** — dead since v1.0.0 (mixer audio uses `srv.tonel.io` direct, no Cloudflare).

### Fixed (Drift Reflow)
- **`Git/web/ws-proxy.js`** updated to match production version (HTTP server with upgrade routing for `/mixer-tcp` + `/mixer-udp`, noServer-mode `WebSocketServer`). The repo had been carrying a stale single-WS variant since v1.0.0 — every deploy from the repo would have downgraded the proxy.
- **`Git/scripts/bump-version.sh`** now respects `YES=1` env var to skip the interactive confirm prompt — required for `release.sh` orchestration.

### Repo policy
- Added `Git/.gitignore` rule for `deploy/.env.deploy` (SSH host / Cloudflare token / tunnel id) — these values stay local. The committed `.env.deploy.example` documents required keys.

| File / Change | Detail |
|---------------|--------|
| `Git/deploy/{web,server,health,rollback,bootstrap}.sh` | New deploy scripts, all `--dry-run` capable |
| `Git/deploy/lib/common.sh` | Shared helpers: logging, drift check, SSH wrappers, deploy log |
| `Git/deploy/.env.deploy.example` | Documented config keys (gitignored real `.env.deploy`) |
| `Git/ops/pm2/ecosystem.config.cjs` | PM2 single source of truth, replaces ad-hoc `pm2 start` flags |
| `Git/ops/nginx/{srv,tonel}.io.conf` | nginx site configs, applied by `server.sh --component=ops` |
| `Git/ops/cloudflared/config.yml.template` | Cloudflared tunnel config (only `api.tonel.io` ingress; mixer route removed) |
| `Git/ops/scripts/start-{mixer,signaling}.sh` | PM2 launchers, mixer cd's into `/var/lib/tonel/` for recordings |
| `Git/scripts/release.sh` | Release orchestrator |
| `Git/docs/DEPLOYMENT.md`, `Git/docs/RELEASE.md` | New canonical docs |
| `Git/docs/DEVELOPMENT.md` | Replaced inline deploy snippets with pointers to RELEASE.md / DEPLOYMENT.md |
| `Git/web/ws-proxy.js` | Reflow from production (HTTP+upgrade routing) |
| `Git/web/webrtc-mixer-proxy.js` | Deleted |
| `Git/scripts/bump-version.sh` | `YES=1` env var skips interactive prompt |
| `Git/.gitignore` | `+ /deploy/.env.deploy` |

## [1.0.2] - 2026-04-28

### Fixed (Build Tooling)
- **`Git/scripts/bump-version.sh` BSD-grep incompatibility** — the script used `grep -oP '...\K...'` (GNU-only) wrapped in `|| echo "unknown"`, so on macOS the regex flag was rejected, `CURRENT_VERSION` became `unknown`, all subsequent `sed` substitutions found no match, and the script exited 0 having changed nothing. Verified this had been silently broken since at least v1.0.0 (`Git/config.schema.json` `version.default` was stuck at `0.3.2`). Replaced `grep -oP` with `sed -nE` (BSD+GNU compatible) in both extraction and verification blocks, and added a hard-fail when current version cannot be detected — silent no-op is the worst failure mode for a release script.

### Changed (Repo Policy)
- **GitHub remote now mirrors only `Git/` + root `.gitignore`** — all other root-level paths (`local_docs/`, `Tonel-Desktop(Legacy)/`, `docs/`, `.claude/`, build artifacts) are local-only. The GitHub repo is purely for code version management of the `Git/` source tree.
- **Git history rewritten** via `git filter-repo --path Git/ --path .gitignore`: every commit hash from this point backward is new. All historical tags (`v0.1.0` through `v1.0.1`) now point to rewritten commit objects. Existing clones must be re-cloned.
- `.gitignore` extended with `/local_docs/`, `/Tonel-Desktop(Legacy)/`, `/.claude/` (root anchored) so the local-only paths stay untracked going forward.

| File / Change | Detail |
|---------------|--------|
| `Git/scripts/bump-version.sh` | `grep -oP` → `sed -nE`; hard-fail on undetected version |
| `.gitignore` | Added `/local_docs/`, `/Tonel-Desktop(Legacy)/`, `/.claude/` |
| Repo history | One-time rewrite via `git filter-repo`; force-pushed |

## [1.0.1] - 2026-04-28

### Fixed (Web Client)
- **GitHub link in App footer** — repo was renamed from `S1-BandRehearsal` to `Tonel` on 2026-04-27, but `Git/web/src/App.tsx` still pointed to the old URL, returning 404 to users who clicked through.

### Fixed (Config Schema)
- **`config.schema.json` `app.version.default` synced to `1.0.1`** — had been stuck at `0.3.2` because `scripts/bump-version.sh` silently no-ops on macOS (uses `grep -P`, unsupported by BSD grep), so prior bumps left this field behind. Updated this release manually; script fix tracked separately.

| File | Change |
|------|--------|
| `Git/web/src/App.tsx` | GitHub URL `S1-BandRehearsal` → `Tonel` |
| `Git/config.schema.json` | `app.version.default` `0.3.2` → `1.0.1` |
| (5 standard version-sync files) | `1.0.0` → `1.0.1` |

## [1.0.0] - 2026-04-27

### Added (Web Client)
- **End-to-end web audio streaming** -- web client can now capture, send, receive, and play audio through the mixer server
- ScriptProcessorNode audio capture (AudioWorklet had zero-data issues with MediaStreamAudioSourceNode)
- Direct frame sending from ScriptProcessor callback (no frameBuffer accumulation -- it caused zero-data bug)
- PCM16 codec: encode `Math.round(s * 32767)` LE, decode `getInt16 LE / 32768.0` (matches AppKit client)
- Level metering: linear RMS + 80/20 EMA smoothing, displayed via single-bar gradient LedMeter with dB scale (-60dB range)
- Playback via BufferSource scheduling with `src.start(0)` immediate play
- Input/output device selection via `getUserMedia` + `AudioContext.setSinkId`
- Auto-reconnect for audio WebSocket on close

### Changed (Architecture)
- **Web audio transport**: replaced WebRTC DataChannel with WebSocket (ws-mixer-proxy) via srv.tonel.io
- **srv.tonel.io**: direct A record to 8.163.21.207 (DNS only, grey cloud, no Cloudflare proxy) with Let's Encrypt SSL cert (certbot-dns-cloudflare)
- nginx on server proxies WSS for srv.tonel.io to ws-mixer-proxy
- ws-mixer-proxy only creates TCP connection for /mixer-tcp path (not /mixer-udp)
- Removed webrtc-mixer-proxy.cjs and WebRTC DTLS/SCTP ports (9007, 10000-10100)

### Changed (Server)
- Mixer server handles PING→PONG on TCP control channel
- start-mixer.sh uses `exec` to prevent zombie processes
- PM2 scripts run from `/opt/tonel-server/` (must cp there after updating)

### DNS
- tonel.io → Cloudflare Pages (orange cloud) -- web static hosting
- api.tonel.io → Cloudflare Tunnel (orange cloud) -- signaling only
- srv.tonel.io → 8.163.21.207 (grey cloud, DNS only) -- mixer audio direct

### Deployment
- Frontend: Cloudflare Pages via `wrangler` CLI with `CLOUDFLARE_API_TOKEN` env var
- Server scripts: cp to `/opt/tonel-server/` then `pm2 restart`
- Mixer binary: build on server, stop→cp→start

## [0.3.6] - 2026-04-26

### Added (AppKit Client)
- **MixerBridge**: 完整的 mixer 音频传输层，TCP:9002 控制通道 + UDP:9003 SPA1 音频收发
- AudioBridge 接入 MixerBridge：麦克风采集 stereo f32 → mono PCM16 → 240 样本/5ms SPA1 包发送
- 服务器混音数据通过 lock-free SPSC ring buffer 接收并播放
- 进入房间自动连接 mixer，离开房间自动断开
- SPA1 HANDSHAKE 握手注册 UDP 地址

### Fixed (AppKit Client)
- 进入房间后仍有本地音频回环 — 当 mixerBridge 已设置但未连接时输出静音，不再回环

## [0.3.5] - 2026-04-25

### Fixed (Web Client)
- **P0-1**: `initPlayback()` 异步无 await → 播放无声问题
- **P0-1 追加**: `initPlaybackWorklet()` 返回 `void` 而非 `Promise` → await 未真正等待 worklet 加载
- **P0-2**: `audioContextPlay` 未调用 `resume()` → 浏览器 autoplay 策略阻止播放
- **P0-3**: `useAudio` 创建独立 AudioContext 与 `audioService` 冲突 → 麦克风占用冲突
- **P0-4**: `parseSpa1Header` 缺少 dataSize 上限检查 → 潜在内存溢出风险

### Fixed (Server)
- **P0-1**: UDP/TCP 缓冲区竞争 — 分离为独立的 `tcp_slab` 和 `udp_slab`
- **P0-3**: Opus 解码未验证返回值 — `decoded <= 0` 时直接 return，避免使用未初始化数据
- **P0-4**: TCP 连接关闭后 use-after-free — 断开时清除所有 `UserEndpoint.tcp_client` 指针，防止 `broadcast_levels` 写入已关闭连接

### Fixed (WebRTC Proxy)
- Proxy 发送双重 MIXER_ANSWER（sync + onLocalDescription 回调）导致浏览器 `setRemoteDescription` 第二次调用失败 → 删除同步回退路径
- 浏览器增加 `answered` 标志防御重复 answer

### Security
- SPA1 packet dataSize 限制为 1356 字节（客户端+服务端双向校验）

## [0.3.4] - 2026-04-24

### Fixed
- 空房间不会自动销毁 — 新增房间闲置回收机制：房间变空后30分钟自动销毁，每5分钟扫描一次。修复了创建后无人加入的房间永久残留的问题。

### Changed
- `RoomManager::leave_room()` 不再立即销毁空房间，统一由 reaper 定时器处理
- `Room` 新增 `empty_since_` 时间戳，记录房间变空的时刻
- `SignalingServer` 新增 `room_reaper_timer_`（5分钟周期）

## [0.3.3] - 2026-04-22

### Security
- Server room passwords now use PBKDF2-HMAC-SHA256 hashing instead of plaintext storage
  - 16-byte random salt, 10000 iterations, 32-byte SHA-256 output
  - Storage format: `base64(salt):base64(hash)`
  - Constant-time comparison to prevent timing attacks

### Fixed
- `config.schema.json` field naming aligned with coding standards (camelCase → snake_case)
- Server and desktop config parsers synchronized to use new snake_case keys

### Changed
- `docs/server-mixer.md` rewritten to match actual implementation (v1.1)

## [0.3.2] - 2026-04-24

### Fixed
- WebRTC "Called in wrong state: stable" error on signal reconnect -- connectMixer() now cleans up existing PeerConnection before creating new one
- WebRTC answer SDP sent before ICE candidates ready -- proxy now uses onLocalDescription callback (node-datachannel)
- WebSocket frequent disconnects (~13s interval) -- browser signalService sends HEARTBEAT every 10s to prevent Cloudflare Tunnel idle timeout
- JUCE client build marked as Legacy, S1-Desktop-AppKit renamed to Tonel-Desktop-AppKit

### Added
- Google STUN server (stun.l.google.com:19302) as fallback for NAT traversal
- Signaling reliability section in architecture docs

## [0.3.1] - 2026-04-20

### Fixed
- WebRTC mixer proxy async SDP handling with node-datachannel
- Server-side WebRTC ICE candidate relay

## [0.3.0] - 2026-04-19

### Added
- WebRTC DataChannel-based mixer audio transport for web client
- webrtc-mixer-proxy (node-datachannel) bridging browser DataChannel to server TCP/UDP
- Cloudflare Tunnel for signaling (api.tonel.io)
- Cloudflare Pages for web hosting (tonel.io)
- Direct DTLS/SCTP audio path bypassing domain ICP restrictions

### Changed
- Web client signaling migrated from direct TCP to WebSocket via Cloudflare Tunnel
- Mixer audio path changed from WebSocket to WebRTC DataChannel for lower latency

## [0.2.0] - 2026-04-15

### Added
- Monochrome minimalist UI with animated instrument background
- Channel strip component with LED meter
- Room password protection
- Audio input device selection in web client

### Fixed
- AppKit UI button click handling
- AudioContext autoplay policy suspension

## [0.1.0] - 2026-04-01

### Added
- Initial release of Tonel
- AppKit native macOS client (zero license risk, MIT-only)
- Signaling server (TCP/JSON room management)
- Mixer server (UDP audio mixing with SPA1 protocol)
- Web client for trial/demo (React + TypeScript)
- SPA1 (Simple Protocol for Audio v1) -- custom 44-byte header binary protocol
- P2P mesh mode for 2-4 users (UDP direct)
- Mixer mode for 5+ users (server-mediated mixing)
- Opus codec support

[1.0.0]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.6...v1.0.0
[0.3.6]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jaysonsu1993-a11y/Tonel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jaysonsu1993-a11y/Tonel/releases/tag/v0.1.0
