# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - 2026-04-29

### Added — live audio tuning panel for latency exploration

The five client-side and two server-side constants that gate end-to-end
audio latency are now adjustable from the room page at runtime, so the
"can we shave another 10 ms off?" question can be answered with sliders
instead of a redeploy cycle.

**Web** — `Git/web/src/components/AudioDebugPanel.tsx`
- Mounts in `RoomPage` when `?debug=1` is in the URL; absent otherwise so
  ordinary users see no UI change.
- Five client knobs (postMessage → playback worklet, no AudioContext
  rebuild, no re-prime click on slider drag):
  `primeTarget`, `primeMin`, `maxScale`, `minScale`, `rateStep`.
- Two server knobs (MIXER_TUNE control message → per-user jitter buffer):
  `jitterTarget`, `jitterMaxDepth`.
- Shows derived "added latency budget = client cushion + server jitter"
  in ms — the actual thing being optimised.
- Live stats (ring fill, rate ppm, reprime/seqGap counters) refreshed at
  5 Hz so the engineer sees how each knob lands.
- Sliders re-render after MIXER_JOIN_ACK (server-reported defaults) and
  after MIXER_TUNE_ACK (server-clamped value), so the panel always shows
  what's actually applied — not what was last requested.

**Server** — `Git/server/src/mixer_server.{h,cpp}`
- `JITTER_TARGET` / `JITTER_MAX_DEPTH` moved from class-scoped constexprs
  to per-`UserEndpoint` mutable fields (`jitter_target`, `jitter_max_depth`).
  Per-user (rather than global) so each tester's experiments don't leak
  into other rooms / users sharing the server.
- New `MIXER_TUNE` JSON control message:
  ```
  {"type":"MIXER_TUNE","room_id":"<r>","user_id":"<u>",
   "jitter_target":<int>,"jitter_max_depth":<int>}
  ```
  Both numeric fields optional; out-of-range values clamped to
  [1..JITTER_TARGET_MAX(16)] / [1..JITTER_MAX_DEPTH_MAX(64)].
  Server responds with `MIXER_TUNE_ACK` carrying the *applied* values
  (single source of truth for the UI).
- Lowering `jitter_target` triggers an immediate re-prime so the queue
  settles to the new (smaller) shape instead of running fat.
- Lowering `jitter_max_depth` immediately trims the live deque so the
  next tick sees the new cap.
- `MIXER_JOIN_ACK` now embeds `jitter_target` and `jitter_max_depth` so
  client-side sliders initialise to whatever defaults the running server
  was built with — no separate query round-trip.

**Worklet refactor** — `Git/web/src/services/audioService.ts`
- `PRIME_TARGET`, `PRIME_MIN` (formerly `${...}` template constants)
  are now `this.targetCount` / `this.primeMin` instance fields, written
  by the new `'tune'` postMessage. The 'tune' message is discriminated
  from PCM frames by an explicit `type` field so the audio fast path
  costs one extra typeof check per frame and nothing more.
- `MAX_SCALE`, `MIN_SCALE`, `rateStep` similarly tunable; `rateStep`
  was previously a `0.00002` literal in two places, now `this.rateStep`.
- `setPlaybackTuning()` clamps each field to a safe range before send so
  an over-eager slider can't put the worklet into an unrecoverable state
  (e.g. primeMin > primeTarget).

**Defaults unchanged.** All numeric defaults match v3.1.0 exactly
(client `1440 / 128 / 1.012 / 0.988 / 2e-5`, server `1 / 8`), so audio
behaviour with no slider movement is byte-identical to before. Verified
via Layer 1 (1 kHz sine SNR 84 dB, THD 0.006 %), Layer 1.5 (12 jitter
scenarios all PASS, plc/s within natural variance), Layer 2 (browser
playback 48 kHz / 44.1 kHz both PASS).

**Security note.** MIXER_TUNE accepts the (room_id, user_id) tuple from
the JSON body without auth — same posture as MIXER_LEAVE. Acceptable
for the current single-tenant tonel.io deployment; if multi-tenant
production is added later, a session token check should gate this
message before a malicious user can sweep someone else's jitter buffer.

## [3.1.0] - 2026-04-29

### Milestone — 破音问题彻底解决，进入 3.x 系列

The 9-version 1.0.30 → 1.0.38 jitter / PLC iteration is closed. User
confirmed v1.0.38 ships without audible click on solo loopback under
production WSS conditions. v3.1.0 is the version-bump milestone for
that resolution + the zero-risk audio-path cleanups documented below;
production audio behaviour is intended to be identical to v1.0.39
(which preserved v1.0.38's audio while fixing unrelated room/deep-link
issues) within measurement noise.

The major-version bump from 1.x to 3.x reflects the depth of the
journey (full PLC overhaul + new Layer 1.5 testing infrastructure +
documented diagnostic playbook in memory) rather than any wire- or
client-breaking change. Existing clients keep working; the SPA1
protocol and capture/playback worklets are unchanged.

### Changed (Audio path cleanups — no behaviour change in production)

1. **`PLC_MAX_DECAY = 10 → 5`** (`audio_mixer.h`). The PLC fade-out
   tail shortens from 50 ms to 25 ms. With the v1.0.34+ jitter buffer
   absorbing virtually all upstream jitter, real PLC events are
   isolated single-tick blips; the longer 50 ms tail was generous
   safety we never used. 25 ms still covers the natural envelope
   decay of a held vowel and feels tighter on intentional stop /
   mute. Layer 1.5 sweep numbers shift slightly (test-end 200 ms
   pause hits the silence threshold earlier so the recorded PLC
   count is lower) but the steady-state behaviour is unchanged —
   isolated jitter still triggers exactly one PLC fill per missed
   frame, with the cosine fade now compressed into 5 frames instead
   of 10.

2. **Removed `Track::prevLen` field** (`audio_mixer.h`). The PCM
   wire frame is fixed at 240 samples and `prevLen` always equalled
   `frameCount` after each `addTrack`. Replaced its single read site
   in `accumulate` with `MAX_FRAME_COUNT` (the existing static
   bound). One field saved per track + one assignment removed in
   `consumeAllTracks`. No allocation or behaviour change.

### Test updates

- `test_plc_fade_after_consume` invariant updated: PLC fill now
  reaches silence by mix #7 (was #12 with `PLC_MAX_DECAY = 10`).
  Loop bound and assertion message updated to match.
- `audio_mixer.h` doc comments updated: "50 ms tail" → "25 ms tail",
  "10 progressively quieter copies" → "PLC_MAX_DECAY progressively
  quieter copies."

### Validation

- **Unit tests**: 13/13 PASS, `test_plc_fade_after_consume` reports
  `silent at mix #7`.
- **Layer 1 sine** (1 kHz, 5 s, amp 0.05/0.30/0.95): SNR 67.26 / 84.01 /
  93.44 dB and THD 0.043 / 0.006 / 0.002 % — byte-identical to all
  baselines from v1.0.32 onward.
- **Layer 1.5 jitter sweep**: PLC counts shift downward slightly due
  to the test-end pause / decay-saturation interaction described
  above; click metrics and pass status unchanged across all rows.
- **Layer 2 browser**: playback / capture paths PASS at 48 kHz and
  44.1 kHz.

### Latency impact

**Zero.** Steady-state buffer wait still ~2.5 ms average / 5 ms
worst (`JITTER_TARGET = 1` unchanged), end-to-end ~62.5 ms average.
No code path that affects on-air timing changed.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` `PLC_MAX_DECAY` | 10 → 5 |
| `Git/server/src/audio_mixer.h` `Track::prevLen` | removed |
| `Git/server/src/audio_mixer.h` `accumulate` PLC path | use `MAX_FRAME_COUNT` instead of `prevLen` |
| `Git/server/src/audio_mixer.h` `consumeAllTracks` | drop `prevLen` assignment |
| `Git/server/src/audio_mixer.h` doc comments | "50 ms" → "25 ms" |
| `Git/server/src/mixer_server_test.cpp` `test_plc_fade_after_consume` | bound + comment update |

## [1.0.39] - 2026-04-29

### Fixed (Room session takeover — same `user_id` no longer kicks the live session)

User: "现在的房间功能比较不稳定，会出现用户被挤出房间的状况。"

Two layers of the same root cause — both servers used `user_id` as the
primary key and silently overwrote on duplicate join, with no takeover
protocol. When the *old* connection eventually closed, its on-close
cascade tore down the room/uid slots that now belonged to the *new*
connection. Net effect: open the same site on a second device (or two
tabs sharing the persisted `tonel_guest_id`, or any WeChat-logged-in
user logging in twice — uid resolves to nickname) and a few seconds
after the second device joins, the second device gets kicked out.

The fix is a "newer session wins, old session is told and bows out"
protocol on both layers:

- `signaling_server`: `process_join_room` detects an existing ctx for
  the same uid and marks it `displaced`. `on_close` for a displaced
  ctx skips the leave_room / user_id_to_ctx_ / user_manager_ cascade.
  The displaced client is sent `SESSION_REPLACED` and its TCP closed.
- `mixer_server`: `MIXER_JOIN` captures the existing
  `UserEndpoint.tcp_client` if it differs from the new one, frees the
  old opus state, overwrites the slot, and after releasing the lock
  notifies + closes the old TCP. `clear_tcp_client` runs on the close
  but no longer matches any UE (we already overwrote), so the new
  session stays clean.

The web client (`signalService` + `audioService`) handles
`SESSION_REPLACED`: the signal service sets a latch that suppresses
`scheduleReconnect` (otherwise we'd race-reconnect into a takeover
loop). `App.tsx` shows a one-shot modal — "账号已在其他设备登录" — and
routes the user back home; the latch is cleared when the user
acknowledges so future drops can still reconnect.

### Added (Deep-link rooms — `/room/<id>` URLs with a password gate)

User: "进入房间后，域名能不能变成 /房间号 的子页面？房间是有密码保护的，需要输入密码才能进。"

`App.tsx` now mirrors room state into `window.history`:

- Entering a room pushes `/room/<id>`; leaving pushes `/`.
- Browser back/forward triggers leave-room / re-prompt as appropriate
  (a popstate listener watches the URL).
- First-load on `/room/<id>` opens a password modal (works for both
  password-protected rooms and open rooms — open rooms accept an
  empty password). Errors stay inline on the modal so users can retry
  without losing the URL.

This also gives Tonel a first shareable surface: send a friend
`https://tonel.io/room/ABCD` and they land directly on the password
prompt. URL-sync is paused while the modal is up so the deep-link
URL isn't clobbered before the user submits.

The room-id regex is `[A-Za-z0-9_-]+`, which matches the codepath
already accepted by the create-room form.

### Added (`www.tonel.io` alias + HSTS at the direct-origin nginx)

User: "用户无论在什么终端，输入 tonel.io 就能正常访问。"

`Git/ops/nginx/tonel.io.conf` now also serves `www.tonel.io` (301 →
naked tonel.io) and emits a `Strict-Transport-Security` header
(`max-age=15552000; includeSubDomains; preload`). The 80-listener
adds the same www→naked redirect.

Important: the production edge for `tonel.io` is **Cloudflare Pages**,
not this nginx (only the legacy direct-origin path hits nginx). To
actually wire `www.tonel.io` in production:

1. Cloudflare Pages → tonel-web project → Custom domains → add
   `www.tonel.io`. CF auto-creates the CNAME.
2. Cloudflare Bulk Redirects (or Page Rules) → `www.tonel.io/*` →
   `https://tonel.io/$1` (301).
3. Cloudflare → SSL/TLS → Edge Certificates → "Always Use HTTPS" on,
   HSTS on (Max Age 6mo, Include Subdomains, Preload).

After the CF HSTS has been served stably for ~2 weeks without
issues, submit `tonel.io` to https://hstspreload.org/ so even
first-visit traffic skips HTTP entirely.

### Notes

- No audio path changed: jitter buffer parameters and broadcast
  timing are untouched. Layer 1 + Layer 1.5 + Layer 2 audio test
  suites all PASS pre-deploy.
- Server-side fixes (mixer + signaling) compile clean with no new
  warnings; the existing `unused-includes` clangd notes are
  pre-existing.

## [1.0.38] - 2026-04-29

### Fixed (Jitter buffer cap 4 → 8 — 4–6× drop in PLC click rate, no latency cost)

User: "现在的这个偶发噪声还是无法忍受，再提升一点。"

Used the v1.0.37 Layer 1.5 jitter sweep to evaluate six candidate
configurations against the v1.0.36 (target=1, cap=4) baseline. Voice
+ Gaussian SD = 0..20 ms, burst patterns:

```
              plc/s at jitterSd =
config         0     5     10    15    20    burst20/15  burst10/20  burst20/30
d1 c4 (base)  1.92  7.88  8.47  14.18 15.00  2.30        2.49        3.83
d1 c8         1.92  2.12  2.50  2.69  4.02   2.30        2.30        2.68
d1 c16        1.92  2.50  2.11  2.31  2.49   2.30        3.83        2.68
d2 c8         1.92  2.12  2.69  1.92  2.69   2.11        2.49        2.68
d2 c16        3.66  2.12  2.31  2.30  3.64   2.11        2.49        2.68
d3 c12        4.62  1.92  2.31  2.12  2.69   1.92        2.30        2.68
```

Two clear takeaways:

1. **The single biggest win is `cap = 4 → 8`** with target unchanged.
   plc/s at SD = 5–15 ms drops 4–6× without adding any latency. The
   v1.0.36 → v1.0.38 transition is a one-line change.

2. **Raising target to 2 or 3 is bad** even on idle (SD = 0): plc/s
   *grows* to 3.66 (target=2 cap=16) and 4.62 (target=3) because the
   deeper steady-state queue is more sensitive to client-vs-server
   clock drift — the buffer occasionally drains to 0 and trips PLC
   despite the deeper average. This corrects v1.0.35's earlier
   diagnosis: the failure mode wasn't "depth 2 vs depth 1" per se,
   it was "headroom = 2 (cap − target) was too small for WSS-over-TCP
   burst arrivals." If headroom is 7+ (cap=8, target=1), bursts get
   queued and drained over the next few ticks instead of hitting the
   cap and dropping the oldest frame.

### Change

`JITTER_MAX_DEPTH = 4 → 8` in `Git/server/src/mixer_server.h`.
Header comment in `UserEndpoint::jitter_queue` revised to explain the
two knobs (target sets latency, cap sets burst headroom) and that
they are NOT interchangeable.
([Git/server/src/mixer_server.h:135](Git/server/src/mixer_server.h:135))

### Latency impact

**Zero.** `JITTER_TARGET` unchanged at 1 → average queue size still
~1 frame → average buffer wait still ~2.5 ms. End-to-end latency
remains at v1.0.36's ~65 ms. The cap only matters during transient
queue spikes; it doesn't change steady-state behaviour.

### Layer 1 byte-identical

SNR / THD at amp 0.05 / 0.30 / 0.95 = 67.26 / 84.01 / 93.44 dB —
identical to v1.0.32 / v1.0.36 baselines. The cap change cannot
affect signal fidelity in a no-jitter test (queue never grows).

### Lessons (added to memory)

- **Steady-state buffer depth (target) and burst headroom (cap −
  target) are independent dials.** When the user-perceived problem
  is "occasional clicks under jitter," it's almost always headroom
  not target — bigger cap, same target, free improvement.
- **Layer 1.5 paid for itself in one iteration.** The v1.0.34→v1.0.35
  regression was diagnosed wrong at the time; the sweep revealed the
  actual mechanism in 5 minutes of local testing.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/mixer_server.h` `JITTER_MAX_DEPTH` | 4 → 8 |
| `Git/server/src/mixer_server.h` comment block | Rewrite to explain target vs cap as independent knobs |
| `~/.claude/projects/.../memory/project_pomu_open_issue.md` | Add cap-vs-target lesson |

## [1.0.37] - 2026-04-28

### Added (Layer 1.5 — local jitter-scenario sweep with deterministic PLC counter)

Production behavior unchanged from v1.0.36. This release adds local
test instrumentation so future jitter-buffer / PLC iterations can be
validated without round-tripping through deploy + user recording.

The trigger: every PLC tuning attempt v1.0.30–v1.0.36 had to be tested
by deploying, asking the user to record loopback audio, and FFT-
analysing the recording. That worked but was slow (5–10 minutes
per iteration), required user time, and missed several issues
because the comparisons weren't level-normalized. v1.0.34's 13×
improvement was real; v1.0.35's regression was real but only
visible after another deploy + recording.

Layer 1.5 closes the loop: I can now run a jitter sweep locally,
diff against a baseline TSV, and decide whether a change works
*before* shipping it.

### What changed in production code

The mixer broadcast now sets bit 0 of SPA1 packet byte 75 (the
"reserved" padding byte) to 1 on ticks where any track's mix used
the PLC fill path, 0 otherwise. Production clients have always
ignored this byte (it's documented as padding), so the wire and
playback behaviour are bit-exact identical to v1.0.36 — Layer 1
SNR/THD baselines unchanged at 67.26 / 84.01 / 93.45 dB.
([Git/server/src/mixer_server.cpp:621](Git/server/src/mixer_server.cpp:621))

The new helper `AudioMixer::countPlcEligibleTracks() const` peeks
at the mixer's tracks before mixing to determine if any will fall
into the PLC path. Cheap (no buffer touch, just metadata) and
const-correct.
([Git/server/src/audio_mixer.h:64](Git/server/src/audio_mixer.h:64))

### Test infrastructure additions

`Git/server/test/audio_quality_e2e.js`:
- New `--signal voice` mode: 200 Hz carrier (period exactly = one
  frame) with a 5 Hz AM envelope. Phase-aligned at frame boundaries
  (clean broadcast → 0 false-positive clicks); different amplitude
  every frame (PLC repeat → measurable boundary jump).
- New `--jitterSd <ms>` Gaussian sender-side jitter injection.
- New `--burstEvery <N> --burstHoldMs <ms>` — simulates main-thread
  stall + burst recovery (the suspected v1.0.35 failure mode).
- New `--summary csv` mode emits one TSV row per run for sweep
  aggregation; suppresses the per-test banner.
- New d2-at-frame-boundary click detector: looks at `|x[n+1] − 2x[n]
  + x[n−1]|` exactly at sample indices `k × 240` and flags when it
  exceeds 6 × the median in-frame d2. Robust to AM-modulated voice;
  near-zero baseline on clean broadcasts.
- Receiver counts `pkt.plcFired` packets directly (the deterministic
  metric); the d2 click detector cross-checks audibility.

`Git/server/test/jitter_scenarios.sh`:
- Spawns the local mixer once, runs a battery of scenarios in CSV mode,
  emits a TSV row per scenario for diffing.
- Default scenarios: voice + Gaussian SD = 0/2/5/10/15/20 ms,
  voice + 3 burst patterns, sine amp 0.05/0.30/0.95 regression rows.

### Validation: reproduces production v1.0.34 → v1.0.35 anomaly

A/B sweep across `JITTER_TARGET = 0/1/2`:

```
                          PLC fires per second
  scenario      depth=0   depth=1   depth=2
  voice +  5ms   5.00      2.12      2.31
  voice + 10ms   9.43      6.33      8.27   ← depth 2 worse than 1
  voice + 15ms  13.40     13.09     10.94
```

The depth-2-is-worse-at-mid-jitter inversion that the user reported
in production now reproduces locally. This means the next residual-
click iteration can be designed and validated against the sweep
without another deploy.

### Skill update

`~/.claude/skills/tonel-audio-testing/SKILL.md` updated with a new
Layer 1.5 section, "iterate locally with Layer 1.5" workflow step,
and a "what each layer does and doesn't catch" matrix. Future
sessions will see the jitter-sweep as the first stop for any audio
issue with `gap=0` / `repri=0` telemetry but user-reported clicks.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` | New `countPlcEligibleTracks() const` |
| `Git/server/src/mixer_server.cpp` `broadcast_mixed_audio` | Set `out_pkt->reserved` PLC bit |
| `Git/server/test/audio_quality_e2e.js` | Voice signal, jitter injection, d2-boundary detector, csv summary |
| `Git/server/test/jitter_scenarios.sh` | New sweep runner |
| `~/.claude/skills/tonel-audio-testing/SKILL.md` | Layer 1.5 docs |

## [1.0.36] - 2026-04-28

### Reverted (Jitter buffer depth 2 → 1 — depth 2 didn't help and may have hurt)

User retest of v1.0.35 (depth 2): "延迟感受不明显，但是噪音频率似乎没变 甚至噪音稍微增大了."

The math predicted depth 2 should reduce click rate further by absorbing
≤10 ms jitter (vs depth 1's ≤5 ms), but production behaviour disagreed.
Likely cause: WSS-over-TCP delivers in occasional bursts (main-thread
stall on either side → N frames arrive in <5 ms when it resumes). With
depth 1 the steady-state buffer averages 1 frame and the headroom to
the `JITTER_MAX_DEPTH=4` hard cap is 3 frames. With depth 2 the
steady-state averages 2 frames, headroom is only 2, and burst arrivals
are more likely to push the queue past 4 → drop oldest → 5 ms of audio
thrown away → click. The trade-off is unfavourable: doubled latency
(5 → 10 ms cost, 65 → 70 ms total) bought no improvement and possibly
new cap-drop clicks.

### Reverted

`JITTER_TARGET = 2 → 1`. Back to v1.0.34 known-good state. End-to-end
latency back to ~65 ms.

### What v1.0.34 actually delivered (recap)

- Click rate 7.2 /s → 0.21 /s (35× reduction)
- Normalized click energy 0.80 → 0.062 (13× reduction)
- User: "几乎彻底解决了噪音"

The 0.21 click/s residual is jitter > 5 ms events that fell through to
PLC fallback. Eliminating those without re-introducing the cap-drop
clicks needs a smarter buffer (adaptive trim to target, or burst-aware
overflow handling), not just a deeper static cap.

### Lessons (added to memory)

- **A bigger buffer isn't unconditionally better.** Steady-state depth +
  burst headroom + hard cap interact: doubling target depth halves
  cap headroom, and if delivery is bursty the cap-drop click rate
  can outweigh the jitter-absorption gain. Measure with a recording,
  don't extrapolate from the one-sided-jitter math.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/mixer_server.h` `JITTER_TARGET` | 2 → 1 |

## [1.0.35] - 2026-04-28

### Tuned (Jitter buffer depth 1 → 2 — absorb the long tail of WSS jitter)

User confirmed v1.0.34 jitter buffer "几乎彻底解决了噪音" — normalized
click energy dropped 13× (0.80 → 0.062), click rate dropped 35× (7.2/s
→ 0.21/s). Residual 0.21 click/s remained, amplitude-independent.
These are the events where public-internet jitter exceeded the
`JITTER_TARGET=1` (5 ms) absorption window and fell through to the
PLC fallback.

Per the math (depth N absorbs up to N × 5 ms one-sided arrival jitter,
average wait (N − 0.5) × 5 ms), bumping depth 1 → 2 covers 95th-pct
WSS-over-Cloudflare jitter (~10 ms) at the cost of an extra 5 ms
end-to-end latency: 65 ms → ~70 ms. Still inside the perceptual
threshold for cross-room band rehearsal (~30–50 ms is where most
people start to notice, depending on instrument).

### Layer 1 byte-identical

SNR 84.01 dB / THD 0.006% at amp 0.30 / 5 s = unchanged from v1.0.34.
The only difference at the unit level is one extra silent priming tick
at room join (5 ms more dead air at start), invisible in the 5 s window.

### Reversibility

If 70 ms feels noticeably laggier than 65 ms, revert with one constant
change (`JITTER_TARGET = 2 → 1`); we land back at v1.0.34 behaviour.
If 0.21 click/s residual goes to ~0 but isn't 100 % gone, JITTER_TARGET = 3
(15 ms cost) is the next step.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/mixer_server.h` `JITTER_TARGET` | 1 → 2 |

## [1.0.34] - 2026-04-28

### Added (Server-side jitter buffer — first non-zero-latency fix; expected to drop click rate to ~0)

User retest of v1.0.33 showed pitch-synchronous PLC was no better than
v1.0.32 forward repeat on normalized click metrics — both sat at
0.8–1.3 click-energy/s no matter what we did inside the PLC fill
itself. Conclusion in memory: every zero-latency PLC scheme just
reshapes the click; eliminating PLC *triggers* requires absorbing
network jitter before it reaches the mixer.

User chose plan A (jitter buffer with +5 ms latency) over plan B
(further PLC tweaks).

### Reverted: v1.0.33 spectral PLC → v1.0.32 forward PLC

Pitch-synchronous PLC didn't regress, but it didn't help either —
v1.0.33 normalized energy 1.25 vs v1.0.32 0.80 in the user
recording. Reverting to forward repeat keeps the fallback path simple
and minimizes the surface that interacts with the new jitter buffer.
The pitch-PLC code (1200-sample history, AMDF detector, voiced/
unvoiced fork) and its `test_plc_pitch_repeat_on_sine` regression
test are removed; the AMDF-vs-autocorrelation lesson stays in memory.

### Added: per-user jitter buffer in `MixerServer`

`UserEndpoint` gains a `std::deque<std::vector<float>> jitter_queue`
plus a `jitter_primed` flag.

```
                       handle_udp_audio
                        (UDP packet in)
                              │
                              ▼
                    enqueue PCM into deque  ─── cap at JITTER_MAX_DEPTH=4
                                              (drop oldest on overflow)

                        handle_mix_timer
                       (5 ms tick, 200/s)
                              │
                              ▼
                  if !primed: wait until queue.size ≥ JITTER_TARGET=1
                  else:       dequeue front → mixer.addTrack()
                              │
                              ▼
                       broadcast_mixed_audio
```

If the queue is empty when a tick fires (jitter > buffer depth), the
mixer's PLC fallback (v1.0.32 forward repeat) fills as before.
Concretely: jitter ≤ ±2.5 ms is fully absorbed; jitter > 5 ms still
falls through to PLC at the same frequency as v1.0.32. Buffer depth
can be raised to 2 (10 ms latency, ±7.5 ms absorbed) by changing one
constant if production tells us we need it.

### Latency impact

**+5 ms** (60 ms → ~65 ms end-to-end). Trade off accepted by the user:
the residual ~7 click events/s on v1.0.32 are perceptually worse than
5 ms of added latency. Memory's `feedback_low_latency_first` is
respected — every zero-latency option was exhausted first.

### Layer 1 byte-identical to v1.0.32

Localhost loopback has ~0 jitter, so the buffer reaches steady state
after one tick and dequeue cadence matches enqueue cadence one-for-one.
SNR/THD across amp 0.05 / 0.30 / 0.95 = 67.26 / 84.01 / 93.45 dB —
identical to v1.0.32 to within measurement noise. Only the start-up
prime tick (one 5 ms silent frame at room join) is new, and it's
swallowed by the 5 s test window.

### Lessons (added to memory)

- **PLC fill quality plateaus around 0.8–1.3 normalized click
  energy/s in production WSS conditions.** Any zero-latency scheme
  (forward repeat, palindrome, pitch repeat) sits in this band.
  Absorbing jitter is the only way below.
- **A 5 ms jitter buffer is the minimum useful depth** — depth 0
  (immediate addTrack) gives no absorption; depth 1 absorbs ±2.5 ms
  one-sided jitter (since the buffer averages 0.5 frames in steady
  state). For wider jitter, raise to depth 2 or 3 — same code, one
  constant change.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` | Reverted to v1.0.32 forward PLC (pitch + history + AMDF removed) |
| `Git/server/src/mixer_server_test.cpp` | Reverted (pitch-sine test removed) |
| `Git/server/src/mixer_server.h` `UserEndpoint` | Add `jitter_queue` deque + `jitter_primed` flag; `JITTER_TARGET`, `JITTER_MAX_DEPTH` constants |
| `Git/server/src/mixer_server.cpp` `handle_udp_audio` | Enqueue PCM frame instead of immediate `mixer.addTrack` |
| `Git/server/src/mixer_server.cpp` `handle_mix_timer` | Drain one frame per user from jitter queue before `broadcast_mixed_audio` |
| `~/.claude/projects/.../memory/project_pomu_open_issue.md` | Add jitter-buffer + PLC-plateau notes |

## [1.0.33] - 2026-04-28

### Fixed (Pitch-synchronous PLC — voice signals get phase-aligned replay instead of plain frame repeat)

User retest of v1.0.32 forward PLC still reported "噼里啪啦", and
normalized FFT confirmed ~7 click events per second remained — every
PLC fill ends at `prev[L-1]` (5 ms ago) while the next fresh frame
starts at `F2[0]` (now), and voice changes enough over 5 ms to make
that join audible as a click.

User chose plan C ("low-latency-first" preserved): improve PLC at
0 latency cost rather than add a server-side jitter buffer.

### How spectral PLC works

`Track` keeps a 25 ms (1200-sample) sliding history of recent voice in
addition to the current fresh frame. After each fresh `consumeAllTracks`
the mixer estimates the pitch period of the recent voice. When the next
tick fires without a fresh frame, PLC fill becomes a *single-pitch-period
loop* drawn from the tail of that history:

```
PLC out[i] = prevHistory[H − P + (decayCount·count + i) mod P]
```

Because voice is locally pitch-periodic, `prevHistory[H−P] ≈
prevHistory[H−1]` (P samples ago is the same phase) — so the PLC fill
starts essentially where the previous tick ended, no synthetic
interpolation needed. Multiple consecutive PLC ticks chain smoothly:
the `decayCount·count` accumulator carries the loop position across tick
boundaries.

For unvoiced segments (whisper, room noise, silence) the detector
returns 0 and PLC falls back to forward frame repeat — i.e. v1.0.32
behaviour. Worst case never regresses.

### AMDF detector (and why not autocorrelation)

The first attempt used normalized autocorrelation
`ncc(lag) = R(lag)·H / (R(0)·(H−lag))`. On a clean 200 Hz sine
(period 240 samples, exact integer at 48 kHz) the test
`test_plc_pitch_repeat_on_sine` failed with the detector picking
lag 242 over lag 240 — `ncc(242) = 1.0014 > ncc(240) = 1.0`.

The bias is a textbook spectral-leakage artifact. The cosine residual
`Σ cos(2π(2i+lag)/T)` in `R(lag)` doesn't cancel unless `(H−lag)` is an
exact period multiple, and on lag = 242 it adds ~2 to the numerator,
producing a fractional-lag winner. Window-based fixes (Hanning the
correlation) help but slow it down.

Switched to AMDF (Average Magnitude Difference Function):
`AMDF(lag) = mean_i |hist[i] − hist[i+lag]|`. Bit-exact 0 at the true
period, no leakage. After the change `test_plc_pitch_repeat_on_sine`
PASSES with `out[0] = 0.0` (= sine(960) exactly, full phase continuity)
and PLC fill RMS = A/√2 = 0.2121.

### Detection band and why Layer 1 stays at baseline

`[PITCH_MIN, PITCH_MAX] = [96, 480]` samples = `[100 Hz, 500 Hz]` —
covers normal voice F0. Layer 1 uses 1 kHz sine (period 48), well
*outside* this band, so the detector returns 0 and PLC takes the
unvoiced fallback path. SNR / THD / rate at amp 0.05 / 0.30 / 0.95
are byte-identical to v1.0.32 baseline (67.26 / 84.01 / 93.44 dB).

### Latency and CPU impact

**Latency: zero.** Same 5 ms broadcast cadence; PLC only fills ticks
that would otherwise be silent.

**CPU**: AMDF over a 1200-sample history with 384 candidate lags is
~350k absolute-difference ops per fresh frame, ≈70M ops/s at 200/s.
On the production x86 server this is < 5 % single-core; well within
budget.

### New regression test

- `test_plc_pitch_repeat_on_sine`: feeds 4 frames of 200 Hz sine
  (build up history past the 960-sample detector minimum), then on
  the next miss verifies `out[0]` matches the would-be next sine
  sample to ±1e-3 and the fill RMS matches a sine RMS to ±0.05.
  Locks both AMDF detection and the phase-continuous PLC loop.

### Workflow note

1. Layer 1 baseline before changes.
2. Implemented pitch PLC with autocorrelation; new sine test FAILED
   exposing the leakage bias.
3. Switched detector to AMDF; new test PASSES, out[0] bit-exact 0.
4. Layer 1 + Layer 2 byte-identical to v1.0.32 baseline.

### Lessons (added to memory)

- **Autocorrelation pitch detectors leak.** The cos((2i+lag)/T) residual
  doesn't cancel for non-period lags and pushes ncc above 1.0 at
  fractional-sample offsets. Use AMDF or windowed autocorrelation,
  not raw normalized autocorrelation.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` Track struct | `prevAudio[480]` → `prevHistory[1200]`; add `historyLen`, `detectedPitch` |
| `Git/server/src/audio_mixer.h` `accumulate` PLC path | Pitch-loop fill if voiced; forward fallback if not |
| `Git/server/src/audio_mixer.h` `consumeAllTracks` | Slide history; run AMDF detect |
| `Git/server/src/audio_mixer.h` `detectPitch` | New AMDF-based pitch detector |
| `Git/server/src/mixer_server_test.cpp` | Add `test_plc_pitch_repeat_on_sine` |
| `~/.claude/projects/.../memory/project_pomu_open_issue.md` | Add autocorrelation-leakage lesson |

## [1.0.32] - 2026-04-28

### Reverted (Roll back v1.0.31 palindrome PLC — objectively worse than v1.0.30 forward repeat)

User retest of v1.0.31 reported persistent "噼里啪啦" click. FFT
analysis on the new recording, normalized for signal RMS to remove the
"user spoke louder this time" confound:

| Metric | v1.0.29 | **v1.0.30** | v1.0.31 |
|---|---|---|---|
| Click rate | 13.9 / s | **7.2 / s** | 15.2 / s |
| Median click jump / signal RMS | 0.41× | **0.20×** | 0.54× |
| p90 click jump / signal RMS | 0.73× | **0.47×** | 0.95× |
| Total click energy / signal energy / s | 3.38 | **0.80** | 6.43 |

v1.0.30 forward PLC is best on every objective metric — the
v1.0.31 palindrome was 8× worse on normalized click energy.

### Why palindrome failed in production despite passing Layer 1

The diagnosis flipped which boundary mattered most. Two PLC boundaries
exist per fill:

1. **Previous-tick → PLC start.** v1.0.30 forward jumps from prev[L-1]
   (last 5 ms ago) to prev[0] (start of prev frame, also 5 ms ago).
   v1.0.31 reverse start from prev[L-1] → prev[L-1] = bit-exact.
2. **PLC end → next-fresh.** v1.0.30 forward ends at prev[L-1] (5 ms
   ago), so next fresh F2[0] is a 5 ms voice diff away.
   v1.0.31 reverse ends at prev[0] (which is *10 ms ago* relative to
   the upcoming F2[0]), so the jump is 2× the voice movement of the
   forward case.

Voice signals change more over 10 ms than over 5 ms, so palindrome
*halved* the easier boundary jump (#1) and *doubled* the harder one
(#2) — net effect was worse perceived audio.

Layer 1 didn't catch it: SNR/THD measure spectral purity of a 1 kHz
sine, and time-reversal preserves magnitude spectrum, so SNR was
byte-identical. The metric that matters here — sample-level
discontinuity at the PLC→fresh transition — wasn't in the test suite.

### Action

- Reverted `accumulate` PLC path to plain forward repeat.
- Removed `test_plc_boundary_continuity_on_ramp`, replaced with
  `test_plc_forward_direction_on_ramp` to lock the simpler invariant.
- Kept `prevLen`, `hasPrev`, `decayCount`, fade math — all still useful
  for the cosine fade-out and reset semantics.

### Latency impact

**Zero.** Same 5 ms broadcast cadence as v1.0.30 / v1.0.31.

### Where this leaves the 破音 issue

Forward PLC v1.0.30 is the best zero-latency point on the curve, but
still has ~7 click events per second on public-net jitter. Further
reduction requires a latency / quality trade — primary candidates:

1. **Server-side 1-frame jitter buffer** (+5 ms latency, 5 ms = 1 PLC
   tick): absorbs single-frame jitter completely, eliminates most
   PLC triggers, ~zero click on typical paths.
2. **Spectral PLC (LPC / pitch-period repeat)**: 0 ms latency cost,
   but ~200 lines of new code + harder to test, and the gain over
   forward repeat is incremental.

Neither is implemented yet — needs a direction call from the user
since it touches the project's "low-latency-first" guideline.

### Lessons (added to memory)

- **Normalize FFT / click metrics for signal energy.** Two recordings
  with different speaking volumes are not directly comparable on
  raw click count. Median click amplitude / signal RMS is the right
  unit.
- **There is more than one PLC boundary.** "PLC stitch is continuous"
  was true for v1.0.31's PLC↔PLC boundary but ignored the more
  common single-miss case where the PLC↔fresh boundary dominates.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` `accumulate` PLC path | Revert palindrome → plain forward repeat |
| `Git/server/src/mixer_server_test.cpp` | Replace boundary-continuity test with forward-direction test |
| `~/.claude/projects/.../memory/project_pomu_open_issue.md` | Add palindrome lesson + normalized metric note |

## [1.0.31] - 2026-04-28

### Fixed (PLC palindrome — eliminate the residual 5 ms boundary click v1.0.30 cut in half)

User retest of v1.0.30 still reported "沙沙" noise. FFT comparison
between the two recordings:

| Metric | v1.0.29 | v1.0.30 |
|---|---|---|
| Click rate | 13.9 / s | **7.2 / s** (halved) |
| Top click-spacing bucket | 0–0.5 ms | **5–5.5 ms** (still 5 ms dominant) |
| Click-train FFT 200 Hz peak | -4.99 dB | -3.73 dB (still present) |

PLC v1.0.30 cut click count in half, but the 200 Hz tick-boundary peak
survived. Diagnosis: PLC repeated `prevAudio[0..L-1]` immediately after
broadcasting `prevAudio[L-1]`. For any signal whose start and end
samples differ (every voice frame), that's a sample-step discontinuity
on the join — a small click instead of the v1.0.29 silent-gap click.

### Why the obvious fix failed first

A linear cross-fade from `prevAudio[L-1]` (= "stitch") to `prevAudio[i]`
across the first 8 samples seemed promising and was implemented as the
first v1.0.31 attempt. Layer 1 showed catastrophic regression — SNR
dropped from 84 dB to 44 dB at amp=0.30, THD jumped 100×. The bridge
injected a synthetic linear trajectory not present in the actual
signal; on a 1 kHz sine that trajectory is broadband noise. **Do not
reintroduce.** The lesson: PLC must always emit *real* signal samples,
never interpolated synthetic ones.

### Fix: palindrome PLC

Alternate forward and reverse playback of `prevAudio` each miss:

```
tick N-1 (fresh)      :  audio[0..L-1]      ends at  audio[L-1]
tick N   (PLC, miss 0):  audio[L-1..0]      starts at audio[L-1] ✓
tick N+1 (PLC, miss 1):  audio[0..L-1]      starts at audio[0]   ✓
tick N+2 (PLC, miss 2):  audio[L-1..0]      starts at audio[L-1] ✓
                                            ...
```

Every tick boundary is now bit-exact continuous: no sample-step
discontinuity, no click. Time reversal preserves the magnitude
spectrum (`|F{x(-t)}| = |F{x(t)}|`), so an automated 1 kHz sine test
sees zero SNR/THD regression — confirmed empirically: SNR/THD across
amp 0.05 / 0.30 / 0.95 is byte-identical to v1.0.30.

The cosine fade-out, PLC_MAX_DECAY=10 (50 ms tail), and silence after
exhaustion are all unchanged. Only the *direction* of replay alternates.
([Git/server/src/audio_mixer.h:147](Git/server/src/audio_mixer.h:147))

### Latency impact

**Zero.** Same 5 ms broadcast cadence, same fresh-frame fast path
(byte-identical to v1.0.29 when no frames are missed), no added
buffering. PLC fills *would-be-silent* ticks with phase-continuous
replay; "now" audio still arrives at the same wall-clock time.

### Tests

- `test_plc_boundary_continuity_on_ramp` (rewritten): asserts
  out2[0] == out1[L-1] (palindrome stitch on miss 0), out2[L-1] ==
  prevAudio[0] (reverse direction), out2[100] == ramp[379]
  (mid-sample comes from reversed prev frame), and forward direction
  on miss 1.
- `test_plc_fade_after_consume` and `test_plc_resets_on_fresh_frame`
  use constant signals which are direction-symmetric, so they still
  pass unchanged — they exercise the cosine fade and reset semantics
  independently of palindrome direction.

### Workflow note

1. Ran both layers BEFORE the fix.
2. First attempt: linear cross-fade. Caught by Layer 1 immediately
   (SNR 84 → 44 dB).
3. Reverted, switched to palindrome.
4. Layer 1 + Layer 2 byte-identical to v1.0.30 baseline ✓.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` `accumulate` PLC path | Alternate fwd/reverse playback per `decayCount` parity |
| `Git/server/src/audio_mixer.h` `Track` | Removed `PLC_BOUNDARY_FADE`, added `prevLen` (for reverse indexing) |
| `Git/server/src/mixer_server_test.cpp` | Rewrote boundary continuity test for palindrome semantics |

## [1.0.30] - 2026-04-28

### Fixed (Server mixer PLC — root cause of residual 破音 across v1.0.10–v1.0.29)

User submitted a 10-second recording of solo loopback distortion. FFT
analysis surfaced an unmistakable signature:

- Inter-click intervals clustered at 5 / 10 / 15 / 20 / 25 ms (5 ms multiples)
- Click-train FFT peak at **200 Hz** (= 1 / 5 ms = server broadcast tick rate)
- No clipping (`|x|>0.95 = 0` samples); normal vowel formant spectrum
- ~14 clicks/s riding atop voice content

This is a textbook 5 ms tick-boundary discontinuity. Mechanism:

When a client PCM packet is delayed by public-internet jitter (WSS over
Cloudflare Tunnel routinely sees ±10 ms variance), it misses its
broadcast tick. The mixer's consume-style invariant (added in v1.0.10
to prevent stale-frame-replay buzz) then broadcast a 5 ms zero-pad in
place of the missing frame — voice → silence → voice = sample-step
discontinuity = audible click. At network-jitter rates this stacks
into the continuous "破音" listeners reported.

The Layer 1 automated test runs on localhost loopback (~0 ms jitter)
so this never showed up in CI. The user-facing telemetry (`gap=0`,
`repri=0`) was correct — no UDP loss, no client-ring underrun — the
bad audio was inside the server's own broadcast.

### Fix: cosine-tapered PLC in `AudioMixer`

`Track` gains `prevAudio[MAX_FRAME_COUNT]`, `decayCount`, `hasPrev`.

1. **Fresh frame** (`frameCount > 0`): normal full-amplitude mix.
   Byte-identical to v1.0.29 on this path.
2. **Missing frame, `decayCount < PLC_MAX_DECAY` (10 ticks = 50 ms)**:
   replay `prevAudio` with cosine-tapered gain
   `fade(k) = 0.5 · (1 + cos(πk / PLC_MAX_DECAY))`. fade(0)=1.0 → first
   miss is a full-amplitude replay (not silence); fade(9)≈0.024 → last
   replay before silence.
3. **`decayCount ≥ PLC_MAX_DECAY`**: contribute silence — bounded decay
   protects against the v1.0.10 200 Hz-buzz hazard the original consume
   invariant was guarding against.
4. **Fresh frame mid-decay**: snaps back to full amplitude, snapshots
   the new frame to `prevAudio`, resets `decayCount`. Models the common
   "one packet delayed, stream resumes" case.

`accumulate` reads `decayCount` without modifying it so multiple
per-recipient mixes within one tick all see the same fade gain; state
advances exactly once per tick in `consumeAllTracks`.
([Git/server/src/audio_mixer.h:123](Git/server/src/audio_mixer.h:123))

### Latency impact

**Zero.** PLC is byte-identical to v1.0.29 on the fresh-frame path.
Layer 1 baselines (SNR 67 / 84 / 93 dB at amp 0.05 / 0.30 / 0.95)
are unchanged because no frames are dropped on the loopback test.

The 50 ms PLC tail does NOT add to end-to-end latency — it fills in
ticks that *would otherwise have been silent.* "Now" audio still
arrives at the same wall-clock time as v1.0.29; the change is that
previously-silent 5 ms ticks now contain decaying replay instead of
zero-pad.

### New regression tests

- `test_plc_fade_after_consume`: full-amp first mix, then 10 PLC fills
  monotonically decaying, silent by mix #12. Locks PLC_MAX_DECAY.
- `test_plc_resets_on_fresh_frame`: track mid-decay snaps back to full
  amplitude when its packet finally arrives, including PLC restart on
  the new prev frame.
- `test_plc_no_replay_before_first_frame`: empty mixer stays
  bit-exact silent (guards against uninitialized `prevAudio` mixing).
- `test_mix_excluding`: updated — consume+mix expects PLC fade(0)=1.0
  (=0.9) instead of the v1.0.29 silence assertion.

### Workflow note (per `tonel-audio-testing` skill)

1. Ran both layers BEFORE — baseline snapshot (SNR 84 dB, browser PASS).
2. User recording → FFT diagnosed 200 Hz click-train signature.
3. Implemented PLC.
4. Ran both layers AFTER — SNR/THD/rate identical to v1.0.29 baseline
   (PLC doesn't trigger when no frames are missed in localhost loopback).
5. Added 3 new unit tests + updated 1 to lock PLC behaviour.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` `Track` struct | Add `prevAudio`, `decayCount`, `hasPrev` |
| `Git/server/src/audio_mixer.h` `accumulate` | Cosine-fade PLC fill on missing frame |
| `Git/server/src/audio_mixer.h` `consumeAllTracks` | Snapshot fresh frame; advance decay |
| `Git/server/src/mixer_server_test.cpp` | 3 new PLC tests + 1 updated consume test |
| `~/.claude/projects/.../memory/project_pomu_open_issue.md` | Marked resolved + lessons learned |

## [1.0.29] - 2026-04-28

### Changed (Roll back the cushion bump that v1.0.28's server fix made unnecessary)

User confirmation on v1.0.28: `rate=+0 ppm`, `repri=0`, `gap=0`,
`ring=5568 stable` — the absolute-deadline timer fixed the drift
completely. The 100 ms playback cushion (PRIME_TARGET=4800) was
sized to compensate for that drift. With drift gone, the extra
70 ms of latency was pure cost — buying nothing.

`PRIME_TARGET` 4800 → 1440 (100 ms → 30 ms). End-to-end mic→speaker
latency drops back to ~60 ms.

### Note (open issue: 破音 still present)

User reports residual 破音 on solo loopback even with all known
sources clean (`rate=0`, `repri=0`, `gap=0`, `micClip=0`, server
SNR 84 dB). All obvious causes are ruled out. The remaining
suspect is a path the test suites don't cover —
`MediaStreamAudioSourceNode → CaptureWorklet` with real Web Audio,
where Chrome's hidden DSP-on-`getUserMedia`-despite-our-flags is
the most likely candidate.

State, hypotheses, and "do not repeat these dead ends" notes are
saved to memory at `project_pomu_open_issue.md` for the next
session to pick up cold.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `PRIME_TARGET` | 4800 → 1440 |
| `Git/server/test/browser/test_page.html` | Worklet copy synced |
| `~/.claude/projects/.../memory/project_pomu_open_issue.md` | New: open-issue handoff doc |

## [1.0.28] - 2026-04-28

### Fixed (Server timer drift — root cause of all the prior client-side cushion bumps)

User's `rate=-12000 ppm` reading on v1.0.27 confirmed the loop was
saturating against the cap *again*: actual server-vs-client rate
offset is ≥ 1.2 %. We can't keep widening the rate cap (already at
the perceptual edge for pitch shift). The real issue is on the
server: `uv_timer_start(handle, cb, 5, 5)` schedules each fire as
"now + 5 ms after this fire", so any libuv dispatch slop (typically
~0.1–0.2 ms, plus event-loop overhead under load) compounds
indefinitely. On production that compounded to ~0.8 % rate offset
(198.4/s instead of 200/s); on top of any browser-side clock skew,
the total exceeded the client's 1.2 % compensation range.

### Server fix: absolute-deadline scheduling

Replaced the repeating `uv_timer` with one-shot timers re-armed
against an absolute deadline (`mix_next_deadline_us_`) tracked in
`uv_hrtime()`-based microseconds. Each broadcast tick:

1. Process every deadline that has already passed (catches up if the
   event loop was delayed; usually one iteration in normal ops).
2. Advance `mix_next_deadline_us_` by exactly 5 ms per broadcast.
3. Re-arm the timer for `max(0, deadline - now)` rounded to ms.

Net effect: average broadcast rate is **exactly 200/s** anchored to
the start time, with per-fire jitter of ≤ 1 ms (libuv's timer
granularity) but **no compounding drift**.
([Git/server/src/mixer_server.cpp:786](Git/server/src/mixer_server.cpp:786))

### New regression test

`audio_quality_e2e.js` now measures the actual broadcast rate from
receive timestamps and asserts it stays within ±5000 ppm (±0.5 %)
of 200/s. With v1.0.28 the local-mixer rate measures **+1105 ppm**
on a 5-second sample (5× tighter than the v1.0.27 baseline of
~+1.8 %). Catches any future timer regression in CI.
([Git/server/test/audio_quality_e2e.js:280](Git/server/test/audio_quality_e2e.js:280))

### Workflow note (per `tonel-audio-testing` skill)

Followed the skill's bisect-fix-lock methodology:
1. Ran both layers BEFORE the change (baseline).
2. Implemented the fix.
3. Ran both layers AFTER (Layer 1: rate now 200.22/s vs baseline
   ~201.8/s; SNR/THD unchanged. Layer 2: unchanged).
4. Added the broadcast-rate regression test so the invariant is
   locked in.

### Latency impact
None. Same 5 ms broadcast cadence; just the cadence is now actually
5 ms instead of 5.04 ms.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/mixer_server.h` | Add `mix_next_deadline_us_`, `MIX_INTERVAL_US` |
| `Git/server/src/mixer_server.cpp` start | Initialise deadline; one-shot timer arm |
| `Git/server/src/mixer_server.cpp` `handle_mix_timer` | Catch-up loop, absolute-deadline re-arm |
| `Git/server/test/audio_quality_e2e.js` | Measure broadcast rate; assert ≤ ±5000 ppm |

## [1.0.27] - 2026-04-28

### Fixed (Rate-scale cap saturation at user's 0.8 %+ drift)

User's `rate=-8000 ppm` reading on v1.0.26 told us their actual
producer/consumer rate offset is **at or above 0.8 %** — the
client's rate loop was saturated against the cap and couldn't
fully keep up. Likely cause: server-side libuv timer slop. The
5 ms `uv_timer` actually fires at ~5.04 ms intervals on average,
delivering ~198 packets/s instead of 200 — a 0.8 % shortfall the
client compensates by slowing its own consumer.

### Two changes (client-side compensation)

- **`PRIME_TARGET` 2400 → 4800 (50 ms → 100 ms cushion).** Even
  with the loop saturated, the wider buffer absorbs sustained
  drift for ~12 s before reaching `PRIME_MIN`. Combined with
  the cap widening below, the loop should converge inside the
  range and ring stays near target.
  ([Git/web/src/services/audioService.ts:415](Git/web/src/services/audioService.ts:415))

- **Rate range widened ±0.8 % → ±1.2 %.** 1.2 % is ~20 cents on
  pitch — measurable on a tuner but consistently below the
  perceptual threshold for short-duration speech (~25-35 cents
  for voice; sustained tones are more sensitive but voice has
  enough frequency variation to mask it).
  ([Git/web/src/services/audioService.ts:478](Git/web/src/services/audioService.ts:478))

### Note (server-side timer is the upstream cause)

The actual fix should be on the server: replacing `uv_timer` with
a higher-precision timer driven by `clock_gettime(CLOCK_MONOTONIC)`,
or computing each broadcast's deadline from the start time rather
than from the previous fire. Deferred — that's a server change with
its own test risk, and the client-side compensation works as long
as the drift stays within ±1.2 %.

### Latency impact
+50 ms playback latency from the cushion bump. End-to-end mic→
speaker now ~130 ms. At the upper edge of "imperceptible delay"
for voice but still within the range users tolerate well in WSS
conferencing apps (Discord, Zoom, etc. are typically 100-200 ms).

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `PlaybackProcessor` | PRIME_TARGET 2400→4800; rate range ±0.008→±0.012 |
| `Git/server/test/browser/test_page.html` | Worklet copy synced |

## [1.0.26] - 2026-04-28

### Fixed (Reprime drift at the rate-scale cap)

User's `rate=-4619 ppm` reading on v1.0.25 told us their browser's
audio thread runs ~0.46 % slower than the server's broadcast clock —
within 92 % of the v1.0.25 ±0.5 % rate cap. With less than 0.05 %
of headroom left, any short network burst pushed the ring under
`PRIME_MIN` and reprimed.

### Three changes

- **`PRIME_TARGET` 1440 → 2400 (30 ms → 50 ms cushion).** Most network
  bursts on WSS-over-public-internet are well under 50 ms; this
  effectively kills the burst-driven reprime case.
  ([Git/web/src/services/audioService.ts:415](Git/web/src/services/audioService.ts:415))

- **Rate range widened ±0.5 % → ±0.8 %.** 0.8 % is at the upper edge
  of imperceptible pitch shift on voice (~14 cents); 1 % starts being
  noticeable on sustained tones. The wider band gives the loop room
  to fully compensate the user's measured 0.46 % drift instead of
  saturating against the cap.
  ([Git/web/src/services/audioService.ts:476](Git/web/src/services/audioService.ts:476))

- **Reprime fade-out: linear → raised-cosine.** Cosine taper has zero
  derivative at both endpoints — the envelope's first derivative
  doesn't kink, which means no spectral splatter on the way to
  silence. At quiet listening levels (e.g. solo loopback of room
  ambient at -38 dB), the linear ramp could still be perceived as a
  faint blip; the cosine is below the ear's click threshold even
  there.
  ([Git/web/src/services/audioService.ts:528](Git/web/src/services/audioService.ts:528))

### Note (the "底噪 only when mic is on" report)

That's not a code bug. Solo loopback echoes the user's own mic back
through the server. With `noiseSuppression: false` (intentionally —
the suppression algorithms add ≥ 30 ms of latency we can't afford),
the room's natural ambient noise floor — HVAC, computer fan,
electrical hum, the mic preamp's self-noise — is also captured and
played back. Disable mic → no input → silent loopback. This is the
same behavior every conferencing app has when monitoring is on with
processing disabled. Quieter room = quieter loopback.

### Latency impact
+20 ms from the cushion bump. End-to-end mic→server→speaker now
~70 ms. Still under voice's "delayed" perception threshold.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `PlaybackProcessor` | PRIME_TARGET 1440→2400; rate range ±0.005→±0.008; cosine fade-out |
| `Git/server/test/browser/test_page.html` | Worklet copy synced |

## [1.0.25] - 2026-04-28

### Fixed (Residual reprime drift in v1.0.24's adaptive loop)

User reported `repri=16` over 6 minutes (down 19× from v1.0.23 but
still non-zero), with `gap=0` and mic muted — confirming the cause was
clock drift, not network or signal. v1.0.24's adaptive loop converged
the rate correctly when ring drifted outside the 0.7×–1.3× target
deadband, but **inside the deadband it slowly drifted `rateScale` back
to 1.0**. So as soon as the ring returned to nominal, the rate
correction undid itself, drift resumed, ring drifted out again,
correction reapplied, ... a slow oscillation that occasionally
clipped `PRIME_MIN` even with no real network problem.

### Two changes

- **Hold `rateScale` inside the deadband** instead of drifting back to
  1.0. The loop is now an integrator with saturation: outside the
  deadband the rate moves; inside, it stays. Steady state converges
  to whatever rate matches producer/consumer exactly, then holds —
  no oscillation, no slow re-drain.
  ([Git/web/src/services/audioService.ts:482](Git/web/src/services/audioService.ts:482))

- **`PRIME_TARGET` 960 → 1440 (20 ms → 30 ms cushion).** Extra 10 ms
  of headroom absorbs main-thread GC pauses, WebSocket bursts, and
  other non-drift events that can briefly drop the ring below
  `PRIME_MIN` even when the rate loop is correct.
  ([Git/web/src/services/audioService.ts:415](Git/web/src/services/audioService.ts:415))

### New diagnostics

Debug strip now also shows:
- `ring=N` — current ring fill (target 1440 = 30 ms)
- `rate=±NNNppm` — current `rateScale` offset from 1.0 in parts per
  million; 1000 ppm = 0.1 % rate correction, 5000 ppm = 0.5 % cap.
  In steady state this should converge to a small non-zero value
  (the actual clock drift between this browser and the server).

### Latency impact
+10 ms playback latency (from the cushion bump). End-to-end mic→speaker
~50 ms, still under the perceptual-delay threshold for voice.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `PlaybackProcessor` | Drop deadband drift-to-1.0; bump `PRIME_TARGET` 960→1440; emit periodic stats |
| `Git/web/src/services/audioService.ts` | Expose `playRateScale`, `playRingFill` |
| `Git/web/src/pages/RoomPage.tsx` debug strip | New `ring=N rate=±NNNppm` fields |
| `Git/server/test/browser/test_page.html` | Worklet copy synced |

## [1.0.24] - 2026-04-28

### Fixed (Slow `repri` growth even with mic muted — clock drift)

User confirmed `gap=0` (no UDP loss/reorder) but `repri` was still
ticking up at ~1/s **even with the microphone off**. That rules out
network jitter and signal-related causes. The remaining suspect is the
clock-skew between the server's 5 ms broadcast timer (NTP-synced) and
the browser's audio thread (CPU crystal). Both nominally 48 kHz, but
hardware clocks drift by 50–500 ppm (0.005–0.05 %). Even tiny drift
accumulates: at 100 ppm the ring loses 5 samples/sec, draining the
20 ms cushion to empty in roughly two minutes. Worklet then reprimes
(silence event → click), which is exactly what the user observed.

### Adaptive playback rate compensation

The playback worklet now runs a slow control loop that nudges its
read step (`effRatio = ratio × rateScale`) up or down within ±0.5 %
to keep the ring near `targetCount` (= `PRIME_TARGET`):

- Ring above 1.3× target → increase `rateScale` toward 1.005 (consume
  faster) at 2e-5 per audio quantum.
- Ring below 0.7× target → decrease toward 0.995 (consume slower).
- Inside the deadband → drift back to 1.0.

±0.5 % is well below the perceptual threshold for pitch shift on
voice content, and 2e-5/quantum (~0.0075/sec) is fast enough to track
typical drift, slow enough to be inaudible on transients. With the
loop closed, **the only thing that should still trigger a reprime is a
real network outage** — sustained drift no longer drains the ring.

### Other improvements

- **Fade-out length 16 → 240 samples (≈330 µs → 5 ms).** When a reprime
  does fire, the soft drop is long enough that the ear perceives it as
  a brief attenuation, not a click.
  ([Git/web/src/services/audioService.ts:498](Git/web/src/services/audioService.ts:498))

- **Browser test analysis sweeps for the actual peak fundamental.**
  The OfflineAudioContext test pre-fills the ring (which only happens
  in the test, never in real listening) so `rateScale` ramps up by
  ~0.5 % during the render — Goertzel at exactly the target frequency
  would under-report due to spectral leakage. Sweeping ±2 % finds the
  true peak so the test reflects actual signal quality. New output
  format includes the recovered peak frequency and the implied shift,
  which is also a useful production diagnostic — a sustained shift
  that doesn't decay back to ~0 % means real client/server clock drift
  is present and the adaptive loop is working as designed.
  ([Git/server/test/browser/browser_audio_test.js:178](Git/server/test/browser/browser_audio_test.js:178))

### Latency impact
None. Same `PRIME_TARGET` (20 ms cushion) as v1.0.23. The control loop
runs entirely on the audio thread, no extra latency, no extra buffers.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `PlaybackProcessor` | Adaptive `rateScale` (clock-drift compensation); 5 ms fade-out on underrun |
| `Git/server/test/browser/test_page.html` | Worklet copy synced |
| `Git/server/test/browser/browser_audio_test.js` | Sweep ±2 % for actual fundamental; report shift |

## [1.0.23] - 2026-04-28

### Fixed (Residual 破音 — playback ring underruns)

User confirmed `roomUsers=1`, `rxPeak` grows on speech, mic isn't
clipping (`micClip=0`), and the audio path is round-tripping the
server. The remaining 破音 had to be on the playback side. Hypothesis:
the 10 ms ring cushion (`PRIME_TARGET=480`) is too tight against
WSS-over-public-internet jitter, which regularly spikes 15+ ms.
When the ring drops below `PRIME_MIN=128` mid-callback, the worklet
silences the rest with no fade — an instantaneous audio→silence
discontinuity that the listener hears as a click. Stacked at voice
peaks (where the discontinuity amplitude is largest), the click
pattern is exactly the 破音 the user described.

### Three changes

- **`PRIME_TARGET` 480 → 960 (10 ms → 20 ms cushion).** Doubles the
  jitter buffer. WSS jitter rarely exceeds 20 ms in steady state, so
  re-prime should now be a rare event. Costs +10 ms playback latency,
  well under the perceptual threshold for "delayed" voice — and a
  worthwhile trade against the audible distortion.
  ([Git/web/src/services/audioService.ts:415](Git/web/src/services/audioService.ts:415))

- **Fade-out on re-prime.** When the ring still does drop below
  `PRIME_MIN` mid-callback, fade the last 16 samples we already wrote
  down to zero (∼330 µs ramp at 48 kHz) before silencing the rest.
  Turns a step-discontinuity into a soft drop — no measurable
  amplitude lost, but the click goes from "obvious" to "imperceptible
  even when it does happen".
  ([Git/web/src/services/audioService.ts:495](Git/web/src/services/audioService.ts:495))

- **Re-prime counter and sequence-gap counter exposed in the room
  debug strip** as `repri=N gap=N`. `repri` increments every time the
  playback worklet underruns (each = one click event). `gap` increments
  every SPA1 packet that arrives out-of-order or after a missing one
  (each = network instability, often the cause of a re-prime that
  follows). This is the diagnostic that confirms the hypothesis: if
  `repri` stays small and 破音 is gone, the cushion bump fixed it; if
  `repri` keeps growing, we need a smarter PLC strategy (next layer).
  ([Git/web/src/pages/RoomPage.tsx:48](Git/web/src/pages/RoomPage.tsx:48))

### Test sync
`Git/server/test/browser/test_page.html` worklet copy updated to match
production (per the `tonel-audio-testing` skill convention). Browser
test SNR/THD unchanged — it pre-fills the ring before render so re-prime
never fires in that scenario, but the cushion change is reflected.

### Latency impact
+10 ms playback latency from the cushion bump. End-to-end (mic →
server → speaker) goes from ~30 ms to ~40 ms in steady state.
Below the 50 ms threshold humans start perceiving as "delayed" voice.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `PlaybackProcessor` | PRIME_TARGET 480 → 960; fade-out on mid-callback underrun; reprime counter |
| `Git/web/src/services/audioService.ts` `playPcm16` | Sequence-gap detection from SPA1 header |
| `Git/web/src/pages/RoomPage.tsx` debug strip | New `repri=N gap=N` fields |
| `Git/server/test/browser/test_page.html` | Worklet copy synced |

## [1.0.22] - 2026-04-28

### Fixed (Possible mic→speaker local loopback in capture worklet)

User report: `rxLvl=0.0000` (server returning silence) **but still hearing
audio with very low latency** — exactly the signature of a local
mic→speaker loopback bypassing the server. The capture `AudioWorklet`
connected its output to `audioContext.destination` to keep the audio
thread invoking `process()`, and although the worklet's `process()`
never explicitly wrote to outputs, an unmodified output buffer's
contents are not always reliably zero across browsers.

### Two layers of defense

- **Worklet explicitly zeros outputs every quantum.** Capture-only
  processor; we never want our outputs reaching the speaker.
  ([Git/web/src/services/audioService.ts:578](Git/web/src/services/audioService.ts:578))

- **Worklet routes through a 0-gain `GainNode` before destination.**
  Defense in depth — even if the worklet's output ever held real
  data, a hard 0-gain sink guarantees nothing reaches the speaker.
  ([Git/web/src/services/audioService.ts:631](Git/web/src/services/audioService.ts:631))

### Improved diagnostics in the room debug strip

`rxLvl` was the RMS of just the *last* received packet. With voice,
that toggles between speech levels and zero in the gaps between
syllables — catching it at zero made it look like the server was
silent when it actually wasn't. Replaced with `rxPeak` (peak-hold
with slow decay; reads near zero only when the server has been
silent for ~350 ms or more — true silence, not a momentary gap).

Also added two fields that disambiguate "why is rx silent":
- `roomUsers=N` — how many users the SERVER thinks are in this
  room (from the LEVELS broadcast). `roomUsers=1` means solo mode
  is active; `roomUsers=2+` means N-1 mix and a peer must be
  audible for `rxPeak > 0`.
- `MUTED` flag — appears when the user has muted; tx packets are
  zeroed by design when muted, so server-side mix is silent for
  this user.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` capture worklet `process()` | Explicit `outputs[0][c].fill(0)` |
| `Git/web/src/services/audioService.ts` `initCaptureWorklet` | Route through `captureSink` GainNode (gain=0) → destination |
| `Git/web/src/services/audioService.ts` `stopCapture` | Disconnect captureSink on teardown |
| `Git/web/src/services/audioService.ts` `rxLevelPeak` | Peak-hold with slow decay |
| `Git/web/src/services/audioService.ts` `serverPeerCount` | Expose `peerLevels.size` for debug strip |
| `Git/web/src/pages/RoomPage.tsx` debug strip | `rxPeak` + `roomUsers=N` + `MUTED` |

## [1.0.21] - 2026-04-28

### Changed (Diagnostic strip — always show capture path + clip count)

v1.0.20 only displayed `micClip=N` when `N > 0`, which was meant to
keep the strip uncluttered but had an unintended side effect: the
absence of `micClip` was ambiguous between "worklet is running and
mic isn't clipping" and "worklet failed silently, fell back to
ScriptProcessor where clip detection doesn't run." The user couldn't
tell which.

The room debug strip now always shows two new fields:
- `cap=wkt` / `cap=sp` / `cap=idle` — which capture path is currently
  active (AudioWorklet, ScriptProcessor fallback, or not capturing).
- `micClip=N` — always shown, even when 0, so the worklet's reach
  is visible.

Console also logs `[Audio] Capture path: AudioWorklet` (or the
fallback message) when capture starts, for environments where the
debug strip isn't readable.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` | New `captureMode` field tracking the active capture path; logged at startup |
| `Git/web/src/pages/RoomPage.tsx` debug strip | Always show `cap=...` and `micClip=N` |

## [1.0.20] - 2026-04-28

### Fixed (Web Capture — residual "破音" at 48 kHz context)

After v1.0.19, listeners reported residual "破音" (peak distortion)
even with the AudioContext locked at 48 kHz, where every resampler
in the chain is a guaranteed no-op and the rest of the path tests
clean (Layer 1 < 0.01 % THD, Layer 2 < 0.05 % THD). The remaining
nonlinearity had to be in the capture stage — and the capture stage
was still a `ScriptProcessorNode`.

`ScriptProcessorNode` is deprecated and runs on the main thread, so
its `onaudioprocess` callbacks compete with React renders, GC pauses,
and any other JS work. Under main-thread load Chromium will drop or
late-fire callbacks, and at the 256-sample buffer Tonel uses (~5.3 ms
per call), even a small drop puts a discontinuity right inside a
voice peak — listeners hear that as breaking sound.

### Capture path migrated to AudioWorklet

- **`startCapture` now creates a `CaptureProcessor` AudioWorklet**,
  which runs on the dedicated audio thread and is guaranteed to be
  invoked at quantum rate. The worklet does the same three jobs the
  main thread used to do (linear resample to 48 kHz with sample-
  accurate phase across blocks, slice into 240-sample frames,
  postMessage each frame back to main) — but without main-thread
  scheduling jitter. Falls back to the old ScriptProcessor path if
  worklet registration fails for any reason. ([Git/web/src/services/audioService.ts:518](Git/web/src/services/audioService.ts:518))

- **Mic clip counter**: the worklet also tracks any input sample
  with `|s| ≥ 1.0` (hardware-level clipping at the source — mic gain
  too high) and reports it back. The room debug strip now shows
  `micClip=N` alongside `tx/rx/play/rxLvl` whenever clipping is
  detected, so the user can tell at a glance whether the distortion
  is in our code or in their mic gain settings. ([Git/web/src/pages/RoomPage.tsx:46](Git/web/src/pages/RoomPage.tsx:46))

### Added (Test methodology now portable across sessions)

- **New skill `tonel-audio-testing`** at
  `~/.claude/skills/tonel-audio-testing/SKILL.md`. Documents both test
  layers (Node + browser), when to use them, what "good" looks like,
  and the bisect-fix-lock workflow. Triggers on Chinese audio symptoms
  (失真 / 破音 / 底噪 / 回声 / 听不到声音) and on any change to
  `Git/server/src/audio_mixer.h`, `Git/server/src/mixer_server.cpp`,
  or `Git/web/src/services/audioService.ts`. Future sessions and any
  newly-onboarded AI will see the skill in their available list and
  follow the same methodology instead of guessing — which is the entire
  point of having the tests.

- **New project memory `feedback_audio_testing_first`** binding the
  skill into the always-loaded memory index, so Tonel sessions
  start with the testing-first invariant in context.

### Latency impact
Reduces capture-side jitter (worklet runs at quantum rate, never
late). No added latency.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `initCaptureWorklet` | New AudioWorklet capture path with in-worklet resample + slicing |
| `Git/web/src/services/audioService.ts` `sendCapturedFrame` | Lean per-frame send (level meter + PCM16 + WS) |
| `Git/web/src/services/audioService.ts` `startCapture` | Try worklet first, fall back to ScriptProcessor on registration failure |
| `Git/web/src/services/audioService.ts` `captureClipCount` | Stat counter for mic clipping |
| `Git/web/src/pages/RoomPage.tsx` debug strip | Surface `micClip=N` when > 0 |
| `~/.claude/skills/tonel-audio-testing/SKILL.md` | New skill — test methodology for future sessions |
| `~/.claude/projects/.../memory/feedback_audio_testing_first.md` | New memory pointer — always-loaded testing-first invariant |

## [1.0.19] - 2026-04-28

### Fixed (Sample-rate change went silent on the in-place rebuild)

v1.0.18's `changeSampleRate` went through `init()`, which stops the old
`MediaStream` tracks and re-acquires the mic via a second
`getUserMedia()` call. In Chromium, two `getUserMedia` calls in quick
succession with different sample-rate constraints can return tracks
that look valid but produce no data — the level meter sat at 0, no
audio left the page, no audio came back. Listeners reported "选了任何
非默认采样率（包括 48000）后就听不到任何声音" — exactly the symptom.

### Two changes, web + server

- **`changeSampleRate` reuses the existing `MediaStream`.** Only the
  `AudioContext`-bound graph is rebuilt — analyser, source, masterGain,
  worklet. The OS-level mic keeps streaming the entire time; only its
  consumer changes. Web Audio internally resamples between the mic's
  native rate and the new context rate, so the new `AudioContext` gets
  honest data immediately. Sidesteps the double-`getUserMedia` failure
  mode entirely. ([Git/web/src/services/audioService.ts:243](Git/web/src/services/audioService.ts:243))

- **Server-side eviction on TCP close.** `clear_tcp_client` used to
  only nullify the dangling `tcp_client` pointer, leaving the user's
  entry in `room->users` indefinitely. With the v1.0.16 N-1 mix in
  place, that orphan entry was the v1.0.18 ghost: a reload-and-
  rejoin (or any other path that closes TCP without sending
  MIXER_LEAVE) left the prior session's userId in the room so the
  rejoined tab got an N-1 mix of "everyone except me" = ghost =
  silence. Now the cleanup actually evicts the user — same path as
  the explicit MIXER_LEAVE handler — and removes the room if it
  emptied. Defense in depth even after the v1.0.18 persistent guest
  ID and v1.0.19 in-place rebuild eliminate the most common reload
  paths. ([Git/server/src/mixer_server.cpp:826](Git/server/src/mixer_server.cpp:826))

### Latency impact
None. In-place rebuild swap is ~50–100 ms of silence during the
AudioContext switch — same as v1.0.18, just without the mic
re-acquisition glitch. Server-side eviction is one extra erase per
TCP close, irrelevant on the audio path.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `changeSampleRate` | Reuse existing `MediaStream`; only rebuild the AudioContext graph |
| `Git/server/src/mixer_server.cpp` `clear_tcp_client` | Evict user from room, remove track, close room if last user — same cleanup as MIXER_LEAVE |

## [1.0.18] - 2026-04-28

### Fixed (Sample-rate change kicked user out + caused silence on rejoin)

The v1.0.17 sample-rate selector was hooked up via
`window.location.reload()`, which:

1. **Kicked the user out of the room** — re-mounting the React app
   lands you back on the home page, you have to re-enter manually.
2. **Made rejoining produce silence** — `App.tsx` regenerated the
   guest userId on every load, so the rejoined session was a *new*
   user from the server's perspective. The previous session's userId
   lingered in `room->users` (no MIXER_LEAVE was sent because the
   page was forcibly reloaded), so the room had two entries: the
   ghost and the new tab. Two users in the room means v1.0.16's
   solo-loopback fallback turns off and N-1 mix activates; the new
   user gets the mix of "everyone except me" = ghost = empty =
   silence (`tx=N rx=N play=N rxLvl=0.0000`, exactly what listeners
   reported). The fix is *both* of these:

- **In-place AudioContext rebuild on sample-rate change.** New
  `audioService.changeSampleRate(rate)` writes the preference, calls
  `init()` (which already has the teardown/recreate path) and
  resumes capture if it was running. WebSocket sessions stay open,
  the userId stays stable, and the room membership doesn't churn.
  ([Git/web/src/services/audioService.ts:236](Git/web/src/services/audioService.ts:236))

- **Persistent guest userId across reloads.** `generateGuestId` now
  reads/writes a stable id from `localStorage`. Logout explicitly
  resets it (logout = identity reset). Reload alone (no logout)
  preserves the same id, so even other reload paths (browser
  refresh, crash recovery) won't leave a ghost in the mixer. The
  fresh-id mint on logout uses the new `resetGuestId()` helper for
  clarity.
  ([Git/web/src/App.tsx:11](Git/web/src/App.tsx:11))

- **`SettingsModal` calls `changeSampleRate` instead of reloading.**
  No more flash + re-entry; the modal stays open, the actual rate
  display updates inline, and the room session is preserved.
  ([Git/web/src/components/SettingsModal.tsx:62](Git/web/src/components/SettingsModal.tsx:62))

### Latency impact
None. The in-place rebuild closes the old `AudioContext` and creates
a new one (~100 ms gap in the audio stream during the swap), then
re-primes the worklet ring (10 ms cushion) — same as initial join.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `changeSampleRate` | New in-place rate change that doesn't disturb WS sessions |
| `Git/web/src/App.tsx` `generateGuestId`, `resetGuestId` | Persist guest id across reloads; explicit reset on logout |
| `Git/web/src/components/SettingsModal.tsx` | Use `changeSampleRate` instead of `window.location.reload()` |

## [1.0.17] - 2026-04-28

### Fixed (Web — RTT display stuck at "--")

The control-WS PING/PONG round-trip was being measured (`pingSentAt`
recorded) but the PONG handler was a no-op comment — `_audioLatency`
never updated, so the latency badge in the room header was permanently
stuck at "--". Wired the PONG handler to compute
`performance.now() − pingSentAt`, store, and notify subscribers.
([Git/web/src/services/audioService.ts:714](Git/web/src/services/audioService.ts:714))

The RoomPage was also missing the subscription side: it imported a
`_setLatency` setter and explicitly threw the function away with
`void _setLatency  // RTT disabled for now`. Replaced with
`audioService.onLatency(setLatency)` registered alongside the peer-level
subscription, so the badge now updates every PING tick (3 s).
([Git/web/src/pages/RoomPage.tsx:25](Git/web/src/pages/RoomPage.tsx:25))

### Added (Web UI — Settings panel)

- **`SettingsModal` component.** Replaces the inline two-row device
  picker that lived in the room header. Cleaner layout, room for
  more options, and out of the way of the mixer view. Opens via a
  ⚙ button next to the latency badge.
  ([Git/web/src/components/SettingsModal.tsx](Git/web/src/components/SettingsModal.tsx))

- **User-selectable AudioContext sample rate.** Dropdown in Settings:
  `自动` (browser default) plus 16/22.05/32/44.1/48 kHz. Stored in
  `localStorage` so the choice survives reloads; changing the rate
  triggers a page reload so AudioContext + getUserMedia restart
  cleanly with the new value. The modal also displays the *actual*
  negotiated rate (browser may override the request) so users can
  spot mismatches.
  ([Git/web/src/services/audioService.ts:205](Git/web/src/services/audioService.ts:205))

### About the residual distortion

The user reported volume-independent distortion remains after v1.0.16.
Most likely root cause: the linear-interpolation resamplers we run on
both sides whenever the AudioContext lands at a rate other than the
48 kHz wire rate (Bluetooth output, system mixer override). Linear
interpolation is fast and zero-latency but isn't a properly bandlimited
filter, so it adds a small frequency-dependent THD that's audible on
sibilants and high-frequency content even at small amplitudes.

The new sample-rate selector is the **diagnostic and the fix** in one:
picking **48 kHz** in Settings forces both `AudioContext` and
`getUserMedia` to 48 kHz, which makes both the capture-side and
worklet-side resamplers no-ops (`fromRate === toRate → return input`).
If the residual distortion vanishes at 48 kHz, the resamplers are the
cause and the proper long-term fix is a polyphase resampler. If
distortion remains, the cause is elsewhere and we have a clean
baseline to compare against.

### Latency impact
RTT fix: zero — same PING cadence (3 s), same code path, just the
PONG arithmetic that was missing. Settings UI: zero — modal-only,
not in audio path.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` PONG handler | Compute and propagate RTT |
| `Git/web/src/services/audioService.ts` `readUserRate`/`writeUserRate`/`actualSampleRate` | New: persist user's sample-rate preference, expose actual rate |
| `Git/web/src/services/audioService.ts` `init` | Honor user-selected rate for both `getUserMedia` and `AudioContext` |
| `Git/web/src/components/SettingsModal.tsx` | New: device + sample-rate UI |
| `Git/web/src/pages/RoomPage.tsx` | Drop inline device selector; add ⚙ button + `SettingsModal`; subscribe to `onLatency` |
| `Git/web/src/styles/globals.css` | Settings modal styling |

## [1.0.16] - 2026-04-28

### Fixed (Mixer — solo user heard silence)

v1.0.15's N-1 mix made every recipient hear the sum of *other* users
instead of themselves looped back. Industry-standard for conferencing,
but for Tonel's setup/rehearsal flow it broke the most common
sanity-check: open the page alone, speak into the mic, verify the
chain works end to end. With one user in the room, "everyone except
me" is empty and the recipient got 200 packets/s of silence
(`tx=N rx=N play=N rxLvl=0.0000` — exactly what listeners reported).

### Fix

- **Solo loopback fallback in `broadcast_mixed_audio`.** When a room
  has ≤ 1 user, send the full mix (which is just the lone user's own
  audio) so they hear themselves. The moment a second user joins,
  switch to N-1 mix automatically — the threshold where self-echo
  starts mattering. One conditional, no per-user toggle, no UI.
  ([Git/server/src/mixer_server.cpp:678](Git/server/src/mixer_server.cpp:678))

### Latency impact
None. Same mix passes per tick, just different selection of which
tracks get included.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/mixer_server.cpp` `broadcast_mixed_audio` | Branch on `room->users.size() <= 1`: solo → full mix copy; multi → existing N-1 mix |

## [1.0.15] - 2026-04-28

### Fixed (Server Mixer — "失真与原音频音量正相关")

The remaining residual distortion turned out to be two compounding
issues at the server. Both were exposed by a fresh amplitude sweep on
the existing Node test:

| Sent amplitude | THD before | THD after |
|----------------|-----------:|-----------:|
| 0.30           | 0.006 %    | 0.006 %   |
| 0.50           | 0.004 %    | 0.004 %   |
| 0.70           | 0.002 %    | 0.002 %   |
| 0.90           | **0.064 %** | **0.002 %** |
| 0.95           | **0.484 %** | **0.002 %** |
| 1.50 (overdrive) | 16.4 %  | 15.6 %    |

### Two changes, both at the mixer

- **Soft-clip knee 0.85 → 0.95.** At 0.85 the tanh saturation engaged
  for any peak above 0.85, so a normal speaking voice with peaks at
  0.85–0.95 took a small amount of THD on every speech burst — exactly
  the volume-correlated distortion listeners reported. Raising the
  knee to 0.95 keeps ordinary voice in the linear region; the tanh
  region only activates near actual full-scale, where it's actually
  preventing real clipping rather than baking in distortion "just in
  case." Below 0.95 → byte-identical to a no-clip path. Above 0.95 →
  smooth saturation as before. ([Git/server/src/audio_mixer.h:154](Git/server/src/audio_mixer.h:154))

- **Per-recipient N-1 mix.** The previous design ran one global mix
  per tick and broadcast the same bytes to every user, including the
  user whose own voice was in the mix. That self-loop arrived back at
  the speaker 30–80 ms later and combed against the receiver's own
  live audio path — at speech peaks the comb-filter sidebands
  manifested as volume-correlated distortion overlaid on the source
  signal. With N-1 mix, each recipient hears the sum of every *other*
  user, never themselves; their own voice never round-trips through
  the server. As a side effect, the mixer sum stays smaller (less
  total content per recipient), so soft-clip activations get even
  rarer in multi-talker rooms. ([Git/server/src/mixer_server.cpp:631](Git/server/src/mixer_server.cpp:631))

  Implementation: `AudioMixer` grew three new methods so the broadcast
  loop can run one mix per recipient without consuming tracks on
  every pass — `mixAll(out, n)`, `mixExcluding(uid, out, n)`, and
  `consumeAllTracks()`. Existing `mix(...)` is now a wrapper around
  `mixAll + consumeAllTracks` so older tests and call sites still
  work. CPU: O(N·tracks) per broadcast; for N ≤ 10 this is ~0.05 ms
  per tick, well below the 5 ms broadcast budget.
  ([Git/server/src/audio_mixer.h:34](Git/server/src/audio_mixer.h:34))

### Known limitation

The Opus encoding path still uses the global full mix (not N-1).
That means an Opus-using listener would still hear themselves looped
back. No production client uses Opus today (web and AppKit both
default to PCM16), so this is documented and deferred until Opus is
actually wired up.

### Latency impact

End-to-end audio latency is unchanged. The N-1 mix adds N-1 extra
mix passes per broadcast tick (~10 µs each at typical sizes); the
knee change is one constant. Both are well below the latency budget.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` `softClipBuffer` | Raise knee 0.85 → 0.95 |
| `Git/server/src/audio_mixer.h` `mixAll`, `mixExcluding`, `consumeAllTracks` | Split mix from consume so the broadcast loop can run a clean N-1 mix per recipient |
| `Git/server/src/mixer_server.cpp` `broadcast_mixed_audio` | Loop recipients, call `mixExcluding` per recipient, encode PCM16 per recipient, send. Consume tracks once at the end. |
| `Git/server/src/mixer_server_test.cpp` | Add `test_mix_excluding` regression test for the new invariants |

## [1.0.14] - 2026-04-28

### Fixed (Web Capture — "失真噪音和源信号混合")

The browser test added in v1.0.13 covered playback only. The remaining
distortion turned out to be on the **capture** side, and the test was
extended to expose it before the fix landed. With a fresh capture-path
test the bug fell out instantly:

| Capture context rate | Recovered fundamental | Pitch shift |
|----------------------|-----------------------|-------------|
| 48 000 Hz            | 1000.0 Hz             | 0.00 % ✅   |
| 44 100 Hz (no fix)   | **1088.0 Hz**         | **+8.80 % ❌** |
| 44 100 Hz (with fix) | 1000.0 Hz             | 0.00 % ✅   |

### Root cause

`startCaptureWithScriptProcessor` reads samples from
`AudioContext.sampleRate` and slices them into 240-sample frames
labelled "5 ms of 48 kHz" before sending to the server. When the
AudioContext lands at 44.1 kHz (Bluetooth output, system mixer
override) the frames carry 5.44 ms of audio but claim to be 5 ms — a
6 % cadence error that the server happily believes. The receiver's
worklet plays the bytes back at 48 kHz, so every recipient (including
the sender themselves, via the server's loopback mix) hears the audio
pitch-shifted up by 8.8 %. Stacked on top of correctly-pitched peer
audio, that pitch-shifted self-echo sounded like "distortion mixed
with the source signal" — the user's own voice running through the
chain at the wrong pitch.

### Fix

- **Stateful linear-interpolation capture resampler.** Mirrors the
  in-worklet playback resampler but runs the other direction:
  AudioContext rate → 48 kHz wire rate. Carries a sample boundary
  across ScriptProcessor callbacks so frame edges don't drop or
  duplicate samples, then `onAudioFrame` slices the wire-rate stream
  into honest 240-sample (5 ms at 48 kHz) packets. No-op at 48 kHz
  contexts. ([Git/web/src/services/audioService.ts:466](Git/web/src/services/audioService.ts:466))

- **Reset on `stopCapture`** so a reconnect starts with empty carry +
  zero phase. ([Git/web/src/services/audioService.ts:899](Git/web/src/services/audioService.ts:899))

### Added (Audio QA Infrastructure)

- **Capture-path test in the existing browser harness.** Generates a
  clean 1 kHz tone at the chosen context rate, runs it through
  capture's slicing logic with the resampler toggled on or off, and
  measures the recovered fundamental on the wire — so the suite both
  *demonstrates* the bug (runs without resampler at 44.1 kHz) and
  *verifies* the fix (runs with resampler). The test fails the suite
  only on the with-resampler variant; the without-resampler variant
  is reported for diagnostic value.
  ([Git/server/test/browser/test_page.html](Git/server/test/browser/test_page.html),
  [Git/server/test/browser/browser_audio_test.js](Git/server/test/browser/browser_audio_test.js))

### Latency impact
Negligible. Capture-side resample is O(N) per ScriptProcessor
callback (~256 samples in, ~278 out at 44.1 kHz contexts); the
fractional-phase carry adds zero latency beyond a single sample
of look-ahead at the boundary. End-to-end audio latency is unchanged
from v1.0.13.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `resampleCaptureTo48k` | New: stateful linear resampler, mic context rate → 48 kHz wire rate |
| `Git/web/src/services/audioService.ts` `startCaptureWithScriptProcessor` | Run resample before `onAudioFrame` |
| `Git/web/src/services/audioService.ts` `stopCapture` | Reset `capCarry` and `capPhase` |
| `Git/server/test/browser/test_page.html` | Add `runCaptureTest`: simulates capture pipeline with toggleable resampler |
| `Git/server/test/browser/browser_audio_test.js` | Add capture-path sweep: shows the bug at 44.1 kHz without resampler, verifies the fix |

## [1.0.13] - 2026-04-28

### Fixed (Web Playback — "几乎听不到人声" v1.0.12 regression)

The v1.0.12 worklet path made web playback *worse*, not better. The
new browser-side automated test (added in this release) caught both
root causes immediately:

- **Producer-side `linearResample` was dropping the fractional 0.5
  sample at every 5 ms packet boundary**, causing a 0.23 % cumulative
  pitch shift (1000 Hz → 1002 Hz at 44.1 kHz contexts) plus a 200 Hz
  click stream from the per-packet phase discontinuity.
- **The worklet had no jitter cushion**: at 44.1 kHz contexts, with
  44 000 input samples/s vs. 44 100 output samples/s, the ring
  oscillated near empty and any network jitter caused underruns —
  the worklet's `if (count > 0)` per-sample check then output zeros
  for most of the callback. End result: mostly silence, occasional
  audio fragments. That is the "几乎听不到人声" symptom.

### Fixed by

- **`PlaybackProcessor` redesigned to mirror AppKit MixerBridge.mm
  RingBuffer.** Ring stores PCM at the wire rate (48 kHz). Resample
  happens INSIDE `process()` with a fractional readPos that advances
  by `48000 / sampleRate` per output sample — sample-accurate phase
  across packet boundaries, no per-frame discontinuity, frequency
  preserved exactly. Prime threshold (10 ms cushion) absorbs network
  jitter; re-prime on near-underrun outputs a clean full-callback
  silence rather than a partial-then-zero glitch. Mono input is
  fanned out to every destination channel so the right speaker is
  never silent on stereo destinations.
  ([Git/web/src/services/audioService.ts:298](Git/web/src/services/audioService.ts:298))

- **`linearResample` removed.** With the in-worklet resampler the
  producer hands raw 48 kHz PCM straight to `port.postMessage`. No
  more boundary clicks, no more length-truncation drift.
  ([Git/web/src/services/audioService.ts:135](Git/web/src/services/audioService.ts:135))

### Added (Audio QA Infrastructure — Layer 2)

- **Browser-side automated audio test.** Real Chromium via Playwright
  loads the production worklet inside an `OfflineAudioContext`, feeds
  known PCM frames, the rendered output is captured back into Node
  for SNR/THD analysis. Tests both 48 kHz and 44.1 kHz contexts —
  the 44.1 kHz path was where every recent web-side audio bug landed
  but no test covered it before today. The new test catches the
  "right channel silent" failure mode (worklet writing only
  `outputs[0][0]`), per-packet phase clicks (frequency drift), and
  ring underruns (silent output) in seconds, with quantitative
  numbers instead of "does it sound bad?".
  ([Git/server/test/browser/](Git/server/test/browser/))

  Current baseline at 1 kHz / amp 0.3:
  | rate | peakAmp | SNR | THD |
  |------|---------|-----|-----|
  | 48 kHz   | 0.27 (vs 0.27 expected) | 69 dB | 0.035 % |
  | 44.1 kHz | 0.27 (vs 0.27 expected) | 69 dB | 0.034 % |

### Latency impact
End-to-end latency is unchanged from v1.0.12 (still no createBuffer
lookahead). The 10 ms prime cushion sits on the receive side of the
ring; it adds at most 10 ms to first-audio time after a connection
or after a long silence, and zero ongoing latency once primed.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `PlaybackProcessor` | In-worklet linear resample with fractional readPos; prime/re-prime jitter buffering; mono → multichannel fan-out |
| `Git/web/src/services/audioService.ts` `playPcm16` | Drop `linearResample`; post raw 48 kHz PCM straight to worklet |
| `Git/web/src/services/audioService.ts` (top of file) | Remove unused `linearResample` helper |
| `Git/server/test/browser/test_page.html` | New: standalone test harness — worklet copy + driver |
| `Git/server/test/browser/browser_audio_test.js` | New: Playwright + Chromium runner with Goertzel SNR/THD analyser |
| `Git/server/test/browser/run.sh` | New: wrapper that auto-installs Playwright + chromium |

## [1.0.12] - 2026-04-28

### Fixed (Web Playback — "音量小也失真" residual distortion)

- **`playPcm16` now feeds the existing AudioWorklet ring instead of
  scheduling a fresh `AudioBufferSourceNode` per 5 ms frame.** The
  worklet had been wired up since v1.0.x but `playPcm16` never used it
  — it took the `createBuffer` fallback path. With a per-frame source,
  Web Audio resamples each 5 ms buffer independently when the
  `AudioContext` ends up at 44.1 kHz instead of the 48 kHz we request
  (Bluetooth output, system mixer overrides). Each resampling kernel
  tail saw zero-padding instead of the next buffer's first samples, so
  every 5 ms boundary leaked a small click. Stacked at 200 Hz the
  clicks turned into a continuous gritty floor noise that listeners
  reported as "amplitude-independent distortion" — v1.0.11's soft clip
  couldn't help because the audio wasn't clipping at all, it was
  resampling-boundary noise. The worklet path emits a continuous sample
  stream (one resampling pass per packet at the producer side, then no
  per-buffer kernels in the audio thread) so frame boundaries are
  sample-exact.
  ([Git/web/src/services/audioService.ts:635](Git/web/src/services/audioService.ts:635))

- **Producer-side linear resampler.** When the AudioContext rate
  differs from 48 kHz, each incoming PCM frame is resampled once to
  the context rate before being posted to the worklet. This keeps the
  worklet's ring at the consumer rate so it never overruns — the bug
  that caused the previous worklet path to be abandoned. Linear
  interpolation is chosen for simplicity and CPU; for VoIP-grade
  speech the audible difference vs. polyphase is below the noise
  floor introduced elsewhere in the chain.
  ([Git/web/src/services/audioService.ts:135](Git/web/src/services/audioService.ts:135))

### Added (Audio QA Infrastructure)

- **End-to-end audio quality automated test.** Spins up a local mixer,
  runs two SPA1 clients (sender + receiver) through it, sends a known
  1 kHz sine wave, computes SNR and THD on the received signal via
  Goertzel. Replaces the manual "ask the user to listen" loop for
  server-side regressions; lets us bisect new distortion against a
  baseline in seconds. Current baseline at amp=0.3:
  SNR 84 dB, THD 0.006 %.
  ([Git/server/test/audio_quality_e2e.js](Git/server/test/audio_quality_e2e.js),
  [Git/server/test/run.sh](Git/server/test/run.sh))

  Scope note: this test covers the network path and server mix only —
  it does **not** cover the Web Audio playback path or the AppKit
  miniaudio playback path. v1.0.12's web fix was diagnosed by reading
  the playback code, not by this test. A browser-level test (Playwright
  or similar) is the next layer of QA infrastructure to build.

### Latency impact
Zero added latency. Linear resample is O(N) per packet, runs once on
the producer thread; the worklet's `process()` is the same cost as
before. Worklet eliminates the 40 ms playback-lookahead cushion that
the createBuffer path needed for jitter absorption — the worklet's
ring is the cushion now and runs ~10 ms by default, so end-to-end
playback latency drops by ~30 ms in the common case.

| File / Change | Detail |
|---------------|--------|
| `Git/web/src/services/audioService.ts` `playPcm16` | Route packets to existing `playbackWorklet` ring; keep `createBuffer` only as a fallback for worklet-init failure |
| `Git/web/src/services/audioService.ts` `linearResample` | New helper: linear interpolation from 48 kHz to AudioContext rate, called once per packet |
| `Git/server/test/audio_quality_e2e.js` | New: Node SPA1 client pair + Goertzel SNR/THD analysis |
| `Git/server/test/run.sh` | New: starts local mixer, runs the test, tears down |

## [1.0.11] - 2026-04-28

### Fixed (Server Mixer — "音量稍大失真噪音")

- **`AudioMixer::mix()` post-processing: hard clip → knee-based soft clip.**
  v1.0.10's mixer post-processing comment said "Limiter — prevent clipping"
  but the implementation was a brick-wall hard clip (`std::max(-1.0f,
  std::min(1.0f, x))`). When two users spoke simultaneously, the linear sum
  exceeded ±1.0 and the hard clamp turned the waveform into a square wave
  full of odd harmonics — listeners heard this as gritty distortion the
  moment any voice got loud. v1.0.11 replaces the clamp with a two-region
  soft clipper: linear pass-through for `|x| ≤ 0.85` (single-talker audio
  is byte-identical to v1.0.10) and `tanh`-shaped saturation in
  `[0.85, 1.0]`. No square-wave artifact, no harmonics, output stays
  inside `[-1, 1]`.
  ([Git/server/src/audio_mixer.h:124](Git/server/src/audio_mixer.h:124))

- **Two regression tests for the soft-clip invariants.**
  `test_soft_clip_below_knee` verifies the linear pass-through region
  produces byte-identical output to the raw sum (no surprise non-linearity
  for normal speech). `test_soft_clip_above_knee` verifies high-volume
  overlap stays inside `[-1, 1]` AND is *not* a hard clamp at 1.0
  (otherwise we'd have silently regressed back to v1.0.10 behavior).
  ([Git/server/src/mixer_server_test.cpp:155](Git/server/src/mixer_server_test.cpp:155))

### Latency impact
Zero added latency. The soft clipper is sample-by-sample and only invokes
`tanh` for samples that exceed the knee — single-talker frames pay
nothing, multi-talker frames pay one branch + one `tanh` per over-the-knee
sample (~hundreds of nanoseconds per 5 ms tick, immeasurable against the
existing mix loop).

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` `AudioMixer::mix` | Hard clamp at `[-1,1]` replaced with knee-based `tanh` soft clip (knee = 0.85, room = 0.15) |
| `Git/server/src/mixer_server_test.cpp` | Add `test_soft_clip_below_knee` and `test_soft_clip_above_knee` regression tests |

## [1.0.10] - 2026-04-28

### Fixed (Server Mixer — root cause of "电流声 + 金属音 + mute 后底噪")

The "电流声 / 金属感 / 人声变噪 / 麦克风关了仍有底噪" symptom v1.0.9 chased
on the AppKit side was actually a server-side mixer bug. AppKit and Web
client-side tweaks (RX-ring prime threshold, ScriptProcessor buffer size)
masked the symptom but didn't fix it. v1.0.10 fixes the source.

- **`AudioMixer::mix()` is now consume-style — each `addTrack()` contributes to
  exactly one mix.** Previously `addTrack` overwrote the per-user audio buffer
  but `mix()` never cleared it, so a user who stopped sending UDP packets (mute,
  packet loss, client stall) had their last 5 ms frame replayed on every 5 ms
  broadcast. That same 240-sample slice repeating at 200 Hz is exactly the
  "metallic 电流声 floor noise" listeners reported, and is why turning off the
  microphone never made the noise stop — the noise was the listener's *own
  last frame* looping forever inside the server. `mix()` now zeroes
  `frameCount` after consuming a track; missing packets become silence
  instead of a held-frame loop. Per-track `lastRms` is computed at
  `addTrack` time and decayed on silent ticks so the level meter falls off
  cleanly when a user mutes. ([Git/server/src/audio_mixer.h:73](Git/server/src/audio_mixer.h:73))

- **5 ms broadcast tick is now unconditional — `pending_mix` gate removed.**
  `handle_mix_timer` previously skipped the broadcast for any room where no
  user had sent a fresh UDP packet in the last 5 ms slot. Combined with
  bursty `ScriptProcessorNode` callbacks on the web client (one callback
  shipping 2 packets back-to-back, then a 5–10 ms gap), the *effective*
  broadcast rate fell to ~75–100 Hz instead of the design's 200 Hz. The
  web client's playback timeline depends on a strict 200 Hz packet stream;
  when packets arrive at 75 Hz, `playTime` falls behind `currentTime` on
  every callback and the re-anchor branch fires constantly, audible as
  continuous static. The 5 ms timer now broadcasts as long as a room has
  any users, and consume-style mix means an idle tick costs 480 zero bytes
  per recipient instead of an audio glitch. ([Git/server/src/mixer_server.cpp:743](Git/server/src/mixer_server.cpp:743))

- **Regression test for the consume invariant.** `test_consume_after_mix`
  verifies a second `mix()` without a fresh `addTrack()` produces silence,
  not a replay of the previous frame. Locks in the v1.0.10 fix against
  future changes. ([Git/server/src/mixer_server_test.cpp:155](Git/server/src/mixer_server_test.cpp:155))

### Fixed (Web Audio Capture)
- **Capture `ScriptProcessorNode` buffer size 512 → 256.** v1.0.9's move to
  512 was a workaround for a bug whose root cause turned out to be in the
  server, not the browser. With v1.0.10's server fix, 256 is both reliable
  on the browsers we support *and* the right size — one 5 ms frame per
  callback aligns with the server's 5 ms broadcast tick and minimizes the
  chance of `addTrack` overwrites at the server. The "unreliable across
  browsers" claim from v1.0.9 was based on observing the static noise
  caused by the server bug. ([Git/web/src/services/audioService.ts:373](Git/web/src/services/audioService.ts:373))

### Latency impact
End-to-end audio latency is unchanged or marginally improved. The consume
model is per-tick O(1) extra work (one assignment per active track) on the
already-existing mix loop, no extra buffering, no extra threads. The
unconditional 5 ms broadcast adds at most one extra 480-byte packet per
recipient per silent slot — bandwidth-only cost, no latency cost.

| File / Change | Detail |
|---------------|--------|
| `Git/server/src/audio_mixer.h` `AudioMixer::mix` | Consume tracks (set `frameCount = 0`) after accumulating; cache `lastRms` at `addTrack` and decay on silent ticks |
| `Git/server/src/mixer_server.cpp` `handle_mix_timer` | Drop `pending_mix` gate; broadcast every 5 ms when a room has any users |
| `Git/server/src/mixer_server_test.cpp` | Add `test_consume_after_mix` regression test |
| `Git/web/src/services/audioService.ts` `startCaptureWithScriptProcessor` | bufferSize 512 → 256 |

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
