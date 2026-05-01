# Tonel Web

React + TypeScript browser client. Trial / demo interface; full low-latency
rehearsal lives in the desktop clients ([`../Tonel-Desktop-AppKit/`](../Tonel-Desktop-AppKit/),
[`../Tonel-MacOS/`](../Tonel-MacOS/)).

## Tech stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build | Vite 5 |
| Audio | Web Audio API — `ScriptProcessorNode` for capture (deliberately, not AudioWorklet — see [`Tonel-local/local_docs/STANDARDS_WEB_AUDIO.md`](../../Tonel-local/local_docs/STANDARDS_WEB_AUDIO.md)) |
| Protocol | SPA1 over WebSocket (proxied to UDP) |
| Signaling | Raw WebSocket (CF Tunnel → ws-proxy → TCP signaling) |

## Develop

```bash
cd web
npm install
npm run dev   # → http://localhost:5173
```

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
├── pages/{Home,Login,Room}Page.tsx
├── hooks/{useAudio,useSignal}.ts
├── services/{audio,signal,mixerRttProbe}Service.ts
├── components/...          — ChannelStrip, LedMeter, etc.
├── types/index.ts
└── styles/, index.css
```

The two server-side proxy scripts live in this dir as a convenience but
run on the production server, not in the browser:

```
ws-proxy.js          — bridges signaling WSS → TCP :9001
ws-mixer-proxy.js    — bridges mixer WSS    → UDP :9003
```

## See also

- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — topology, port map, WSS connection flow
- [`../docs/SPA1_PROTOCOL.md`](../docs/SPA1_PROTOCOL.md) — wire format
- [`../docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md) — build/test/deploy workflow
- [`../../Tonel-local/local_docs/STANDARDS_WEB_AUDIO.md`](../../Tonel-local/local_docs/STANDARDS_WEB_AUDIO.md) — browser audio rules (internal)
