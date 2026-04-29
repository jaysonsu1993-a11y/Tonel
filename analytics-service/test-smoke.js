/**
 * Smoke test harness — sandbox-only. Substitutes the native `sqlite3`
 * package with a callback-API wrapper around Node 22's built-in
 * `node:sqlite`, then loads server.js and exercises every endpoint.
 *
 * NOT for production. Real installs use the real sqlite3 package.
 */
const Module = require('module');
const sqliteBuiltin = require('node:sqlite');

// ─── Shim: implement just enough of sqlite3 v5's callback API ──────────────
function makeShim() {
    class Database {
        constructor(file) {
            this.db = new sqliteBuiltin.DatabaseSync(file === ':memory:' ? ':memory:' : file);
        }
        serialize(fn) { fn(); }            // node:sqlite is sync — no-op
        run(sql, params, cb) {
            if (typeof params === 'function') { cb = params; params = []; }
            try { this.db.prepare(sql).run(...(params || [])); cb && cb.call({ lastID: 0 }, null); }
            catch (e) { cb && cb(e); }
        }
        get(sql, params, cb) {
            if (typeof params === 'function') { cb = params; params = []; }
            try { cb(null, this.db.prepare(sql).get(...(params || []))); }
            catch (e) { cb(e); }
        }
        all(sql, params, cb) {
            if (typeof params === 'function') { cb = params; params = []; }
            try { cb(null, this.db.prepare(sql).all(...(params || []))); }
            catch (e) { cb(e); }
        }
        prepare(sql) {
            const stmt = this.db.prepare(sql);
            return {
                run(...args) { try { stmt.run(...args); } catch (e) { console.error(e); } },
                finalize(cb) { cb && cb(); },
            };
        }
    }
    return { verbose: () => ({ Database }), Database };
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'sqlite3') return 'sqlite3-shim';
    return origResolve.call(this, request, ...rest);
};
require.cache['sqlite3-shim'] = { exports: makeShim() };

// ─── Override env, then boot server ────────────────────────────────────────
process.env.PORT = process.env.PORT || '9907';
process.env.ADMIN_PASSWORD = 'test123';
process.env.JWT_SECRET = 'test-secret';

// Use in-memory DB so smoke test is hermetic.
// Sandbox's mounted FS can't always write the .db file; chdir to /tmp
// so server.js's `path.join(__dirname, 'analytics.db')` lands somewhere
// writable. (We restore __dirname to the script's dir after.)
const path = require('path');
const fs = require('fs');
const tmp = '/tmp/analytics-smoke-' + Date.now();
fs.mkdirSync(tmp, { recursive: true });
process.chdir(tmp);
// Hack: copy server.js to tmp so __dirname there is /tmp/...
fs.copyFileSync(path.join(__dirname, 'server.js'), path.join(tmp, 'server.js'));
fs.cpSync(path.join(__dirname, 'public'), path.join(tmp, 'public'), { recursive: true });
fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(tmp, 'node_modules'));

require(path.join(tmp, 'server.js'));

// ─── Test runner ───────────────────────────────────────────────────────────
const PORT = process.env.PORT;
async function main() {
    await new Promise(r => setTimeout(r, 500));
    const base = `http://127.0.0.1:${PORT}`;
    let passed = 0, failed = 0;
    const log = (ok, name, detail) => {
        const tag = ok ? '✓' : '✗';
        console.log(`${tag} ${name}${detail ? '  ' + detail : ''}`);
        ok ? passed++ : failed++;
    };

    // 1. health
    let r = await fetch(`${base}/health`);
    log(r.ok, 'GET /health', `status=${r.status}`);

    // 2. login
    r = await fetch(`${base}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'test123' }),
    });
    const { token } = await r.json();
    log(r.ok && !!token, 'POST /api/admin/login', `token=${token ? token.slice(0, 20) + '…' : 'none'}`);

    // 3. login wrong password → 401
    r = await fetch(`${base}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    log(r.status === 401, 'POST /api/admin/login (bad pwd)', `status=${r.status}`);

    // 4. tracking — multiple visits with different cities
    const visits = [
        { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Chrome/120', path: '/' },
        { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605', path: '/login' },
        { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121', path: '/room/abc' },
    ];
    for (const v of visits) {
        r = await fetch(`${base}/api/track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': v.ua },
            body: JSON.stringify({ path: v.path, referrer: '', session_id: 'sid' + Math.random() }),
        });
        log(r.ok, `POST /api/track  ${v.path}`, `status=${r.status}`);
    }

    // 5. dashboard endpoints (with auth)
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const endpoints = [
        ['summary', 'visits'],
        ['trend', 'points'],
        ['geo', 'points'],
        ['countries', 'countries'],
        ['cities', 'cities'],
        ['devices', 'devices'],
        ['paths', 'paths'],
        ['recent', 'recent'],
    ];
    for (const [ep, key] of endpoints) {
        r = await fetch(`${base}/api/dashboard/${ep}?range=all`, auth);
        const data = r.ok ? await r.json() : null;
        const has = data && (key in data || typeof data[key] !== 'undefined');
        log(r.ok && has, `GET /api/dashboard/${ep}`, `keys=${data ? Object.keys(data).join(',') : '—'}`);
    }

    // 6. dashboard endpoint without auth → 401
    r = await fetch(`${base}/api/dashboard/summary`);
    log(r.status === 401, 'GET /api/dashboard/summary (no auth)', `status=${r.status}`);

    // 7. admin page served
    r = await fetch(`${base}/admin/`);
    const html = await r.text();
    log(r.ok && html.includes('Tonel Analytics'), 'GET /admin/', `length=${html.length}`);

    // 8. tracker.js served
    r = await fetch(`${base}/tracker.js`);
    const js = await r.text();
    log(r.ok && js.includes('tonelTrack'), 'GET /tracker.js', `length=${js.length}`);

    console.log(`\n${passed} passed, ${failed} failed`);
    try { fs.unlinkSync(path.join(__dirname, 'analytics.db')); } catch (_) {}
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
