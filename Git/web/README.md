# Tonel-Web

React web client for Tonel -- a low-fidelity trial/demo interface.

## Overview

The web client allows users to try the S1 band rehearsal experience directly in their browser. It connects to the same signaling and mixer servers as the desktop clients, using WebSocket proxies.

**Purpose:** User acquisition and trial. The full low-latency experience is delivered by the desktop clients (AppKit/JUCE).

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 |
| Language | TypeScript |
| Build | Vite 5 |
| Audio | Web Audio API + AudioWorklet (fallback: ScriptProcessorNode) |
| Protocol | SPA1 over WebSocket (proxied to UDP) |
| Signaling | WebSocket (raw, proxied to TCP signaling server) |

Dependencies (`package.json`):
- `@microsoft/signalr` -- included as a dependency but the current implementation uses raw WebSockets
- `react` / `react-dom`

## Development

```bash
cd Git/web
npm install
npm run dev
```

Dev server: `http://localhost:5173`

## Build

```bash
npm run build
# Output: dist/
npm run preview   # Preview production build
```

## Architecture

```
web/src/
├── main.tsx                 # React entry point
├── App.tsx                  # Root component, page routing
├── types/index.ts           # TypeScript interfaces (PeerInfo, RoomMember, etc.)
├── pages/
│   ├── HomePage.tsx         # Landing page
│   ├── LoginPage.tsx        # User login (phone/WeChat)
│   └── RoomPage.tsx         # Active room session
├── hooks/
│   ├── useAudio.ts          # Audio capture + playback hook
│   └── useSignal.ts         # WebSocket signaling hook
├── services/
│   ├── audioService.ts      # SPA1 encode/decode, AudioWorklet, mixer connection
│   └── signalService.ts     # Signaling WebSocket, room management
├── components/
│   ├── ChannelStrip.tsx     # Audio meter UI
│   └── LedMeter.tsx         # LED level indicator
├── styles/globals.css       # Global styles
└── index.css                # App styles
```

## Connection Flow

1. **Signaling**: WebSocket connects to `/signaling` endpoint, proxied by `ws-proxy.js` to TCP port 9001
2. **Mixer Control**: WebSocket connects to `/mixer-tcp`, sends `MIXER_JOIN`
3. **Mixer Audio**: WebSocket connects to `/mixer-udp`, proxied by `ws-mixer-proxy.js` to UDP port 9003. SPA1 binary packets are sent as binary WebSocket frames.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VITE_SIGNALING_URL` | `signal.tonel.io` | Signaling server domain |
| `VITE_SIGNALING_PORT` | `9001` | Signaling TCP port |
| `VITE_MIXER_PORT` | `9003` | Mixer UDP port |

## Audio Pipeline

1. **Capture**: `getUserMedia()` with echo cancellation, noise suppression, and auto gain **disabled** for raw low-latency audio
2. **Encode**: AudioWorklet captures 20ms frames, converts to PCM16, wraps in SPA1 header
3. **Send**: Binary SPA1 packets sent via WebSocket → proxy → UDP mixer
4. **Receive**: SPA1 packets from mixer (mixed audio), decoded to PCM16, played via Web Audio API `AudioBufferSourceNode`

## Limitations

- Browser Web Audio API introduces ~20-50ms additional latency vs native clients
- Opus decoding in browser requires WASM (not included in this build) -- PCM16 only
- Not suitable for production low-latency rehearsal; use desktop clients for that purpose
