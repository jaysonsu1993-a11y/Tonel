/**
 * Seed analytics.db with mock visit data so the dashboard is non-empty
 * before any real traffic hits the tracker.
 *
 * Usage:
 *   npm run seed                  # default: 2000 visits over last 14 days
 *   N_VISITS=10000 npm run seed   # bigger demo set
 */
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const N = parseInt(process.env.N_VISITS || '2000', 10);
const DAYS = parseInt(process.env.DAYS || '14', 10);

// (country_code, country, city, lat, lng, weight)
const CITIES = [
  ['US', 'United States', 'San Francisco', 37.7749, -122.4194, 18],
  ['US', 'United States', 'New York',      40.7128,  -74.0060, 16],
  ['US', 'United States', 'Seattle',       47.6062, -122.3321,  6],
  ['US', 'United States', 'Austin',        30.2672,  -97.7431,  4],
  ['CN', 'China',         'Beijing',       39.9042, 116.4074, 14],
  ['CN', 'China',         'Shanghai',      31.2304, 121.4737, 12],
  ['CN', 'China',         'Shenzhen',      22.5431, 114.0579, 10],
  ['CN', 'China',         'Hangzhou',      30.2741, 120.1551,  6],
  ['CN', 'China',         'Chengdu',       30.5728, 104.0668,  4],
  ['JP', 'Japan',         'Tokyo',         35.6762, 139.6503, 10],
  ['JP', 'Japan',         'Osaka',         34.6937, 135.5023,  3],
  ['KR', 'South Korea',   'Seoul',         37.5665, 126.9780,  5],
  ['SG', 'Singapore',     'Singapore',      1.3521, 103.8198,  6],
  ['HK', 'Hong Kong',     'Hong Kong',     22.3193, 114.1694,  4],
  ['TW', 'Taiwan',        'Taipei',        25.0330, 121.5654,  4],
  ['GB', 'United Kingdom','London',        51.5074,  -0.1278,  9],
  ['DE', 'Germany',       'Berlin',        52.5200,  13.4050,  6],
  ['FR', 'France',        'Paris',         48.8566,   2.3522,  5],
  ['NL', 'Netherlands',   'Amsterdam',     52.3676,   4.9041,  3],
  ['SE', 'Sweden',        'Stockholm',     59.3293,  18.0686,  2],
  ['CA', 'Canada',        'Toronto',       43.6532, -79.3832,  4],
  ['CA', 'Canada',        'Vancouver',     49.2827,-123.1207,  3],
  ['AU', 'Australia',     'Sydney',       -33.8688, 151.2093,  4],
  ['IN', 'India',         'Bangalore',     12.9716,  77.5946,  6],
  ['IN', 'India',         'Mumbai',        19.0760,  72.8777,  4],
  ['BR', 'Brazil',        'São Paulo',    -23.5505, -46.6333,  3],
  ['MX', 'Mexico',        'Mexico City',   19.4326, -99.1332,  2],
  ['IL', 'Israel',        'Tel Aviv',      32.0853,  34.7818,  3],
  ['AE', 'United Arab Emirates', 'Dubai',  25.2048,  55.2708,  2],
  ['ZA', 'South Africa',  'Cape Town',    -33.9249,  18.4241,  2],
];

const PATHS = [
  ['/', 35], ['/room/AB12', 12], ['/room/JAM01', 8], ['/#pricing', 10],
  ['/#download', 12], ['/login', 6], ['/admin/', 2], ['/blog/post-1', 4],
];

const BROWSERS = [['Chrome', 55], ['Safari', 22], ['Firefox', 8],
                  ['Edge', 9], ['Brave', 3], ['Opera', 1]];
const OS_ITEMS = [['macOS', 32], ['Windows', 38], ['iOS', 14],
                  ['Android', 12], ['Linux', 4]];
const DEVICES  = [['desktop', 70], ['mobile', 26], ['tablet', 4]];
const REFERRERS = ['', 'https://google.com/', 'https://twitter.com/',
                   'https://news.ycombinator.com/', 'https://github.com/jaysonsu1993-a11y/Tonel',
                   'https://producthunt.com/', ''];

function weighted(arr) {
  const total = arr.reduce((s, x) => s + x[x.length - 1], 0);
  let r = Math.random() * total;
  for (const item of arr) {
    r -= item[item.length - 1];
    if (r <= 0) return item;
  }
  return arr[arr.length - 1];
}

function fakeIp() {
  // A random-looking v4 in non-reserved ranges. Doesn't have to match the
  // city — geo data comes from CITIES, this is just for the IP column.
  return [
    1 + Math.floor(Math.random() * 222),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    1 + Math.floor(Math.random() * 254),
  ].join('.');
}

const db = new sqlite3.Database(path.join(__dirname, 'analytics.db'));

db.serialize(() => {
  // Make sure schema exists (mirror server.js).
  db.run(`CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, ip TEXT NOT NULL, ip_hash TEXT NOT NULL,
    country TEXT, country_code TEXT, region TEXT, city TEXT,
    lat REAL, lng REAL,
    path TEXT, referrer TEXT, user_agent TEXT,
    browser TEXT, os TEXT, device TEXT, session_id TEXT)`);

  const stmt = db.prepare(`INSERT INTO visits
    (ts, ip, ip_hash, country, country_code, region, city, lat, lng,
     path, referrer, user_agent, browser, os, device, session_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const SALT = 'seed-salt';
  const now = Math.floor(Date.now() / 1000);
  const ipPool = []; // reuse some IPs so "unique" < "visits"
  for (let i = 0; i < Math.max(50, Math.floor(N / 4)); i++) ipPool.push(fakeIp());

  for (let i = 0; i < N; i++) {
    // Bias time toward recent (sqrt skew → more recent visits).
    const dayOffset = Math.floor((Math.random() ** 0.6) * DAYS);
    const ts = now - dayOffset * 86400 - Math.floor(Math.random() * 86400);

    const c = weighted(CITIES);
    const p = weighted(PATHS);
    const b = weighted(BROWSERS);
    const o = weighted(OS_ITEMS);
    const d = weighted(DEVICES);
    const ref = REFERRERS[Math.floor(Math.random() * REFERRERS.length)];

    const ip = Math.random() < 0.7
      ? ipPool[Math.floor(Math.random() * ipPool.length)]
      : fakeIp();
    const ipHash = crypto.createHash('sha256').update(ip + SALT).digest('hex').slice(0, 24);
    const sid = crypto.randomBytes(8).toString('hex');

    // Tiny lat/lng jitter so points don't perfectly stack on the map.
    const jitter = () => (Math.random() - 0.5) * 0.4;

    stmt.run(
      ts, ip, ipHash,
      c[1], c[0], null, c[2], c[3] + jitter(), c[4] + jitter(),
      p[0], ref,
      `Mozilla/5.0 (${o[0]}) ${b[0]}`,
      b[0], o[0], d[0],
      sid,
    );
  }
  stmt.finalize(() => {
    console.log(`[seed] inserted ${N} visits across ${DAYS} days`);
    db.close();
  });
});
