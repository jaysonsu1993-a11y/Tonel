/**
 * Mixer host selection with auto-fallback.
 *
 * Production has two mixer servers behind two different hostnames:
 *   - srv.tonel.io     → 酷番云广州 (primary, v5.0.0+)
 *   - srv-new.tonel.io → Aliyun Beijing (fallback)
 *
 * The kufan box is the primary because it's geographically closer to
 * most users (CN south), but its hypervisor has an aggressive,
 * un-tunable network-level "abuse" filter that occasionally blocks
 * a client IP for 10-60 minutes after seeing a burst of half-open
 * connections (we don't get a knob — the rule lives outside our VM).
 * When that happens, the user's TLS handshakes to srv.tonel.io get
 * RST'd at the virtual-network layer and the OS never sees them.
 *
 * Without fallback, that lockout makes tonel.io/ totally unusable
 * until the timer expires. With fallback, the client probes
 * srv.tonel.io first, and if its TLS layer is unreachable, switches
 * to srv-new.tonel.io. The choice is cached in localStorage with a
 * short TTL so subsequent connects within the same session are
 * instant — and so when the kufan timer expires, we organically
 * flip back without the user noticing.
 *
 * The probe is GET / against the host (a static 200 OK from nginx,
 * no upstream proxy). RST or timeout = host unreachable.
 *
 * Forced via `?host=` query param or `/new` pathPrefix:
 *   /new          → always Aliyun
 *   ?host=kufan   → force kufan (no fallback)
 *   ?host=aliyun  → force Aliyun
 */

const KUFAN_HOST  = 'srv.tonel.io'
const ALIYUN_HOST = 'srv-new.tonel.io'
const CACHE_KEY   = 'tonel-mixer-host-v1'
const CACHE_TTL_MS = 10 * 60 * 1000  // 10 minutes
const PROBE_TIMEOUT_MS = 2500

interface Cached { host: string; ts: number }

function loadCached(): string | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached
    if (Date.now() - c.ts > CACHE_TTL_MS) return null
    if (c.host !== KUFAN_HOST && c.host !== ALIYUN_HOST) return null
    return c.host
  } catch { return null }
}

function saveCached(host: string): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ host, ts: Date.now() } as Cached))
  } catch { /* localStorage disabled */ }
}

function clearCached(): void {
  try { localStorage.removeItem(CACHE_KEY) } catch {}
}

async function probeReachable(host: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:'
  const url = `${protocol}//${host}/`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // mode: 'no-cors' so a 200 with restrictive CORS still resolves OK.
    // We don't read the response, only verify the request didn't error
    // out at the TLS / TCP layer (which is what RST shows up as in
    // the fetch API — `TypeError: Failed to fetch`).
    await fetch(url, { method: 'GET', cache: 'no-store', signal: ctrl.signal, mode: 'no-cors' })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/**
 * Resolve the mixer host to use for this session. Cached for 10 min.
 * The `/new` URL prefix and `?host=` query param both override the
 * auto-selection. Otherwise: kufan-first, with auto-fallback to Aliyun
 * if kufan is unreachable.
 *
 * @param forceRetest skip the cache and re-probe (e.g. after a connect
 *                    failure on the cached host).
 */
export async function pickMixerHost(forceRetest = false): Promise<string> {
  // Explicit overrides
  if (location.pathname.startsWith('/new')) return ALIYUN_HOST
  const forced = new URLSearchParams(location.search).get('host')
  if (forced === 'kufan')  return KUFAN_HOST
  if (forced === 'aliyun') return ALIYUN_HOST

  // Cached decision still fresh
  if (!forceRetest) {
    const cached = loadCached()
    if (cached) return cached
  }

  // Probe primary (kufan)
  if (await probeReachable(KUFAN_HOST)) {
    saveCached(KUFAN_HOST)
    return KUFAN_HOST
  }

  // Primary unreachable — use fallback. Cache it so subsequent connects
  // within the session don't pay the probe cost again.
  console.warn(`[mixerHost] ${KUFAN_HOST} unreachable, falling back to ${ALIYUN_HOST}`)
  saveCached(ALIYUN_HOST)
  return ALIYUN_HOST
}

/**
 * Mark the currently-cached host as bad (e.g. after a WSS handshake
 * error). The next `pickMixerHost()` call will re-probe and, if needed,
 * flip to the other host.
 */
export function invalidateMixerHostCache(): void {
  clearCached()
}

/** Whether the active host is the fallback. UI may want to show a hint. */
export function isUsingFallbackHost(): boolean {
  const cached = loadCached()
  return cached === ALIYUN_HOST && !location.pathname.startsWith('/new')
}
