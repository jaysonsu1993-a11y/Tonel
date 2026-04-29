# tonel-analytics-service

Lightweight visitor analytics + admin dashboard for **tonel.io**.

Standalone service. Located at `Tonel/analytics-service/` (root, NOT under
`Git/`). Mirrors `Git/user-service`'s code style (Express + sqlite3 + JWT)
so it slots into the same PM2 / `Git/deploy/` workflow on the production
server.

## What it gives you

- **`POST /api/track`** — endpoint called by a 1.5 KB JS snippet on the
  public site. Records IP, geo (country/city/lat/lng via `geoip-lite`,
  fully offline), user-agent, path, referrer, session.
- **`GET /api/dashboard/*`** — JSON APIs (Bearer auth) for the admin UI:
  summary, trend, geo, countries, cities, devices, recent feed.
- **`/admin/`** — self-contained dashboard page (single HTML, ECharts
  via CDN). World map with origin dots, KPIs, line chart, donut charts,
  Top countries / cities tables, live feed.

## Quick start

```bash
cd analytics-service
rm -rf node_modules           # remove sandbox-test symlinks (if present)
cp .env.example .env          # edit ADMIN_PASSWORD before exposing publicly
npm install                   # ~30s, downloads geoip-lite DB (~30 MB)
npm run seed                  # optional: 2000 mock visits for the demo
npm start                     # listens on :9007
```

Open <http://localhost:9007/admin/> and log in with the credentials from
`.env` (defaults: `admin` / `admin123`).

### Smoke test

`test-smoke.js` exercises every endpoint without needing the native
`sqlite3` package (it shims around Node 22's built-in `node:sqlite`):

```bash
node --experimental-sqlite test-smoke.js
# 17 passed, 0 failed
```

## Embed the tracker on the public site

Add to `Tonel/Git/web/index.html` (or any page that should report visits):

```html
<script src="https://analytics.tonel.io/tracker.js"
        data-endpoint="https://analytics.tonel.io"
        defer></script>
```

For local development against this service running on `:9007`:

```html
<script src="http://localhost:9007/tracker.js"
        data-endpoint="http://localhost:9007"
        defer></script>
```

The tracker auto-tracks SPA route changes (patches `pushState`/
`replaceState`/`popstate`). For custom events, call `window.tonelTrack()`.

## Deployment

Same shape as `user-service`. Add to your PM2 ecosystem:

```js
// ecosystem.config.js (excerpt)
{ name: 'tonel-analytics', cwd: '/opt/tonel/analytics-service',
  script: 'server.js', env: { NODE_ENV: 'production', PORT: 9007 } }
```

Cloudflare Tunnel route (in `ops/cloudflared/config.yml.template`):

```yaml
- hostname: analytics.tonel.io
  service: http://127.0.0.1:9007
```

Then point a CNAME / Cloudflare DNS record at the tunnel.

## Notes

- **Privacy**: raw IPs are stored to enable geo + uniqueness, but the
  dashboard masks the last octet on display. A persisted random salt is
  used for the `ip_hash` "unique visitors" count.
- **Retention**: `RETENTION_DAYS` (default 90) prunes raw rows; daily
  per-country totals roll up into `daily_geo` first.
- **GeoIP DB**: `geoip-lite` ships its own MaxMind-derived offline DB.
  Run `npx geoip-lite-update` periodically to refresh.
- **Real client IP behind Cloudflare/Tunnel**: requires
  `TRUST_PROXY=1` (default). Cloudflare sets `CF-Connecting-IP`, which
  cloudflared forwards as `X-Forwarded-For` — Express picks it up.

## API reference

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/track` | none | tracker beacon |
| `GET`  | `/api/track.gif` | none | fallback beacon |
| `POST` | `/api/admin/login` | none | returns 7-day JWT |
| `GET`  | `/api/dashboard/summary?range=7d` | Bearer | totals |
| `GET`  | `/api/dashboard/trend?range=7d`   | Bearer | line chart |
| `GET`  | `/api/dashboard/geo?range=7d`     | Bearer | map points |
| `GET`  | `/api/dashboard/countries`        | Bearer | top countries |
| `GET`  | `/api/dashboard/cities`           | Bearer | top cities |
| `GET`  | `/api/dashboard/devices`          | Bearer | device/browser/OS |
| `GET`  | `/api/dashboard/paths`            | Bearer | top URLs |
| `GET`  | `/api/dashboard/recent`           | Bearer | last 50 visits |
| `GET`  | `/health` | none | liveness |

Range values: `24h`, `7d`, `30d`, `all`.
