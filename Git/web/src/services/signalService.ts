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

  async connect(): Promise<void> {
    // Use wss if page is https, else ws
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//api.tonel.io/signaling`

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url)
      this.ws.onopen = () => {
        console.log('[Signal] Connected')
        this.startHeartbeat()
        resolve()
      }
      this.ws.onmessage = (evt) => {
        const messages = evt.data.split('\n').filter((m: string) => m.trim())
        for (const raw of messages) {
          try {
            const parsed = JSON.parse(raw)
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
        this.scheduleReconnect()
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
        this.send({ type: 'HEARTBEAT', user_id: this.userId })
      }
    }, 10000) // Send heartbeat every 10 seconds
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
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

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const signalService = new SignalService()
