/**
 * tonel-analytics-service
 *
 * Lightweight Express + SQLite service that:
 *   1. Receives visit events from a JS tracking snippet (POST /api/track)
 *   2. Resolves IPs to country/city/lat/lng with geoip-lite (offline DB)
 *   3. Parses user-agents into device/browser/os
 *   4. Exposes JSON dashboard APIs at /api/dashboard/*
 *   5. Serves a self-contained admin dashboard at /admin/
 *
 * Deliberately mirrors the user-service code style (Express + sqlite3 +
 * jsonwebtoken) so it slots into the same deploy/PM2 layout.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

// Soft-require: geoip-lite ships a ~30 MB MaxMind DB and may not be available
// (e.g. on a fresh node_modules without `npm install`). Without it, geo
// columns stay null and the world map will only render points that arrive
// pre-populated (e.g. from the seed script).
let geoip;
try { geoip = require('geoip-lite'); }
catch (_) { console.warn('[analytics] geoip-lite missing — geo lookup disabled'); geoip = { lookup: () => null }; }

// Soft-require: ua-parser-js. Fallback returns minimal browser/os/device.
let UAParser;
try { UAParser = require('ua-parser-js'); }
catch (_) {
    console.warn('[analytics] ua-parser-js missing — using regex fallback');
    UAParser = function (ua) {
        ua = String(ua || '');
        const browser = /Edg\//.test(ua) ? 'Edge'
                      : /OPR\//.test(ua) ? 'Opera'
                      : /Chrome\//.test(ua) ? 'Chrome'
                      : /Safari\//.test(ua) ? 'Safari'
                      : /Firefox\//.test(ua) ? 'Firefox' : null;
        const os = /Mac OS X/.test(ua) ? 'macOS'
                 : /Windows/.test(ua) ? 'Windows'
                 : /Android/.test(ua) ? 'Android'
                 : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
                 : /Linux/.test(ua) ? 'Linux' : null;
        const isMobile = /Mobile|Android|iPhone/.test(ua);
        const isTablet = /iPad|Tablet/.test(ua);
        return { getResult: () => ({
            browser: { name: browser },
            os: { name: os },
            device: { type: isTablet ? 'tablet' : (isMobile ? 'mobile' : '') },
        }) };
    };
}

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT || '9007', 10);
const JWT_SECRET    = process.env.JWT_SECRET || 'tonel-analytics-dev-secret';
const ADMIN_USER    = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TRUST_PROXY   = (process.env.TRUST_PROXY || '1') !== '0';
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '90', 10);
const CORS_ORIGINS  = (process.env.CORS_ORIGINS || '*')
    .split(',').map(s => s.trim()).filter(Boolean);

// Always allow same-origin — the bundled admin page is served from this
// process, so a fetch from /admin/ to /api/admin/login carries
// `Origin: http://localhost:<PORT>` and would otherwise be CORS-blocked
// (which surfaces as "Unexpected token '<'" on the login screen because
// Express returns its default HTML error page).
const SELF_ORIGINS = [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
];
for (const o of SELF_ORIGINS) if (!CORS_ORIGINS.includes(o)) CORS_ORIGINS.push(o);

const app = express();
if (TRUST_PROXY) app.set('trust proxy', true);

// ─── CORS — open for /api/track, restricted for admin APIs ──────────────────
const corsAllowAll = cors({ origin: true, credentials: false });
const corsAllowList = cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);                  // curl / server-side
        if (CORS_ORIGINS.includes('*')) return cb(null, true);
        if (CORS_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
});

app.use(express.json({ limit: '32kb' }));

// ─── Database ────────────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'analytics.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Raw visit rows. One per pageview. Keep RETENTION_DAYS, then prune.
    db.run(`CREATE TABLE IF NOT EXISTS visits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,            -- unix seconds
        ip            TEXT NOT NULL,
        ip_hash       TEXT NOT NULL,               -- sha256(ip+salt) for "unique"
        country       TEXT,
        country_code  TEXT,
        region        TEXT,
        city          TEXT,
        lat           REAL,
        lng           REAL,
        path          TEXT,
        referrer      TEXT,
        user_agent    TEXT,
        browser       TEXT,
        os            TEXT,
        device        TEXT,                        -- mobile / desktop / tablet
        session_id    TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country_code)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_visits_ip_hash ON visits(ip_hash)`);

    // Daily roll-up — one row per (day, country). Survives pruning of `visits`.
    db.run(`CREATE TABLE IF NOT EXISTS daily_geo (
        day           TEXT NOT NULL,               -- YYYY-MM-DD UTC
        country_code  TEXT NOT NULL,
        country       TEXT,
        visits        INTEGER NOT NULL DEFAULT 0,
        unique_ips    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, country_code)
    )`);
});

// Stable salt for ip hashing, persisted in a tiny meta table so "unique
// visitors" stays stable across restarts. Falls back to in-memory salt
// the first time around — that's fine, it just resets the unique count.
let IP_SALT = crypto.randomBytes(16).toString('hex');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    db.get(`SELECT v FROM meta WHERE k='ip_salt'`, (err, row) => {
        if (row && row.v) { IP_SALT = row.v; return; }
        db.run(`INSERT OR REPLACE INTO meta (k, v) VALUES ('ip_salt', ?)`, [IP_SALT]);
    });
});

const hashIp = (ip) => crypto.createHash('sha256').update(ip + IP_SALT).digest('hex').slice(0, 24);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getClientIp(req) {
    // express `trust proxy` already populates req.ip from XFF; fall back to
    // socket address for direct hits (e.g. running behind no proxy at all).
    let ip = req.ip || req.connection?.remoteAddress || '';
    // Strip IPv6-mapped IPv4 prefix so geoip-lite recognises the address.
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function classifyDevice(uaResult) {
    const t = (uaResult.device.type || '').toLowerCase();
    if (t === 'mobile' || t === 'tablet' || t === 'wearable') return t;
    return 'desktop';
}

function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}

function isoDay(ts) {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ─── Auth (dashboard APIs only) ──────────────────────────────────────────────
function adminAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        if (payload.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
        req.admin = payload;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ============================================================================
// Public endpoints
// ============================================================================

// Health check.
app.get('/health', corsAllowAll, (_req, res) => {
    res.json({ status: 'ok', service: 'analytics', ts: new Date().toISOString() });
});

// Tracking endpoint — called by tracker.js on every pageview.
// Intentionally permissive CORS so any origin running the snippet works,
// and intentionally cheap (single insert) so it can stay on the hot path.
app.post('/api/track', corsAllowAll, (req, res) => {
    const ts = Math.floor(Date.now() / 1000);
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';
    const { path: pageUrl, referrer, session_id } = req.body || {};

    const geo = geoip.lookup(ip) || {};
    const parsed = new UAParser(ua).getResult();

    const row = {
        ts,
        ip,
        ip_hash: hashIp(ip),
        country:      geo.country || null,
        country_code: geo.country || null,
        region:       Array.isArray(geo.region) ? geo.region[0] : geo.region || null,
        city:         geo.city    || null,
        lat:          Array.isArray(geo.ll) ? geo.ll[0] : null,
        lng:          Array.isArray(geo.ll) ? geo.ll[1] : null,
        path:         (pageUrl || req.headers.referer || '/').slice(0, 500),
        referrer:     (referrer || '').slice(0, 500),
        user_agent:   ua.slice(0, 500),
        browser:      parsed.browser.name || null,
        os:           parsed.os.name || null,
        device:       classifyDevice(parsed),
        session_id:   (session_id || '').slice(0, 64),
    };

    db.run(
        `INSERT INTO visits
         (ts, ip, ip_hash, country, country_code, region, city, lat, lng,
          path, referrer, user_agent, browser, os, device, session_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.ts, row.ip, row.ip_hash, row.country, row.country_code, row.region,
         row.city, row.lat, row.lng, row.path, row.referrer, row.user_agent,
         row.browser, row.os, row.device, row.session_id],
        (err) => {
            if (err) {
                console.error('insert visits failed', err);
                return res.status(500).json({ ok: false });
            }
            res.json({ ok: true });
        }
    );
});

// Convenience: GET endpoint for tracking via <img> beacon when fetch is
// blocked (some Safari/Brave configs). The tracker.js snippet uses POST
// by default and falls back to this if needed.
app.get('/api/track.gif', corsAllowAll, (req, res) => {
    req.body = req.query;
    // Fire-and-forget the same insert path, then return a 1x1 gif.
    const fakeRes = { json: () => {}, status: () => fakeRes };
    app._router.handle(
        Object.assign({}, req, { method: 'POST', url: '/api/track' }),
        fakeRes,
        () => {}
    );
    const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    res.set('Content-Type', 'image/gif').send(gif);
});

// ============================================================================
// Admin login — exchange ADMIN_USER/ADMIN_PASSWORD for a 7d JWT
// ============================================================================
app.post('/api/admin/login', corsAllowList, (req, res) => {
    const { username, password } = req.body || {};
    if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = jwt.sign({ role: 'admin', user: username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, expiresIn: 7 * 24 * 3600 });
});

// ============================================================================
// Dashboard APIs (require Bearer token)
// ============================================================================
app.use('/api/dashboard', corsAllowList, adminAuth);

// Convert ?range=24h|7d|30d|all into a unix-seconds threshold.
function rangeStart(range) {
    const now = Math.floor(Date.now() / 1000);
    switch (range) {
        case '24h': return now - 24 * 3600;
        case '7d':  return now - 7  * 86400;
        case '30d': return now - 30 * 86400;
        case 'all': return 0;
        default:    return now - 24 * 3600;
    }
}

// Top-line numbers + sparkline.
app.get('/api/dashboard/summary', (req, res) => {
    const since = rangeStart(req.query.range || '7d');
    db.serialize(() => {
        const out = {};
        db.get(`SELECT COUNT(*) AS visits, COUNT(DISTINCT ip_hash) AS uniques
                FROM visits WHERE ts >= ?`, [since], (e1, r1) => {
            if (e1) return res.status(500).json({ error: e1.message });
            out.visits  = r1.visits  || 0;
            out.uniques = r1.uniques || 0;
            db.get(`SELECT COUNT(DISTINCT country_code) AS countries
                    FROM visits WHERE ts >= ? AND country_code IS NOT NULL`,
                   [since], (e2, r2) => {
                if (e2) return res.status(500).json({ error: e2.message });
                out.countries = r2.countries || 0;
                db.get(`SELECT COUNT(*) AS visits_24h
                        FROM visits WHERE ts >= ?`,
                       [Math.floor(Date.now()/1000) - 86400], (e3, r3) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    out.visits_24h = r3.visits_24h || 0;
                    res.json(out);
                });
            });
        });
    });
});

// Time-series (line chart). Bucket size depends on range.
app.get('/api/dashboard/trend', (req, res) => {
    const range = req.query.range || '7d';
    const since = rangeStart(range);
    // 24h → 1h buckets; 7d → 1d; 30d → 1d; all → 1d
    const bucket = range === '24h' ? 3600 : 86400;
    db.all(
        `SELECT (ts / ?) * ? AS bucket,
                COUNT(*) AS visits,
                COUNT(DISTINCT ip_hash) AS uniques
         FROM visits
         WHERE ts >= ?
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [bucket, bucket, since],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({
                bucket_seconds: bucket,
                points: rows.map(r => ({
                    t: r.bucket,
                    iso: new Date(r.bucket * 1000).toISOString(),
                    visits: r.visits,
                    uniques: r.uniques,
                })),
            });
        }
    );
});

// Geo points for the world map (lat/lng + city aggregation).
app.get('/api/dashboard/geo', (req, res) => {
    const since = rangeStart(req.query.range || '7d');
    db.all(
        `SELECT country, country_code, city, lat, lng,
                COUNT(*) AS visits,
                COUNT(DISTINCT ip_hash) AS uniques
         FROM visits
         WHERE ts >= ? AND lat IS NOT NULL AND lng IS NOT NULL
         GROUP BY country_code, city, lat, lng
         ORDER BY visits DESC
         LIMIT 500`,
        [since],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ points: rows });
        }
    );
});

// Country totals — drives the choropleth + Top countries panel.
app.get('/api/dashboard/countries', (req, res) => {
    const since = rangeStart(req.query.range || '7d');
    db.all(
        `SELECT country, country_code,
                COUNT(*) AS visits,
                COUNT(DISTINCT ip_hash) AS uniques
         FROM visits
         WHERE ts >= ? AND country_code IS NOT NULL
         GROUP BY country_code
         ORDER BY visits DESC`,
        [since],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ countries: rows });
        }
    );
});

// City totals — Top cities panel.
app.get('/api/dashboard/cities', (req, res) => {
    const since = rangeStart(req.query.range || '7d');
    db.all(
        `SELECT country, country_code, city,
                COUNT(*) AS visits,
                COUNT(DISTINCT ip_hash) AS uniques
         FROM visits
         WHERE ts >= ? AND city IS NOT NULL AND city <> ''
         GROUP BY country_code, city
         ORDER BY visits DESC
         LIMIT 30`,
        [since],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ cities: rows });
        }
    );
});

// Device + browser + OS distributions.
app.get('/api/dashboard/devices', (req, res) => {
    const since = rangeStart(req.query.range || '7d');
    const bucket = (col) => new Promise((resolve, reject) => {
        db.all(
            `SELECT ${col} AS name, COUNT(*) AS value
             FROM visits WHERE ts >= ? AND ${col} IS NOT NULL
             GROUP BY ${col} ORDER BY value DESC LIMIT 10`,
            [since], (e, r) => e ? reject(e) : resolve(r)
        );
    });
    Promise.all([bucket('device'), bucket('browser'), bucket('os')])
        .then(([devices, browsers, os]) => res.json({ devices, browsers, os }))
        .catch(e => res.status(500).json({ error: e.message }));
});

// Top paths (which pages get hit).
app.get('/api/dashboard/paths', (req, res) => {
    const since = rangeStart(req.query.range || '7d');
    db.all(
        `SELECT path, COUNT(*) AS visits, COUNT(DISTINCT ip_hash) AS uniques
         FROM visits WHERE ts >= ?
         GROUP BY path ORDER BY visits DESC LIMIT 20`,
        [since],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ paths: rows });
        }
    );
});

// Recent live feed — last 50 visits with masked IPs (privacy).
app.get('/api/dashboard/recent', (req, res) => {
    db.all(
        `SELECT ts, ip, country, city, path, browser, os, device
         FROM visits ORDER BY ts DESC LIMIT 50`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            // Mask last octet of v4 IPs / last group of v6 for display.
            const masked = rows.map(r => ({
                ...r,
                ip: r.ip.includes('.')
                    ? r.ip.replace(/\.\d+$/, '.×')
                    : r.ip.replace(/[0-9a-f]+$/, '×'),
            }));
            res.json({ recent: masked });
        }
    );
});

// ============================================================================
// Static admin page
// ============================================================================
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.get('/admin', (_req, res) => res.redirect('/admin/'));

// Serve the tracker snippet at root for easy <script> embedding.
app.get('/tracker.js', corsAllowAll, (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tracker.js'));
});

// ─── Retention sweep ─────────────────────────────────────────────────────────
function pruneOldVisits() {
    if (RETENTION_DAYS <= 0) return;
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
    // Roll into daily_geo first, then delete.
    db.serialize(() => {
        db.run(
            `INSERT INTO daily_geo (day, country_code, country, visits, unique_ips)
             SELECT strftime('%Y-%m-%d', datetime(ts, 'unixepoch')) AS day,
                    country_code, country,
                    COUNT(*), COUNT(DISTINCT ip_hash)
             FROM visits WHERE ts < ? AND country_code IS NOT NULL
             GROUP BY day, country_code
             ON CONFLICT(day, country_code) DO UPDATE SET
                visits = visits + excluded.visits,
                unique_ips = unique_ips + excluded.unique_ips`,
            [cutoff],
            (err) => { if (err) console.error('roll-up failed', err); }
        );
        db.run(`DELETE FROM visits WHERE ts < ?`, [cutoff], (err) => {
            if (err) console.error('prune failed', err);
        });
    });
}
setInterval(pruneOldVisits, 6 * 3600 * 1000); // every 6h

// ─── Boot ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[tonel-analytics] listening on :${PORT}`);
    console.log(`[tonel-analytics]   admin   → http://localhost:${PORT}/admin/`);
    console.log(`[tonel-analytics]   tracker → http://localhost:${PORT}/tracker.js`);
    console.log(`[tonel-analytics]   CORS    → ${CORS_ORIGINS.join(', ') || '*'}`);
    console.log(`[tonel-analytics]   trust proxy: ${TRUST_PROXY}, retention: ${RETENTION_DAYS}d`);
});
