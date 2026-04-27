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

class AudioService {
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
  private pingSentAt:       number = 0
  private _audioLatency:    number = -1
  private latencyCallbacks: Array<(ms: number) => void> = []

  // Playback (shares audioContext with capture to avoid autoplay policy issues)
  private masterGain:       GainNode | null = null

  // Debug counters
  public rxCount = 0   // received SPA1 audio packets from server
  public txCount = 0   // sent SPA1 audio packets to server
  public playCount = 0 // packets sent to playback worklet
  public cbCount = 0   // level callback invocations

  // Capture pipeline
  private processor:      AudioWorkletNode | ScriptProcessorNode | null = null
  private isCapturing:    boolean = false
  private sequence:       number = 0
  // timestamp removed — now using wall-clock ms in SPA1 header for RTT
  private frameBuffer:    Float32Array[] = []
  private readonly FRAME_WANT_SAMPLES = FRAME_SAMPLES  // 480 @ 48kHz = 10ms

  // Playback adaptive jitter buffer: tracks arrival intervals and adjusts target depth
  private targetBufferFrames = 2  // Start with 2 frames (20ms), will adapt
  private arrivalIntervals: number[] = []  // Last 20 packet arrival intervals (ms)
  private lastArrivalTime = 0
  private readonly MIN_BUFFER_FRAMES = 2   // 20ms minimum
  private readonly MAX_BUFFER_FRAMES = 8   // 80ms maximum

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
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
          sampleRate:       SAMPLE_RATE,
          channelCount:     CHANNELS,
        },
        video: false,
      })

      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
      // FIX: Resume the AudioContext to unfreeze it from browser autoplay policy.
      // Without this the context stays in 'suspended' state and no audio flows.
      await this.audioContext.resume()

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

    // Adaptive ring buffer: max 8 frames (80ms), target starts at 2 frames (20ms)
    // Target is updated dynamically based on network jitter measurements.
    const maxBufSize = FRAME_SAMPLES * 8
    const initialTarget = this.targetBufferFrames * FRAME_SAMPLES
    const code = `
      class PlaybackProcessor extends AudioWorkletProcessor {
        constructor() {
          super()
          this.buf = new Float32Array(${maxBufSize})
          this.writePos = 0
          this.readPos = 0
          this.count = 0
          this.targetCount = ${initialTarget}
          this.port.onmessage = (ev) => {
            if (ev.data && ev.data.type === 'setTarget') {
              this.targetCount = ev.data.samples
              return
            }
            const samples = ev.data
            const len = samples.length
            for (let i = 0; i < len; i++) {
              if (this.count < ${maxBufSize}) {
                this.buf[this.writePos] = samples[i]
                this.writePos = (this.writePos + 1) % ${maxBufSize}
                this.count++
              } else {
                // overflow: drop oldest
                this.buf[this.writePos] = samples[i]
                this.writePos = (this.writePos + 1) % ${maxBufSize}
                this.readPos = (this.readPos + 1) % ${maxBufSize}
              }
            }
          }
        }
        process(inputs, outputs) {
          const out = outputs[0][0]
          if (!out) return true
          // Adaptive playback: try to maintain target buffer depth
          // If buffer is too full (> target + 1 frame), skip some samples to drain
          // If buffer is below target, output silence and let it fill
          const target = this.targetCount
          const frameSize = ${FRAME_SAMPLES}
          let skip = 0
          if (this.count > target + frameSize) {
            skip = Math.min(frameSize, this.count - target) // skip up to 1 frame
          }
          // Apply skip (drop oldest samples)
          while (skip-- > 0 && this.count > 0) {
            this.readPos = (this.readPos + 1) % ${maxBufSize}
            this.count--
          }
          // Output audio
          for (let i = 0; i < out.length; i++) {
            if (this.count > 0) {
              out[i] = this.buf[this.readPos]
              this.readPos = (this.readPos + 1) % ${maxBufSize}
              this.count--
            } else {
              out[i] = 0  // underrun: silence
            }
          }
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
    this.frameBuffer   = []

    // Use ScriptProcessorNode for capture — AudioWorklet has known issues
    // with MediaStreamAudioSourceNode producing zeros in some browsers.
    this.startCaptureWithScriptProcessor()
  }

  private startCaptureWithScriptProcessor(): void {
    if (!this.audioContext) return
    // Use small buffer (256 samples ≈ 5.3ms) to match server's 5ms mix timer.
    // Large buffers cause frame bursts where server drops all but the last frame.
    const node = this.audioContext.createScriptProcessor(256, 1, 1)
    node.onaudioprocess = (ev) => {
      if (!this.muted) {
        this.onAudioFrame(new Float32Array(ev.inputBuffer.getChannelData(0)))
      }
    }
    // Connect source → processor so it receives mic audio
    if (this.source) {
      this.source.connect(node)
    }
    node.connect(this.audioContext.destination)
    this.processor = node
  }

  private smoothedLevel = 0
  private nextPlayTime = 0

  private onAudioFrame(f32: Float32Array): void {
    // Input level: linear RMS + EMA smoothing (matches AppKit AudioBridge)
    // AppKit: prev * 0.8 + rms * 0.2, no extra scaling, 0-1 linear range
    let sum = 0
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i]
    const rms = Math.sqrt(sum / f32.length)
    this.smoothedLevel = this.smoothedLevel * 0.8 + rms * 0.2
    this.currentLevel = this.smoothedLevel

    this.frameBuffer.push(f32)
    let total = 0
    for (const b of this.frameBuffer) total += b.length

    while (total >= this.FRAME_WANT_SAMPLES) {
      const parts: Float32Array[] = []
      let used = 0
      for (const b of this.frameBuffer) {
        if (used + b.length <= this.FRAME_WANT_SAMPLES) {
          parts.push(b)
          used += b.length
        } else {
          const split = this.FRAME_WANT_SAMPLES - used
          parts.push(b.slice(0, split))
          this.frameBuffer[this.frameBuffer.indexOf(b)] = b.slice(split)
          used += split
          break
        }
      }
      if (used >= this.FRAME_WANT_SAMPLES) {
        const frame = this.concatenate(parts)
        const pcm16 = float32ToPcm16(frame)
        // FIX #2: use correct SPA1 format (BE, with userId field)
        // Embed wall-clock ms (low 16 bits) as timestamp for RTT measurement
        const nowMs = Math.floor(performance.now()) & 0xFFFF
        const spa1 = buildSpa1Packet(
          pcm16,
          SPA1_CODEC_PCM16,
          this.sequence++,
          nowMs,
          `${this.roomId}:${this.userId}`
        )
        // Send via WebSocket (browser → ws-proxy → ws-mixer-proxy → UDP 9003)
        if (this.audioWs?.readyState === WebSocket.OPEN) {
          this.audioWs.send(spa1)
          this.txCount++
        }
        total -= this.FRAME_WANT_SAMPLES
        const newBuf: Float32Array[] = []
        for (const b of this.frameBuffer) {
          if (b.length > 0) newBuf.push(b)
        }
        this.frameBuffer = newBuf
      } else {
        break
      }
    }
  }

  private concatenate(arrays: Float32Array[]): Float32Array {
    const out = new Float32Array(this.FRAME_WANT_SAMPLES)
    let off = 0
    for (const a of arrays) { out.set(a, off); off += a.length }
    return out
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
    const host = 'api.tonel.io'
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
        console.log('[Mixer] Audio WebSocket closed')
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

    // RTT from SPA1 timestamp — matches AppKit MixerBridge exactly:
    // Server echoes client's ms-low-16 timestamp back in mixed audio
    if (header.timestamp > 0) {
      const now16 = Math.floor(performance.now()) & 0xFFFF
      const rtt = (now16 - header.timestamp) & 0xFFFF  // unsigned 16-bit subtract
      if (rtt < 10000) {  // discard wrap-around glitches (>10s)
        const prev = this._audioLatency
        // AppKit: (prev * 4 + rtt) / 5  — integer EMA, 80% old + 20% new
        this._audioLatency = (prev <= 0) ? rtt : Math.floor((prev * 4 + rtt) / 5)
        this.latencyCallbacks.forEach(cb => cb(this._audioLatency))
      }
    }

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
          if (this.pingSentAt > 0) {
            this._audioLatency = Math.round(performance.now() - this.pingSentAt)
            this.pingSentAt = 0
            this.latencyCallbacks.forEach(cb => cb(this._audioLatency))
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

    // Record arrival time and update adaptive buffer depth
    const now = performance.now()
    this.updateAdaptiveBufferDepth(now)

    const header = parseSpa1Header(data)
    if (!header || header.dataSize === 0) return

    const pcm = parseSpa1Body(data, header.dataSize)
    const f32 = pcm16ToFloat32(pcm)

    // Direct buffer playback (simpler, more reliable than worklet ring buffer)
    this.playCount++
    const buffer = this.audioContext.createBuffer(
      CHANNELS,
      f32.length,
      SAMPLE_RATE
    )
    buffer.getChannelData(0).set(f32)

    const src = this.audioContext.createBufferSource()
    src.buffer = buffer
    src.connect(this.masterGain)
    // Schedule playback to maintain continuous stream without gaps/overlaps
    const frameDuration = f32.length / SAMPLE_RATE
    const ctxNow = this.audioContext.currentTime
    if (this.nextPlayTime < ctxNow) this.nextPlayTime = ctxNow
    src.start(this.nextPlayTime)
    this.nextPlayTime += frameDuration
  }

  /**
   * Update target buffer depth based on network jitter.
   * Tracks last 20 packet arrival intervals, computes mean + 2*stddev.
   * Sends updated target to the AudioWorklet via port message.
   */
  private updateAdaptiveBufferDepth(now: number): void {
    if (this.lastArrivalTime === 0) {
      this.lastArrivalTime = now
      return
    }

    const interval = now - this.lastArrivalTime
    this.lastArrivalTime = now

    // Sanity: ignore absurd intervals (e.g. after pause/resume)
    if (interval < 0 || interval > 200) return

    this.arrivalIntervals.push(interval)
    if (this.arrivalIntervals.length > 20) {
      this.arrivalIntervals.shift()
    }

    if (this.arrivalIntervals.length < 5) return

    // Compute mean and stddev
    const avg = this.arrivalIntervals.reduce((a, b) => a + b, 0) / this.arrivalIntervals.length
    const variance = this.arrivalIntervals.reduce((sum, v) => sum + (v - avg) ** 2, 0) / this.arrivalIntervals.length
    const stddev = Math.sqrt(variance)

    // Target = avg interval + 2*stddev (covers ~95% of jitter)
    // Convert to frames (each frame = 10ms)
    let targetFrames = Math.ceil((avg + 2 * stddev) / 10)
    if (targetFrames < this.MIN_BUFFER_FRAMES) targetFrames = this.MIN_BUFFER_FRAMES
    if (targetFrames > this.MAX_BUFFER_FRAMES) targetFrames = this.MAX_BUFFER_FRAMES

    // Exponential smoothing to avoid sudden jumps
    const smoothed = Math.round((this.targetBufferFrames * 3 + targetFrames) / 4)

    if (smoothed !== this.targetBufferFrames) {
      this.targetBufferFrames = smoothed
      // Notify AudioWorklet of new target
      if (this.playbackWorklet) {
        this.playbackWorklet.port.postMessage({
          type: 'setTarget',
          samples: smoothed * FRAME_SAMPLES
        })
      }
    }
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

  /** Switch to a different audio input device by its deviceId */
  async setInputDevice(deviceId: string): Promise<void> {
    try {
      // Re-acquire with the chosen device (prefer over exact to handle device changes)
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { ideal: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
          sampleRate:       SAMPLE_RATE,
          channelCount:     CHANNELS,
        },
        video: false,
      })
      // Stop old tracks only after new stream is ready
      if (this.mediaStream) {
        this.mediaStream.getAudioTracks().forEach(t => t.stop())
      }
      this.mediaStream = newStream
      // Reconnect source → analyser + processor
      if (this.audioContext) {
        if (this.source) try { this.source.disconnect() } catch (_) {}
        this.source = this.audioContext.createMediaStreamSource(this.mediaStream)
        if (this.analyser) this.source.connect(this.analyser)
        if (this.processor) this.source.connect(this.processor)
      }
    } catch (err) {
      console.error('[Audio] setInputDevice failed:', err)
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
    if (this.processor) {
      try { this.processor.disconnect() } catch (_) {}
      if ('port' in this.processor) {
        ;(this.processor as AudioWorkletNode).port.onmessage = null
      }
      ;(this.processor as ScriptProcessorNode).onaudioprocess = null
      this.processor = null
    }
    this.frameBuffer = []
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
