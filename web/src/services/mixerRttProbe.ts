/**
 * Lightweight RTT probe to the audio mixer for the home-page hero
 * number. v5.1.20 redesign — **same algorithm as the in-room RTT
 * display**: a WebSocket PING/PONG against `/mixer-tcp`, timed by
 * `performance.now()` between send and receipt of the JSON `{type:
 * "PONG"}` reply. This produces a single number that's directly
 * comparable to the in-room latency strip — same wire protocol, same
 * server processing path, same RTT semantics.
 *
 * **Independent measurement** — does NOT read `audioService._audioLatency`
 * or any other in-room state. The probe owns its own WebSocket; in-room
 * code owns its own. Both happen to send identical `{type:"PING"}`
 * frames over identical `/mixer-tcp` URLs, but the JS-level data flows
 * never touch each other.
 *
 * History:
 *  - v5.0.3 → v5.1.8: WSS PING/PONG (this current shape, but the close
 *    semantics on navigation were racy → tripped kufan DPI's "two
 *    concurrent /mixer-tcp WS handshakes" rule).
 *  - v5.1.9: removed entirely (homepage hero became a placeholder
 *    animation).
 *  - v5.1.10–.11: HTTPS `fetch('/')` instead of WSS — gave a real
 *    number but ~5ms higher than the in-room display because of HTTP
 *    request overhead vs WS frames.
 *  - v5.1.20 (this version): back to WSS PING/PONG to match the
 *    in-room number, with the v5.1.7 lessons baked in: `stop()`
 *    returns Promise<void> that resolves on actual CLOSED, and
 *    `App.tsx`'s navigation handlers `await mixerRttProbe.stop()`
 *    BEFORE setting `setPage('room')` — guarantees the homepage WS
 *    is fully off the wire before audioService opens its own.
 *
 * Wire path: `wss://<mixer-host>/mixer-tcp`. The mixer's `PING` branch
 * (server/src/mixer_server.cpp) replies `{"type":"PONG"}` without
 * requiring MIXER_JOIN, so a homepage probe with no roomId/userId
 * works fine. Pings every 3 s after first connect; auto-reconnects on
 * close while the probe is still `started`.
 *
 * Host pairing follows the same `/new` rule the rest of the app uses.
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

  /**
   * Asynchronous stop — resolves only when the underlying WebSocket
   * has actually reached `CLOSED`. Callers (App.tsx's navigation
   * handlers) `await` this before triggering `setPage('room')` so
   * the homepage's `/mixer-tcp` socket is fully off the wire before
   * `audioService.connectMixer` opens its own. This is the v5.1.7
   * lesson recapitulated: a synchronous `ws.close()` only marks the
   * socket CLOSING; the kernel teardown takes another 50–200 ms,
   * during which a new WS handshake to the same path on the same IP
   * can be flagged as a burst by the kufan upstream DPI.
   */
  stop(): Promise<void> {
    this.started = false
    if (this.pingTimer)      { clearInterval(this.pingTimer);     this.pingTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    const w = this.ws
    this.ws = null
    if (!w || w.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => { w.onclose = null; w.onerror = null; resolve() }
      w.onclose = done
      w.onerror = done
      try { w.close() } catch { done() }
      // Belt-and-suspenders timeout — if the close handler somehow
      // never fires (very rare), don't deadlock the join flow. 500 ms
      // is comfortably above normal TCP teardown.
      setTimeout(done, 500)
    })
  }

  onLatency(cb: Sub): () => void {
    this.subs.push(cb)
    if (this.last >= 0) { try { cb(this.last) } catch { /* noop */ } }
    return () => { this.subs = this.subs.filter(s => s !== cb) }
  }

  private connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // v5.1.22: mirror audioService.ts host routing (/, /new, /hk).
    const _path    = location.pathname
    const host     = _path.startsWith('/new') ? 'srv-new.tonel.io'
                   : _path.startsWith('/hk')  ? 'srv-hk.tonel.io'
                   :                             'srv.tonel.io'
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
