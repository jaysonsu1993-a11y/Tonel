/**
 * Lightweight RTT probe against the audio mixer's control WebSocket.
 *
 * Used by the home page hero to display the same RTT figure that
 * appears inside a live room — the mixer-server round-trip — instead
 * of the signal server's RTT (which routes through a different host).
 *
 * Wire path: opens wss://<mixer-host>/mixer-tcp and sends bare
 * `{"type":"PING"}` lines on a 3 s cadence. The mixer replies
 * `{"type":"PONG"}` without requiring MIXER_JOIN — see
 * server/src/mixer_server.cpp PING branch. Auto-reconnects on close.
 *
 * Host pairing (srv.tonel.io vs srv-new.tonel.io) tracks the same
 * `/new` pathPrefix rule audioService.ts uses, so the home page
 * matches whichever environment the room would actually connect to.
 */

type Sub = (rttMs: number) => void

class MixerRttProbe {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingSentAt = 0
  private last = -1
  private subs: Sub[] = []
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    this.connect()
  }

  stop(): void {
    this.started = false
    if (this.pingTimer)      { clearInterval(this.pingTimer);      this.pingTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    try { this.ws?.close() } catch { /* noop */ }
    this.ws = null
  }

  onLatency(cb: Sub): () => void {
    this.subs.push(cb)
    if (this.last >= 0) { try { cb(this.last) } catch { /* noop */ } }
    return () => { this.subs = this.subs.filter(s => s !== cb) }
  }

  private connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host     = location.pathname.startsWith('/new') ? 'srv-new.tonel.io' : 'srv.tonel.io'
    const url      = `${protocol}//${host}/mixer-tcp`

    let ws: WebSocket
    try { ws = new WebSocket(url) } catch { this.scheduleReconnect(); return }
    this.ws = ws

    ws.onopen = () => {
      this.sendPing()
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.sendPing(), 3000)
    }
    ws.onmessage = (evt) => {
      if (typeof evt.data !== 'string') return
      for (const line of evt.data.split('\n')) {
        if (!line.trim()) continue
        try {
          const m = JSON.parse(line)
          if (m.type === 'PONG' && this.pingSentAt > 0) {
            const rtt = Math.round(performance.now() - this.pingSentAt)
            this.pingSentAt = 0
            this.last = rtt
            for (const cb of this.subs) { try { cb(rtt) } catch { /* noop */ } }
          }
        } catch { /* ignore non-JSON */ }
      }
    }
    ws.onerror = () => { /* surfaced via onclose */ }
    ws.onclose = () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
      this.ws = null
      if (this.started) this.scheduleReconnect()
    }
  }

  private sendPing(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.pingSentAt = performance.now()
    this.ws.send(JSON.stringify({ type: 'PING' }) + '\n')
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.started) this.connect()
    }, 3000)
  }
}

export const mixerRttProbe = new MixerRttProbe()
