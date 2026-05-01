import type { PeerInfo } from '../types'

type SignalHandler = (msg: SignalMessage) => void

type SignalMessage =
  | { type: 'PEER_LIST'; peers: PeerInfo[] }
  | { type: 'PEER_JOINED'; peer: PeerInfo }
  | { type: 'PEER_LEFT'; user_id: string }
  | { type: 'ROOM_LIST'; rooms: string[] }
  | { type: 'JOIN_ROOM_ACK'; room_id: string }
  | { type: 'CREATE_ROOM_ACK'; room_id: string }
  | { type: 'ERROR'; message: string }
  // Sent by the server when a newer connection takes over this user_id —
  // another device or tab joined with the same identity. The old session
  // must surrender (do not reconnect) or it would race the new one.
  | { type: 'SESSION_REPLACED'; user_id: string }
  // WebRTC mixer signaling relay
  | { type: 'MIXER_ANSWER'; target_user_id: string; sdp: string }
  | { type: 'MIXER_ICE_RELAY'; target_user_id: string; candidate: string; sdpMid: string }

class SignalService {
  private ws: WebSocket | null = null
  private handlers: SignalHandler[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private roomId = ''
  private userId = ''
  // Set after SESSION_REPLACED. Suppresses scheduleReconnect so we don't
  // bounce back and immediately re-take over the new session in a loop.
  private sessionReplaced = false

  // Ping/latency measurement
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pingSentAt = 0
  private _latency = -1
  private latencyCallbacks: Array<(ms: number) => void> = []

  async connect(): Promise<void> {
    // Use wss if page is https, else ws
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // /new path routes to the Guangzhou test signaling; root path stays on production.
    const apiHost = window.location.pathname.startsWith('/new') ? 'api-new.tonel.io' : 'api.tonel.io'
    const url = `${protocol}//${apiHost}/signaling`

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)
      this.ws.onopen = () => {
        console.log('[Signal] Connected')
        this.startHeartbeat()
        // v3.6.2: replay JOIN_ROOM after reconnect.
        //
        // Without this, the post-reconnect ctx is unknown to the
        // server's room map: on_close has already removed our prior
        // membership and broadcast PEER_LEFT. Subsequent peers' joins
        // never reach us — `peers=0` even while the mixer-side audio
        // path keeps working (mixer has its own auto-rehandshake in
        // audioService). That's the long-standing
        // `peers=0 roomUsers=2` discrepancy the user kept hitting.
        //
        // Server's join_room is idempotent on the room.users set
        // (`add_user` returns false on duplicate inserts but doesn't
        // error), so a stray replay when we're still actually in the
        // room is harmless.
        if (this.roomId && this.userId) {
          console.log('[Signal] Reconnect: replaying JOIN_ROOM for', this.roomId, this.userId)
          this.send({
            type:    'JOIN_ROOM',
            room_id: this.roomId,
            user_id: this.userId,
            ip:      '0.0.0.0',
            port:    9003,
          })
        }
        resolve()
      }
      this.ws.onmessage = (evt) => {
        const messages = evt.data.split('\n').filter((m: string) => m.trim())
        for (const raw of messages) {
          try {
            const parsed = JSON.parse(raw)

            // Handle PONG for latency measurement
            if (parsed.type === 'PONG' || parsed.type === 'HEARTBEAT_ACK') {
              if (this.pingSentAt > 0) {
                this._latency = Math.round(performance.now() - this.pingSentAt)
                this.pingSentAt = 0
                this.latencyCallbacks.forEach(cb => cb(this._latency))
              }
              continue
            }

            // SESSION_REPLACED: a newer connection has taken over this uid.
            // Flag the service so the imminent server-initiated close does
            // not trigger reconnect, then forward to subscribers (App will
            // surface the toast and route the user back home).
            if (parsed.type === 'SESSION_REPLACED') {
              this.sessionReplaced = true
            }

            // Server sends PEER_JOINED with flat {user_id, ip, port} at top level,
            // but SignalMessage expects a nested peer object — normalize here.
            let msg: SignalMessage
            if (parsed.type === 'PEER_JOINED' && parsed.user_id !== undefined) {
              msg = {
                type: 'PEER_JOINED',
                peer: { user_id: parsed.user_id, ip: parsed.ip ?? '', port: parsed.port ?? 0 },
              }
            } else {
              msg = parsed as SignalMessage
            }
            this.handlers.forEach(h => h(msg))
          } catch (e) {
            console.warn('[Signal] Parse error:', raw)
          }
        }
      }
      this.ws.onerror = (err) => {
        console.error('[Signal] Error:', err)
        reject(new Error('WebSocket error'))
      }
      this.ws.onclose = () => {
        console.log('[Signal] Disconnected')
        this.stopHeartbeat()
        if (!this.sessionReplaced) this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {})
    }, 3000)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.pingSentAt = performance.now()
        this.send({ type: 'HEARTBEAT', user_id: this.userId })
      }
    }, 5000) // Send heartbeat every 5 seconds (also serves as ping)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /** Subscribe to latency updates (ms). Returns unsubscribe function. */
  onLatency(callback: (ms: number) => void): () => void {
    this.latencyCallbacks.push(callback)
    // Immediately report last known latency if available
    if (this._latency >= 0) callback(this._latency)
    return () => {
      this.latencyCallbacks = this.latencyCallbacks.filter(cb => cb !== callback)
    }
  }

  get latency(): number {
    return this._latency
  }

  async joinRoom(roomId: string, userId: string, ip: string, port: number, password?: string): Promise<void> {
    await this.ensureConnected()
    this.roomId = roomId
    this.userId = userId
    const msg: Record<string, unknown> = { type: 'JOIN_ROOM', room_id: roomId, user_id: userId, ip, port }
    if (password) msg.password = password
    return this.sendAndWait(msg, 'JOIN_ROOM_ACK')
  }

  async createRoom(roomId: string, userId: string, password?: string): Promise<void> {
    await this.ensureConnected()
    this.roomId = roomId
    this.userId = userId
    const msg: Record<string, unknown> = { type: 'CREATE_ROOM', room_id: roomId, user_id: userId }
    if (password) msg.password = password
    return this.sendAndWait(msg, 'CREATE_ROOM_ACK')
  }

  // Wait for WebSocket to be OPEN (handles CONNECTING state without creating a duplicate connection)
  private ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        const ws = this.ws!
        const onOpen = () => { ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onError); resolve() }
        const onError = () => { ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onError); reject(new Error('连接失败')) }
        ws.addEventListener('open', onOpen)
        ws.addEventListener('error', onError)
      })
    }
    return this.connect()
  }

  // Send a message and wait for the expected ACK type or any ERROR
  private sendAndWait(msg: Record<string, unknown>, ackType: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws

      const cleanup = () => {
        clearTimeout(timer)
        unsub()
        ws?.removeEventListener('close', onClose)
      }

      // Immediately reject if the connection drops while waiting
      const onClose = () => { cleanup(); reject(new Error('连接已断开')) }
      ws?.addEventListener('close', onClose)

      const timer = setTimeout(() => { cleanup(); reject(new Error('连接超时')) }, 8000)

      const unsub = this.onMessage((m) => {
        if (m.type === ackType) { cleanup(); resolve() }
        else if (m.type === 'ERROR') { cleanup(); reject(new Error(m.message)) }
      })

      if (!this.send(msg)) {
        cleanup()
        reject(new Error('未连接到服务器'))
      }
    })
  }

  // ── WebRTC mixer signaling ───────────────────────────────────────────────

  sendMixerOffer(sdp: string, userId: string): boolean {
    return this.send({ type: 'MIXER_OFFER', user_id: userId, sdp })
  }

  sendMixerIce(candidate: string, sdpMid: string, userId: string): boolean {
    return this.send({ type: 'MIXER_ICE', user_id: userId, candidate, sdpMid })
  }

  async leaveRoom(): Promise<void> {
    if (!this.ws) return
    this.send({
      type: 'LEAVE_ROOM',
      room_id: this.roomId,
      user_id: this.userId,
    })
    this.roomId = ''
    this.userId = ''
  }

  private send(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg) + '\n')
      return true
    }
    return false
  }

  onMessage(handler: SignalHandler): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }

  /** Reset the session-replaced latch — call after the user explicitly
   *  re-engages (logs in / joins a room) so future drops can reconnect. */
  resetSessionReplaced(): void {
    this.sessionReplaced = false
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const signalService = new SignalService()
