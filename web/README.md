# Tonel Web

React + TypeScript browser client. Together with the macOS desktop client
([`../Tonel-MacOS/`](../Tonel-MacOS/)) this is one of the two ways to join a
Tonel room.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build | Vite 5 |
| Audio capture | `getUserMedia` → `AudioWorklet` (capture + monitor) |
| Audio playback | Custom `AudioWorkletProcessor` with jitter buffer + drift adapter |
| Codec | PCM16 over the wire (Opus on roadmap) |
| Wire protocol | [SPA1](../docs/SPA1_PROTOCOL.md) |
| Audio transport | WSS for `/` (kufan); WebTransport for `/new` (Aliyun) |
| Signaling | WSS → Cloudflare Tunnel → TCP signaling_server |

## Develop

```bash
cd web
npm install
npm run dev   # → http://localhost:5173
```

The dev server points at the production mixer/signaling backends by default
(via DNS for `srv.tonel.io` / `api.tonel.io`). To force the Aliyun path, hit
`http://localhost:5173/new`.

## Build & deploy

```bash
npm run build              # → dist/
# Production deploy goes through the release pipeline:
../deploy/web.sh           # vite build + wrangler pages deploy
```

## Source layout

```
web/src/
├── main.tsx                — React entry
├── App.tsx                 — root + routing
├── pages/{Home,Room}Page.tsx
├── hooks/useAudio.ts, useSignal.ts
├── services/audioService.ts        — main audio engine, mixer connect, capture/playback worklets
├── services/signalService.ts       — signaling WSS client
├── services/mixerRttProbe.ts       — homepage hero RTT (HTTPS-fetch based, no WebSocket)
├── components/                     — ChannelStrip, LedMeter, AudioDebugPanel, etc.
├── types/index.ts
└── styles/, index.css
```

The Node-based server-side proxies (used to live alongside `web/src` for
historical reasons) now live under `server/proxy/`:

```
server/proxy/ws-proxy.js          — bridges signaling WSS → TCP :9001
server/proxy/ws-mixer-proxy.js    — bridges mixer WSS    → TCP :9002 + UDP :9003
```

## See also

- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — topology, port map, WSS connection flow
- [`../docs/SPA1_PROTOCOL.md`](../docs/SPA1_PROTOCOL.md) — wire format
- [`../docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) — build/test/deploy workflow
