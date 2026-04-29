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

// Frame size: 5ms of audio for lower latency
const FRAME_SAMPLES = Math.floor(SAMPLE_RATE * 5 / 1000)  // 240 samples @ 48kHz

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

export class AudioService {
  private audioContext:     AudioContext | null = null
  private mediaStream:       MediaStream | null = null
  private analyser:         AnalyserNode | null = null
  private source:           MediaStreamAudioSourceNode | null = null
  // levelCallback removed — UI polls currentLevel directly via RAF
  private animationFrameId: number | null = null
  private muted:            boolean = false
  public  currentLevel:     number = 0

  // WebSocket connections to mixer (via ws-proxy → ws-mixer-proxy)
  private controlWs:        WebSocket | null = null
  private audioWs:          WebSocket | null = null
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
  private monitorBaseGain   = 1.0   // user-adjustable (future slider)
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
  private tuningSaveTimer: ReturnType<typeof setTimeout> | null = null
  private static tuningStorageKey(roomId: string, userId: string): string {
    return `${AudioService.TUNING_KEY_PREFIX}${roomId}:${userId}`
  }
  /** Default tuning values. Single source of truth — used by both the
   *  initial `this.tuning` field below and `resetRoomTuning()` below. */
  private static readonly DEFAULT_PB = Object.freeze({
    primeTarget: 1440, primeMin: 128,
    maxScale: 1.012,   minScale: 0.988,
    rateStep: 0.00002,
  })
  private static readonly DEFAULT_SRV = Object.freeze({
    jitterTarget: 1, jitterMaxDepth: 8,
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
  public tuning = {
    primeTarget: 1440,    // 30 ms @ 48 kHz; latency cost = ring depth
    primeMin:    128,     // re-prime floor; below = audible reprime click
    maxScale:    1.012,
    minScale:    0.988,
    rateStep:    0.00002, // integrator step per quantum (rate-loop convergence)
  }
  // Server-side per-user jitter buffer. Defaults overwritten by MIXER_JOIN_ACK.
  public serverTuning = {
    jitterTarget:   1,    // frames; latency cost = (target − 0.5) × 5 ms
    jitterMaxDepth: 8,    // frames; cap-drop is 5 ms gone → click
  }
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

    // Disconnect everything tied to the old AudioContext, but keep the
    // MediaStream alive (don't stop its tracks).
    this.stopCapture()
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
    this.audioContext = new AudioContext({ sampleRate: requestedRate })
    await this.audioContext.resume()

    if (this.audioContext.sampleRate !== requestedRate) {
      console.warn(`[Audio] AudioContext rate is ${this.audioContext.sampleRate} Hz, requested ${requestedRate}. Capture and worklet will resample.`)
    } else {
      console.log(`[Audio] AudioContext rate ${this.audioContext.sampleRate} Hz (in-place rebuild)`)
    }

    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.3

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
    this.source.connect(this.analyser)

    this.masterGain = this.audioContext.createGain()
    this.masterGain.gain.value = 1.0
    this.masterGain.connect(this.audioContext.destination)

    // Local monitor wired via worklet pass-through (see ensureMonitorWorklet
    // for the iOS-Safari rationale). Fire-and-forget; failure leaves
    // monitor disabled and the user just falls back to "no self-hear in
    // multi-user rooms" — same as pre-v3.4.0 behaviour.
    void this.ensureMonitorWorklet()

    await this.initPlaybackWorklet()

    // Close the old AudioContext after the new one is fully wired.
    try { oldCtx.close() } catch (_) {}

    if (wasCapturing) this.startCapture()
  }

  async init(): Promise<MediaStream> {
    // Clean up previous state to avoid stale AudioContext/MediaStream pileup
    this.stopCapture()
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(t => t.stop())
      this.mediaStream = null
    }
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
      // User-selectable AudioContext rate. Stored in localStorage so the
      // choice survives a reload. Null/missing → let the browser pick (its
      // default, usually the OS audio device's native rate). Explicitly
      // setting 48000 lines up with the wire rate and bypasses both the
      // capture-side and worklet-side resamplers entirely — a useful
      // diagnostic when chasing residual distortion.
      const userRate = AudioService.readUserRate()
      const requestedRate = userRate ?? SAMPLE_RATE

      // Mobile fallback. iOS Safari (some versions) throws on a non-native
      // AudioContext sample rate, and `getUserMedia` can throw
      // OverconstrainedError when `sampleRate: 48000` doesn't match the
      // device. Try the constrained path first for desktop / modern
      // mobile (where it gives us nice 48 kHz alignment with the wire);
      // if anything throws, fall back to "let the browser decide" so the
      // user at least gets *some* audio path. The capture worklet's
      // resampler handles the rate mismatch transparently — this is
      // exactly the codepath the desktop 44.1 kHz case already exercises.
      const tryGetUserMedia = async (constrained: boolean): Promise<MediaStream> => {
        const audio: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
          channelCount:     CHANNELS,
        }
        if (constrained) audio.sampleRate = requestedRate
        return navigator.mediaDevices.getUserMedia({ audio, video: false })
      }
      const tryAudioContext = (constrained: boolean): AudioContext => {
        return constrained
          ? new AudioContext({ sampleRate: requestedRate })
          : new AudioContext()
      }

      try {
        this.mediaStream  = await tryGetUserMedia(true)
        this.audioContext = tryAudioContext(true)
      } catch (constrainedErr) {
        console.warn('[Audio] Constrained init failed, retrying without sampleRate hint:', constrainedErr)
        // Make sure no half-open mic stream from the failed attempt sticks
        // around — Safari has been known to leak the indicator dot.
        if (this.mediaStream) {
          try { this.mediaStream.getAudioTracks().forEach(t => t.stop()) } catch {}
          this.mediaStream = null
        }
        this.mediaStream  = await tryGetUserMedia(false)
        this.audioContext = tryAudioContext(false)
      }
      // FIX: Resume the AudioContext to unfreeze it from browser autoplay policy.
      // Without this the context stays in 'suspended' state and no audio flows.
      await this.audioContext.resume()
      // The sampleRate hint is best-effort — Bluetooth output / system overrides
      // may force a different rate. Log so we can spot the mismatch.
      if (this.audioContext.sampleRate !== requestedRate) {
        console.warn(`[Audio] AudioContext rate is ${this.audioContext.sampleRate} Hz, requested ${requestedRate}. Capture and worklet will resample.`)
      } else {
        console.log(`[Audio] AudioContext rate ${this.audioContext.sampleRate} Hz`)
      }

      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 256
      this.analyser.smoothingTimeConstant = 0.3

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
      this.source.connect(this.analyser)

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
    this.masterGain.connect(this.audioContext.destination)
    // Local monitor — see field-level comment for rationale. Starts at 0
    // and engages once the room population reaches ≥2 (LEVELS broadcast).
    // Local monitor — see field comment for the worklet-passthrough
    // rationale. ensureMonitorWorklet creates monitorGain inside, so
    // we don't need a pre-check here.
    void this.ensureMonitorWorklet()
    await this.initPlaybackWorklet()
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
      class MonitorProcessor extends AudioWorkletProcessor {
        constructor() {
          super()
          this.gain = 0   // updated via postMessage from updateMonitorGain
          this.port.onmessage = (ev) => {
            if (ev.data && typeof ev.data.gain === 'number') {
              this.gain = ev.data.gain
            }
          }
        }
        process(inputs, outputs) {
          const inp = inputs[0]
          const out = outputs[0]
          if (!inp || !inp[0] || !out || !out[0]) return true
          if (this.gain <= 0) {
            // Silence — but still write zeros so the worklet's output
            // channel count doesn't go ambiguous and trigger an upstream
            // node disconnect on some browsers.
            for (let c = 0; c < out.length; c++) out[c].fill(0)
            return true
          }
          const src = inp[0]
          const g   = this.gain
          for (let c = 0; c < out.length; c++) {
            const dst = out[c]
            const n   = Math.min(dst.length, src.length)
            for (let i = 0; i < n; i++) dst[i] = src[i] * g
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
      this.source.connect(this.monitorWorklet)
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
    const target = (this.peerLevels.size >= 2) ? this.monitorBaseGain : 0
    this._monitorTarget = target
    // v3.4.5: gain lives inside the monitor worklet. The audio thread
    // smoothing (small per-quantum glide) could be added there if a
    // click is heard at the boundary; for now an instant gain step is
    // sufficient since the boundary only fires on user join/leave (rare).
    if (this.monitorWorklet) {
      this.monitorWorklet.port.postMessage({ gain: target })
    }
  }
  private _monitorTarget = 0
  /** Current monitor gain target (post-ramp). Surfaced in the debug strip. */
  get monitorGainTarget(): number { return this._monitorTarget }

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
              // *perceived* latency only ever creeps up. We accept one
              // audible discontinuity (drop ~target_delta samples) for
              // an instantaneous, observable latency change. Same trade
              // as the server-side jitter_queue trim on target shrink.
              if (this.count > this.targetCount) {
                const drop = this.count - this.targetCount
                this.readPos = (Math.floor(this.readPos) + drop) % ${RING_SIZE}
                this.count   = this.targetCount
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
            // Cold start / fully drained — emit a clean full-callback silence.
            out0.fill(0)
            for (let c = 1; c < channels.length; c++) channels[c].fill(0)
            // Only count this as a re-prime event the first time we land
            // here after a primed state, so we don't keep ticking up while
            // staying in re-prime across many quanta.
            if (this.primed) {
              this.reprimeCount++
              this.port.postMessage({ type: 'reprime', count: this.reprimeCount })
            }
            this.primed = false
            return true
          }
          // Slow control loop: nudge rateScale to keep count near target.
          //
          // v1.0.24 had a deadband around target where rateScale drifted
          // back toward 1.0. That was wrong — once the loop converged to,
          // say, rateScale = 1.003 (compensating ~0.3 % clock drift), any
          // ring that landed inside the deadband would pull rateScale
          // back, ring would refill from drift, drift the rate back,
          // refill, ... a slow oscillation that occasionally clipped
          // PRIME_MIN and fired a reprime even when no real issue was
          // present.
          //
          // v1.0.25 holds rateScale once we're inside the deadband. The
          // loop is now an integrator (+ saturation): outside the
          // deadband the rate moves; inside, it stays. Steady state
          // converges to whatever rate matches producer/consumer
          // exactly, no oscillation.
          if (this.count > this.targetCount * 1.3) {
            this.rateScale = Math.min(this.MAX_SCALE, this.rateScale + this.rateStep)
          } else if (this.count < this.targetCount * 0.7) {
            this.rateScale = Math.max(this.MIN_SCALE, this.rateScale - this.rateStep)
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
            out0[i] = a + (b - a) * frac
            const newReadPos = idxF + effRatio
            const newIdx     = Math.floor(newReadPos)
            this.count -= (newIdx - idx)
            this.readPos = newReadPos % ${RING_SIZE}
            if (this.count < this.primeMin) {
              // Mid-callback underrun. Apply a 240-sample (5 ms) raised-
              // cosine fade to the samples already written before silencing
              // the rest. Cosine taper is smoother than linear at both
              // ends — no bend in the envelope's first or last derivative —
              // so the residual artifact is below the ear's click-detection
              // threshold even at quiet listening levels.
              const fadeLen = i + 1 < 240 ? i + 1 : 240
              for (let f = 0; f < fadeLen; f++) {
                // Half-cosine from 1 (at start of fade) to 0 (at end of fade).
                // f/fadeLen ∈ [0,1); cos transitions 1 → 0 over 0 → π/2.
                const w = 0.5 * (1 + Math.cos(Math.PI * (1 - f / fadeLen)))
                out0[i - f] *= w
              }
              for (let j = i + 1; j < out0.length; j++) out0[j] = 0
              this.primed = false
              this.reprimeCount++
              this.port.postMessage({ type: 'reprime', count: this.reprimeCount })
              break
            }
          }
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
    // Clamp into safe ranges — sliders may land just outside.
    next.primeMin    = Math.max(0,    Math.min(next.primeTarget, next.primeMin))
    next.primeTarget = Math.max(next.primeMin, Math.min(24000, next.primeTarget))
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
        const blob = JSON.stringify({ client: this.tuning, server: this.serverTuning })
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
      const parsed = JSON.parse(raw) as { client?: Partial<AudioService['tuning']>;
                                          server?: Partial<AudioService['serverTuning']> }
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
        const { frame, stats } = ev.data
        if (!frame) return
        if (stats?.clips) this.captureClipCount += stats.clips
        this.sendCapturedFrame(frame as Float32Array)
      }
      this.source.connect(node)
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

    if (this.audioWs?.readyState !== WebSocket.OPEN) return
    if (this.muted) {
      // Worklet doesn't know about mute; zero the frame here so server
      // sees silence rather than mic content while muted.
      frame.fill(0)
    }
    const uid = `${this.roomId}:${this.userId}`
    const pcm16 = float32ToPcm16(frame)
    const spa1 = buildSpa1Packet(pcm16, SPA1_CODEC_PCM16, this.sequence++, 0, uid)
    this.audioWs.send(spa1)
    this.txCount++
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
    // Connect source → processor so it receives mic audio
    if (this.source) {
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
      this.audioWs.send(spa1)
      this.txCount++
      offset += FRAME_SAMPLES
    }
    // Carry the tail (always < FRAME_SAMPLES) into the next callback.
    this.captureLeftover = offset < buf.length
      ? new Float32Array(buf.subarray(offset))
      : new Float32Array(0)
  }

  // ── Mixer WebSocket connection (control + audio) ───────────────────────────

  public async connectMixer(userId: string, roomId: string): Promise<void> {
    this.userId = userId
    this.roomId = roomId

    // Clean up any existing WebSockets before reconnecting
    if (this.controlWs || this.audioWs) {
      console.log('[Mixer] Cleaning up existing WebSockets before reconnect')
      try { this.controlWs?.close() } catch (_) {}
      try { this.audioWs?.close() } catch (_) {}
      this.controlWs = null
      this.audioWs = null
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Direct connection to Alibaba Cloud server (bypasses Cloudflare Tunnel)
    const host = 'srv.tonel.io'
    const controlUrl = `${protocol}//${host}/mixer-tcp`
    const audioUrl   = `${protocol}//${host}/mixer-udp`

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Mixer WebSocket 连接超时'))
      }, 15000)

      let controlReady = false
      let audioReady = false
      const checkBothReady = () => {
        if (controlReady && audioReady) {
          clearTimeout(timer)
          // Send MIXER_JOIN via control channel
          console.log('[Mixer] Both WebSockets open, sending MIXER_JOIN')
          this.controlWs?.send(JSON.stringify({
            type:    'MIXER_JOIN',
            room_id: this.roomId,
            user_id: this.userId,
          }) + '\n')
          // Send SPA1 handshake via audio channel to register UDP return path
          console.log('[Mixer] Sending SPA1 handshake on audio WebSocket')
          const pkt = buildSpa1Packet(
            new Uint8Array(0),
            SPA1_CODEC_HANDSHAKE,
            0, 0,
            `${this.roomId}:${this.userId}`
          )
          this.audioWs?.send(pkt)
          resolve()
        }
      }

      // ── Control WebSocket (/mixer-tcp) ──────────────────────────────────
      this.controlWs = new WebSocket(controlUrl)
      this.controlWs.binaryType = 'arraybuffer'
      this.controlWs.onopen = () => {
        console.log('[Mixer] Control WebSocket open')
        controlReady = true
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

      // ── Audio WebSocket (/mixer-udp) ────────────────────────────────────
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
              this.audioWs?.send(pkt)
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
