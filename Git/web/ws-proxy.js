#!/usr/bin/env node
/**
 * WebSocket to TCP Proxy for S1 Signaling Server
 *
 * Web clients connect via WebSocket (wss://api.tonel.io/signaling)
 * This proxy translates WebSocket frames to raw TCP JSON messages
 * and forwards them to the signaling server on port 9001.
 *
 * Also proxies /mixer-tcp and /mixer-udp upgrades to the mixer proxy (port 9005).
 *
 * Run: node ws-proxy.js [ws_port] [tcp_host] [tcp_port]
 */

const http = require('http')
const net = require('net')
const { WebSocketServer, WebSocket } = require('ws')

const WS_PORT = parseInt(process.argv[2] || '9004', 10)
const TCP_HOST = process.argv[3] || '127.0.0.1'
const TCP_PORT = parseInt(process.argv[4] || '9001', 10)
const MIXER_PROXY_PORT = 9005

// ─── Signaling WebSocket server (noServer mode) ─────────────────────────────

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress
  console.log(`[WS-Proxy] New signaling connection from ${clientIp}`)

  let tcpClient = null
  let closing = false

  // Connect to TCP signaling server
  tcpClient = net.createConnection({ host: TCP_HOST, port: TCP_PORT }, () => {
    console.log(`[WS-Proxy] Connected to TCP server ${TCP_HOST}:${TCP_PORT}`)
  })

  tcpClient.setTimeout(0)
  tcpClient.setKeepAlive(true)

  // Forward TCP -> WebSocket
  tcpClient.on('data', (data) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data.toString())
      } catch (e) {
        console.error('[WS-Proxy] Send to WS error:', e.message)
      }
    }
  })

  tcpClient.on('close', () => {
    console.log('[WS-Proxy] TCP connection closed')
    if (ws.readyState === ws.OPEN) {
      ws.close()
    }
  })

  tcpClient.on('error', (err) => {
    console.error('[WS-Proxy] TCP error:', err.message)
    closing = true
    ws.close()
  })

  // Forward WebSocket -> TCP
  ws.on('message', (msg) => {
    if (tcpClient && !closing) {
      // Ensure message ends with newline (server protocol)
      const data = msg.toString().trim() + '\n'
      tcpClient.write(data)
    }
  })

  ws.on('close', () => {
    console.log('[WS-Proxy] WebSocket closed')
    closing = true
    if (tcpClient) {
      tcpClient.destroy()
    }
  })

  ws.on('error', (err) => {
    console.error('[WS-Proxy] WS error:', err.message)
    closing = true
    if (tcpClient) {
      tcpClient.destroy()
    }
  })
})

// ─── HTTP server with upgrade routing ────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end('Upgrade Required')
})

// ─── Mixer WebSocket bridge server (noServer mode) ──────────────────────────

const mixerWss = new WebSocketServer({ noServer: true })

mixerWss.on('connection', (clientWs, req) => {
  const path = req.url || ''
  const clientIp = req.socket.remoteAddress
  console.log(`[WS-Proxy] Mixer bridge connection from ${clientIp} (path: ${path})`)

  // Open a WebSocket CLIENT connection to ws-mixer-proxy
  const upstreamUrl = `ws://127.0.0.1:${MIXER_PROXY_PORT}${path}`
  const upstream = new WebSocket(upstreamUrl)

  let clientOpen = true
  let upstreamOpen = false

  // Queue messages until upstream is ready
  const pendingMessages = []

  upstream.on('open', () => {
    upstreamOpen = true
    console.log(`[WS-Proxy] Upstream WS connected to ${upstreamUrl}`)
    // Flush queued messages
    for (const m of pendingMessages) {
      upstream.send(m.data, { binary: m.binary })
    }
    pendingMessages.length = 0
  })

  // Upstream → Client
  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary })
    }
  })

  // Client → Upstream
  clientWs.on('message', (data, isBinary) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
    } else {
      pendingMessages.push({ data, binary: isBinary })
    }
  })

  // Cleanup
  upstream.on('close', () => {
    upstreamOpen = false
    console.log(`[WS-Proxy] Upstream WS closed (path: ${path})`)
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close()
  })

  upstream.on('error', (err) => {
    console.error(`[WS-Proxy] Upstream WS error: ${err.message}`)
    upstreamOpen = false
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close()
  })

  clientWs.on('close', () => {
    clientOpen = false
    console.log(`[WS-Proxy] Client WS closed (path: ${path})`)
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
  })

  clientWs.on('error', (err) => {
    console.error(`[WS-Proxy] Client WS error: ${err.message}`)
    clientOpen = false
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
  })
})

httpServer.on('upgrade', (req, socket, head) => {
  const path = req.url || ''

  if (path === '/mixer-tcp' || path === '/mixer-udp') {
    // WebSocket-to-WebSocket bridge to ws-mixer-proxy
    mixerWss.handleUpgrade(req, socket, head, (ws) => {
      mixerWss.emit('connection', ws, req)
    })
    return
  }

  // Default: signaling WebSocket
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

// ─── Start ───────────────────────────────────────────────────────────────────

httpServer.listen(WS_PORT, () => {
  console.log(`[WS-Proxy] HTTP/WS server listening on port ${WS_PORT}`)
  console.log(`[WS-Proxy] Signaling → ${TCP_HOST}:${TCP_PORT}`)
  console.log(`[WS-Proxy] Mixer paths → 127.0.0.1:${MIXER_PROXY_PORT}`)
})

wss.on('error', (err) => {
  console.error('[WS-Proxy] Server error:', err.message)
})

process.on('SIGTERM', () => {
  console.log('[WS-Proxy] SIGTERM, shutting down...')
  mixerWss.close()
  wss.close()
  httpServer.close()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[WS-Proxy] SIGINT, shutting down...')
  mixerWss.close()
  wss.close()
  httpServer.close()
  process.exit(0)
})
