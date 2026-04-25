/**
 * audioService.ts — S1 Web Audio Client
 *
 * Implements:
 *   1. Audio capture via AudioWorklet (fallback ScriptProcessorNode)
 *   2. PCM16 SPA1 packet assembly & WebRTC DataChannel send
 *   3. SPA1 packet receive → PCM16 decode → Web Audio API playback
 *   4. MIXER_JOIN handshake with the mixer TCP server (via reliable DataChannel)
 *   5. UDP-like audio relay via unreliable DataChannel (direct DTLS to server)
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

function parseSpa1Body(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf, SPA1_HEADER_SIZE)
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM16 Codec
// ─────────────────────────────────────────────────────────────────────────────

function float32ToPcm16(f32: Float32Array): Uint8Array {
  const out  = new Uint8Array(f32.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
  }
  return out
}

function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  const view = new Float32Array(pcm.length / 2)
  const dv   = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let i = 0; i < view.length; i++) {
    const s = dv.getInt16(i * 2, true)
    view[i] = s < 0 ? s / 0x8000 : s / 0x7FFF
  }
  return view
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
  private levelCallback:    AudioLevelCallback | null = null
  private animationFrameId: number | null = null
  private muted:            boolean = false
  public  currentLevel:     number = 0

  // WebRTC DataChannel connection to mixer (replaces WebSocket)
  private pc:               RTCPeerConnection | null = null
  private controlChannel:   RTCDataChannel | null = null
  private audioChannel:     RTCDataChannel | null = null
  private signalUnsub:      (() => void) | null = null
  private userId:           string = ''
  private roomId:           string = ''

  // Remote peer level tracking
  private peerLevelCallback: PeerLevelCallback | null = null
  private peerLevels: Map<string, number> = new Map()

  // Audio latency (RTT via control DataChannel)
  private pingTimer:        ReturnType<typeof setInterval> | null = null
  private pingSentAt:       number = 0
  private _audioLatency:    number = -1
  private latencyCallbacks: Array<(ms: number) => void> = []

  // Playback
  private audioContextPlay: AudioContext | null = null
  private masterGain:       GainNode | null = null

  // Capture pipeline
  private processor:      AudioWorkletNode | ScriptProcessorNode | null = null
  private isCapturing:    boolean = false
  private sequence:       number = 0
  private timestamp:      number = 0
  private frameBuffer:    Float32Array[] = []
  private readonly FRAME_WANT_SAMPLES = FRAME_SAMPLES  // 480 @ 48kHz = 10ms

  // Playback adaptive jitter buffer: tracks arrival intervals and adjusts target depth
  private targetBufferFrames = 2  // Start with 2 frames (20ms), will adapt
  private arrivalIntervals: number[] = []  // Last 20 packet arrival intervals (ms)
  private lastArrivalTime = 0
  private readonly MIN_BUFFER_FRAMES = 2   // 20ms minimum
  private readonly MAX_BUFFER_FRAMES = 8   // 80ms maximum

  async init(): Promise<MediaStream> {
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
    this.audioContextPlay = new AudioContext({ sampleRate: SAMPLE_RATE })
    // P0-2 fix: Resume AudioContext to unfreeze from browser autoplay policy
    await this.audioContextPlay.resume()
    this.masterGain = this.audioContextPlay.createGain()
    this.masterGain.gain.value = 1.0
    this.masterGain.connect(this.audioContextPlay.destination)
    await this.initPlaybackWorklet()
  }

  private async initPlaybackWorklet(): Promise<void> {
    if (!this.audioContextPlay || !this.masterGain) return

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
      await this.audioContextPlay.audioWorklet.addModule(url)
      if (!this.audioContextPlay || !this.masterGain) return
      this.playbackWorklet = new AudioWorkletNode(this.audioContextPlay, 'playback-processor')
      this.playbackWorklet.connect(this.masterGain)
    } catch (err) {
      console.warn('[Audio] Playback worklet failed, using legacy mode:', err)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private startLevelMonitoring(): void {
    if (!this.analyser) return
    const data = new Uint8Array(this.analyser.frequencyBinCount)
    const update = () => {
      if (this.analyser) {
        this.analyser.getByteFrequencyData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const rms   = Math.sqrt(sum / data.length)
        // FIX: Normalize level to 0–1 range instead of 0–100 for consistency.
        const level = Math.min(1.0, rms / 128)
        this.currentLevel = level
        if (this.levelCallback) {
          this.levelCallback(level)
        }
      }
      this.animationFrameId = requestAnimationFrame(update)
    }
    update()
  }

  onLevel(cb: AudioLevelCallback): void {
    this.levelCallback = cb
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
    this.timestamp     = 0
    this.frameBuffer   = []

    if (typeof AudioWorkletNode !== 'undefined') {
      this.startCaptureWithWorklet()
    } else {
      this.startCaptureWithScriptProcessor()
    }
  }

  private startCaptureWithWorklet(): void {
    if (!this.audioContext) return
    const code = `
      class MicProcessor extends AudioWorkletProcessor {
        process(inputs, outputs) {
          const input = inputs[0]
          if (!input || !input[0]) return true
          this.port.postMessage({ f32: Array.from(input[0]) })
          return true
        }
      }
      registerProcessor('mic-processor', MicProcessor)
    `
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))

    this.audioContext.audioWorklet.addModule(url).then(() => {
      if (!this.audioContext) return
      const node = new AudioWorkletNode(this.audioContext, 'mic-processor')
      ;(node.port as MessagePort).onmessage = (ev: MessageEvent) => {
        if (!this.muted) {
          this.onAudioFrame(new Float32Array(ev.data.f32))
        }
      }
      node.connect(this.audioContext.destination)
      this.processor = node
      URL.revokeObjectURL(url)
    }).catch(err => {
      console.error('[Audio] AudioWorklet failed, falling back:', err)
      URL.revokeObjectURL(url)
      this.startCaptureWithScriptProcessor()
    })
  }

  private startCaptureWithScriptProcessor(): void {
    if (!this.audioContext) return
    const node = this.audioContext.createScriptProcessor(4096, 1, 1)
    node.onaudioprocess = (ev) => {
      if (!this.muted) {
        this.onAudioFrame(new Float32Array(ev.inputBuffer.getChannelData(0)))
      }
    }
    node.connect(this.audioContext.destination)
    this.processor = node
  }

  private onAudioFrame(f32: Float32Array): void {
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
        const spa1 = buildSpa1Packet(
          pcm16,
          SPA1_CODEC_PCM16,
          this.sequence++,
          Math.floor(this.timestamp / 100),  // server uses 100ms units
          `${this.roomId}:${this.userId}`
        )
        this.timestamp += FRAME_SAMPLES
        // Send via unreliable DataChannel (browser → DTLS → proxy → UDP 9003)
        if (this.audioChannel?.readyState === 'open') {
          this.audioChannel.send(spa1)
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

  // ── Mixer WebRTC DataChannel (replaces WebSocket) ─────────────────────────

  public async connectMixer(userId: string, roomId: string): Promise<void> {
    this.userId = userId
    this.roomId = roomId

    // Clean up any existing PeerConnection before creating a new one
    // This handles signal reconnect scenarios where the old PC is still alive
    if (this.pc) {
      console.log('[Mixer] Cleaning up existing PeerConnection before reconnect')
      this.signalUnsub?.()
      this.signalUnsub = null
      this.controlChannel = null
      this.audioChannel = null
      try { this.pc.close() } catch (_) {}
      this.pc = null
    }

    // Lazy import to avoid circular dependency at module level
    const { signalService } = await import('./signalService')

    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.qq.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.miwifi.com:3478' },
      ],
    })

    // Create DataChannels (browser is the offerer)
    this.controlChannel = this.pc.createDataChannel('control', {
      ordered: true,
    })
    this.audioChannel = this.pc.createDataChannel('audio', {
      ordered: false,
      maxRetransmits: 0,  // unreliable, UDP-like
    })

    // ── Control channel handlers ──────────────────────────────────────────
    this.controlChannel.onopen = () => {
      console.log('[Mixer] Control DataChannel open, sending MIXER_JOIN')
      this.controlChannel?.send(JSON.stringify({
        type:    'MIXER_JOIN',
        room_id: this.roomId,
        user_id: this.userId,
      }) + '\n')
    }
    this.controlChannel.onmessage = (evt) => {
      this.handleMixerMessage(evt.data)
    }
    this.controlChannel.onclose = () => {
      console.log('[Mixer] Control DataChannel closed')
      this.stopCapture()
    }

    // ── Audio channel handlers ────────────────────────────────────────────
    this.audioChannel.binaryType = 'arraybuffer'
    this.audioChannel.onopen = () => {
      console.log('[Mixer] Audio DataChannel open, sending SPA1 handshake')
      const pkt = buildSpa1Packet(
        new Uint8Array(0),
        SPA1_CODEC_HANDSHAKE,
        0, 0,
        `${this.roomId}:${this.userId}`
      )
      this.audioChannel?.send(pkt)
    }
    this.audioChannel.onmessage = (evt) => {
      this.handleMixerMessage(evt.data)
    }

    // ── ICE candidates → relay to proxy via signaling ─────────────────────
    this.pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        signalService.sendMixerIce(
          evt.candidate.candidate,
          evt.candidate.sdpMid || '0',
          this.userId
        )
      }
    }

    this.pc.onconnectionstatechange = () => {
      console.log(`[Mixer] WebRTC state: ${this.pc?.connectionState}`)
    }

    // ── Listen for MIXER_ANSWER / MIXER_ICE_RELAY from proxy ──────────────
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.signalUnsub?.()
        reject(new Error('WebRTC 连接超时'))
      }, 15000)

      let answered = false
      this.signalUnsub = signalService.onMessage((msg) => {
        if (msg.type === 'MIXER_ANSWER' && !answered) {
          answered = true
          this.pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
            .then(() => {
              clearTimeout(timer)
              console.log('[Mixer] Remote description set')
              resolve()
            })
            .catch(reject)
        } else if (msg.type === 'MIXER_ICE_RELAY') {
          this.pc?.addIceCandidate(new RTCIceCandidate({
            candidate: msg.candidate,
            sdpMid: msg.sdpMid,
          })).catch(e => console.warn('[Mixer] ICE error:', e))
        }
      })

      // Create and send offer
      this.pc!.createOffer()
        .then(offer => this.pc!.setLocalDescription(offer))
        .then(() => {
          const sdp = this.pc!.localDescription!.sdp
          signalService.sendMixerOffer(sdp, this.userId)
          console.log('[Mixer] SDP offer sent via signaling')
        })
        .catch(reject)
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
    if (!this.audioContextPlay || !this.masterGain) return

    // Record arrival time and update adaptive buffer depth
    const now = performance.now()
    this.updateAdaptiveBufferDepth(now)

    const header = parseSpa1Header(data)
    if (!header || header.dataSize === 0) return

    const pcm = parseSpa1Body(data)
    const f32 = pcm16ToFloat32(pcm)

    // Ring buffer path: send float32 samples to playback worklet
    // Use transferable ArrayBuffer to avoid copy and reduce GC pressure
    if (this.playbackWorklet) {
      this.playbackWorklet.port.postMessage(f32, [f32.buffer])
      return
    }

    // Legacy fallback: create buffer + source per frame
    const buffer = this.audioContextPlay.createBuffer(
      CHANNELS,
      f32.length,
      SAMPLE_RATE
    )
    buffer.getChannelData(0).set(f32)

    const src = this.audioContextPlay.createBufferSource()
    src.buffer = buffer
    src.connect(this.masterGain)
    src.start(0)
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

  /** Enumerate all available audio input devices */
  async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
    try {
      // Request permission first so device labels are visible
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter(d => d.kind === 'audioinput')
    } catch {
      return []
    }
  }

  /** Switch to a different audio input device by its deviceId */
  async setInputDevice(deviceId: string): Promise<void> {
    // Stop existing tracks
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(t => t.stop())
    }
    // Re-acquire with the chosen device
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
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
    // Reconnect source to analyser
    if (this.source && this.analyser) {
      this.source.disconnect()
      this.source = this.audioContext!.createMediaStreamSource(this.mediaStream)
      this.source.connect(this.analyser)
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

  // ── Audio latency measurement (via control DataChannel PING/PONG) ─────────

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.controlChannel?.readyState === 'open') {
        this.pingSentAt = performance.now()
        this.controlChannel.send(JSON.stringify({ type: 'PING' }) + '\n')
      }
    }, 3000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /** Subscribe to audio latency updates (ms RTT via DataChannel). Returns unsubscribe. */
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
    this.audioContextPlay?.close()
    this.signalUnsub?.()
    this.controlChannel?.close()
    this.audioChannel?.close()
    this.pc?.close()
    this.mediaStream       = null
    this.audioContext      = null
    this.audioContextPlay  = null
    this.analyser          = null
    this.source            = null
    this.pc                = null
    this.controlChannel    = null
    this.audioChannel      = null
    this.signalUnsub       = null
    this.masterGain        = null
  }
}

export const audioService = new AudioService()
