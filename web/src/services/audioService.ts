/**
 * audioService.ts — S1 Web Audio Client
 *
 * Implements:
 *   1. Audio capture via AudioWorklet (fallback ScriptProcessorNode)
 *   2. PCM16 SPA1 packet assembly & WebSocket send
 *   3. SPA1 packet receive → PCM16 decode → Web Audio API playback
 *   4. MIXER_JOIN handshake with the mixer TCP server (via /mixer-tcp WebSocket)
 *   5. Audio relay via /mixer-udp WebSocket (→ proxy → UDP 9003)
 */


// ─────────────────────────────────────────────────────────────────────────────
// SPA1 Packet Constants  (server expects big-endian, 44-byte header)
// ─────────────────────────────────────────────────────────────────────────────

// Magic: 'SPA1' as big-endian uint32 = 0x53415031
const SPA1_MAGIC         = 0x53415031
const SPA1_HEADER_SIZE   = 76   // bytes before audio data (P1-1: userId 64 bytes)
const SPA1_CODEC_PCM16   = 0
const SPA1_CODEC_OPUS    = 1
const SPA1_CODEC_HANDSHAKE = 0xFF  // special codec for UDP address registration

const SAMPLE_RATE = 48000
const CHANNELS    = 1

// Frame size: 2.5 ms of audio for lower latency.
// Phase B v4.2.0: halved from 5 ms (240) to 2.5 ms (120). Saves
// ~2.5 ms of capture-side buffering. Server-side mix tick was halved
// to match (mixer_server.h MIX_INTERVAL_US = 2500). Combined with
// the matching server tick, total e2e win is ~5 ms. Cost: packet
// rate 200 → 400 fps; native AppKit clients (which assume 240) need
// a corresponding update — see CHANGELOG v4.2.0.
const FRAME_MS      = 2.5
const FRAME_SAMPLES = Math.floor(SAMPLE_RATE * FRAME_MS / 1000)  // 120 samples @ 48kHz

// ─────────────────────────────────────────────────────────────────────────────
// SPA1 Packet Builder  (matches server's SPA1Packet struct)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a SPA1 packet in the format the server expects:
 *  - magic:     u32 BE  (0x53415031)
 *  - sequence:  u16 BE
 *  - timestamp: u16 BE  (100ms units on server side)
 *  - userId:    char[64] (room_id:user_id, null-terminated) [P1-1]
 *  - codec:     u8
 *  - dataSize:  u16 BE
 *  - reserved:  u8
 *  - data:      audio payload
 */
function buildSpa1Packet(
  data: Uint8Array,
  codec: number,
  sequence: number,
  timestamp: number,
  userId: string
): ArrayBuffer {
  const totalSize = SPA1_HEADER_SIZE + data.byteLength
  const buf  = new ArrayBuffer(totalSize)
  const view = new DataView(buf)
  const u8   = new Uint8Array(buf)

  // magic (BE)
  view.setUint32(0, SPA1_MAGIC, false)
  // sequence (BE, u16)
  view.setUint16(4, sequence & 0xFFFF, false)
  // timestamp (BE, u16) — server uses 100ms units
  view.setUint16(6, timestamp & 0xFFFF, false)
  // userId (64 bytes, "room_id:user_id" format, null-terminated) [P1-1]
  const uidStr = `${userId}`
  for (let i = 0; i < 64; i++) {
    u8[8 + i] = i < uidStr.length ? uidStr.charCodeAt(i) : 0
  }
  // codec (u8)
  u8[72] = codec
  // dataSize (BE, u16) — audio data byte length
  view.setUint16(73, data.byteLength, false)
  // reserved
  u8[75] = 0
  // audio payload
  u8.set(data, SPA1_HEADER_SIZE)

  return buf
}

// ─────────────────────────────────────────────────────────────────────────────
// SPA1 Header Parser
// ─────────────────────────────────────────────────────────────────────────────

// P0-4 fix: Maximum allowed dataSize to prevent memory overflow
const MAX_DATA_SIZE = 1356  // Matches server's MAX_PAYLOAD_SIZE

function parseSpa1Header(buf: ArrayBuffer): {
  sequence: number; timestamp: number; userId: string;
  codec: number; dataSize: number;
} | null {
  if (buf.byteLength < SPA1_HEADER_SIZE) return null
  const view = new DataView(buf)
  const u8   = new Uint8Array(buf)

  const magic = view.getUint32(0, false)  // BE
  if (magic !== SPA1_MAGIC) return null

  // Layout matches mixer_server.h: userId is 64 bytes at offset 8-71 [P1-1]
  const sequence  = view.getUint16(4, false)
  const timestamp = view.getUint16(6, false)
  const userId = String.fromCharCode(...u8.slice(8, 72)).replace(/\0.*$/, '')
  const codec    = u8[72]
  const dataSize = view.getUint16(73, false)

  // P0-4 fix: Validate dataSize to prevent memory overflow attacks
  if (dataSize > MAX_DATA_SIZE) {
    console.warn('[Audio] SPA1 dataSize exceeds limit:', dataSize)
    return null
  }

  return { sequence, timestamp, userId, codec, dataSize }
}

function parseSpa1Body(buf: ArrayBuffer, dataSize?: number): Uint8Array {
  if (dataSize !== undefined) {
    return new Uint8Array(buf, SPA1_HEADER_SIZE, dataSize)
  }
  return new Uint8Array(buf, SPA1_HEADER_SIZE)
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM16 Codec
// ─────────────────────────────────────────────────────────────────────────────

// PCM16 codec — matches AppKit's encoding: mono * 32767, decode / 32768
function float32ToPcm16(f32: Float32Array): Uint8Array {
  const out  = new Uint8Array(f32.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    view.setInt16(i * 2, Math.round(s * 32767), true)  // LE, matches x86 server
  }
  return out
}

function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  const out = new Float32Array(pcm.length / 2)
  const dv  = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let i = 0; i < out.length; i++) {
    out[i] = dv.getInt16(i * 2, true) / 32768.0  // LE, matches AppKit decode
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioService
// ─────────────────────────────────────────────────────────────────────────────

type AudioLevelCallback = (level: number) => void
type PeerLevelCallback = (userId: string, level: number) => void

/**
 * One mic device routed through its own gain + analyser. The user can
 * have several of these — each contributes to the local input mix that
 * goes out as a single SPA1 stream. See the `inputChannels` field
 * comment in AudioService for the architecture summary.
 *
 * Public-ish: returned by `getInputChannels()` for the UI to render
 * one ChannelStrip per channel. Audio nodes are exposed read-only so
 * the UI can hook analysers for level meters without re-implementing
 * the polling.
 */
export interface InputChannel {
  /** Stable id ('ch0', 'ch1', …). Used as the React key on the strip. */
  id: string
  /** OS device id from `enumerateDevices()`. 'default' = system default
   *  (no `{exact}` constraint, lets the browser pick). */
  deviceId: string
  /** User-friendly device label, e.g. "MacBook Pro Microphone". */
  deviceLabel: string
  mediaStream: MediaStream
  source: MediaStreamAudioSourceNode
  gainNode: GainNode
  analyser: AnalyserNode
  /** Last-set unmuted user gain (0-2). Effective gainNode value is 0
   *  when muted, `userGain` otherwise. */
  userGain: number
  muted: boolean
}

export class AudioService {
  private audioContext:     AudioContext | null = null
  // Single-stream legacy aliases — populated as channel 0's mediaStream/
  // source so the existing 40+ touch-points keep working unchanged
  // through the multi-input refactor (v3.6.0). New code should reach
  // into `inputChannels[0]` instead.
  private mediaStream:       MediaStream | null = null
  private source:           MediaStreamAudioSourceNode | null = null
  private analyser:         AnalyserNode | null = null   // channel 0's analyser, kept as alias
  // levelCallback removed — UI polls currentLevel directly via RAF
  private animationFrameId: number | null = null
  private muted:            boolean = false
  public  currentLevel:     number = 0

  // ── Multi-input architecture (v3.6.0) ─────────────────────────────────────
  //
  // Each `InputChannel` is one mic device routed through a per-channel
  // gain stage and analyser. All channels' gainNode outputs converge on
  // `inputSumGain`, which is what the capture worklet (and ScriptProcessor
  // fallback) actually reads. This means a single SPA1 stream goes out,
  // carrying the *sum* of every channel — peers see the user as one
  // voice in their channel strip. Locally the user can mix their inputs
  // in whatever proportion they want via the per-strip faders.
  //
  // Cleanest semantic: input fader = "how loud does the room hear THIS
  // mic of mine." The summed result also feeds the local monitor
  // (via the existing capture-worklet → main-thread → monitor route),
  // so the user hears their own mix at the same balance.
  private inputChannels: InputChannel[] = []
  private inputSumGain: GainNode | null = null
  private nextChannelId = 0

  // WebSocket connections to mixer (via ws-proxy → ws-mixer-proxy)
  private controlWs:        WebSocket | null = null
  private audioWs:          WebSocket | null = null
  // Audio data path can also run over WebTransport (HTTP/3 datagrams)
  // — same SPA1 packet format on the wire, but UDP-style unreliable
  // unordered transport that kills the TCP HoL/burst pattern. Set
  // when WT is the active audio transport; null = WSS audio path.
  // The control channel (controlWs) stays WSS regardless — it carries
  // low-volume JSON + PING/PONG and doesn't benefit from WT.
  private audioWT:          WebTransport | null = null
  private audioWTWriter:    WritableStreamDefaultWriter<Uint8Array> | null = null
  private audioWTReader:    ReadableStreamDefaultReader<Uint8Array> | null = null
  // Reported in debug panel + tooltips so the user / engineer can see
  // which transport is active without inspecting the network panel.
  public  audioTransport:   'wt' | 'wss' | 'unknown' = 'unknown'
  private userId:           string = ''
  private roomId:           string = ''

  // Remote peer level tracking
  private peerLevelCallback: PeerLevelCallback | null = null
  private peerLevels: Map<string, number> = new Map()

  // Session takeover notification (mixer server emits SESSION_REPLACED when
  // another connection joins with the same user_id).
  private sessionReplacedCallback: (() => void) | null = null

  // Audio latency (RTT via control WebSocket PING/PONG)
  private pingTimer:        ReturnType<typeof setInterval> | null = null
  // @ts-ignore — pingSentAt used in startPing
  private pingSentAt = 0
  private _audioLatency:    number = -1
  private latencyCallbacks: Array<(ms: number) => void> = []

  // Playback (shares audioContext with capture to avoid autoplay policy issues)
  private masterGain:       GainNode | null = null

  // v3.7.7: speaker-mode (v3.7.2 → v3.7.6) reverted. The iOS
  // workaround (set `navigator.audioSession.type = 'playback'` then
  // route through MediaStreamDestination → <audio>) ended up
  // poisoning the audio session: once 'playback' was set, the next
  // getUserMedia threw `InvalidStateError: AudioSession category is
  // not compatible with audio capture`, and the only reliable
  // recovery was clearing site data + restarting Safari. The
  // category persists across page reloads in some iOS versions, so
  // a single failed toggle bricks mic acquisition for the user.
  // Rolled back per user request; the iPhone will go through the
  // earpiece when mic is active. Future revisit should NOT touch
  // navigator.audioSession.type.

  // Local monitor — `source → monitorGain → destination`. Lets the user
  // hear their own mic with ~0 ms latency (one audio quantum) instead of
  // the ~30–100 ms server round trip.
  //
  // Engagement rule: monitor is OFF when the room has ≤1 user (server's
  // solo loopback already plays the user's voice back, so adding the
  // local monitor would create a doubled echo) and ON when there are
  // ≥2 users (server runs N-1 mix → user has no server-side self-loop
  // → only the local monitor lets them hear themselves). The transition
  // tracks `peerLevels.size`, which the LEVELS broadcast updates ~20 Hz.
  //
  // Caveat — feedback: if the user is on speakers (not headphones), the
  // monitor signal plays out the speaker, mic picks it up, and goes back
  // to peers as a delayed second copy of the user's voice. Headphones
  // sidestep this. Same constraint already applied to the solo-loopback
  // path; we accept it here too.
  private monitorGain:      GainNode | null = null
  private monitorBaseGain   = 1.0   // user-adjustable via setMonitorBaseGain
  // Independent monitor mute. Separate from `muted` (which gates the mic
  // going TO peers). Letting the user mute their *own* hear without
  // muting their voice to the room is the natural meaning of a mute
  // button on the MIXER's self-strip vs the INPUT TRACKS' self-strip.
  private monitorMuted      = false
  // Pass-through worklet placed between source and monitorGain. iOS
  // Safari (and possibly other WebKit-based browsers) silently mutes any
  // path that goes `MediaStreamSource → ... → destination` if the chain
  // doesn't pass through an audio-thread node first — anti-feedback /
  // echo gating that the API doesn't expose. v3.4.3 routed monitor
  // through masterGain hoping that the extra gain stage would be
  // enough; user reported `mon=1.00` but still inaudible. The worklet
  // hop "decouples" the mic source: its inputs read mic samples, its
  // outputs are a normal worklet-produced stream that passes through
  // destination just fine. Verified by the existing playbackWorklet
  // path, which also reaches destination via masterGain without issue.
  private monitorWorklet:   AudioWorkletNode | null = null

  // Debug counters
  public rxCount = 0   // received SPA1 audio packets from server
  public txCount = 0   // sent SPA1 audio packets to server
  public playCount = 0 // packets sent to playback
  public rxLevel = 0      // RMS of last received audio (0 = silence)
  public rxLevelPeak = 0  // peak-hold of rxLevel — useful when packets alternate
                          // between speech and gaps; raw rxLevel can be 0 between
                          // syllables and mislead debugging.
  public playReprimeCount = 0   // playback worklet underrun events (every one is a click)
  public playPlcCount     = 0   // PLC concealment episodes (Phase B v4.2). Each = a brief
                                // underrun the worklet rode out by replaying lastBlock
                                // with energy decay instead of going silent. High plc
                                // with low reprime = controller doing its job; high
                                // reprime relative to plc = sustained drops PLC couldn't
                                // mask (network or server died for >10ms).
  public rxSeqGapCount    = 0   // received SPA1 packets out-of-order or missing
  public playRateScale    = 1.0 // playback worklet's adaptive rate (1.0 = nominal; ±0.5%)
  public playRingFill     = 0   // current ring fill in samples (target ~1440)
  private rxLastSeq = -1

  // ── Per-room tuning persistence ──────────────────────────────────────────
  //
  // Each (roomId, userId) pair gets its own slot in localStorage. A slider
  // tweaked in room A doesn't follow the user into room B; two devices
  // signed in as the same user keep independent tuning because each
  // device has its own localStorage. Multiple rooms simply coexist —
  // their slots are independent JSON blobs and never interact.
  //
  // Defaults aren't written. A missing slot means "no override" → the
  // server reports its own defaults via MIXER_JOIN_ACK and the worklet
  // uses the values baked into `this.tuning`. When the user changes a
  // slider, save fires (debounced); when RESET fires, we wipe the slot
  // and re-apply defaults.
  private static readonly TUNING_KEY_PREFIX = 'tonel.tuning.'
  // Bumped whenever we change a default in `tuning` / `serverTuning` that
  // would silently regress users with saved per-room overrides.
  //
  // History:
  //   v1 (implicit, pre-v4.1.1) — original v3.x defaults. Blobs from
  //     this era have NO `v` field and are discarded on load.
  //   v2 (v4.1.1) — Phase A: maxScale 1.012 → 1.025, proportional
  //     fast-adjust. Discarding v1 was needed so users got the new
  //     headroom (otherwise rateScale stayed pinned at the old rail).
  //   v3 (v4.2.0) — Phase B: primeTarget 1440 → 144 (30 ms → 3 ms),
  //     primeMin 128 → 32. Enabled by client PCM PLC.
  //   v4 (v4.2.2) — Phase B tuning correction: primeTarget 144 → 288
  //     (3 ms → 6 ms), primeMin 32 → 64. v3's 3 ms target was too
  //     aggressive for the actual server tick burst pattern — even
  //     with PLC working (v4.2.1), PLC fired 6+ times/sec sustained
  //     in real sessions, producing audible distortion (1.8% of audio
  //     was PLC-filled).
  //   v5 (v4.2.3) — Phase B tuning refinement (user-validated empirical
  //     sweet spot): primeTarget 288 → 672 (6 ms → 14 ms), primeMin
  //     64 → 16 (1.3 ms → 0.3 ms), jitterMaxDepth 8 → 13.
  //   v6 (v4.3.7) — Post-rollback re-tune (user-validated on v4.3.6
  //     after the Phase C audio-path rollback): primeTarget 672 →
  //     576 (14 ms → 12 ms), primeMin 16 → 48 (0.3 ms → 1.0 ms),
  //     jitterTarget 1 → 2 (server-side, was the v1.0.38 default),
  //     jitterMaxDepth 13 → 33. The user iterated on debug-panel
  //     sliders against v4.3.6 (= v4.2.3 audio code, no Phase C)
  //     and reported these values as both the right latency AND
  //     the right audio quality. The bigger jitterMaxDepth=33 (~83 ms
  //     server-side cap) gives the server room to absorb burst
  //     patterns without cap-drop clicks; the bigger primeMin=48
  //     trades 1 ms more PLC-trigger sensitivity for fewer
  //     ring excursions to absolute-zero (which previously could
  //     audibly snap before PLC took over).
  //
  // Schema mismatch on load → discard the stale blob, apply current
  // defaults. Memory rule (`feedback_state_migration_test`) requires
  // any future bump here to also add a Layer-6 scenario asserting the
  // discard happens correctly.
  //   v7 (v4.3.8) — primeTarget effective floor raised from 48 →
  //     primeMin+192 (one quantum + jitter cushion). Below that, every
  //     post-trim quantum mid-callback-underruns and triggers PLC
  //     replay of lastBlock; rapid panel adjustments stack PLC events
  //     into the audible "听觉上的叠加" the user reported on v4.3.7.
  //     Discard old slots so anyone who explored down to 144 in the
  //     panel doesn't carry that into v4.3.8.
  private static readonly TUNING_SCHEMA_VERSION = 7
  private tuningSaveTimer: ReturnType<typeof setTimeout> | null = null
  private static tuningStorageKey(roomId: string, userId: string): string {
    return `${AudioService.TUNING_KEY_PREFIX}${roomId}:${userId}`
  }
  /** Default tuning values. SINGLE SOURCE OF TRUTH — used by both the
   *  initial `this.tuning` field below (via spread) and the
   *  schema-discard / RESET paths in loadRoomTuningIntoState() and
   *  resetRoomTuning(). Bumping these values must NOT be done in
   *  isolation: also bump TUNING_SCHEMA_VERSION so existing users'
   *  saved-tuning slots get discarded on next load (otherwise a
   *  stale slot pins the user to the OLD defaults).
   *
   *  History:
   *    Phase A v4.1.2: maxScale/minScale used to be 1.012/0.988
   *      (v3.x era). v4.1.0 bumped the live `this.tuning` to ±2.5%
   *      but forgot to update DEFAULT_PB — migration path applied
   *      OLD constants. Hotfixed in v4.1.2 with both updated.
   *    Phase B v4.2.0: primeTarget 1440 → 144, primeMin 128 → 32.
   *      Enabled by the new PCM PLC (worklet now rides ~10 ms
   *      underruns smoothly instead of reprime → click). Schema
   *      bumped v2 → v3 for the discard.
   *    Phase B tuning v4.2.2: primeTarget 144 → 288, primeMin 32
   *      → 64. v4.2.0's 3 ms target was too aggressive — even
   *      with PLC working correctly (v4.2.1), real sessions saw
   *      PLC firing 6+ times/sec sustained, producing audible
   *      distortion (1.8% of audio was PLC-filled).
   *    Phase B tuning v4.2.3: primeTarget 288 → 672, primeMin 64
   *      → 16. User-validated empirical sweet spot.
   *    v4.3.7 post-rollback re-tune: primeTarget 672 → 576,
   *      primeMin 16 → 48, server defaults to jitterTarget=2 /
   *      jitterMaxDepth=33. User iterated on debug panel against
   *      v4.3.6 (= v4.2.3 audio code, Phase C removed) and
   *      confirmed both latency AND audio quality were right with
   *      this exact set. */
  private static readonly DEFAULT_PB = Object.freeze({
    primeTarget: 576, primeMin: 48,
    maxScale: 1.025,  minScale: 0.975,
    rateStep: 0.00002,
  })
  private static readonly DEFAULT_SRV = Object.freeze({
    jitterTarget: 2, jitterMaxDepth: 33,
  })

  // ── Live tuning knobs ────────────────────────────────────────────────────
  // The numeric defaults match the historical hardcoded constants — see the
  // PRIME_TARGET / MAX_SCALE comments around initPlaybackWorklet for the
  // rationale on each value. They live on `this` (rather than as locals in
  // initPlaybackWorklet) so two things work:
  //   (1) the worklet template literal can interpolate the current values
  //       on construction (so a panel-driven change persists across an
  //       AudioContext rebuild — e.g. sample-rate switch);
  //   (2) `setPlaybackTuning()` can postMessage updates into a *running*
  //       worklet without recreating the audio graph, so a slider drag
  //       doesn't introduce a re-prime click.
  // serverJitter* are similarly cached locally and reflected to the server
  // via the MIXER_TUNE control message — see `setServerTuning()`.
  // Live tuning. **Initialised by spreading DEFAULT_PB so there's only
  // one source of truth** — drift between this and DEFAULT_PB caused
  // the v4.1.2 regression where migration applied stale defaults.
  // Don't reintroduce hardcoded numbers here.
  //
  // Inline value notes (current as of v4.2.0):
  //   primeTarget 144 (3 ms @ 48k) — Phase B floor. Was 1440 in v4.1.x;
  //     the new client PCM PLC absorbs underruns gracefully, so the
  //     ring no longer needs 30 ms of cushion.
  //   primeMin 32 (~0.67 ms) — PLC trigger threshold. Lower = trigger
  //     PLC less, but undershoot risks running the ring negative.
  //   maxScale ±2.5% — Phase A v4.1 widening; absorbs server mix-tick
  //     scheduling jitter without pinning at the rail.
  //   rateStep — integrator step per quantum, scaled 1×/4×/8× by the
  //     proportional fast-adjust depending on excess.
  public tuning: { primeTarget: number, primeMin: number, maxScale: number, minScale: number, rateStep: number }
                = { ...AudioService.DEFAULT_PB }
  // Server-side per-user jitter buffer. Defaults from DEFAULT_SRV
  // (single source of truth, see same rationale as tuning above).
  // Overwritten by MIXER_JOIN_ACK in normal operation.
  public serverTuning: { jitterTarget: number, jitterMaxDepth: number }
                     = { ...AudioService.DEFAULT_SRV }
  private tuningChangeCallbacks: Array<() => void> = []
  /** Subscribe to tuning value changes (e.g. from MIXER_JOIN_ACK). UI uses
   *  this to refresh slider positions without polling. */
  onTuningChanged(cb: () => void): void { this.tuningChangeCallbacks.push(cb) }
  private fireTuningChanged(): void {
    for (const cb of this.tuningChangeCallbacks) {
      try { cb() } catch (_) {}
    }
  }
  get audioWsState(): string {
    const ws = this.audioWs
    if (!ws) return 'null'
    return ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] || String(ws.readyState)
  }
  public cbCount = 0   // level callback invocations

  // Capture pipeline
  private processor:      AudioWorkletNode | ScriptProcessorNode | null = null
  private isCapturing:    boolean = false
  private sequence:       number = 0
  // ScriptProcessor delivers 1024-sample callbacks but we ship 240-sample
  // (5ms) frames. 1024 / 240 = 4 frames + 64-sample remainder. Stash the
  // remainder here and prepend it on the next callback so no samples are
  // dropped — otherwise the encoder leaks 1.33ms of audio every 21ms.
  private captureLeftover: Float32Array = new Float32Array(0)
  // timestamp removed — now using wall-clock ms in SPA1 header for RTT
  // frameBuffer removed — onAudioFrame sends directly from ScriptProcessor data

  // ── User sample-rate preference (persisted in localStorage) ──────────────
  // null = "auto" (let the browser pick). A specific rate forces both the
  // mic capture and the AudioContext to that rate, which is useful as both
  // a feature ("I know my hardware likes 48 kHz") and a diagnostic ("does
  // distortion go away when I bypass the resampler?").
  private static readonly RATE_STORAGE_KEY = 'tonel.audio.sampleRate'
  static readonly SUPPORTED_RATES: readonly number[] = [16000, 22050, 32000, 44100, 48000]

  static readUserRate(): number | null {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(AudioService.RATE_STORAGE_KEY)
    if (!v) return null
    const n = Number(v)
    return AudioService.SUPPORTED_RATES.includes(n) ? n : null
  }

  static writeUserRate(rate: number | null): void {
    if (typeof localStorage === 'undefined') return
    if (rate === null) localStorage.removeItem(AudioService.RATE_STORAGE_KEY)
    else localStorage.setItem(AudioService.RATE_STORAGE_KEY, String(rate))
  }

  /** Actual AudioContext sample rate (after browser negotiation). */
  get actualSampleRate(): number {
    return this.audioContext?.sampleRate ?? 0
  }

  /**
   * Browser-reported output device latency in ms (Chrome / Firefox).
   * Returns 0 when unsupported (Safari) or when the AudioContext
   * isn't yet built. Used by RoomPage to warn users on high-latency
   * output devices (Bluetooth headphones routinely add 100-200 ms).
   *
   * `outputLatency` settles after the first audio quantum has played,
   * so callers should poll over the first 1-2 seconds of a session
   * rather than reading once at init time.
   */
  get outputLatencyMs(): number {
    const ol = (this.audioContext as any)?.outputLatency
    return typeof ol === 'number' ? ol * 1000 : 0
  }

  /**
   * Apply a new requested AudioContext sample rate without reloading the page.
   *
   * Why in-place vs. `window.location.reload()`: a reload re-mounts the React
   * app, drops the WebSocket sessions, and would regenerate the guest userId
   * on App init if it weren't persisted in localStorage. The in-place rebuild
   * keeps the user in the room with a single stable userId, so the server
   * doesn't see a phantom session lingering and its solo-loopback fallback
   * keeps working.
   *
   * Implementation: only the AudioContext-bound graph is rebuilt — the
   * MediaStream is intentionally REUSED. v1.0.18 went through `init()` which
   * stops the old MediaStream tracks and re-acquires via `getUserMedia()`.
   * In Chromium, re-acquiring the mic in quick succession with new
   * sample-rate constraints can return tracks that look valid but produce
   * no data, so the level meter and capture path go silent. Reusing the
   * existing MediaStream sidesteps that — the OS-level mic keeps streaming,
   * and only its target AudioContext changes (Web Audio internally
   * resamples between mic native rate and context rate).
   */
  async changeSampleRate(rate: number | null): Promise<void> {
    AudioService.writeUserRate(rate)

    // First-time setup or mid-init: fall back to full init.
    if (!this.audioContext || !this.mediaStream) {
      await this.init()
      this.startCapture()
      return
    }

    const wasCapturing = this.isCapturing
    // Snapshot device IDs before tearing down — we'll re-acquire each
    // channel under the new context. The old subgraphs all get torn
    // down because their AudioNodes belong to the old AudioContext.
    const channelDeviceIds = this.inputChannels.map(c => c.deviceId)

    // Disconnect everything tied to the old AudioContext.
    this.stopCapture()
    for (const ch of this.inputChannels) {
      try { ch.gainNode.disconnect() } catch {}
      try { ch.source.disconnect() } catch {}
      try { ch.analyser.disconnect() } catch {}
      ch.mediaStream.getAudioTracks().forEach(t => t.stop())
    }
    this.inputChannels = []
    this.nextChannelId = 0
    if (this.inputSumGain) { try { this.inputSumGain.disconnect() } catch {} this.inputSumGain = null }
    if (this.source) { try { this.source.disconnect() } catch (_) {} this.source = null }
    if (this.playbackWorklet) { try { this.playbackWorklet.disconnect() } catch (_) {} this.playbackWorklet = null }
    if (this.masterGain) { try { this.masterGain.disconnect() } catch (_) {} this.masterGain = null }
    if (this.monitorWorklet) { try { this.monitorWorklet.disconnect() } catch (_) {} this.monitorWorklet = null }
    if (this.monitorGain) { try { this.monitorGain.disconnect() } catch (_) {} this.monitorGain = null }
    this.analyser = null
    this.captureLeftover = new Float32Array(0)
    this.capCarry = new Float32Array(0)
    this.capPhase = 0

    const oldCtx = this.audioContext
    this.audioContext = null

    const requestedRate = (AudioService.readUserRate() ?? SAMPLE_RATE)
    // latencyHint: 0 asks the browser for the smallest output buffer it can
    // give. Chrome/Firefox honour the numeric form by reducing baseLatency
    // (typically ~25 ms → ~5 ms on macOS CoreAudio). Safari tends to ignore
    // it and use its default, so the call is safe everywhere. Trade-off:
    // smaller buffer → less CPU headroom for the playback worklet. Tonel's
    // worklet is light (PCM ring + linear interp), so the risk of new
    // underruns is small relative to the latency win.
    this.audioContext = new AudioContext({ sampleRate: requestedRate, latencyHint: 0 })
    await this.audioContext.resume()

    if (this.audioContext.sampleRate !== requestedRate) {
      console.warn(`[Audio] AudioContext rate is ${this.audioContext.sampleRate} Hz, requested ${requestedRate}. Capture and worklet will resample.`)
    } else {
      console.log(`[Audio] AudioContext rate ${this.audioContext.sampleRate} Hz (in-place rebuild)`)
    }

    // Rebuild input bus + channels under the new context. Re-acquire
    // every channel that existed (or just default if there were none).
    this.inputSumGain = this.audioContext.createGain()
    this.inputSumGain.gain.value = 1.0
    if (channelDeviceIds.length === 0) channelDeviceIds.push('default')
    for (const did of channelDeviceIds) {
      try { await this.addInputChannel(did) } catch (e) { console.warn('[Audio] re-add channel failed', did, e) }
    }
    const ch0 = this.inputChannels[0]
    this.mediaStream = ch0?.mediaStream ?? null
    this.source      = ch0?.source ?? null
    this.analyser    = ch0?.analyser ?? null

    this.masterGain = this.audioContext.createGain()
    this.masterGain.gain.value = 1.0
    // v3.7.7: direct to destination — speaker-mode swap is gone.
    this.masterGain.connect(this.audioContext.destination)

    void this.ensureMonitorWorklet()

    await this.initPlaybackWorklet()

    // Close the old AudioContext after the new one is fully wired.
    try { oldCtx.close() } catch (_) {}

    if (wasCapturing) this.startCapture()
  }

  async init(): Promise<MediaStream> {
    // v3.7.6: simplified init.
    //
    // The user reported mobile Chrome / iOS Safari couldn't acquire mic
    // permission even after pressing the retry button — i.e. the gesture
    // chain through `runInit → audioService.init → getUserMedia` was
    // breaking somewhere. v3.5.1 had a near-identical init that worked
    // on mobile; v3.6.0+ added complexity (multi-input, outputBus,
    // speaker mode auto-apply, 30 s timeout race) that piled extra
    // awaits between the gesture and gUM. iOS' user-activation tracking
    // is fussy about gesture chains across awaits, so we strip back to
    // the v3.5.1 shape and only do what's needed before gUM.
    //
    // Specifically dropped:
    //   - 30 s timeout race (suspected to interfere with iOS gUM grant).
    //   - `channelCount: 1` constraint (some mobile devices reject it).
    //   - `adoptStreamAsChannel` indirection (an extra await + call).
    //   - speaker-mode auto-apply (spawned an audio.play() outside any
    //     gesture, throwing NotAllowedError that contaminated the path).
    //
    // What stays:
    //   - inputSumGain (multi-input bus). Built around channel 0 inline.
    //   - outputBus (speaker-mode swap point). Default route to
    //     destination, identical audible behaviour to a direct connect.
    //   - inputChannels[] tracking. Channel 0 populated inline, no async
    //     side-trip.

    // Cleanup (all sync). Runs even on first call — no-ops on null fields.
    this.stopCapture()
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(t => t.stop())
      this.mediaStream = null
    }
    // Tear down any prior multi-input channels too — without this, a
    // re-init (e.g. retry button) leaks the prior streams' tracks and
    // mobile Chrome refuses to reuse the mic.
    for (const ch of this.inputChannels) {
      try { ch.gainNode.disconnect() } catch {}
      try { ch.source.disconnect() } catch {}
      try { ch.analyser.disconnect() } catch {}
      ch.mediaStream.getAudioTracks().forEach(t => t.stop())
    }
    this.inputChannels = []
    this.nextChannelId = 0
    if (this.inputSumGain) { try { this.inputSumGain.disconnect() } catch {} this.inputSumGain = null }
    if (this.source) { try { this.source.disconnect() } catch (_) {} this.source = null }
    if (this.playbackWorklet) { try { this.playbackWorklet.disconnect() } catch (_) {} this.playbackWorklet = null }
    if (this.masterGain) { try { this.masterGain.disconnect() } catch (_) {} this.masterGain = null }
    if (this.monitorWorklet) { try { this.monitorWorklet.disconnect() } catch (_) {} this.monitorWorklet = null }
    if (this.monitorGain) { try { this.monitorGain.disconnect() } catch (_) {} this.monitorGain = null }
    if (this.animationFrameId) { cancelAnimationFrame(this.animationFrameId); this.animationFrameId = null }
    if (this.audioContext) { try { this.audioContext.close() } catch (_) {} this.audioContext = null }
    this.analyser = null
    this.txCount = 0; this.rxCount = 0; this.playCount = 0

    try {
      // v3.7.7: defensive recovery. iOS Safari preserves
      // navigator.audioSession.type across page reloads in the same
      // tab session. If a previous v3.7.2 → v3.7.6 page set it to
      // 'playback' for speaker mode, the next getUserMedia rejects
      // with InvalidStateError. Force it back to 'play-and-record'
      // here so the iPhone's recovery path is "just refresh" rather
      // than "clear site data and restart Safari." Wrapped in
      // try/catch because some iOS versions throw when setting type
      // while in an incompatible state — we don't want one failed
      // assignment to prevent the rest of init from running.
      try {
        const ns = navigator as { audioSession?: { type?: string } }
        if (ns.audioSession) ns.audioSession.type = 'play-and-record'
      } catch (err) {
        console.warn('[Audio] audioSession.type reset failed (ignoring):', err)
      }

      const userRate = AudioService.readUserRate()

      // Plain getUserMedia — no Promise.race wrapper. Mobile devices
      // sometimes reject `channelCount: 1`, so we omit it; the wire
      // protocol is mono-PCM and the worklets handle whatever the
      // device gives us.
      const tryGetUserMedia = (rateHint: number | null): Promise<MediaStream> => {
        const audio: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        }
        if (rateHint !== null) audio.sampleRate = rateHint
        return navigator.mediaDevices.getUserMedia({ audio, video: false })
      }
      const tryAudioContext = (rateHint: number | null): AudioContext => {
        // latencyHint: 0 — see in-place rebuild path above for rationale.
        return rateHint !== null
          ? new AudioContext({ sampleRate: rateHint, latencyHint: 0 })
          : new AudioContext({ latencyHint: 0 })
      }

      // Phase A.3 — sample rate auto-alignment.
      //
      // If the user has explicitly set a rate (Settings → 采样率), honour
      // it. Otherwise:
      //   1. Acquire the mic with NO rate constraint → browser picks the
      //      mic's native rate (typical: 48000 on most external mics,
      //      44100 on built-in laptop mics, sometimes 16000 on Bluetooth
      //      headsets).
      //   2. Read that native rate from `track.getSettings().sampleRate`.
      //   3. Build the AudioContext at that exact rate.
      //
      // This skips Chrome's internal mic→ctx resampler when they
      // mismatch. Resampling adds ~5-10 ms of latency on the capture
      // side (one extra buffer for the polyphase filter). Pre-Phase-A
      // we always asked for 48 kHz, which forced resampling on any
      // 44.1 kHz built-in mic.
      let requestedMicRate: number | null = userRate
      let actualMicRate = 0

      if (userRate !== null) {
        // Explicit user choice — try it, fall back to browser default
        // if rejected (OverconstrainedError on mobile).
        try {
          this.mediaStream = await tryGetUserMedia(userRate)
        } catch (err) {
          console.warn('[Audio] Constrained getUserMedia (user rate) failed, retrying unconstrained:', err)
          this.mediaStream = await tryGetUserMedia(null)
        }
      } else {
        // Auto: no rate constraint. Browser picks mic native.
        this.mediaStream = await tryGetUserMedia(null)
      }

      // Inspect what the mic actually gave us.
      try {
        const settings = this.mediaStream.getAudioTracks()[0]?.getSettings()
        if (settings?.sampleRate) actualMicRate = settings.sampleRate
      } catch (_) { /* getSettings unsupported on some old Safari */ }

      // Pick the AudioContext rate. If we know the mic native rate AND
      // the user didn't pin a specific rate, follow the mic. Otherwise
      // fall back to the user's choice or 48 kHz default.
      const ctxRate = (userRate === null && actualMicRate > 0) ? actualMicRate
                    : (userRate ?? SAMPLE_RATE)
      requestedMicRate = ctxRate

      try {
        this.audioContext = tryAudioContext(ctxRate)
      } catch (ctxErr) {
        console.warn('[Audio] Constrained AudioContext failed, retrying unconstrained:', ctxErr)
        this.audioContext = tryAudioContext(null)
      }
      await this.audioContext.resume()
      const aligned = (actualMicRate === 0 || this.audioContext.sampleRate === actualMicRate)
      if (this.audioContext.sampleRate !== requestedMicRate || !aligned) {
        console.warn(`[Audio] AudioContext rate ${this.audioContext.sampleRate} Hz, mic native ${actualMicRate || '?'} Hz, requested ${requestedMicRate}. Capture/worklet will resample.`)
      } else {
        console.log(`[Audio] AudioContext rate ${this.audioContext.sampleRate} Hz aligned with mic native ${actualMicRate} Hz — no resampler`)
      }

      // Build channel 0's subgraph inline (no async indirection).
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.smoothingTimeConstant = 0.3

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
      this.source.connect(this.analyser)

      // Multi-input bus. Channel 0's gain stage feeds it.
      this.inputSumGain = this.audioContext.createGain()
      this.inputSumGain.gain.value = 1.0
      const ch0Gain = this.audioContext.createGain()
      ch0Gain.gain.value = 1.0
      this.source.connect(ch0Gain)
      ch0Gain.connect(this.inputSumGain)

      const ch0Label = this.mediaStream.getAudioTracks()[0]?.label || 'Default Input'
      this.inputChannels = [{
        id: `ch${this.nextChannelId++}`,
        deviceId:    'default',
        deviceLabel: ch0Label,
        mediaStream: this.mediaStream,
        source:      this.source,
        gainNode:    ch0Gain,
        analyser:    this.analyser,
        userGain:    1.0,
        muted:       false,
      }]

      this.startLevelMonitoring()
      await this.initPlayback()  // P0-1 fix: await async initPlayback

      return this.mediaStream
    } catch (err) {
      console.error('[Audio] Init error:', err)
      throw err
    }
  }

  // Playback worklet node for ring-buffer based playback
  private playbackWorklet: AudioWorkletNode | null = null

  private async initPlayback(): Promise<void> {
    // Reuse the capture AudioContext for playback — a single context avoids
    // browser autoplay policy issues (the capture context is already running
    // because getUserMedia granted permission).
    if (!this.audioContext) return
    this.masterGain = this.audioContext.createGain()
    this.masterGain.gain.value = 1.0
    // v3.7.7: direct to destination — speaker-mode swap is gone.
    this.masterGain.connect(this.audioContext.destination)
    void this.ensureMonitorWorklet()
    await this.initPlaybackWorklet()
    // v3.7.6: speaker-mode is user-driven only. Auto-applying from
    // localStorage at init time spawned an audio.play() outside any
    // gesture, which threw NotAllowedError and contaminated init's
    // promise chain in subtle ways on mobile Safari. The user can
    // re-toggle the speaker switch in Settings after entering the
    // room — it's a single tap.
  }

  // ── Multi-input channel management ─────────────────────────────────────
  //
  // The methods below own all per-channel audio-graph wiring. `init()` /
  // `changeSampleRate()` rebuild the channel list by tearing down the
  // old graph and calling `addInputChannel('default')` to seed channel 0.
  // The legacy `this.source` / `this.mediaStream` / `this.analyser`
  // fields are kept as aliases of channel 0 so the existing 40+
  // touch-points across the codebase don't all have to be rewritten in
  // one go.

  /**
   * Acquire a mic device, build its per-channel subgraph, and add it to
   * the input mix. Returns the new channel's id. Throws if the audio
   * graph isn't ready (caller must `init()` first).
   *
   * deviceId='default' lets the browser pick (usually the OS default).
   * A specific deviceId pins this channel to that device — survives
   * device-list reorderings as long as the device stays plugged in.
   */
  async addInputChannel(deviceId: string = 'default'): Promise<string> {
    if (!this.audioContext || !this.inputSumGain) {
      throw new Error('AudioService not initialized — call init() first')
    }
    const requestedRate = AudioService.readUserRate() ?? SAMPLE_RATE
    const audioConstraint: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
      sampleRate:       requestedRate,
      channelCount:     CHANNELS,
    }
    if (deviceId && deviceId !== 'default') {
      audioConstraint.deviceId = { exact: deviceId }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false })
    return this.adoptStreamAsChannel(stream, deviceId)
  }

  /**
   * Wire an already-acquired MediaStream as a new input channel.
   * Used by `init()` to reuse the gestural getUserMedia stream as
   * channel 0 — without this, init would have to call getUserMedia
   * twice in quick succession, and on mobile Chrome the second call
   * sometimes hangs / fails (the v3.7.4 mobile-Chrome no-mic-permission
   * bug). Public `addInputChannel(deviceId)` for the + button still
   * does its own getUserMedia for additional inputs (each new
   * channel needs its own stream / device anyway).
   */
  private async adoptStreamAsChannel(stream: MediaStream, deviceId: string): Promise<string> {
    if (!this.audioContext || !this.inputSumGain) {
      throw new Error('AudioService not initialized — call init() first')
    }
    const id = `ch${this.nextChannelId++}`
    const source = this.audioContext.createMediaStreamSource(stream)
    const gainNode = this.audioContext.createGain()
    gainNode.gain.value = 1.0
    const analyser = this.audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.3
    // Audio: source → gainNode → inputSumGain. Tap: source → analyser
    // (parallel, no downstream — analyser is leaf, just for level metering).
    source.connect(gainNode)
    gainNode.connect(this.inputSumGain)
    source.connect(analyser)

    // Resolve the label from enumerateDevices for nice display. After
    // getUserMedia has succeeded, `label` is populated (browsers gate
    // it on permission).
    let deviceLabel = ''
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (deviceId === 'default') {
        const trackLabel = stream.getAudioTracks()[0]?.label
        deviceLabel = trackLabel || 'Default Input'
      } else {
        const dev = devices.find(d => d.deviceId === deviceId)
        deviceLabel = dev?.label || `Input ${id}`
      }
    } catch {
      deviceLabel = `Input ${id}`
    }

    const channel: InputChannel = {
      id, deviceId, deviceLabel, mediaStream: stream,
      source, gainNode, analyser, userGain: 1.0, muted: false,
    }
    this.inputChannels.push(channel)
    return id
  }

  /**
   * Tear down a channel's subgraph and stop its mic. The first channel
   * (`ch0`) cannot be removed — there must always be at least one
   * input. Returns true if a channel was removed.
   */
  removeInputChannel(id: string): boolean {
    if (this.inputChannels.length <= 1) return false   // never remove the last
    const idx = this.inputChannels.findIndex(c => c.id === id)
    if (idx < 0) return false
    const ch = this.inputChannels[idx]
    try { ch.gainNode.disconnect() } catch {}
    try { ch.source.disconnect() } catch {}
    try { ch.analyser.disconnect() } catch {}
    ch.mediaStream.getAudioTracks().forEach(t => t.stop())
    this.inputChannels.splice(idx, 1)
    return true
  }

  /** Per-channel gain (channel-strip fader). Stacks with `muted` —
   *  effective gainNode value is 0 when muted, `userGain` otherwise. */
  setInputChannelGain(id: string, g: number): void {
    const ch = this.inputChannels.find(c => c.id === id)
    if (!ch || !this.audioContext) return
    ch.userGain = Math.max(0, Math.min(2, g))
    const eff = ch.muted ? 0 : ch.userGain
    ch.gainNode.gain.setTargetAtTime(eff, this.audioContext.currentTime, 0.01)
  }
  setInputChannelMuted(id: string, b: boolean): void {
    const ch = this.inputChannels.find(c => c.id === id)
    if (!ch || !this.audioContext) return
    ch.muted = b
    const eff = ch.muted ? 0 : ch.userGain
    ch.gainNode.gain.setTargetAtTime(eff, this.audioContext.currentTime, 0.01)
  }

  /**
   * Swap the device backing an existing channel without losing the
   * channel slot (gain/mute state stays). Tears down the old subgraph,
   * acquires the new device, rewires.
   */
  async setInputChannelDevice(id: string, deviceId: string): Promise<void> {
    if (!this.audioContext || !this.inputSumGain) return
    const ch = this.inputChannels.find(c => c.id === id)
    if (!ch) return
    const requestedRate = AudioService.readUserRate() ?? SAMPLE_RATE
    const audioConstraint: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
      sampleRate:       requestedRate,
      channelCount:     CHANNELS,
    }
    if (deviceId && deviceId !== 'default') {
      audioConstraint.deviceId = { exact: deviceId }
    }
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false })
    // Rewire: stop old, build new on top of existing gainNode/analyser
    // (they keep their settings).
    try { ch.source.disconnect() } catch {}
    ch.mediaStream.getAudioTracks().forEach(t => t.stop())
    ch.mediaStream = newStream
    ch.source = this.audioContext.createMediaStreamSource(newStream)
    ch.source.connect(ch.gainNode)
    ch.source.connect(ch.analyser)
    ch.deviceId = deviceId
    try {
      const trackLabel = newStream.getAudioTracks()[0]?.label
      if (trackLabel) ch.deviceLabel = trackLabel
      else if (deviceId !== 'default') {
        const devices = await navigator.mediaDevices.enumerateDevices()
        ch.deviceLabel = devices.find(d => d.deviceId === deviceId)?.label || ch.deviceLabel
      }
    } catch {}
    // If this is channel 0, refresh the legacy alias so anything still
    // reading `this.mediaStream` / `this.source` keeps pointing at the
    // current device.
    if (this.inputChannels[0] === ch) {
      this.mediaStream = newStream
      this.source      = ch.source
    }
  }

  /** Read-only snapshot of the current channel list for the UI. */
  getInputChannels(): readonly InputChannel[] {
    return this.inputChannels
  }

  /**
   * Compute the current per-channel level (RMS, smoothed, scaled to 0-1).
   * Polled by the UI for each strip's meter. Cheap — uses the channel's
   * AnalyserNode time-domain buffer.
   */
  getInputChannelLevel(id: string): number {
    const ch = this.inputChannels.find(c => c.id === id)
    if (!ch) return 0
    const buf = new Float32Array(ch.analyser.fftSize)
    ch.analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    return Math.min(1, rms * 5)   // same scaling factor as captureWorklet's level meter
  }

  /**
   * Wire the source → monitorWorklet → destination chain.
   *
   * v3.4.4 routed monitor `worklet → monitorGain → masterGain → destination`
   * on the theory that going through the same gain stages as peer audio
   * would dodge iOS Safari's mic-to-speaker gate. That worked on iOS
   * but on desktop Chrome the path remained inaudible despite
   * `mon=1.00`. Two-stage GainNode chain seems to trigger a different
   * (or additional) gating layer.
   *
   * v3.4.5: skip the GainNodes entirely. Connect the worklet directly
   * to `destination` and apply gain *inside* the worklet by scaling
   * samples in `process()`. The "old accidental loopback" pattern from
   * pre-v1.0.x was exactly this: `worklet → destination` direct, with
   * any output level controlled in the worklet itself. That combination
   * is browsers' "blessed" mic-passthrough path because the worklet is
   * audio-thread code that the browser treats as a generated stream
   * rather than a mic-to-speaker shortcut.
   *
   * Side-effect: `setMasterGain(0)` no longer mutes the monitor (the
   * masterGain isn't on the monitor's path anymore), so soloing self
   * keeps you hearing yourself locally — which is closer to what the
   * user wants anyway. Independent monitor mute can be added later.
   */
  private async ensureMonitorWorklet(): Promise<boolean> {
    if (!this.audioContext || !this.source) return false
    if (this.monitorWorklet) return true
    const code = `
      // v3.4.7: queue-fed monitor processor.
      //
      // Background: v3.4.5/3.4.6 connected source → monitorWorklet just
      // like the capture worklet. On Chrome desktop, the diagnostics
      // showed monProc=14880 monIn=9626 monOut=0 — process() ran, inputs
      // had length > 0, but every input sample was 0. Same source feeding
      // both worklets, yet capture sees real mic (clipping detected!) and
      // monitor sees silence. That's Chrome's mic-track double-tap
      // suppression: the WebRTC audio-processing layer marks the *first*
      // consumer as authoritative and zeros samples reaching subsequent
      // consumers, even within the Web Audio API.
      //
      // Workaround: don't tap mic twice. The capture worklet already has
      // real mic samples and posts them to main thread for SPA1 send. We
      // intercept at that hop and postMessage the same frames to this
      // worklet, which queues them and emits via process(). This monitor
      // worklet has NO audio input — its source is the port queue. From
      // Chrome's perspective there's no mic→speaker path here, so the
      // suppression never fires.
      //
      // Latency cost: one main-thread round trip (~5–10 ms) + the queue's
      // current depth. Still far below the ~30–100 ms server bounce, so
      // the user gets near-real-time self-hear.
      class MonitorProcessor extends AudioWorkletProcessor {
        constructor() {
          super()
          this.gain      = 0
          this.queue     = []     // FIFO of Float32Array frames
          this.queueLen  = 0      // total samples buffered
          this.readPos   = 0      // position into queue[0]
          this.procCalls = 0
          this.framesIn  = 0      // frames received via port
          this.outWrote  = 0
          this.statsTick = 0
          this.port.onmessage = (ev) => {
            const d = ev.data
            if (d instanceof Float32Array) {
              this.queue.push(d)
              this.queueLen += d.length
              this.framesIn++
              // v3.4.8: tight cap as a defensive backstop. With raw
              // context-rate blocks producer = consumer, queue should
              // oscillate near zero. If a main-thread stall briefly
              // bursts frames in, drop oldest to keep latency bounded
              // (~10 ms wall-clock at any context rate). Each drop is
              // an audible click — but a 1-second silent backlog of
              // your own voice is much worse.
              while (this.queueLen > 480) {
                const old = this.queue.shift()
                if (!old) break
                this.queueLen -= old.length - this.readPos
                this.readPos = 0
              }
            } else if (d && d.type === 'gain' && typeof d.gain === 'number') {
              this.gain = d.gain
            }
          }
        }
        process(_inputs, outputs) {
          this.procCalls++
          const out = outputs[0]
          if (!out || !out[0]) return true
          const dst0 = out[0]
          if (this.gain <= 0) {
            for (let c = 0; c < out.length; c++) out[c].fill(0)
            if (++this.statsTick >= 120) {
              this.statsTick = 0
              this.port.postMessage({
                type: 'monStats',
                procCalls: this.procCalls,
                framesIn:  this.framesIn,
                outWrote:  this.outWrote,
                queueLen:  this.queueLen,
              })
            }
            return true
          }
          const g = this.gain
          let idx = 0
          let wrote = false
          while (idx < dst0.length && this.queue.length > 0) {
            const head = this.queue[0]
            const avail = head.length - this.readPos
            const take  = Math.min(avail, dst0.length - idx)
            for (let i = 0; i < take; i++) {
              const v = head[this.readPos + i] * g
              dst0[idx + i] = v
              if (v !== 0) wrote = true
            }
            idx += take
            this.readPos += take
            this.queueLen -= take
            if (this.readPos >= head.length) {
              this.queue.shift()
              this.readPos = 0
            }
          }
          // Underrun → silence the rest of this quantum.
          while (idx < dst0.length) { dst0[idx++] = 0 }
          // Fan mono signal to all output channels.
          for (let c = 1; c < out.length; c++) out[c].set(dst0)
          if (wrote) this.outWrote++
          if (++this.statsTick >= 120) {
            this.statsTick = 0
            this.port.postMessage({
              type: 'monStats',
              procCalls: this.procCalls,
              framesIn:  this.framesIn,
              outWrote:  this.outWrote,
              queueLen:  this.queueLen,
            })
          }
          return true
        }
      }
      registerProcessor('monitor-processor', MonitorProcessor)
    `
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
    try {
      await this.audioContext.audioWorklet.addModule(url)
      if (!this.audioContext || !this.source) return false
      // Force stereo output so mono → stereo upmix isn't browser-dependent.
      this.monitorWorklet = new AudioWorkletNode(this.audioContext, 'monitor-processor', {
        numberOfInputs:    1,
        numberOfOutputs:   1,
        outputChannelCount: [2],
      })
      // Capture monitor stats for the debug strip — see field comments
      // on `monitor*` getters below for what each counter tells us.
      this.monitorWorklet.port.onmessage = (ev) => {
        const d = ev.data
        if (d && d.type === 'monStats') {
          this._monProcCalls = d.procCalls
          this._monInSeen    = d.framesIn   // now "frames received via port"
          this._monOutWrote  = d.outWrote
          this._monQueueLen  = d.queueLen
        }
      }
      // v3.4.7: NO source.connect(monitorWorklet). The capture worklet's
      // main-thread message handler forwards every captured frame to
      // this worklet via postMessage — see `sendCapturedFrame`. That
      // route avoids Chrome desktop's "second mic-tap returns silence"
      // suppression because the monitor worklet never tunes a mic
      // track itself.
      // v3.7.7: back to direct destination (speaker-mode is gone).
      this.monitorWorklet.connect(this.audioContext.destination)
      this.updateMonitorGain()   // posts initial gain (0)
      return true
    } catch (err) {
      console.warn('[Audio] monitor worklet init failed:', err)
      return false
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /**
   * Recompute the monitor gain target from the current `peerLevels.size`.
   * 0 when the user is alone (server runs solo loopback → adding monitor
   * would double the user's voice in their own ears), `monitorBaseGain`
   * when there are peers (server runs N-1 → monitor is the only path
   * to hear self).
   *
   * Uses a tight `linearRampToValueAtTime` (10 ms) instead of
   * `setTargetAtTime` (which is exponential and can land at fractional
   * values that are hard to reason about during debugging). 10 ms is
   * short enough not to be perceptible as a fade-in but long enough to
   * avoid the click an instant `gain.value =` would produce on the
   * audio thread under load.
   */
  private updateMonitorGain(): void {
    const engaged = (this.peerLevels.size >= 2) && !this.monitorMuted
    const target  = engaged ? this.monitorBaseGain : 0
    this._monitorTarget = target
    if (this.monitorWorklet) {
      // v3.4.7: distinguished message shape `{type:'gain', gain}` so the
      // worklet's onmessage can disambiguate between gain commands and
      // raw Float32Array frames coming on the same port.
      this.monitorWorklet.port.postMessage({ type: 'gain', gain: target })
    }
  }
  private _monitorTarget = 0
  /** Current monitor gain target (post-ramp). Surfaced in the debug strip. */
  get monitorGainTarget(): number { return this._monitorTarget }

  // Monitor worklet diagnostics — populated from periodic monStats posts
  // every ~128 quanta. Pinned in the debug strip so a silent monitor on
  // a particular browser tells us *which stage* is failing:
  //   monProc not growing  → worklet's process() not being invoked
  //                          (worklet creation / connection failed silently).
  //   monProc grows, monIn=0 → process() runs but inputs[0][0] is empty
  //                          (source.connect(monitorWorklet) didn't take).
  //   monIn>0, monOut=0    → input flowing, gain=0 (peerLevels.size<2)
  //                          OR samples are all-zero (mic muted at OS level).
  //   monOut>0 but inaudible → output reaching the worklet's output channel
  //                          but destination is dropping it (rare — would
  //                          mean an even stricter browser gate).
  private _monProcCalls = 0
  private _monInSeen    = 0
  private _monOutWrote  = 0
  private _monQueueLen  = 0
  get monitorProcCalls(): number { return this._monProcCalls }
  get monitorInSeen():    number { return this._monInSeen }
  get monitorOutWrote():  number { return this._monOutWrote }
  /** Current monitor queue depth (samples). At 48 kHz, /48 ≈ ms. With
   *  raw-block forwarding (v3.4.8+), this should oscillate near 0;
   *  a sustained nonzero queue indicates main-thread jank or a
   *  producer/consumer rate mismatch. */
  get monitorQueueLen(): number { return this._monQueueLen }

  /**
   * Future-proof user-facing knob — not yet wired to the debug panel,
   * but a single setter so we don't need to reach into private state
   * later. Range [0, 2] — 1.0 nominal, 2.0 = +6 dB headroom for
   * underdriven mics.
   */
  setMonitorBaseGain(g: number): void {
    this.monitorBaseGain = Math.max(0, Math.min(2, g))
    this.updateMonitorGain()
  }

  // (v3.7.2 setSpeakerMode + speakerModeValue removed in v3.7.7. The
  // iOS audioSession.type='playback' override poisoned subsequent
  // getUserMedia calls — InvalidStateError on init. Until a workaround
  // exists that doesn't mutate audioSession state, iOS users hear
  // peer audio through the earpiece while mic is active.)
  /** Toggle the local monitor on/off independent of the population-based
   *  engagement. Wired to the MIXER section's self-strip mute button. */
  setMonitorMuted(muted: boolean): void {
    this.monitorMuted = muted
    this.updateMonitorGain()
  }

  // ── Per-peer playback gain (channel-strip faders) ───────────────────────
  // Server stores the table in this user's UserEndpoint and applies it
  // at mix time via `mixExcludingWithGains`. Client just sends the
  // command and tracks the local mirror for UI initialisation.
  private peerGains = new Map<string, number>()
  /** Cached per-peer gain — last value sent (or acked). Range [0, 2]. */
  getPeerGain(peerUserId: string): number {
    return this.peerGains.get(peerUserId) ?? 1.0
  }
  /**
   * Set this user's playback gain for one specific peer (channel-strip
   * fader → here). The change is server-side: the next mix tick's N-1
   * mix sent to *this* user scales that peer's track by `gain`. Other
   * users' mixes are unaffected.
   *
   * Range [0, 2]; 1.0 is unity. The server clamps to the same range and
   * deletes the key on exact 1.0 so the map stays small.
   */
  setPeerGain(peerUserId: string, gain: number): void {
    const clamped = Math.max(0, Math.min(2, gain))
    this.peerGains.set(peerUserId, clamped)
    if (this.controlWs?.readyState === WebSocket.OPEN) {
      this.controlWs.send(JSON.stringify({
        type:           'PEER_GAIN',
        room_id:        this.roomId,
        user_id:        this.userId,
        target_user_id: peerUserId,
        gain:           clamped,
      }) + '\n')
    }
  }

  // ── Input gain (mic send level) ─────────────────────────────────────────
  // Multiplied into mic samples before SPA1 encode. Local-only; this is
  // how loud peers (and the recording sink) hear *your* voice. Default
  // 1.0 = unity, range [0, 2] for a +6 dB ceiling. Wired to the INPUT
  // TRACKS self-strip's fader.
  private inputGain = 1.0
  setInputGain(g: number): void {
    this.inputGain = Math.max(0, Math.min(2, g))
  }
  get inputGainValue(): number { return this.inputGain }
  /** Current monitor base gain (0-2). For UI initialisation. */
  get monitorBaseGainValue(): number { return this.monitorBaseGain }
  get monitorMutedValue(): boolean { return this.monitorMuted }
  /** Whether the local monitor is currently audible (≥2 peers). */
  get monitorActive(): boolean {
    return !!this.monitorWorklet && this.peerLevels.size >= 2
  }

  private async initPlaybackWorklet(): Promise<void> {
    if (!this.audioContext || !this.masterGain) return

    // PlaybackProcessor — mirrors AppKit MixerBridge.mm RingBuffer.
    //
    // Why this design (vs. the pre-v1.0.13 versions):
    //   1. Ring stores PCM at the WIRE rate (48 kHz) — no producer-side
    //      resample. The previous v1.0.12 producer-resampled per packet,
    //      which dropped the fractional 0.5 sample at every 5 ms boundary
    //      and shifted the apparent frequency by ~0.23 % at 44.1 kHz
    //      contexts (1000 Hz → 1002 Hz) plus introduced 200 Hz click
    //      stream from the per-packet phase discontinuity.
    //   2. Resample happens INSIDE process(), once, with a fractional
    //      readPos that advances by ratio = 48000 / sampleRate per output
    //      sample. Linear interpolation, sample-accurate phase across
    //      packet boundaries — this is the same approach a real-time
    //      VoIP playout buffer uses.
    //   3. Prime / re-prime threshold (10 ms cushion) absorbs network
    //      jitter. Without it the ring oscillates near empty whenever
    //      input rate (44 000 samples/s post-resample of 200×220) doesn't
    //      match output rate (44 100), so any jitter underruns and the
    //      worklet outputs silence — the v1.0.12 "几乎听不到人声"
    //      regression. With the new design the ring never goes near
    //      empty under normal jitter.
    //   4. Mono input is fanned out to every destination channel so the
    //      right speaker isn't silent on stereo destinations.
    // Jitter cushion sizing.
    //
    // PRIME_TARGET sets the steady-state ring depth — i.e., how many
    // input-rate samples we keep buffered while playing. It's also the
    // playback latency: ring takes ~PRIME_TARGET/48000 seconds to drain.
    //
    // PRIME_MIN is the floor: if the ring drops below this mid-callback
    // we silence the rest of the callback and re-prime.
    //
    // v1.0.13 set these to 480 / 128 (10 ms / 2.7 ms). A 10 ms cushion
    // is tight enough that any network jitter > ~7 ms drops the ring
    // below the floor and fires a re-prime. Each re-prime is an
    // instantaneous audio→silence transition — a discontinuity that
    // the listener hears as a click. Stacked at voice peaks (where the
    // discontinuity amplitude is largest), the click pattern is what
    // the user reported as 破音.
    //
    // v1.0.23 doubles the cushion to 20 ms. WSS-over-public-internet
    // jitter is regularly 15+ ms; 20 ms absorbs the common case while
    // adding only 10 ms of playback latency (well under the perceptual
    // threshold for "delayed" voice). The audio-thread cost of 480
    // additional buffered samples is zero (Float32Array, pre-allocated).
    const RING_SIZE    = 48000   // 1 second @ wire rate (48 kHz)
    // Initial values — pulled from this.tuning so a panel-driven change
    // persists across an AudioContext rebuild (sample-rate switch). At
    // runtime they're updated via the 'tune' postMessage in the worklet's
    // onmessage handler, no graph rebuild required.
    const PRIME_TARGET = this.tuning.primeTarget
    const PRIME_MIN    = this.tuning.primeMin
    const MAX_SCALE    = this.tuning.maxScale
    const MIN_SCALE    = this.tuning.minScale
    const RATE_STEP    = this.tuning.rateStep
    const code = `
      class PlaybackProcessor extends AudioWorkletProcessor {
        constructor() {
          super()
          this.buf      = new Float32Array(${RING_SIZE})
          this.writePos = 0
          this.readPos  = 0          // fractional, in input-rate samples
          this.count    = 0          // input-rate samples currently buffered
          this.primed   = false
          this.ratio    = 48000 / sampleRate   // input samples per output sample
          this.reprimeCount = 0      // how many times we've re-primed (silence event)

          // Adaptive rate compensation. The server's 5 ms broadcast timer
          // and the browser's audio thread run on different physical
          // clocks (server NTP-synced, browser CPU crystal); both nominally
          // 48 kHz but in practice off by 50-500 ppm. The mismatch
          // accumulates: at 100 ppm drift, the ring loses ~5 samples/sec,
          // so a fixed-rate consumer drifts the ring to empty (and a
          // reprime click) every ~3 minutes even with no jitter and no
          // mic input. The user observed reprimes growing while muted —
          // exactly this mode. We close the loop here: nudge readPos's
          // step size up/down by ≤0.5 % to track the producer rate. 0.5 %
          // is well under the perceptual threshold for pitch shift on
          // voice, and the slow adaptation rate (0.002 % per quantum)
          // keeps the change inaudible.
          this.targetCount = ${PRIME_TARGET}
          this.primeMin    = ${PRIME_MIN}
          this.rateScale   = 1.0
          // ±1.2 % rate range (v1.0.27: widened from ±0.8 % since the user
          // saturated the v1.0.26 cap at -8000 ppm). 1.2 % is ~20 cents on
          // pitch — measurable on a tuner, but on conversational voice
          // listeners reliably miss it (perceptual threshold ~25-35 cents
          // for short-duration speech). At 1.5 % most listeners *can*
          // detect a shift, so we stop here.
          this.MAX_SCALE   = ${MAX_SCALE}
          this.MIN_SCALE   = ${MIN_SCALE}
          // Per-quantum nudge magnitude for the rate-tracking integrator.
          // Bigger = faster convergence to producer rate (good for first
          // few seconds after join) but proportionally more pitch jitter
          // around steady state. 2e-5 was the v1.0.25 chosen value.
          this.rateStep    = ${RATE_STEP}
          this.statsTick   = 0   // post stats periodically for the debug strip

          // ── PLC (Packet Loss Concealment) state — Phase B v4.2 ─────────
          //
          // When the ring drains (count < primeMin), classic behaviour was
          // emit silence + set primed=false + wait for ring to refill all
          // the way to targetCount before resuming. That's a "reprime":
          // audible click + several quanta of dead air + a fresh latency
          // floor to climb out of. The rate controller can't tell the
          // difference between a reprime and a real glitch, so reprime
          // events also confuse the integrator.
          //
          // PLC replaces silence with a *concealment quantum*: replay the
          // last-emitted 128-sample block with progressive energy decay.
          // The listener hears the previous signal "ringing out" instead
          // of a brick wall. If the ring refills within ~10 ms (4 quanta),
          // we ramp back into real audio with a short crossfade and the
          // glitch is below perceptual threshold. Only sustained underruns
          // (>4 quanta) escalate to reprime — those are real network /
          // server problems, not transient jitter the rate controller
          // could have ridden out.
          //
          // Memory cost: one Float32Array of 128 samples (~512 B).
          // CPU cost: same as silence path (one fill loop) with a multiply.
          this.lastBlock     = new Float32Array(128)
          this.concealQuanta = 0     // how many quanta we've concealed in a row
          this.concealCount  = 0     // lifetime PLC events (one per "primed → underrun" transition)
          // Decay envelope per consecutive concealment quantum.
          // 4 entries = max 4 × ~2.67 ms = ~10.7 ms of PLC before reprime.
          this.concealDecay  = [1.0, 0.7, 0.4, 0.15]
          // ── Trim-crossfade state — v4.3.8 ──────────────────────────────
          // When a 'tune' message shrinks targetCount and we trim the
          // ring (readPos jumps forward), the next quantum's first sample
          // is the post-jump audio while lastBlock holds the pre-jump
          // audio. A direct splice is a step discontinuity (measured up
          // to 0.58 in panel_tune_offline.js, vs. 0.04 sample-to-sample
          // for a 0.3-amp 1 kHz sine) — audible as a click.
          //
          // Per slider drag the panel emits ~60 tune messages/sec, each
          // potentially causing a trim. The clicks compound into a "tick
          // storm" the user reports as "听觉上的叠加".
          //
          // Fix: after each trim, mark the next N output samples to be a
          // linear crossfade from lastBlock (just-played audio held in
          // the PLC scratch) to the post-jump ring content. 32 samples
          // = 0.67 ms at 48 kHz, well under perceptual threshold for a
          // ramp, but long enough to mask the splice step.
          this.trimFadeRemaining = 0     // samples of crossfade still owed
          this.port.onmessage = (ev) => {
            const m = ev.data
            // Tuning message — runtime knobs from the room debug panel.
            // Discriminated by an explicit \`type\` field so audio frames
            // (Float32Array / ArrayBuffer) keep flowing through the fast
            // path below with one extra check per frame.
            if (m && m.type === 'tune') {
              if (typeof m.primeTarget === 'number') this.targetCount = m.primeTarget
              if (typeof m.primeMin    === 'number') this.primeMin    = m.primeMin
              if (typeof m.maxScale    === 'number') this.MAX_SCALE   = m.maxScale
              if (typeof m.minScale    === 'number') this.MIN_SCALE   = m.minScale
              if (typeof m.rateStep    === 'number') this.rateStep    = m.rateStep
              // Re-clamp current rateScale into the new band so a tighter
              // band takes effect immediately instead of waiting for the
              // next tick to drift back inside.
              if (this.rateScale > this.MAX_SCALE) this.rateScale = this.MAX_SCALE
              if (this.rateScale < this.MIN_SCALE) this.rateScale = this.MIN_SCALE
              // Hard-trim ring on target shrink. Without this, the rate
              // loop drains the ring to the new target only over ~10 s
              // (max +1.2 % rateScale × hysteresis band). For a debug
              // panel where the user expects "lower the slider, hear
              // less latency," that delay reads as "knob has no effect"
              // — and worse, a sequence of grow-then-shrink moves can
              // leave the ring above target with each iteration, so
              // *perceived* latency only ever creeps up.
              //
              // v4.3.8: schedule a 32-sample crossfade in the next
              // process() instead of letting the splice step through
              // raw. Avoids the click storm a slider drag produces
              // (~60 tune messages/sec → up to 60 clicks/sec without
              // crossfade — see panel_tune_offline.js). Same latency
              // trade-off as before; just the discontinuity is
              // smoothed instead of bare.
              // 16-sample deadband (~0.33 ms): tune messages whose only
              // delta vs. the live ring is sub-quantum jitter (which
              // happens every time the user holds the slider still while
              // count fluctuates 1-3 samples around target across tick
              // boundaries) shouldn't trigger trim+crossfade. Without
              // this, a stationary slider produces ~60 trim+crossfade
              // events/sec, each crossfade injecting a 32-sample
              // lastBlock[127]-DC blend — measurable as a 90 dB SNR
              // drop on a clean tone (panel_tune_offline.js
              // spam_no_change). Real slider drag motion always
              // produces drop >= slider step (48 samples), so this
              // threshold doesn't dull responsiveness.
              if (this.count > this.targetCount + 16) {
                const drop = this.count - this.targetCount
                this.readPos = (Math.floor(this.readPos) + drop) % ${RING_SIZE}
                this.count   = this.targetCount
                // Engage the crossfade. Cap at 32 (one full ramp); if a
                // second trim fires before the previous ramp finished,
                // the new trim resets the counter rather than stacking
                // — the lastBlock the new ramp will fade FROM is the
                // post-previous-ramp audio, which is already smooth.
                this.trimFadeRemaining = 32
              }
              return
            }
            let samples = m
            if (samples instanceof ArrayBuffer) samples = new Float32Array(samples)
            if (!samples || !samples.length) return
            const len = samples.length
            for (let i = 0; i < len; i++) {
              this.buf[this.writePos] = samples[i]
              this.writePos = (this.writePos + 1) % ${RING_SIZE}
              if (this.count < ${RING_SIZE}) {
                this.count++
              } else {
                // Slide-window overflow: drop the oldest sample.
                this.readPos = (Math.floor(this.readPos) + 1) % ${RING_SIZE}
              }
            }
            if (!this.primed && this.count >= this.targetCount) {
              this.primed = true
            }
          }
        }
        process(inputs, outputs) {
          const channels = outputs[0]
          if (!channels || !channels[0]) return true
          const out0 = channels[0]
          if (!this.primed || this.count < this.primeMin) {
            // Underrun. Try PLC first; only escalate to silence + reprime
            // after we've exhausted the concealment budget.
            //
            // Three sub-cases:
            //   1. !this.primed (cold start) — never PLC, just silence
            //      (we have no last-block content to extend yet).
            //   2. primed && concealQuanta < 4 — PLC: emit decayed copy
            //      of lastBlock. Crucially, do NOT set primed=false —
            //      we want to resume into real audio as soon as count
            //      crosses primeMin again, NOT wait for a full
            //      targetCount refill.
            //   3. primed && concealQuanta >= 4 — give up, silence +
            //      reprime. This is a real glitch the controller couldn't
            //      ride out (server died, ~10 ms of network drop, etc.)
            if (this.primed && this.concealQuanta < this.concealDecay.length) {
              const decay = this.concealDecay[this.concealQuanta]
              for (let i = 0; i < out0.length; i++) {
                out0[i] = this.lastBlock[i % 128] * decay
              }
              this.concealQuanta++
              if (this.concealQuanta === 1) {
                // Only count one PLC event per "underrun episode" to
                // mirror the reprime-counting convention.
                this.concealCount++
                this.port.postMessage({ type: 'plc', count: this.concealCount })
              }
              for (let c = 1; c < channels.length; c++) channels[c].set(out0)
              return true
            }
            // PLC budget exhausted (or never primed) — silence + reprime.
            out0.fill(0)
            for (let c = 1; c < channels.length; c++) channels[c].fill(0)
            if (this.primed) {
              this.reprimeCount++
              this.port.postMessage({ type: 'reprime', count: this.reprimeCount })
            }
            this.primed = false
            this.concealQuanta = 0   // reset — next reprime episode starts fresh
            return true
          }
          // Reached the normal path. If we just exited concealment, mark
          // the transition so the post-render ramp-in knows to crossfade
          // the first few samples.
          const wasConcealing = this.concealQuanta > 0
          this.concealQuanta  = 0
          // Slow control loop: nudge rateScale to keep count near target.
          //
          // v1.0.24 had a deadband around target where rateScale drifted
          // back toward 1.0. That was wrong — once the loop converged to,
          // say, rateScale = 1.003 (compensating ~0.3 % clock drift), any
          // ring that landed inside the deadband would pull rateScale
          // back, ring would refill from drift, drift the rate back,
          // refill, ... a slow oscillation that occasionally clipped
          // PRIME_MIN and fired a reprime even when no real issue was
          // present. v1.0.25 fixed that with a hold-in-deadband
          // integrator (no oscillation in steady state).
          //
          // Phase A v4.1 — proportional fast-adjust. With fixed rateStep,
          // recovering from a 5-frame burst (count = 2.5x target)
          // takes ~12 seconds even at the rail, and during recovery a
          // second burst can pile on. We saw users stuck with
          // rate=+12000ppm for entire sessions and ring=774 (vs
          // target 288) for that reason. The fix: when count is FAR
          // from target, scale the integrator step up so we drain
          // bursts in < 1 sec; near target the step is unchanged so
          // steady-state pitch jitter is identical.
          //
          //   excess > 2.0×  → step × 8   (catastrophic burst recovery)
          //   excess > 1.5×  → step × 4   (large burst)
          //   excess > 1.3×  → step × 1   (normal slow drift adjust)
          //   inside deadband → no change (hold)
          //   below 0.7×     → step × 1   (slow drain too slow)
          //   below 0.5×     → step × 4   (about to underrun)
          const r = this.count / this.targetCount
          let step = 0
          if      (r > 2.0)  step =  this.rateStep * 8
          else if (r > 1.5)  step =  this.rateStep * 4
          else if (r > 1.3)  step =  this.rateStep
          else if (r < 0.5)  step = -this.rateStep * 4
          else if (r < 0.7)  step = -this.rateStep
          if (step !== 0) {
            this.rateScale = Math.min(this.MAX_SCALE,
                              Math.max(this.MIN_SCALE, this.rateScale + step))
          }
          const effRatio = this.ratio * this.rateScale

          // Periodic stats: post ~3× per second so the debug strip updates
          // without flooding the message channel.
          if (++this.statsTick >= 128) {
            this.statsTick = 0
            this.port.postMessage({ type: 'stats', rateScale: this.rateScale, count: this.count })
          }

          for (let i = 0; i < out0.length; i++) {
            const idxF = this.readPos
            const idx  = Math.floor(idxF)
            const frac = idxF - idx
            const a = this.buf[idx]
            const b = this.buf[(idx + 1) % ${RING_SIZE}]
            let sample = a + (b - a) * frac
            // v4.3.8 trim crossfade: when a tune-trim just jumped readPos
            // forward, the first 32 output samples linearly blend the
            // pre-trim audio (held DC at lastBlock[127], the last sample
            // of the previous quantum) toward the post-trim ring content.
            // Cheap, branch-light, and below the audible click threshold
            // for a slider drag's worth of trims.
            if (this.trimFadeRemaining > 0) {
              const t = (32 - this.trimFadeRemaining) / 32
              sample = this.lastBlock[127] * (1 - t) + sample * t
              this.trimFadeRemaining--
            }
            out0[i] = sample
            const newReadPos = idxF + effRatio
            const newIdx     = Math.floor(newReadPos)
            this.count -= (newIdx - idx)
            this.readPos = newReadPos % ${RING_SIZE}
            if (this.count < this.primeMin) {
              // Mid-callback underrun. Phase B v4.2.1 — extend PLC to
              // this path (was top-of-callback only in v4.2.0).
              //
              // With v4.2.0's small primeTarget (144 samp = 3 ms), the
              // ring drains fast enough that most underruns happen
              // partway through a quantum, not at the start. The old
              // cosine-fade-then-zero path was bypassing PLC entirely,
              // producing a reprime cascade (2020+ in a 5-min session)
              // with plc=0. This branch now produces a continuous
              // PLC-style output: keep the samples we already wrote
              // (ramped down briefly to mask the splice), then fill
              // the remainder of the quantum from lastBlock with the
              // same decay schedule as the start-of-callback PLC.
              //
              // Note we don't reset primed. The next quantum will
              // either continue PLC (if ring still empty) or resume
              // normal output with the existing wasConcealing ramp-in.
              const decay = this.concealDecay[this.concealQuanta] ?? 0
              if (decay > 0) {
                // Crossfade region: hold the last real sample (out0[i],
                // already valid) decaying linearly to 0, while ramping
                // in the PLC tail from lastBlock. Sum is a smooth bridge
                // — no sample-step at the splice point.
                const lastReal = out0[i]
                const xfLen = Math.min(16, out0.length - i - 1)
                for (let j = 1; j <= xfLen; j++) {
                  const t = j / xfLen   // 0 → 1
                  const plcVal = this.lastBlock[(i + j) % 128] * decay
                  out0[i + j] = lastReal * (1 - t) + plcVal * t
                }
                // Fill remaining with pure PLC content (decay applied).
                for (let j = i + 1 + xfLen; j < out0.length; j++) {
                  out0[j] = this.lastBlock[j % 128] * decay
                }
                this.concealQuanta++
                if (this.concealQuanta === 1) {
                  this.concealCount++
                  this.port.postMessage({ type: 'plc', count: this.concealCount })
                }
                // Don't reset primed — next quantum either continues
                // PLC or resumes normal output. The post-render
                // lastBlock save below will capture this filled quantum
                // for the next PLC iteration if needed.
                break
              }
              // PLC budget exhausted (concealDecay[concealQuanta] = 0
              // because index ≥ length): fall back to original cosine
              // fade + zero + reprime.
              const fadeLen = i + 1 < 240 ? i + 1 : 240
              for (let f = 0; f < fadeLen; f++) {
                const w = 0.5 * (1 + Math.cos(Math.PI * (1 - f / fadeLen)))
                out0[i - f] *= w
              }
              for (let j = i + 1; j < out0.length; j++) out0[j] = 0
              this.primed = false
              this.concealQuanta = 0     // reset for next episode
              this.reprimeCount++
              this.port.postMessage({ type: 'reprime', count: this.reprimeCount })
              break
            }
          }
          // Ramp-in after concealment: the first 32 samples of the first
          // post-PLC quantum get a linear 0→1 envelope. This avoids a step
          // discontinuity between the last (heavily-decayed) concealment
          // sample and the first real sample. 32 samples = 0.67 ms ramp,
          // long enough to be inaudible but short enough not to mute a
          // significant chunk of resumed content.
          if (wasConcealing) {
            const rampLen = Math.min(32, out0.length)
            for (let i = 0; i < rampLen; i++) {
              out0[i] *= i / rampLen
            }
          }
          // Save this quantum's output for potential PLC use next time.
          // We snapshot AFTER any ramp-in so the PLC source itself doesn't
          // contain the previous concealment's tail (would compound
          // artifacts on back-to-back underruns).
          this.lastBlock.set(out0.subarray(0, 128))
          for (let c = 1; c < channels.length; c++) channels[c].set(out0)
          return true
        }
      }
      registerProcessor('playback-processor', PlaybackProcessor)
    `
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))

    try {
      await this.audioContext.audioWorklet.addModule(url)
      if (!this.audioContext || !this.masterGain) return
      this.playbackWorklet = new AudioWorkletNode(this.audioContext, 'playback-processor')
      this.playbackWorklet.port.onmessage = (ev) => {
        const d = ev.data
        if (!d) return
        if (d.type === 'reprime') this.playReprimeCount = d.count
        else if (d.type === 'plc') this.playPlcCount = d.count
        else if (d.type === 'stats') {
          this.playRateScale = d.rateScale
          this.playRingFill  = d.count
        }
      }
      this.playbackWorklet.connect(this.masterGain)
    } catch (err) {
      console.warn('[Audio] Playback worklet failed, using legacy mode:', err)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private startLevelMonitoring(): void {
    // Level is computed from ScriptProcessor data in onAudioFrame().
    // UI polls audioService.currentLevel directly via requestAnimationFrame.
  }

  onLevel(cb: AudioLevelCallback): void {
    // Legacy: UI now polls currentLevel directly. Kept for compatibility.
    void cb
  }

  /** Set master output gain (0-1 linear). Controls playback volume. */
  setMasterGain(gain: number): void {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(1, gain))
    }
  }

  /**
   * Update the playback worklet's tuning knobs live. Each field is optional;
   * any field omitted retains its current value. Sends a single 'tune'
   * postMessage so the worklet picks up all the changes atomically (no
   * mid-callback inconsistency between, say, primeMin and primeTarget).
   *
   * Ranges enforced here so an unbounded slider can't put the worklet
   * into an unrecoverable state:
   *   primeTarget ∈ [primeMin .. RING_SIZE / 2]
   *   primeMin    ∈ [0 .. primeTarget]
   *   minScale    ∈ [0.95, 1.0)
   *   maxScale    ∈ (1.0, 1.05]
   *   rateStep    ∈ [0, 0.001]
   */
  setPlaybackTuning(t: Partial<AudioService['tuning']>, opts?: { persist?: boolean }): void {
    const next = { ...this.tuning, ...t }
    // Clamp into safe ranges — sliders may land just outside, or a
    // saved value from an older schema may leak through.
    next.primeMin    = Math.max(0,    Math.min(next.primeTarget, next.primeMin))
    // primeTarget floor = primeMin + 192 (= 128-sample quantum + 64
    // jitter cushion). Below that, post-trim count is too low to feed
    // a single quantum without underrunning, and PLC replays
    // lastBlock — rapid panel changes stack PLC events into the
    // audible "听觉上的叠加" effect (see panel_tune_offline.js
    // wiggle_target / drag_target_down scenarios). Schema version 7
    // discards saved slots that sit below the new floor; this clamp
    // is the second line of defence for any values that bypass the
    // schema gate.
    next.primeTarget = Math.max(next.primeMin + 192, Math.min(24000, next.primeTarget))
    next.minScale    = Math.max(0.95, Math.min(0.9999, next.minScale))
    next.maxScale    = Math.min(1.05, Math.max(1.0001, next.maxScale))
    next.rateStep    = Math.max(0, Math.min(0.001, next.rateStep))
    this.tuning = next
    if (this.playbackWorklet) {
      this.playbackWorklet.port.postMessage({
        type: 'tune',
        primeTarget: next.primeTarget,
        primeMin:    next.primeMin,
        maxScale:    next.maxScale,
        minScale:    next.minScale,
        rateStep:    next.rateStep,
      })
    }
    this.fireTuningChanged()
    if (opts?.persist !== false) this.scheduleTuningSave()
  }

  /**
   * Update the server-side per-user jitter buffer. Sends MIXER_TUNE on the
   * control WebSocket; the server clamps to its own ceilings and replies
   * with MIXER_TUNE_ACK carrying the *applied* values (which may differ if
   * the slider went past the server's max). When the ack arrives we update
   * `this.serverTuning` to whatever the server actually applied — single
   * source of truth — and fire the change callback so the UI re-renders.
   */
  setServerTuning(t: Partial<AudioService['serverTuning']>, opts?: { persist?: boolean }): void {
    const next = { ...this.serverTuning, ...t }
    if (this.controlWs?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        type:             'MIXER_TUNE',
        room_id:          this.roomId,
        user_id:          this.userId,
        jitter_target:    next.jitterTarget,
        jitter_max_depth: next.jitterMaxDepth,
      }) + '\n'
      this.controlWs.send(payload)
    }
    // Optimistic update — overwritten on MIXER_TUNE_ACK if server clamped.
    this.serverTuning = next
    this.fireTuningChanged()
    if (opts?.persist !== false) this.scheduleTuningSave()
  }

  /** Debounced write of (this.tuning, this.serverTuning) to localStorage,
   *  keyed by the current (roomId, userId). Calls coalesce inside a
   *  500 ms window so a slider drag (~10 events/sec) yields one write per
   *  second-ish, not 10. */
  private scheduleTuningSave(): void {
    if (!this.roomId || !this.userId) return     // pre-join — nothing to key on
    if (this.tuningSaveTimer) clearTimeout(this.tuningSaveTimer)
    this.tuningSaveTimer = setTimeout(() => {
      this.tuningSaveTimer = null
      try {
        const key = AudioService.tuningStorageKey(this.roomId, this.userId)
        const blob = JSON.stringify({
          v: AudioService.TUNING_SCHEMA_VERSION,
          client: this.tuning,
          server: this.serverTuning,
        })
        localStorage.setItem(key, blob)
      } catch (err) {
        console.warn('[Audio] tuning save failed:', err)
      }
    }, 500)
  }

  /**
   * Read any saved tuning for the *current* room/user and apply it. Called
   * from the MIXER_JOIN_ACK handler (after the server's defaults flow into
   * `this.serverTuning`) so the user's saved values cleanly overlay the
   * server's defaults. If nothing is saved, this is a no-op — `this.tuning`
   * keeps the values from the worklet construction or from a previous room.
   *
   * On a corrupt blob (parse error / shape mismatch), we fall through to
   * resetRoomTuning() which wipes the slot AND restores defaults — better
   * than carrying half-applied junk into the audio path.
   */
  private loadRoomTuningIntoState(): void {
    if (!this.roomId || !this.userId) return
    const key = AudioService.tuningStorageKey(this.roomId, this.userId)
    let raw: string | null = null
    try { raw = localStorage.getItem(key) } catch { return }
    if (!raw) {
      // No saved tuning for this room/user — explicitly reset in-memory
      // values to defaults so a previous room's tuning doesn't leak into
      // this one (the user may have just left a tuned room and entered
      // a fresh one).
      this.setPlaybackTuning(AudioService.DEFAULT_PB,  { persist: false })
      this.setServerTuning(AudioService.DEFAULT_SRV,   { persist: false })
      return
    }
    try {
      const parsed = JSON.parse(raw) as { v?: number;
                                          client?: Partial<AudioService['tuning']>;
                                          server?: Partial<AudioService['serverTuning']> }
      // Schema-version gate: a saved blob older than the current schema
      // (or missing the version field, which means pre-v4.1.0) carries
      // defaults that are now considered wrong (e.g. maxScale 1.012 from
      // v3.x pins rateScale at the OLD rail and defeats Phase A.1).
      // Discard + reset rather than partially applying stale knobs.
      if (typeof parsed.v !== 'number' || parsed.v < AudioService.TUNING_SCHEMA_VERSION) {
        console.log(`[Audio] saved tuning schema v${parsed.v ?? '?'} < current v${AudioService.TUNING_SCHEMA_VERSION}; discarding stale slot for ${this.roomId}:${this.userId}`)
        try { localStorage.removeItem(key) } catch {}
        this.setPlaybackTuning(AudioService.DEFAULT_PB,  { persist: false })
        this.setServerTuning(AudioService.DEFAULT_SRV,   { persist: false })
        return
      }
      if (parsed.client) this.setPlaybackTuning(parsed.client, { persist: false })
      if (parsed.server) this.setServerTuning (parsed.server, { persist: false })
    } catch (err) {
      console.warn('[Audio] tuning parse failed; clearing slot:', err)
      try { localStorage.removeItem(key) } catch {}
      this.setPlaybackTuning(AudioService.DEFAULT_PB,  { persist: false })
      this.setServerTuning(AudioService.DEFAULT_SRV,   { persist: false })
    }
  }

  /** Wipe the persisted slot for the current room AND restore defaults
   *  in-memory + on the worklet + on the server. Bound to the panel's
   *  RESET button. After this, leaving and rejoining the room shows
   *  server defaults (no override saved). */
  resetRoomTuning(): void {
    if (this.roomId && this.userId) {
      try { localStorage.removeItem(AudioService.tuningStorageKey(this.roomId, this.userId)) } catch {}
    }
    this.setPlaybackTuning(AudioService.DEFAULT_PB,  { persist: false })
    this.setServerTuning(AudioService.DEFAULT_SRV,   { persist: false })
  }

  /** True when there's a saved override for the current room/user. The
   *  panel uses this to render the "📍 saved for this room" indicator. */
  hasSavedTuning(): boolean {
    if (!this.roomId || !this.userId) return false
    try {
      return localStorage.getItem(AudioService.tuningStorageKey(this.roomId, this.userId)) !== null
    } catch { return false }
  }
  get currentRoomId(): string { return this.roomId }
  get currentUserId(): string { return this.userId }

  /** Subscribe to remote peer level updates. Callback receives (userId, level 0-1). */
  onPeerLevel(cb: PeerLevelCallback): void {
    this.peerLevelCallback = cb
  }

  /**
   * Snapshot of the current per-peer level map (uid → 0-1).
   * UI consumers should poll this rather than relying on
   * `onPeerLevel` callbacks alone — the callbacks only fire for
   * upserts, so a user who LEFT (and got pruned from the
   * mixer-side LEVELS broadcast) would otherwise stay in the UI
   * forever. v3.7.4 added the poll-based reconcile in RoomPage to
   * close that gap.
   */
  get peerLevelsSnapshot(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [uid, lvl] of this.peerLevels) out[uid] = lvl
    return out
  }

  /** Notified once when this session is displaced by a newer join with the
   *  same user_id (e.g. logging in on a second device). */
  onSessionReplaced(cb: () => void): void {
    this.sessionReplacedCallback = cb
  }

  /** Get last known level for a peer (0-1), or 0 if unknown. */
  getPeerLevel(userId: string): number {
    return this.peerLevels.get(userId) ?? 0
  }

  /** How many users the SERVER thinks are in this room (from the LEVELS broadcast).
   *  Includes self. > 1 means N-1 mix is active; 1 means solo loopback. */
  get serverPeerCount(): number {
    return this.peerLevels.size
  }

  // ── Capture: AudioWorklet → 5 ms frames → SPA1 encode → send ─────────────
  //
  // The chain runs an AudioWorklet on the audio thread (NOT the deprecated
  // `ScriptProcessorNode` which sits on the main thread and drops callbacks
  // under load). The worklet does three jobs in process():
  //   1. Resample the mic input from `sampleRate` (AudioContext rate) to
  //      48 kHz, with a fractional readPos that carries across blocks so
  //      adjacent quanta join cleanly.
  //   2. Slice the resampled stream into 240-sample (5 ms @ 48 kHz) frames.
  //   3. Track the per-block peak to surface mic clipping (sample ≥ 1.0).
  // It posts one message per frame to the main thread, where we just
  // PCM16-encode and ship.
  //
  // The previous ScriptProcessorNode capture path was the suspected source
  // of the v1.0.19 residual "破音" — at 48 kHz context the rest of the chain
  // is provably clean (Node + browser tests both at < 0.05 % THD), so the
  // remaining nonlinearity had to come from the capture stage. ScriptProcessor
  // at buffer 256 is at the lower edge of where Chromium reliably calls it,
  // and any callback-drop or main-thread-jank-induced underrun would land on
  // signal peaks where listeners hear it as breaking sound.

  private captureSink: GainNode | null = null  // 0-gain sink, prevents mic→speaker leak

  private captureClipCount = 0  // mic samples observed at |s| >= 1.0
  /** Total mic samples observed at |s| ≥ 1.0 (hardware clipping at the source). */
  get captureClipCountValue(): number { return this.captureClipCount }

  // Which capture path actually took over. Diagnostic — lets us see at a
  // glance whether we got the audio-thread worklet or fell back to the
  // main-thread ScriptProcessor (in which case clip detection isn't
  // running and the worklet-only fixes don't apply).
  private captureMode: 'idle' | 'worklet' | 'script-processor' = 'idle'
  get captureModeValue(): 'idle' | 'worklet' | 'script-processor' { return this.captureMode }

  public startCapture(): void {
    if (this.isCapturing || !this.audioContext) return
    this.isCapturing = true
    this.sequence     = 0
    this.captureClipCount = 0
    // Try AudioWorklet first; fall back to ScriptProcessor if module
    // registration fails (very old browsers / Worklet-blocking policies).
    void this.initCaptureWorklet().then((ok) => {
      if (ok) {
        this.captureMode = 'worklet'
        console.log('[Audio] Capture path: AudioWorklet')
      } else {
        console.warn('[Audio] Capture worklet failed, falling back to ScriptProcessor')
        this.startCaptureWithScriptProcessor()
        this.captureMode = 'script-processor'
        console.log('[Audio] Capture path: ScriptProcessor (fallback)')
      }
    })
  }

  private async initCaptureWorklet(): Promise<boolean> {
    if (!this.audioContext || !this.source) return false

    const FRAME_SIZE_LOCAL = FRAME_SAMPLES   // 240 = 5 ms @ 48 kHz
    const code = `
      class CaptureProcessor extends AudioWorkletProcessor {
        constructor() {
          super()
          this.frameSize  = ${FRAME_SIZE_LOCAL}
          this.outBuf     = new Float32Array(this.frameSize)
          this.outPos     = 0
          // Resampler: input samples per output sample. ratio === 1 short-circuits
          // when the AudioContext is at 48 kHz, sparing the interp on the hot path.
          this.ratio      = sampleRate / 48000
          this.phase      = 0
          this.lastSample = 0
          this.peakBlock  = 0      // running peak |sample| inside the current frame
          this.clips      = 0      // samples observed at |s| >= 1.0 (hardware clip)
        }
        process(inputs, outputs) {
          // Capture-only: we read inputs and post frames back to the
          // main thread. We never want our outputs to reach the speaker.
          // Explicitly zero outputs every quantum — an unmodified output
          // buffer's contents are spec'd to be zero, but we don't trust
          // that across all browser builds. Combined with the 0-gain
          // sink the main thread routes our output through, this gives
          // a hard guarantee against any local mic→speaker loopback.
          if (outputs && outputs[0]) {
            for (let c = 0; c < outputs[0].length; c++) outputs[0][c].fill(0)
          }
          const input = inputs[0]
          if (!input || !input[0] || input[0].length === 0) return true
          const block = input[0]

          // v3.4.8: post the raw input block (pre-resample, AT context
          // rate) for the monitor worklet. Posting the wire-rate
          // (48 kHz) frame instead caused queue accumulation at the
          // monitor whenever AudioContext rate ≠ 48 kHz: capture
          // produces samples at 48k pace, but monitor's process() runs
          // at context rate (44.1 kHz on Bluetooth output is the
          // common bad case), so ~3900 samples/sec accumulate in the
          // queue → growing latency until the cap kicks in. Raw block
          // is by definition at context rate, so producer and consumer
          // match exactly. Each block is 128 samples (one quantum).
          const rawCopy = new Float32Array(block)
          this.port.postMessage({ rawBlock: rawCopy }, [rawCopy.buffer])

          // Track hardware clipping at the input — surfaces as a stat
          // back to the main thread so the user can tell when their mic
          // gain is the actual problem (vs. our code).
          for (let i = 0; i < block.length; i++) {
            const a = block[i] >= 0 ? block[i] : -block[i]
            if (a >= 1.0) this.clips++
            if (a > this.peakBlock) this.peakBlock = a
          }

          // Resample to 48 kHz with sample-accurate phase across block boundaries.
          let outSamples
          if (this.ratio === 1) {
            outSamples = block
          } else {
            const ext = new Float32Array(block.length + 1)
            ext[0] = this.lastSample
            ext.set(block, 1)
            const tmp = []
            let p = this.phase
            while (Math.floor(p) + 1 < ext.length) {
              const idx  = Math.floor(p)
              const frac = p - idx
              tmp.push(ext[idx] + (ext[idx + 1] - ext[idx]) * frac)
              p += this.ratio
            }
            this.phase      = p - block.length
            this.lastSample = block[block.length - 1]
            outSamples = tmp
          }

          // Accumulate into 240-sample frames; post each completed frame.
          for (let i = 0; i < outSamples.length; i++) {
            this.outBuf[this.outPos++] = outSamples[i]
            if (this.outPos >= this.frameSize) {
              const frame = this.outBuf.slice(0, this.frameSize)
              const stats = { clips: this.clips, peak: this.peakBlock }
              this.peakBlock = 0
              this.clips     = 0
              this.port.postMessage({ frame, stats }, [frame.buffer])
              this.outPos = 0
            }
          }
          return true
        }
      }
      registerProcessor('capture-processor', CaptureProcessor)
    `
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
    try {
      await this.audioContext.audioWorklet.addModule(url)
      if (!this.audioContext || !this.source) return false
      const node = new AudioWorkletNode(this.audioContext, 'capture-processor')
      node.port.onmessage = (ev) => {
        const d = ev.data
        // Two message shapes:
        //   { rawBlock: Float32Array }       per-quantum block at context
        //                                    rate, forwarded to monitor.
        //   { frame: Float32Array, stats }   wire-rate frame for SPA1 send.
        if (d.rawBlock && this.monitorWorklet) {
          // Forward to monitor at context rate. Honour mute + input
          // gain so the INPUT TRACKS fader audibly affects the user's
          // own monitor too — pre-v3.5.2 inputGain only scaled the
          // outgoing SPA1 (so peers heard the change but the user
          // heard their monitor unchanged, which read as "fader does
          // nothing").
          if (this.muted) {
            d.rawBlock.fill(0)
          } else if (this.inputGain !== 1.0) {
            const g = this.inputGain
            for (let i = 0; i < d.rawBlock.length; i++) d.rawBlock[i] *= g
          }
          this.monitorWorklet.port.postMessage(d.rawBlock, [d.rawBlock.buffer])
          return
        }
        const { frame, stats } = d
        if (!frame) return
        if (stats?.clips) this.captureClipCount += stats.clips
        this.sendCapturedFrame(frame as Float32Array)
      }
      // v3.6.0: feed from the per-channel summing bus, not from a
      // single mic source. inputSumGain carries the user's complete
      // input mix (channel 0 + any additional channels added via
      // addInputChannel), so the captured frame and the local monitor
      // both receive the mixed signal.
      if (this.inputSumGain) this.inputSumGain.connect(node)
      else if (this.source)  this.source.connect(node)   // safety net
      // AudioWorkletNode needs to be connected somewhere downstream for the
      // audio thread to keep invoking process(). Route through a 0-gain
      // GainNode before destination — this guarantees no mic→speaker
      // loopback regardless of what the worklet's outputs contain. The
      // worklet zeroes them too (defense in depth), but a ground-truth
      // 0-gain sink is the version that survives every browser quirk.
      const sink = this.audioContext.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(this.audioContext.destination)
      this.captureSink = sink
      this.processor = node
      return true
    } catch (err) {
      console.warn('[Audio] addModule(capture-processor) failed:', err)
      return false
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private sendCapturedFrame(frame: Float32Array): void {
    // Level meter for UI (RMS + EMA smoothing, matches AppKit AudioBridge).
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)
    this.smoothedLevel = this.smoothedLevel * 0.8 + rms * 0.2
    this.currentLevel = Math.min(1.0, this.smoothedLevel * 5)

    // (v3.4.7's forward of the wire-rate frame to the monitor worklet
    // moved to the capture-worklet's `rawBlock` path in v3.4.8 — the
    // wire-rate (48 kHz) frame caused queue accumulation when the
    // AudioContext rate ≠ 48 kHz. Raw block is at context rate.)

    // Gate the capture send on whichever audio transport is active.
    // No-op early-out keeps the level meter and per-channel processing
    // running even when the wire is briefly down (mid-reconnect).
    if (!this.isAudioTransportReady()) return
    if (this.muted) {
      // Worklet doesn't know about mute; zero the frame here so server
      // sees silence rather than mic content while muted.
      frame.fill(0)
    } else if (this.inputGain !== 1.0) {
      // Input gain — scale samples in place before encode. PCM16 will
      // hard-clamp to [-1, 1] so a gain > ~3 starts visibly clipping;
      // we cap at 2 in the setter, so worst case is +6 dB headroom and
      // peaks above 0.5 nominal start saturating audibly. Acceptable
      // tradeoff vs adding a soft-clip stage on the input.
      const g = this.inputGain
      for (let i = 0; i < frame.length; i++) frame[i] *= g
    }
    const uid = `${this.roomId}:${this.userId}`
    const pcm16 = float32ToPcm16(frame)
    const spa1 = buildSpa1Packet(pcm16, SPA1_CODEC_PCM16, this.sequence++, 0, uid)
    this.sendAudioPacket(spa1)
    this.txCount++
  }

  /**
   * True if at least one audio transport (WT or WSS) is ready to
   * accept a packet. Used as the early-out gate in the capture
   * callback so the level meter / channel UI keeps running across
   * reconnect blips.
   */
  private isAudioTransportReady(): boolean {
    if (this.audioWT && this.audioWTWriter) return true
    return this.audioWs?.readyState === WebSocket.OPEN
  }

  private startCaptureWithScriptProcessor(): void {
    if (!this.audioContext) return
    // 256 samples = 5.33 ms per callback ≈ 1 SPA1 frame (240 each) shipped
    // per callback with leftover carried over. This matters because the
    // server mixer is single-buffered per track: addTrack overwrites the
    // previous frame, and only one broadcast happens per 5 ms timer slot.
    //
    // Larger sizes ship multiple frames in a burst inside one callback,
    // and the server keeps only the last frame in each 5 ms slot:
    //   bufferSize=512 (10.67 ms): ~2-3 frames per burst → server keeps 1
    //     → ~75 packets/s reaches the client (vs. the expected 200/s)
    //   bufferSize=1024 (21.33 ms): ~4 frames per burst → ~50 packets/s
    //
    // The web client schedules each received 5 ms packet on a continuous
    // playTime timeline; when packets arrive at < 200/s, playTime falls
    // behind currentTime, the re-anchor branch fires constantly, and each
    // re-anchor introduces a small discontinuity. Stacked at tens of
    // events per second, the discontinuities sound like persistent
    // electrical static — the symptom v1.0.9 reintroduced when this
    // value was changed to 512.
    //
    // v1.0.9 thought 256 was unreliable (callback drops under load). In
    // practice, on the browsers this app supports, 256 is fine — the
    // packet-loss-via-server-overwrite issue dominates over any rare
    // ScriptProcessor underrun.
    const node = this.audioContext.createScriptProcessor(256, 1, 1)
    node.onaudioprocess = (ev) => {
      // Always send frames (even silence when muted) to keep server mixer alive
      // AppKit: audio callback always runs, mute just zeros the data
      const input = ev.inputBuffer.getChannelData(0)
      const raw   = this.muted ? new Float32Array(input.length) : new Float32Array(input)
      // Resample mic input to the wire rate (48 kHz) before slicing into
      // 240-sample frames. Without this, when the AudioContext lands at
      // 44.1 kHz (Bluetooth output, system mixer override) the 240
      // samples-per-frame label "5 ms of 48 kHz" is a lie — they're
      // really 5.44 ms of 44.1 kHz audio. Receivers play that back as
      // 5 ms at 48 kHz, pitch-shifting by +8.8 %, so the user hears
      // their own voice come back through the server-side echo at the
      // wrong pitch overlaid on the correct peer audio. (v1.0.14)
      const wireSamples = this.resampleCaptureTo48k(raw)
      if (wireSamples.length > 0) this.onAudioFrame(wireSamples)
    }
    // v3.6.0: feed from inputSumGain so this fallback also gets the
    // multi-input mix instead of just channel 0's raw source.
    if (this.inputSumGain) {
      this.inputSumGain.connect(node)
    } else if (this.source) {
      this.source.connect(node)
    }
    // Route through a 0-gain GainNode before destination — same defense
    // the worklet capture path already has. ScriptProcessor's outputBuffer
    // contents are implementation-defined when not written by the
    // onaudioprocess handler; most browsers zero them, but a 0-gain sink
    // is the version that survives every browser quirk and prevents any
    // stray mic→speaker leak. AudioWorkletNode/ScriptProcessor still need
    // a downstream connection to keep their callbacks firing — the
    // 0-gain node satisfies that without making the mic audible locally.
    const sink = this.audioContext.createGain()
    sink.gain.value = 0
    node.connect(sink)
    sink.connect(this.audioContext.destination)
    this.captureSink = sink
    this.processor = node
  }

  // ── Capture-side resampler state ───────────────────────────────────────────
  // Linear-interpolation resampler that converts the mic stream from the
  // AudioContext's actual sample rate to the wire rate (48 kHz). State is
  // carried across ScriptProcessor callbacks so packet boundaries don't
  // drop or duplicate samples. Mirrors the in-worklet playback resampler.
  private capCarry: Float32Array = new Float32Array(0)
  private capPhase: number = 0

  private resampleCaptureTo48k(input: Float32Array): Float32Array {
    if (!this.audioContext) return input
    const ctxRate = this.audioContext.sampleRate
    if (ctxRate === SAMPLE_RATE) return input
    const ratio = ctxRate / SAMPLE_RATE   // input samples per output sample
    let buf: Float32Array
    if (this.capCarry.length > 0) {
      buf = new Float32Array(this.capCarry.length + input.length)
      buf.set(this.capCarry, 0)
      buf.set(input, this.capCarry.length)
    } else {
      buf = input
    }
    const out: number[] = []
    let phase = this.capPhase
    while (Math.floor(phase) + 1 < buf.length) {
      const idx = Math.floor(phase)
      const frac = phase - idx
      out.push(buf[idx] + (buf[idx + 1] - buf[idx]) * frac)
      phase += ratio
    }
    const consumedInt = Math.floor(phase)
    this.capCarry = buf.slice(consumedInt)
    this.capPhase = phase - consumedInt
    return new Float32Array(out)
  }

  private smoothedLevel = 0
  // Continuous playback timeline: each incoming 5ms PCM16 frame is scheduled
  // at playTime, then playTime advances by frame.duration. When a network
  // gap pushes playTime into the past, we re-anchor to currentTime + lookahead.
  private playTime = 0
  private readonly PLAYBACK_LOOKAHEAD_SEC = 0.04  // 40ms jitter cushion

  private onAudioFrame(f32: Float32Array): void {
    // Input level: linear RMS + EMA smoothing (AppKit AudioBridge pattern)
    let sum = 0
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i]
    const rms = Math.sqrt(sum / f32.length)
    this.smoothedLevel = this.smoothedLevel * 0.8 + rms * 0.2
    this.currentLevel = Math.min(1.0, this.smoothedLevel * 5)

    if (this.audioWs?.readyState !== WebSocket.OPEN) return
    const uid = `${this.roomId}:${this.userId}`

    // Concatenate any leftover from the previous callback in front of the
    // new samples so frame boundaries are never dropped.
    let buf: Float32Array
    if (this.captureLeftover.length > 0) {
      buf = new Float32Array(this.captureLeftover.length + f32.length)
      buf.set(this.captureLeftover, 0)
      buf.set(f32, this.captureLeftover.length)
    } else {
      buf = f32
    }

    let offset = 0
    while (offset + FRAME_SAMPLES <= buf.length) {
      const frame = buf.subarray(offset, offset + FRAME_SAMPLES)
      const pcm16 = float32ToPcm16(frame)
      const spa1 = buildSpa1Packet(pcm16, SPA1_CODEC_PCM16, this.sequence++, 0, uid)
      this.sendAudioPacket(spa1)
      this.txCount++
      offset += FRAME_SAMPLES
    }
    // Carry the tail (always < FRAME_SAMPLES) into the next callback.
    this.captureLeftover = offset < buf.length
      ? new Float32Array(buf.subarray(offset))
      : new Float32Array(0)
  }

  // ── Mixer WebSocket connection (control + audio) ───────────────────────────

  /**
   * Send one SPA1 audio packet to the mixer over whichever audio
   * transport is currently active. Routes through WebTransport
   * datagrams when available, falls back to the WSS audio socket
   * otherwise. Silent no-op if neither is connected — capture loop
   * runs at 200 Hz and we don't want to log-spam during a brief
   * reconnect window.
   *
   * Note: WT writes return a Promise we deliberately don't await —
   * fire-and-forget is the right model for unreliable datagrams,
   * matching the WSS path's WebSocket.send() semantics.
   */
  private sendAudioPacket(buf: ArrayBuffer): void {
    if (this.audioWT && this.audioWTWriter) {
      // WT writer typing wants a Uint8Array view; the underlying
      // bytes are the same so this is a zero-copy wrap.
      void this.audioWTWriter.write(new Uint8Array(buf)).catch((_err) => {
        // WT writer rejects when the session has closed mid-send.
        // The wt.closed promise handler will tear down state; we
        // just drop this packet rather than logging on every send.
      })
      return
    }
    if (this.audioWs?.readyState === WebSocket.OPEN) {
      this.audioWs.send(buf)
    }
  }

  /**
   * Decide which audio transport to use for this connect. Honours
   * `?transport=wt|wss|auto` so a developer can force a path
   * without code changes; defaults to "WT if the browser supports
   * it, WSS otherwise". Safari / older browsers fall through to
   * WSS automatically — there's no `WebTransport` global there.
   */
  private chooseAudioTransport(): 'wt' | 'wss' {
    const forced = new URLSearchParams(location.search).get('transport')
    if (forced === 'wss') return 'wss'
    if (forced === 'wt')  return 'wt'   // user explicitly asked for WT — let connect fail loudly if unsupported
    // v5.0.0: production migrated to 酷番云广州 (srv.tonel.io DNS-A
    // points there). The new provider's hypervisor egress bursts UDP
    // datagrams enough to produce 破音 on the WT path
    // (project_kufan_udp_burst memory; audio_quality_e2e.js --mode wt
    // shows 4-15× click_rate vs WSS). All / users force WSS.
    //
    // /new is the Aliyun fallback path (DNS-A points to old server)
    // — the Aliyun route has clean UDP, so /new keeps WT default
    // and gets the latency benefit. AppKit users still hardcoded to
    // Aliyun also use the same UDP path; if WT works for /new, it
    // works for them.
    if (location.pathname.startsWith('/new')) {
      return (typeof WebTransport !== 'undefined') ? 'wt' : 'wss'
    }
    return 'wss'
  }

  /**
   * Try to open a WebTransport audio session. Returns true on success
   * (audioWT/Writer/Reader populated, read loop spawned). Returns
   * false on any failure — the caller should fall back to WSS.
   *
   * Failure modes we tolerate cleanly:
   *   - browser has no WebTransport global (older Chrome / Safari)
   *   - server cert invalid for the WT host (LetsEncrypt mis-issue)
   *   - UDP 4433 blocked by user's network (corporate firewalls
   *     often block non-443 UDP — common reason WT can't connect
   *     even when the spec says it should)
   *   - server-side `tonel-wt-mixer-proxy` is down (mid-rollout
   *     scenario where we ship the client before the server)
   *
   * Each of these collapses to "fall back to WSS" with one warning
   * line, never an unhandled rejection.
   */
  private async tryWebTransport(audioWtUrl: string): Promise<boolean> {
    if (typeof WebTransport === 'undefined') return false
    try {
      const wt = new WebTransport(audioWtUrl)
      // wt.ready resolves after the QUIC + WT handshakes complete.
      // If the server is unreachable or the cert is bad this rejects.
      await wt.ready
      this.audioWT       = wt
      this.audioWTWriter = wt.datagrams.writable.getWriter()
      this.audioWTReader = wt.datagrams.readable.getReader()
      // Background reader loop. Each datagram is one SPA1 packet.
      void this.runAudioWTReadLoop()
      // Watch for session close so we can clean up references —
      // the resolved value is { closeCode, reason } on graceful
      // close; rejected for transport errors. Either way we drop
      // state and the next reconnect cycle will retry WT.
      wt.closed.then((info) => {
        console.log('[Mixer] WebTransport closed:', info)
      }).catch((err) => {
        console.warn('[Mixer] WebTransport closed with error:', err)
      }).finally(() => {
        this.audioWT       = null
        this.audioWTWriter = null
        this.audioWTReader = null
      })
      return true
    } catch (err) {
      console.warn('[Mixer] WebTransport connect failed, will fall back to WSS:', err)
      return false
    }
  }

  /**
   * Read datagrams off the WT session and route them through the
   * same handler the WSS audio path uses. Each datagram is a full
   * SPA1 packet; `handleMixerMessage` already takes ArrayBuffer.
   */
  private async runAudioWTReadLoop(): Promise<void> {
    if (!this.audioWTReader) return
    try {
      while (true) {
        const { value, done } = await this.audioWTReader.read()
        if (done) break
        // value is a Uint8Array view; copy into a fresh ArrayBuffer
        // so we don't pin the WT runtime's internal pool buffer
        // (it gets reused across reads). The cast is safe because
        // the WT spec guarantees standard ArrayBuffer-backed views.
        const copy = new Uint8Array(value.byteLength)
        copy.set(value)
        this.handleMixerMessage(copy.buffer)
      }
    } catch (err) {
      console.warn('[Mixer] WT read loop ended:', err)
    }
  }

  public async connectMixer(userId: string, roomId: string): Promise<void> {
    this.userId = userId
    this.roomId = roomId

    // v5.1.9: removed `mixerRttProbe.stop()` + the await-old-CLOSED
    // cleanup. The whole reason both existed is gone — `mixerRttProbe`
    // was a homepage-only singleton that opened its own /mixer-tcp
    // socket, racing audioService's socket on every room entry. v5.1.9
    // deletes the probe entirely (the homepage figure is now an
    // animated placeholder), so this code path can never have a
    // concurrent /mixer-tcp socket from another part of the app to
    // wait for. The user-driven retry path also no longer races —
    // `runInit` reaches connectMixer at most twice in practice (the
    // useEffect auto-attempt and the 启用麦克风 click), and after
    // v5.1.9 the only socket the cleanup needs to consider is one
    // from a previous attempt of audioService itself.

    // Clean up any existing transports from a prior connectMixer call
    // (e.g. user pressed 启用麦克风 to retry). Synchronous close is
    // fine here: the new socket below opens against the same path,
    // and the酷番云 WAF dropped the second handshake only when two
    // were established from different code paths within the same
    // millisecond. A retry-after-failure here is sequenced through
    // React state and a user click, leaving plenty of time for the
    // old socket to drain.
    if (this.controlWs || this.audioWs || this.audioWT) {
      console.log('[Mixer] Cleaning up existing transports before reconnect')
      try { this.controlWs?.close() } catch (_) {}
      try { this.audioWs?.close() } catch (_) {}
      try { this.audioWT?.close() } catch (_) {}
      this.controlWs       = null
      this.audioWs         = null
      this.audioWT         = null
      this.audioWTWriter   = null
      this.audioWTReader   = null
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Direct connection to Alibaba Cloud server (bypasses Cloudflare Tunnel).
    // /new path routes to the Guangzhou test mixer; root path stays on production.
    // This pairing must stay in sync with App.tsx pathPrefix() and
    // signalService.ts apiHost selection. (Originally added in v4.3.2,
    // dropped during a v4.3.5 refactor — re-added in v4.3.10.)
    const host = location.pathname.startsWith('/new') ? 'srv-new.tonel.io' : 'srv.tonel.io'
    const controlUrl = `${protocol}//${host}/mixer-tcp`
    const audioUrl   = `${protocol}//${host}/mixer-udp`
    // WebTransport listens on UDP 4433 with the same TLS cert as
    // nginx — the URL is always https:// regardless of page protocol
    // (WebTransport is HTTPS-only, no ws/wss equivalent).
    const audioWtUrl = `https://${host}:4433/mixer-wt`

    // Decide audio transport BEFORE wiring the control channel —
    // we want the resolve() to wait on the actual audio path that
    // ends up being used. WT attempt happens up-front so we know
    // whether to skip creating audioWs or not.
    const chosen = this.chooseAudioTransport()
    let useWT = false
    if (chosen === 'wt') {
      useWT = await this.tryWebTransport(audioWtUrl)
    }
    this.audioTransport = useWT ? 'wt' : 'wss'
    console.log(`[Mixer] audio transport: ${this.audioTransport}` +
                (chosen === 'wt' && !useWT ? ' (WT attempted, fell back)' : ''))

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Mixer 连接超时'))
      }, 15000)

      let controlReady = false
      // When WT is the active audio transport, audioReady is already
      // true (tryWebTransport returned only on a fully-handshaken
      // session). When WSS, audioReady flips on audioWs.onopen.
      let audioReady = useWT
      const checkBothReady = () => {
        if (controlReady && audioReady) {
          clearTimeout(timer)
          // Send MIXER_JOIN via control channel
          console.log('[Mixer] Both transports ready, sending MIXER_JOIN')
          this.controlWs?.send(JSON.stringify({
            type:    'MIXER_JOIN',
            room_id: this.roomId,
            user_id: this.userId,
          }) + '\n')
          // Send SPA1 handshake on the audio channel — same packet
          // works for both WT and WSS. The proxy on the other side
          // uses it to register the uid → session mapping.
          console.log(`[Mixer] Sending SPA1 handshake on audio channel (${this.audioTransport})`)
          const pkt = buildSpa1Packet(
            new Uint8Array(0),
            SPA1_CODEC_HANDSHAKE,
            0, 0,
            `${this.roomId}:${this.userId}`
          )
          this.sendAudioPacket(pkt)
          resolve()
        }
      }

      // ── Sequential WebSocket open ───────────────────────────────────────
      //
      // v5.1.10: open controlWs FIRST, audioWs only after controlWs is
      // OPEN. Previously the two were created back-to-back synchronously,
      // which made them race onto the wire as concurrent WSS handshakes
      // to the same nginx (one to /mixer-tcp, one to /mixer-udp, both
      // proxying to the same upstream :9005). The酷番云 hypervisor
      // sometimes dropped one of the two — surfaced to the user as
      // 'Audio WebSocket 连接失败' (when /mixer-udp lost the race) or
      // 'Control WebSocket 连接失败' (when /mixer-tcp did). Sequencing
      // them adds ~one network RTT (~5-15 ms in China) to room-entry
      // time, which is negligible vs. the cost of a failed join.

      const openAudioWs = () => {
        if (useWT) return  // WT already up — no audio WS needed
        this.audioWs = new WebSocket(audioUrl)
        this.audioWs.binaryType = 'arraybuffer'
        this.audioWs.onopen = () => {
          console.log('[Mixer] Audio WebSocket open')
          audioReady = true
          checkBothReady()
        }
        this.audioWs.onmessage = (evt) => {
          this.handleMixerMessage(evt.data)
        }
        this.audioWs.onclose = () => {
          console.log('[Mixer] Audio WebSocket closed, reconnecting...')
          // Auto-reconnect audio WS (matches AppKit's persistent UDP socket)
          setTimeout(() => {
            if (!this.audioWs || this.audioWs.readyState > 1) {
              this.audioWs = new WebSocket(audioUrl)
              this.audioWs.binaryType = 'arraybuffer'
              this.audioWs.onopen = () => {
                console.log('[Mixer] Audio WebSocket reconnected')
                // Re-send handshake to re-register UDP return path
                const pkt = buildSpa1Packet(
                  new Uint8Array(0), SPA1_CODEC_HANDSHAKE, 0, 0,
                  `${this.roomId}:${this.userId}`
                )
                this.sendAudioPacket(pkt)
              }
              this.audioWs.onmessage = (evt) => this.handleMixerMessage(evt.data)
              this.audioWs.onclose = () => {
                console.log('[Mixer] Audio WebSocket closed again, will retry...')
                setTimeout(() => this.audioWs?.onclose?.(new CloseEvent('close')), 3000)
              }
              this.audioWs.onerror = () => {}
            }
          }, 1000)
        }
        this.audioWs.onerror = (evt) => {
          console.error('[Mixer] Audio WebSocket error:', evt)
          clearTimeout(timer)
          reject(new Error('Audio WebSocket 连接失败'))
        }
      }

      // ── Control WebSocket (/mixer-tcp) ──────────────────────────────────
      this.controlWs = new WebSocket(controlUrl)
      this.controlWs.binaryType = 'arraybuffer'
      this.controlWs.onopen = () => {
        console.log('[Mixer] Control WebSocket open')
        controlReady = true
        // Now that the first WSS is fully handshaken, kick off the
        // audio one. checkBothReady() runs on whichever finishes last.
        openAudioWs()
        checkBothReady()
      }
      this.controlWs.onmessage = (evt) => {
        this.handleMixerMessage(evt.data)
      }
      this.controlWs.onclose = () => {
        console.log('[Mixer] Control WebSocket closed')
        this.stopCapture()
      }
      this.controlWs.onerror = (evt) => {
        console.error('[Mixer] Control WebSocket error:', evt)
        clearTimeout(timer)
        reject(new Error('Control WebSocket 连接失败'))
      }
    })
  }

  private handleMixerMessage(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      // Handle possible multi-line JSON (newline-delimited from TCP)
      const lines = data.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) this.handleJsonMessage(trimmed)
      }
      return
    }

    // Binary SPA1 packet from mixer server (mixed audio response)
    const header = parseSpa1Header(data)
    if (!header) return
    this.rxCount++

    // TODO: RTT measurement disabled — was causing page freeze due to
    // timestamp calculation issues. Will re-implement with proper sequenced PING.

    switch (header.codec) {
      case SPA1_CODEC_PCM16:
        this.playPcm16(data)
        break
      case SPA1_CODEC_OPUS:
        // Opus decode requires opus.js — not included in this build
        break
      default:
        console.warn(`[Mixer] Unknown SPA1 codec: ${header.codec}`)
    }
  }

  private handleJsonMessage(data: string): void {
      try {
        const msg = JSON.parse(data)
        if (msg.type === 'MIXER_JOIN_ACK') {
          console.log('[Mixer] MIXER_JOIN_ACK received, starting capture')
          // Server reports its current jitter defaults inline so the debug
          // panel can render slider initial positions matching reality.
          // Missing fields = older server build → keep our local defaults.
          if (typeof msg.jitter_target === 'number') {
            this.serverTuning.jitterTarget = msg.jitter_target
          }
          if (typeof msg.jitter_max_depth === 'number') {
            this.serverTuning.jitterMaxDepth = msg.jitter_max_depth
          }
          // Overlay the user's saved per-room tuning (if any) on top of
          // the server's defaults. setServerTuning will fire MIXER_TUNE
          // back to the server, so the room jitter buffer goes from
          // server-default → user-saved within one round trip. Stored
          // with `persist: false` so this rehydration doesn't loop.
          this.loadRoomTuningIntoState()
          this.fireTuningChanged()
          this.startCapture()
          this.startPing()
        } else if (msg.type === 'MIXER_TUNE_ACK') {
          // Server clamped to its own ceilings; treat the ack as the source
          // of truth and overwrite local state with what was actually
          // applied. fireTuningChanged() then re-renders the slider so the
          // user sees the clamp visually.
          if (typeof msg.jitter_target === 'number') {
            this.serverTuning.jitterTarget = msg.jitter_target
          }
          if (typeof msg.jitter_max_depth === 'number') {
            this.serverTuning.jitterMaxDepth = msg.jitter_max_depth
          }
          this.fireTuningChanged()
        } else if (msg.type === 'HANDSHAKE_ACK' || msg.type === 'OK') {
          console.log('[Mixer] Handshake ack, starting capture')
          this.startCapture()
          this.startPing()
        } else if (msg.type === 'LEVELS' && msg.levels) {
          // Per-user input levels from mixer server: { "user1": 0.42, "user2": 0.15, ... }
          // The server sends ALL current room users every ~50 ms, so anyone
          // missing from this snapshot has left. Pre-v3.4.0 this handler
          // only `set()`-ed the present users and never `delete()`-d the
          // absent ones — `peerLevels.size` accumulated ghost entries, so
          // `serverPeerCount` was wrong any time someone left and
          // `updateMonitorGain` would treat a single-user room as multi.
          const present = new Set(Object.keys(msg.levels))
          for (const uid of [...this.peerLevels.keys()]) {
            if (!present.has(uid)) this.peerLevels.delete(uid)
          }
          for (const [uid, level] of Object.entries(msg.levels)) {
            this.peerLevels.set(uid, level as number)
            if (this.peerLevelCallback) this.peerLevelCallback(uid, level as number)
          }
          // Engage / disengage local monitor at the population boundary.
          this.updateMonitorGain()
        } else if (msg.type === 'PONG') {
          // PONG received — RTT = now − pingSentAt. The control WS goes
          // through the same TCP path as MIXER_JOIN, so this is the
          // server-round-trip latency that matches what listeners
          // perceive as "echo time" for the UDP audio stream.
          if (this.pingSentAt > 0) {
            const rtt = Math.round(performance.now() - this.pingSentAt)
            this._audioLatency = rtt
            this.pingSentAt = 0
            for (const cb of this.latencyCallbacks) {
              try { cb(rtt) } catch (_) {}
            }
          }
        } else if (msg.type === 'SESSION_REPLACED') {
          // Another device/tab joined with the same userId. The audio path
          // server-side has already handed our slot to the new session;
          // emit so App can route the user back home with a toast.
          console.warn('[Mixer] Session replaced by another device for', msg.user_id)
          if (this.sessionReplacedCallback) {
            try { this.sessionReplacedCallback() } catch (_) {}
          }
        }
      } catch (_) {
        console.warn('[Mixer] Non-JSON string:', data)
      }
  }

  // ── Audio playback ─────────────────────────────────────────────────────────

  private playPcm16(data: ArrayBuffer): void {
    if (!this.audioContext || !this.masterGain) return
    // Ensure AudioContext is running (may be suspended by browser policy)
    if (this.audioContext.state === 'suspended') this.audioContext.resume()

    const header = parseSpa1Header(data)
    if (!header || header.dataSize === 0) return

    const pcm = parseSpa1Body(data, header.dataSize)
    const f32 = pcm16ToFloat32(pcm)

    // Sequence-gap detection. SPA1 packets carry a 16-bit sequence number;
    // a gap (mod 65536) means a UDP packet got dropped or reordered between
    // server and us. Frequent gaps correlate with the click pattern listeners
    // hear — the worklet's ring drains during the gap, fires a re-prime, and
    // the audio→silence→audio transitions are the click.
    if (this.rxLastSeq >= 0) {
      const expected = (this.rxLastSeq + 1) & 0xFFFF
      if (header.sequence !== expected) this.rxSeqGapCount++
    }
    this.rxLastSeq = header.sequence

    // Compute RMS of received audio for diagnostics
    let rxSum = 0
    for (let i = 0; i < f32.length; i++) rxSum += f32[i] * f32[i]
    this.rxLevel = Math.sqrt(rxSum / f32.length)
    // Peak-hold with slow decay — at 200 packets/s, decay factor 0.99 means
    // the peak halves every ~70 packets (~350 ms). Good window for "did any
    // recent packet have audio?" diagnostics.
    this.rxLevelPeak = Math.max(this.rxLevelPeak * 0.99, this.rxLevel)
    this.playCount++

    // Preferred path: hand the raw 48 kHz PCM to the AudioWorklet.
    //
    // The worklet stores samples at the wire rate and resamples inside
    // process() with a fractional readPos that advances continuously
    // across packet boundaries — so frequency is preserved exactly and
    // there are no per-packet phase discontinuities. It also has a
    // prime/re-prime threshold so network jitter doesn't underrun the
    // ring (the v1.0.12 regression at non-48 kHz contexts).
    if (this.playbackWorklet) {
      this.playbackWorklet.port.postMessage(f32, [f32.buffer])
      return
    }

    // Fallback: createBuffer scheduling. Used only when the worklet
    // failed to initialize (very old browsers). Has the resampling-
    // boundary problem described above — keep as a graceful degradation
    // so we don't go fully silent if the worklet path breaks.
    const buffer = this.audioContext.createBuffer(CHANNELS, f32.length, SAMPLE_RATE)
    buffer.getChannelData(0).set(f32)
    const src = this.audioContext.createBufferSource()
    src.buffer = buffer
    src.connect(this.masterGain)
    const now = this.audioContext.currentTime
    if (this.playTime < now + 0.005) {
      this.playTime = now + this.PLAYBACK_LOOKAHEAD_SEC
    }
    src.start(this.playTime)
    this.playTime += buffer.duration
  }

  // Legacy: called by UI; real sending is via capture pipeline
  sendAudioData(_chunk: Float32Array): void {
    // Audio data is now captured and sent automatically via AudioWorklet.
    // This method is a no-op for backward compatibility.
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(t => { t.enabled = !muted })
    }
  }

  get isMuted(): boolean {
    return this.muted
  }

  /** Debug: return current audio pipeline state */
  debugState(): string {
    const ctx = this.audioContext
    const stream = this.mediaStream
    const tracks = stream?.getAudioTracks() ?? []
    return [
      ctx ? `state=${ctx.state}` : 'no-ctx',
      stream ? `stream=${tracks.length}tr` : 'no-stream',
      tracks[0] ? `track=${tracks[0].readyState}` : '',
      this.analyser ? 'analyser' : 'no-analyser',
      this.source ? 'source' : 'no-source',
      this.masterGain ? 'gain' : 'no-gain',
      this.playbackWorklet ? 'pb-worklet' : 'no-pb-worklet',
      this.processor ? 'mic-proc' : 'no-mic-proc',
      this.controlWs ? `ctrl=${this.controlWs.readyState}` : 'no-ctrl',
      this.audioWs ? `audio=${this.audioWs.readyState}` : 'no-audio',
    ].filter(Boolean).join(' ')
  }

  /** Enumerate all available audio input devices */
  async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
    try {
      // If init() already acquired permission, just enumerate directly
      if (this.mediaStream) {
        const devices = await navigator.mediaDevices.enumerateDevices()
        return devices.filter(d => d.kind === 'audioinput')
      }
      // Otherwise request permission first so device labels are visible,
      // then STOP the temporary stream to avoid holding the mic
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      tempStream.getAudioTracks().forEach(t => t.stop())
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter(d => d.kind === 'audioinput')
    } catch {
      return []
    }
  }

  /** Enumerate all available audio output devices */
  async getAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter(d => d.kind === 'audiooutput')
    } catch {
      return []
    }
  }

  /** Switch to a different audio input device by its deviceId.
   *  Matches AppKit pattern: stop → uninit → reinit → restart */
  async setInputDevice(deviceId: string): Promise<void> {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
          sampleRate:       SAMPLE_RATE,
          channelCount:     CHANNELS,
        },
        video: false,
      })
      // Stop old tracks after new stream is ready
      if (this.mediaStream) {
        this.mediaStream.getAudioTracks().forEach(t => t.stop())
      }
      this.mediaStream = newStream
      // Reset capture state
      // frameBuffer removed
      this.smoothedLevel = 0
      // Reconnect source → processor chain
      if (this.audioContext) {
        if (this.source) try { this.source.disconnect() } catch (_) {}
        this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
        if (this.processor) this.source.connect(this.processor)
      }
      console.log('[Audio] Switched input to:', newStream.getAudioTracks()[0]?.label)
    } catch (err) {
      console.error('[Audio] setInputDevice failed:', err)
      // Fallback: try without exact constraint
      try {
        const fallback = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { ideal: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: SAMPLE_RATE, channelCount: CHANNELS },
          video: false,
        })
        if (this.mediaStream) this.mediaStream.getAudioTracks().forEach(t => t.stop())
        this.mediaStream = fallback
        // frameBuffer removed
        if (this.audioContext) {
          if (this.source) try { this.source.disconnect() } catch (_) {}
          this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
          if (this.processor) this.source.connect(this.processor)
        }
      } catch (_) { /* give up silently */ }
    }
  }

  /** Switch audio output device (speaker/headphones) */
  async setOutputDevice(deviceId: string): Promise<void> {
    try {
      const ctx = this.audioContext as any
      if (ctx && typeof ctx.setSinkId === 'function') {
        await ctx.setSinkId(deviceId)
      }
    } catch (err) {
      console.error('[Audio] setOutputDevice failed:', err)
    }
  }

  public stopCapture(): void {
    this.isCapturing = false
    this.captureMode = 'idle'
    this.captureLeftover = new Float32Array(0)
    this.capCarry = new Float32Array(0)
    this.capPhase = 0
    this.playTime = 0
    if (this.processor) {
      try { this.processor.disconnect() } catch (_) {}
      if ('port' in this.processor) {
        ;(this.processor as AudioWorkletNode).port.onmessage = null
      }
      ;(this.processor as ScriptProcessorNode).onaudioprocess = null
      this.processor = null
    }
    if (this.captureSink) {
      try { this.captureSink.disconnect() } catch (_) {}
      this.captureSink = null
    }
  }

  mute(): void {
    this.setMuted(true)
  }

  unmute(): void {
    this.setMuted(false)
  }

  // ── Audio latency measurement (via control WebSocket PING/PONG) ───────────

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.controlWs?.readyState === WebSocket.OPEN) {
        this.pingSentAt = performance.now()
        this.controlWs.send(JSON.stringify({ type: 'PING' }) + '\n')
      }
    }, 3000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /** Subscribe to audio latency updates (ms RTT via WebSocket). Returns unsubscribe. */
  onLatency(callback: (ms: number) => void): () => void {
    this.latencyCallbacks.push(callback)
    if (this._audioLatency >= 0) callback(this._audioLatency)
    return () => {
      this.latencyCallbacks = this.latencyCallbacks.filter(cb => cb !== callback)
    }
  }

  get audioLatency(): number {
    return this._audioLatency
  }

  /**
   * Estimated mouth-to-ear end-to-end audio latency (ms). Sums every
   * known buffer in the round trip from a talker's mic to a listener's
   * speaker:
   *   capture frame (FRAME_MS, one PCM frame, currently 2.5 ms) +
   *   network RTT (control WS ≈ audio WS) +
   *   server jitter wait, avg = (jitterTarget − 0.5) × FRAME_MS +
   *   server mix tick (FRAME_MS, currently 2.5 ms) +
   *   client playback ring depth (live, samples / sampleRate) +
   *   browser output device latency (audioContext.outputLatency).
   *
   * Returns −1 until the first PONG arrives, since RTT is the only
   * component we don't already know. Recomputed on read — no timer.
   *
   * Uses FRAME_MS for the frame-size-dependent terms so the formula
   * tracks the constant — Phase B v4.2.0 halved this from 5 ms to
   * 2.5 ms, dropping the static contribution by ~5 ms.
   */
  get audioE2eLatency(): number {
    if (this._audioLatency < 0) return -1
    const captureMs = FRAME_MS
    const rttMs     = this._audioLatency
    const jitterMs  = Math.max(0, (this.serverTuning.jitterTarget - 0.5) * FRAME_MS)
    const mixTickMs = FRAME_MS
    const sr        = this.audioContext?.sampleRate || 48000
    const ringMs    = (this.playRingFill / sr) * 1000
    // outputLatency is in seconds (Chrome/FF); Safari often omits it.
    const outMs     = ((this.audioContext as any)?.outputLatency ?? 0) * 1000
    return Math.round(captureMs + rttMs + jitterMs + mixTickMs + ringMs + outMs)
  }

  destroy(): void {
    this.stopPing()
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
    }
    this.stopCapture()
    if (this.playbackWorklet) {
      try { this.playbackWorklet.disconnect() } catch (_) {}
      this.playbackWorklet = null
    }
    if (this.monitorWorklet) {
      try { this.monitorWorklet.disconnect() } catch (_) {}
      this.monitorWorklet = null
    }
    if (this.monitorGain) {
      try { this.monitorGain.disconnect() } catch (_) {}
      this.monitorGain = null
    }
    this.mediaStream?.getAudioTracks().forEach(t => t.stop())
    this.audioContext?.close()
    this.controlWs?.close()
    this.audioWs?.close()
    this.mediaStream       = null
    this.audioContext      = null
    this.analyser          = null
    this.source            = null
    this.controlWs         = null
    this.audioWs           = null
    this.masterGain        = null
    // Reset peerLevels so a fresh `init()` doesn't see stale ghosts
    // from the previous room.
    this.peerLevels.clear()
  }
}

export const audioService = new AudioService()
