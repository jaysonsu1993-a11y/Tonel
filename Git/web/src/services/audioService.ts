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

  // Audio latency (RTT via control WebSocket PING/PONG)
  private pingTimer:        ReturnType<typeof setInterval> | null = null
  // @ts-ignore — pingSentAt used in startPing
  private pingSentAt = 0
  private _audioLatency:    number = -1
  private latencyCallbacks: Array<(ms: number) => void> = []

  // Playback (shares audioContext with capture to avoid autoplay policy issues)
  private masterGain:       GainNode | null = null

  // Debug counters
  public rxCount = 0   // received SPA1 audio packets from server
  public txCount = 0   // sent SPA1 audio packets to server
  public playCount = 0 // packets sent to playback
  public rxLevel = 0   // RMS of last received audio (0 = silence)
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

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
          sampleRate:       requestedRate,
          channelCount:     CHANNELS,
        },
        video: false,
      })

      this.audioContext = new AudioContext({ sampleRate: requestedRate })
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
    await this.initPlaybackWorklet()
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
    const RING_SIZE    = 48000   // 1 second @ wire rate (48 kHz)
    const PRIME_TARGET = 480     // 10 ms cushion before draining starts
    const PRIME_MIN    = 128     // re-prime if ring would drop below this
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
          this.port.onmessage = (ev) => {
            let samples = ev.data
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
            if (!this.primed && this.count >= ${PRIME_TARGET}) {
              this.primed = true
            }
          }
        }
        process(inputs, outputs) {
          const channels = outputs[0]
          if (!channels || !channels[0]) return true
          const out0 = channels[0]
          if (!this.primed || this.count < ${PRIME_MIN}) {
            this.primed = false
            out0.fill(0)
            for (let c = 1; c < channels.length; c++) channels[c].fill(0)
            return true
          }
          for (let i = 0; i < out0.length; i++) {
            const idxF = this.readPos
            const idx  = Math.floor(idxF)
            const frac = idxF - idx
            const a = this.buf[idx]
            const b = this.buf[(idx + 1) % ${RING_SIZE}]
            out0[i] = a + (b - a) * frac
            const newReadPos = idxF + this.ratio
            const newIdx     = Math.floor(newReadPos)
            this.count -= (newIdx - idx)
            this.readPos = newReadPos % ${RING_SIZE}
            if (this.count < ${PRIME_MIN}) {
              for (let j = i + 1; j < out0.length; j++) out0[j] = 0
              this.primed = false
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

  /** Subscribe to remote peer level updates. Callback receives (userId, level 0-1). */
  onPeerLevel(cb: PeerLevelCallback): void {
    this.peerLevelCallback = cb
  }

  /** Get last known level for a peer (0-1), or 0 if unknown. */
  getPeerLevel(userId: string): number {
    return this.peerLevels.get(userId) ?? 0
  }

  // ── Capture: AudioWorklet → 10ms frames → SPA1 encode → send ─────────────

  public startCapture(): void {
    if (this.isCapturing || !this.audioContext) return
    this.isCapturing = true
    this.sequence     = 0
    // Use ScriptProcessorNode for capture — AudioWorklet has known issues
    // with MediaStreamAudioSourceNode producing zeros in some browsers.
    this.startCaptureWithScriptProcessor()
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
    node.connect(this.audioContext.destination)
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
          this.startCapture()
          this.startPing()
        } else if (msg.type === 'HANDSHAKE_ACK' || msg.type === 'OK') {
          console.log('[Mixer] Handshake ack, starting capture')
          this.startCapture()
          this.startPing()
        } else if (msg.type === 'LEVELS' && msg.levels) {
          // Per-user input levels from mixer server: { "user1": 0.42, "user2": 0.15, ... }
          if (this.peerLevelCallback) {
            for (const [uid, level] of Object.entries(msg.levels)) {
              this.peerLevels.set(uid, level as number)
              this.peerLevelCallback(uid, level as number)
            }
          }
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

    // Compute RMS of received audio for diagnostics
    let rxSum = 0
    for (let i = 0; i < f32.length; i++) rxSum += f32[i] * f32[i]
    this.rxLevel = Math.sqrt(rxSum / f32.length)
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
    this.mediaStream?.getAudioTracks().forEach(t => t.stop())
    this.audioContext?.close()
    this.audioContext?.close()
    this.controlWs?.close()
    this.audioWs?.close()
    this.mediaStream       = null
    this.audioContext      = null
    this.audioContext  = null
    this.analyser          = null
    this.source            = null
    this.controlWs         = null
    this.audioWs           = null
    this.masterGain        = null
  }
}

export const audioService = new AudioService()
