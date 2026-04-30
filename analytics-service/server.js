/**
 * tonel-analytics-service (Cloudflare GraphQL mode)
 *
 * Reads visitor analytics directly from Cloudflare's edge logs via the
 * GraphQL Analytics API. No tracker snippet, no client-side JS, no
 * database. Cloudflare has been recording every request to tonel.io
 * since you put the domain behind their network — `npm start` and the
 * dashboard immediately shows historical data (up to ~30 days on Free
 * plan).
 *
 * Endpoints (same shape as the old tracker-based version, so the admin
 * UI didn't have to change):
 *
 *   POST /api/admin/login          → JWT
 *   GET  /api/dashboard/summary    → KPIs
 *   GET  /api/dashboard/trend      → time-series
 *   GET  /api/dashboard/geo        → world-map points (country centroids)
 *   GET  /api/dashboard/countries  → top countries
 *   GET  /api/dashboard/cities     → ASN proxy (CF doesn't expose city)
 *   GET  /api/dashboard/devices    → device / browser / OS
 *   GET  /api/dashboard/paths      → top URLs
 *   GET  /api/dashboard/recent     → most-recent activity (per-minute aggregate)
 *   GET  /admin/                   → static dashboard
 *   GET  /health                   → liveness + cf-credentials check
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');

// Offline IP→city lookup. Soft-require so the service still boots if the
// optional native data files aren't installed.
let geoip;
try { geoip = require('geoip-lite'); }
catch (_) { geoip = { lookup: () => null }; }

// Lightweight UA parser (soft-require so the service still boots without it).
let UAParser;
try { UAParser = require('ua-parser-js'); }
catch (_) {
    UAParser = function (ua) {
        ua = String(ua || '');
        return { getResult: () => ({
            browser: { name:
                /Edg\//.test(ua) ? 'Edge' :
                /OPR\//.test(ua) ? 'Opera' :
                /Chrome\//.test(ua) ? 'Chrome' :
                /Firefox\//.test(ua) ? 'Firefox' :
                /Safari\//.test(ua) ? 'Safari' : null,
            },
            os: { name:
                /Mac OS X/.test(ua) ? 'macOS' :
                /Windows/.test(ua) ? 'Windows' :
                /Android/.test(ua) ? 'Android' :
                /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
                /Linux/.test(ua) ? 'Linux' : null,
            },
            device: { type:
                /iPad|Tablet/.test(ua) ? 'tablet' :
                /Mobile|Android|iPhone/.test(ua) ? 'mobile' : 'desktop',
            },
        }) };
    };
}

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '9007', 10);
const JWT_SECRET     = process.env.JWT_SECRET || 'tonel-analytics-dev-secret';
const ADMIN_USER     = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CF_TOKEN       = process.env.CLOUDFLARE_API_TOKEN;
const CF_ZONE        = process.env.CLOUDFLARE_ZONE_ID;
const CORS_ORIGINS   = (process.env.CORS_ORIGINS || '*')
    .split(',').map(s => s.trim()).filter(Boolean);

const SELF_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
for (const o of SELF_ORIGINS) if (!CORS_ORIGINS.includes(o)) CORS_ORIGINS.push(o);

if (!CF_TOKEN || !CF_ZONE) {
    console.error('[FATAL] CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID must be set in .env');
    console.error('        See .env.example for instructions.');
    process.exit(1);
}

const app = express();
app.use(express.json({ limit: '32kb' }));

const corsAllowList = cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (CORS_ORIGINS.includes('*')) return cb(null, true);
        if (CORS_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
});

// ─── Cloudflare GraphQL helper ──────────────────────────────────────────────
const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

async function cfQuery(query, variables) {
    const r = await fetch(CF_GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CF_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) {
        const text = await r.text();
        throw new Error(`Cloudflare API HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
    const json = await r.json();
    if (json.errors && json.errors.length) {
        throw new Error('Cloudflare GraphQL: ' + json.errors.map(e => e.message).join('; '));
    }
    return json.data;
}

// Lightweight 60-second cache so refreshing the dashboard doesn't hammer
// Cloudflare's API. Keyed by query + variables.
const CACHE = new Map();
const CACHE_TTL_MS = 60 * 1000;

async function cfQueryCached(query, variables) {
    const key = JSON.stringify([query, variables]);
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    const v = await cfQuery(query, variables);
    CACHE.set(key, { t: Date.now(), v });
    if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
    return v;
}

// ─── Range → ISO timestamps ─────────────────────────────────────────────────
function rangeWindow(range) {
    const until = new Date();
    const since = new Date(until);
    switch (range) {
        case '24h': since.setHours(since.getHours() - 24); break;
        case '7d':  since.setDate(since.getDate() - 7); break;
        // Cloudflare Free plan retains httpRequestsAdaptiveGroups data for
        // ~8 days (the API rejects "older than 1w1d"). Clamp 30d/all to 7d
        // so the dashboard still shows the widest available window instead
        // of erroring. Upgrade to Pro plan for true 30d.
        case '30d': since.setDate(since.getDate() - 7); break;
        case 'all': since.setDate(since.getDate() - 7); break;
        default:    since.setHours(since.getHours() - 24);
    }
    return { since: since.toISOString(), until: until.toISOString() };
}

// ─── Auth ───────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        if (payload.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

app.post('/api/admin/login', corsAllowList, (req, res) => {
    const { username, password } = req.body || {};
    if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = jwt.sign({ role: 'admin', user: username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, expiresIn: 7 * 24 * 3600 });
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok', service: 'analytics', mode: 'cloudflare-graphql',
        zone: CF_ZONE.slice(0, 8) + '…',
        ts: new Date().toISOString(),
    });
});

// ─── Cloudflare query helper ────────────────────────────────────────────────
/**
 * Adaptive groups have full UA + path + country dimensions. Used for
 * everything visitor-facing.
 *
 * Cloudflare Free plan caps httpRequestsAdaptiveGroups to a 24h window per
 * query. For longer ranges we split into ≤24h sub-windows, query in
 * parallel, and merge groups by their dimensions.
 */
async function cfAdaptiveOne(since, until, dims, opts = {}) {
    const dimList = dims.map(d => `        ${d}`).join('\n');
    const limit = opts.limit || 1000;
    const order = opts.order || 'count_DESC';
    const data = await cfQueryCached(`
        query AdaptiveGroups($zone: String!, $since: Time!, $until: Time!) {
            viewer {
                zones(filter: {zoneTag: $zone}) {
                    httpRequestsAdaptiveGroups(
                        limit: ${limit},
                        filter: {datetime_geq: $since, datetime_lt: $until},
                        orderBy: [${order}]
                    ) {
                        count
                        dimensions {
${dimList}
                        }
                    }
                }
            }
        }`,
        { zone: CF_ZONE, since, until });
    return data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
}

function chunkWindow(since, until, maxHours = 24) {
    const sMs = new Date(since).getTime();
    const uMs = new Date(until).getTime();
    const stepMs = maxHours * 3600 * 1000;
    if (uMs - sMs <= stepMs) return [[since, until]];
    const out = [];
    for (let s = sMs; s < uMs; s += stepMs) {
        const e = Math.min(s + stepMs, uMs);
        out.push([new Date(s).toISOString(), new Date(e).toISOString()]);
    }
    return out;
}

// Cloudflare's GraphQL endpoint returns transient 5xx / rate-limit errors
// when many requests fire in parallel (cold dashboard load = ~7 endpoints
// × ~7 chunks = ~49 concurrent calls). Cap concurrency and retry transient
// failures with backoff so the dashboard loads cleanly.
async function withRetry(fn, retries = 2) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try { return await fn(); }
        catch (e) {
            lastErr = e;
            const msg = String(e.message || '');
            const transient = /HTTP 5\d\d|HTTP 429|fetch failed|ECONNRESET|timeout/i.test(msg);
            if (!transient || i === retries) throw e;
            await new Promise(r => setTimeout(r, 200 * (i + 1) + Math.random() * 100));
        }
    }
    throw lastErr;
}

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

async function cfAdaptive(since, until, dims, opts = {}) {
    const chunks = chunkWindow(since, until, 24);
    if (chunks.length === 1) return cfAdaptiveOne(since, until, dims, opts);

    const all = await mapWithConcurrency(chunks, 3,
        ([s, u]) => withRetry(() => cfAdaptiveOne(s, u, dims, opts)));

    // Merge by dimensions identity. Time-bucket dims (datetimeHour/Minute/date)
    // never collide across chunks, so this just concatenates them; non-time
    // dims like country/path/UA collide and get summed.
    const merged = new Map();
    for (const groups of all) {
        for (const g of groups) {
            const key = JSON.stringify(g.dimensions);
            const cur = merged.get(key);
            if (cur) cur.count += g.count;
            else merged.set(key, { count: g.count, dimensions: { ...g.dimensions } });
        }
    }
    const result = [...merged.values()];

    const order = opts.order || 'count_DESC';
    const usc = order.lastIndexOf('_');
    const field = order.slice(0, usc);
    const dir = order.slice(usc + 1);
    result.sort((a, b) => {
        const av = field === 'count' ? a.count : a.dimensions[field];
        const bv = field === 'count' ? b.count : b.dimensions[field];
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return dir === 'ASC' ? cmp : -cmp;
    });

    if (opts.limit) return result.slice(0, opts.limit);
    return result;
}

// ─── Dashboard endpoints ────────────────────────────────────────────────────
app.use('/api/dashboard', corsAllowList, adminAuth);

// Diagnostic endpoint — handy first stop when debugging "dashboard is empty".
app.get('/api/dashboard/diagnostic', async (_req, res) => {
    try {
        const since = new Date();
        since.setDate(since.getDate() - 30);
        const data = await cfQuery(`
            query Probe($zone: String!, $since: String!) {
                viewer {
                    zones(filter: {zoneTag: $zone}) {
                        httpRequests1dGroups(
                            limit: 30, filter: {date_geq: $since},
                            orderBy: [date_DESC]
                        ) { sum { requests } dimensions { date } }
                    }
                }
            }`, { zone: CF_ZONE, since: since.toISOString().slice(0, 10) });
        res.json({ ok: true, sample: data });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/dashboard/summary', async (req, res) => {
    try {
        const { since, until } = rangeWindow(req.query.range || '7d');
        const last24 = rangeWindow('24h');

        const groups = await cfAdaptive(since, until, ['clientCountryName']);
        const last24Groups = await cfAdaptive(last24.since, last24.until, ['clientCountryName']);

        const visits = groups.reduce((s, g) => s + g.count, 0);
        const visits_24h = last24Groups.reduce((s, g) => s + g.count, 0);
        const countries = new Set(groups.map(g => g.dimensions.clientCountryName).filter(Boolean)).size;

        // Cloudflare GraphQL doesn't expose unique-IP counts on the Free plan.
        // Fallback estimate: requests per session ≈ 4 (rough empirical).
        const uniques = Math.round(visits / 4);

        res.json({ visits, uniques, countries, visits_24h });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/trend', async (req, res) => {
    try {
        const range = req.query.range || '7d';
        const { since, until } = rangeWindow(range);
        const isHour = range === '24h';
        const dim = isHour ? 'datetimeHour' : 'date';
        const order = isHour ? 'datetimeHour_ASC' : 'date_ASC';
        const groups = await cfAdaptive(since, until, [dim], { limit: 5000, order });

        const byBucket = new Map();
        for (const g of groups) {
            const key = g.dimensions[dim];
            byBucket.set(key, (byBucket.get(key) || 0) + g.count);
        }
        const points = [...byBucket.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
            .map(([k, count]) => ({
                t: Math.floor(new Date(k).getTime() / 1000),
                iso: new Date(k).toISOString(),
                visits: count,
                uniques: Math.round(count / 4),
            }));

        res.json({ bucket_seconds: isHour ? 3600 : 86400, points });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/countries', async (req, res) => {
    try {
        const { since, until } = rangeWindow(req.query.range || '7d');
        const groups = await cfAdaptive(since, until, ['clientCountryName'], { limit: 250 });

        const byCountry = new Map();
        for (const g of groups) {
            const code = g.dimensions.clientCountryName;
            if (!code) continue;
            byCountry.set(code, (byCountry.get(code) || 0) + g.count);
        }
        const countries = [...byCountry.entries()]
            .map(([code, visits]) => ({
                country_code: code,
                country: ISO_TO_NAME[code] || code,
                visits,
                uniques: Math.round(visits / 4),
            }))
            .sort((a, b) => b.visits - a.visits);

        res.json({ countries });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

// City breakdown isn't in the GraphQL schema — try ASN/network as a
// city-ish proxy. The clientASNDescription field requires a paid plan;
// fall back to country-only rows on Free.
app.get('/api/dashboard/cities', async (req, res) => {
    try {
        const { since, until } = rangeWindow(req.query.range || '7d');
        let groups, useAsn = true;
        try {
            groups = await cfAdaptive(since, until,
                ['clientCountryName', 'clientASNDescription'], { limit: 100 });
        } catch (e) {
            if (/clientasndescription|clientASNDescription/i.test(e.message)) {
                useAsn = false;
                groups = await cfAdaptive(since, until,
                    ['clientCountryName'], { limit: 100 });
            } else throw e;
        }

        const byKey = new Map();
        for (const g of groups) {
            const country = g.dimensions.clientCountryName;
            if (!country) continue;
            const asn = useAsn ? g.dimensions.clientASNDescription : '—';
            if (useAsn && !asn) continue;
            const key = country + '|' + asn;
            byKey.set(key, (byKey.get(key) || 0) + g.count);
        }
        const cities = [...byKey.entries()]
            .map(([key, visits]) => {
                const [country_code, asn] = key.split('|');
                return {
                    country_code,
                    country: ISO_TO_NAME[country_code] || country_code,
                    city: asn,
                    visits,
                    uniques: Math.round(visits / 4),
                };
            })
            .sort((a, b) => b.visits - a.visits)
            .slice(0, 30);

        res.json({
            cities,
            _note: useAsn
                ? 'CF API exposes ASN, not city — shown in city column'
                : 'Free plan: ASN dim unavailable — showing country only',
        });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

// World map points — one dot per country at its centroid, sized by visits.
app.get('/api/dashboard/geo', async (req, res) => {
    try {
        const { since, until } = rangeWindow(req.query.range || '7d');
        const groups = await cfAdaptive(since, until, ['clientCountryName'], { limit: 250 });

        const byCountry = new Map();
        for (const g of groups) {
            const code = g.dimensions.clientCountryName;
            if (!code) continue;
            byCountry.set(code, (byCountry.get(code) || 0) + g.count);
        }
        const points = [...byCountry.entries()]
            .map(([code, visits]) => {
                const c = COUNTRY_CENTROIDS[code];
                if (!c) return null;
                return {
                    country_code: code,
                    country: ISO_TO_NAME[code] || code,
                    city: null,
                    lat: c.lat, lng: c.lng,
                    visits,
                    uniques: Math.round(visits / 4),
                };
            })
            .filter(Boolean);

        res.json({ points });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/devices', async (req, res) => {
    try {
        const { since, until } = rangeWindow(req.query.range || '7d');
        const [byDevice, withUA] = await Promise.all([
            cfAdaptive(since, until, ['clientDeviceType'], { limit: 50 }),
            cfAdaptive(since, until, ['userAgent'],       { limit: 1000 }),
        ]);

        const devicesMap = new Map();
        for (const g of byDevice) {
            const t = g.dimensions.clientDeviceType || 'unknown';
            devicesMap.set(t, (devicesMap.get(t) || 0) + g.count);
        }
        const devices = [...devicesMap.entries()]
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value);

        const browsersMap = new Map(), osMap = new Map();
        for (const g of withUA) {
            const ua = g.dimensions.userAgent || '';
            const r = new UAParser(ua).getResult();
            const b = r.browser.name || 'Other';
            const o = r.os.name || 'Other';
            browsersMap.set(b, (browsersMap.get(b) || 0) + g.count);
            osMap.set(o, (osMap.get(o) || 0) + g.count);
        }
        const top = (m) => [...m.entries()]
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 10);

        res.json({ devices, browsers: top(browsersMap), os: top(osMap) });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard/paths', async (req, res) => {
    try {
        const { since, until } = rangeWindow(req.query.range || '7d');
        const groups = await cfAdaptive(since, until, ['clientRequestPath'], { limit: 200 });

        const byPath = new Map();
        for (const g of groups) {
            const p = g.dimensions.clientRequestPath || '/';
            byPath.set(p, (byPath.get(p) || 0) + g.count);
        }
        const paths = [...byPath.entries()]
            .map(([path, visits]) => ({ path, visits, uniques: Math.round(visits / 4) }))
            .sort((a, b) => b.visits - a.visits)
            .slice(0, 20);

        res.json({ paths });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

// "Recent" — Cloudflare doesn't store individual request rows, so we
// approximate with per-minute aggregates over the last hour, broken
// down by country + path + device. Each row is activity in a 1-min window.
// Mask the last octet of an IPv4 (192.0.2.45 → 192.0.2.x) or last hextet
// of an IPv6 to avoid surfacing full visitor IPs in the admin UI.
function maskIp(ip) {
    if (!ip) return '—';
    if (ip.includes('.')) {
        const parts = ip.split('.');
        if (parts.length === 4) return parts.slice(0, 3).join('.') + '.x';
    }
    if (ip.includes(':')) {
        const parts = ip.split(':');
        return parts.slice(0, -1).join(':') + ':x';
    }
    return ip;
}

app.get('/api/dashboard/recent', async (req, res) => {
    try {
        // Look back 24h, not 1h: low-traffic sites may have no visits in the
        // most recent hour, leaving "最近 50 条" empty. Cloudflare adaptive
        // groups still cap each query at 24h, but cfAdaptive chunks longer
        // ranges automatically — 24h fits in a single chunk anyway.
        const until = new Date();
        const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
        const groups = await cfAdaptive(
            since.toISOString(), until.toISOString(),
            ['datetimeMinute', 'clientIP', 'clientCountryName', 'clientRequestPath', 'clientDeviceType'],
            { limit: 500, order: 'datetimeMinute_DESC' }
        );

        const recent = groups.slice(0, 50).map(g => {
            const rawIp = g.dimensions.clientIP || '';
            const lookup = rawIp ? geoip.lookup(rawIp) : null;
            return {
                ts: Math.floor(new Date(g.dimensions.datetimeMinute).getTime() / 1000),
                ip: maskIp(rawIp),
                country: ISO_TO_NAME[g.dimensions.clientCountryName] || g.dimensions.clientCountryName || '',
                city: (lookup && lookup.city) ? lookup.city : '',
                path: g.dimensions.clientRequestPath || '/',
                browser: null, os: null,
                device: g.dimensions.clientDeviceType || 'unknown',
                count: g.count,
            };
        });

        res.json({ recent });
    } catch (e) { console.error(`[dash] ${req.path}:`, e.message); res.status(500).json({ error: e.message }); }
});

// ─── Static admin page ──────────────────────────────────────────────────────
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.get('/admin', (_req, res) => res.redirect('/admin/'));

// ─── Boot ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[tonel-analytics] listening on :${PORT} (mode: cloudflare-graphql)`);
    console.log(`[tonel-analytics]   admin → http://localhost:${PORT}/admin/`);
    console.log(`[tonel-analytics]   zone  → ${CF_ZONE.slice(0, 8)}…${CF_ZONE.slice(-4)}`);
    console.log(`[tonel-analytics]   token → ${CF_TOKEN.slice(0, 8)}…${CF_TOKEN.slice(-4)}`);
    console.log(`[tonel-analytics]   CORS  → ${CORS_ORIGINS.join(', ')}`);
    // Surface credential issues immediately, not only when someone opens the dashboard.
    // Use a 7-day window — Cloudflare caps queries at 52w1d1h, and the
    // earlier "2024-01-01" probe broke whenever today was >1y after that date.
    const probeStart = new Date();
    probeStart.setDate(probeStart.getDate() - 7);
    const probeStartDate = probeStart.toISOString().slice(0, 10);
    cfQuery(`
        query Probe($zone: String!, $since: String!) {
            viewer {
                zones(filter: {zoneTag: $zone}) {
                    httpRequests1dGroups(limit: 1, filter: {date_geq: $since}) {
                        sum { requests }
                    }
                }
            }
        }`, { zone: CF_ZONE, since: probeStartDate })
    .then(d => {
        const reqs = d.viewer.zones[0]?.httpRequests1dGroups[0]?.sum?.requests;
        console.log(`[tonel-analytics]   ✓ Cloudflare API OK (sample: ${reqs ?? 0} reqs)`);
    })
    .catch(e => {
        console.error(`[tonel-analytics]   ✗ Cloudflare API check FAILED: ${e.message}`);
        console.error(`[tonel-analytics]     verify CLOUDFLARE_API_TOKEN scope and zone id`);
    });
});

// ─── ISO 3166-1 alpha-2 country names + centroids (subset) ──────────────────
const ISO_TO_NAME = {
    US: 'United States', CN: 'China', JP: 'Japan', KR: 'South Korea',
    GB: 'United Kingdom', DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain',
    NL: 'Netherlands', SE: 'Sweden', NO: 'Norway', FI: 'Finland', DK: 'Denmark',
    RU: 'Russia', UA: 'Ukraine', PL: 'Poland', CZ: 'Czech Republic',
    AU: 'Australia', NZ: 'New Zealand', CA: 'Canada', MX: 'Mexico', BR: 'Brazil',
    AR: 'Argentina', CL: 'Chile', PE: 'Peru', CO: 'Colombia', VE: 'Venezuela',
    IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', ID: 'Indonesia', TH: 'Thailand',
    VN: 'Vietnam', PH: 'Philippines', MY: 'Malaysia', SG: 'Singapore',
    TW: 'Taiwan', HK: 'Hong Kong', AE: 'United Arab Emirates', SA: 'Saudi Arabia',
    IL: 'Israel', TR: 'Turkey', EG: 'Egypt', ZA: 'South Africa', NG: 'Nigeria',
    KE: 'Kenya', ET: 'Ethiopia', MA: 'Morocco', CH: 'Switzerland', AT: 'Austria',
    BE: 'Belgium', PT: 'Portugal', GR: 'Greece', IE: 'Ireland', RO: 'Romania',
    HU: 'Hungary', BG: 'Bulgaria', RS: 'Serbia', HR: 'Croatia', IR: 'Iran',
    IQ: 'Iraq',
};

// Centroid (lat, lng) per country. World atlas approximate values.
const COUNTRY_CENTROIDS = {
    US: { lat: 39.5,  lng: -98.4  }, CN: { lat: 35.0,  lng: 105.0 },
    JP: { lat: 36.2,  lng: 138.3  }, KR: { lat: 36.0,  lng: 127.8 },
    GB: { lat: 54.7,  lng: -2.0   }, DE: { lat: 51.2,  lng: 10.4  },
    FR: { lat: 46.2,  lng: 2.2    }, IT: { lat: 41.9,  lng: 12.6  },
    ES: { lat: 40.5,  lng: -3.7   }, NL: { lat: 52.1,  lng: 5.3   },
    SE: { lat: 60.1,  lng: 18.6   }, NO: { lat: 60.5,  lng: 8.5   },
    FI: { lat: 61.9,  lng: 25.7   }, DK: { lat: 56.3,  lng: 9.5   },
    RU: { lat: 61.5,  lng: 105.3  }, UA: { lat: 48.4,  lng: 31.2  },
    PL: { lat: 51.9,  lng: 19.1   }, CZ: { lat: 49.8,  lng: 15.5  },
    AU: { lat: -25.3, lng: 133.8  }, NZ: { lat: -40.9, lng: 174.9 },
    CA: { lat: 56.1,  lng: -106.3 }, MX: { lat: 23.6,  lng: -102.5},
    BR: { lat: -14.2, lng: -51.9  }, AR: { lat: -38.4, lng: -63.6 },
    CL: { lat: -35.7, lng: -71.5  }, PE: { lat: -9.2,  lng: -75.0 },
    CO: { lat: 4.6,   lng: -74.3  }, VE: { lat: 6.4,   lng: -66.6 },
    IN: { lat: 20.6,  lng: 78.96  }, PK: { lat: 30.4,  lng: 69.3  },
    BD: { lat: 23.7,  lng: 90.4   }, ID: { lat: -0.8,  lng: 113.9 },
    TH: { lat: 15.9,  lng: 100.99 }, VN: { lat: 14.1,  lng: 108.3 },
    PH: { lat: 12.9,  lng: 121.8  }, MY: { lat: 4.2,   lng: 101.98},
    SG: { lat: 1.35,  lng: 103.8  }, TW: { lat: 23.7,  lng: 121.0 },
    HK: { lat: 22.3,  lng: 114.2  }, AE: { lat: 23.4,  lng: 53.85 },
    SA: { lat: 23.9,  lng: 45.1   }, IL: { lat: 31.05, lng: 34.85 },
    TR: { lat: 38.96, lng: 35.2   }, EG: { lat: 26.8,  lng: 30.8  },
    ZA: { lat: -30.6, lng: 22.9   }, NG: { lat: 9.08,  lng: 8.7   },
    KE: { lat: -0.02, lng: 37.9   }, ET: { lat: 9.15,  lng: 40.5  },
    MA: { lat: 31.79, lng: -7.1   }, CH: { lat: 46.8,  lng: 8.2   },
    AT: { lat: 47.5,  lng: 14.6   }, BE: { lat: 50.5,  lng: 4.5   },
    PT: { lat: 39.4,  lng: -8.2   }, GR: { lat: 39.07, lng: 21.8  },
    IE: { lat: 53.4,  lng: -8.2   }, RO: { lat: 45.9,  lng: 24.97 },
    HU: { lat: 47.16, lng: 19.5   }, BG: { lat: 42.7,  lng: 25.5  },
    RS: { lat: 44.0,  lng: 21.0   }, HR: { lat: 45.1,  lng: 15.2  },
    IR: { lat: 32.4,  lng: 53.7   }, IQ: { lat: 33.2,  lng: 43.7  },
};
