/**
 * Lightweight RTT probe to the audio mixer for the home-page hero
 * number. v5.1.10 redesign — **does not open a WebSocket**.
 *
 * Why fetch instead of WSS:
 *   The previous WSS-based probe (v5.0.3 → v5.1.8) opened its own
 *   /mixer-tcp socket from the home page, then audioService opened
 *   ITS /mixer-tcp socket the moment the user entered a room. Two
 *   concurrent WSS handshakes from the same client through 酷番云's
 *   hypervisor reliably tripped a hypervisor-level handshake drop.
 *   Five releases (v5.1.6, .7, .8, .9, and the audioService cleanup
 *   in this one) all ultimately came back to the same conclusion:
 *   the home page must not pre-open a /mixer-tcp WebSocket. v5.1.9
 *   removed the probe entirely; v5.1.10 brings it back via plain
 *   HTTPS.
 *
 * Wire path: GET https://<mixer-host>/mixer-tcp. The endpoint is
 * really a WebSocket upgrade, but a plain GET against it (no
 * Upgrade/Connection headers) returns nginx's `426 Upgrade Required`
 * — fast, cheap, no upgrade negotiated. We measure the elapsed time
 * of the round trip. Includes TCP+TLS the first time, then HTTP/2
 * stream RTT thereafter (the browser pools the connection). Either
 * way it's a tight upper bound on the user-to-mixer network RTT,
 * close enough to the WebSocket PING/PONG figure for a homepage
 * cosmetic display.
 *
 * Host pairing (srv.tonel.io vs srv-new.tonel.io) follows the same
 * `/new` rule as audioService.connectMixer.
 */

type Sub = (rttMs: number) => void

class MixerRttProbe {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: AbortController | null = null
  private last = -1
  private subs: Sub[] = []
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 3000)
  }

  // Synchronous — no socket to await. Aborts any in-flight fetch so
  // a navigating-away page doesn't keep a request alive past unmount.
  stop(): void {
    this.started = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.inFlight) { try { this.inFlight.abort() } catch { /* noop */ } this.inFlight = null }
  }

  onLatency(cb: Sub): () => void {
    this.subs.push(cb)
    if (this.last >= 0) { try { cb(this.last) } catch { /* noop */ } }
    return () => { this.subs = this.subs.filter(s => s !== cb) }
  }

  private async tick(): Promise<void> {
    if (!this.started) return
    const protocol = location.protocol === 'https:' ? 'https:' : 'http:'
    const host     = location.pathname.startsWith('/new') ? 'srv-new.tonel.io' : 'srv.tonel.io'
    const url      = `${protocol}//${host}/mixer-tcp`

    const controller = new AbortController()
    this.inFlight = controller
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    const t0 = performance.now()
    try {
      // Don't care about the response body — server returns 426 for a
      // plain GET against the WS endpoint, which arrives quickly.
      // `cache: 'no-store'` makes the timing reliable across reloads.
      await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        // Avoid sending a CORS preflight: we read no headers from
        // the response; the browser only times the round trip.
        mode: 'no-cors',
      })
    } catch (_) {
      // Aborted, network failure, etc. Don't fire callback on failure.
      clearTimeout(timeoutId)
      if (this.inFlight === controller) this.inFlight = null
      return
    }
    clearTimeout(timeoutId)
    if (this.inFlight === controller) this.inFlight = null

    const rtt = Math.round(performance.now() - t0)
    this.last = rtt
    for (const cb of this.subs) {
      try { cb(rtt) } catch { /* noop */ }
    }
  }
}

export const mixerRttProbe = new MixerRttProbe()
