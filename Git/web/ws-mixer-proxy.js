#!/usr/bin/env node
/**
 * WebSocket to TCP/UDP Proxy for S1 Mixer Server
 *
 * Solves the UDP return-path problem:
 * - Proxy binds a fixed UDP port so server knows where to send responses
 * - Maintains a mapping of browser WS -> server address
 * - Forwards server UDP responses back to the correct browser WS
 *
 * Paths:
 *   /mixer-tcp  — JSON control messages only (TCP)
 *   /mixer-udp  — SPA1 binary audio (UDP relay)
 *
 * Usage: node ws-mixer-proxy.js [ws_port] [tcp_host] [tcp_port] [udp_host] [udp_port] [recv_port]
 */

const { WebSocketServer } = require('ws')
const net = require('net')
const dgram = require('dgram')

const WS_PORT   = parseInt(process.argv[2] || '9005', 10)
const TCP_HOST  = process.argv[3] || '127.0.0.1'
const TCP_PORT  = parseInt(process.argv[4] || '9002', 10)
const UDP_HOST  = process.argv[5] || '127.0.0.1'
const UDP_PORT  = parseInt(process.argv[6] || '9003', 10)
const RECV_PORT = parseInt(process.argv[7] || '9006', 10)  // Fixed port to receive from server

// ─── WebSocket server (noServer mode) ───────────────────────────────────────

const wss = new WebSocketServer({ noServer: true }, () => {
  console.log(`[WS-Mixer-Proxy] WS server listening on port ${WS_PORT}`)
  console.log(`[WS-Mixer-Proxy] TCP control  → ${TCP_HOST}:${TCP_PORT}`)
  console.log(`[WS-Mixer-Proxy] UDP send     → ${UDP_HOST}:${UDP_PORT}`)
  console.log(`[WS-Mixer-Proxy] UDP recv     ← ${UDP_HOST}:${UDP_PORT} (bound to ${RECV_PORT})`)
})

// ─── UDP: receive mixed audio from server ────────────────────────────────────

// Single UDP socket bound to a FIXED port — this is the return address the server
// will send mixed audio back to. Each browser session maps to this socket.
const udpRecv = dgram.createSocket('udp4')
udpRecv.bind(RECV_PORT, () => {
  console.log(`[WS-Mixer-Proxy] UDP receive socket bound to port ${RECV_PORT}`)
})
udpRecv.on('error', (err) => {
  console.error('[WS-Mixer-Proxy] UDP recv socket error:', err.message)
})

// Route incoming server UDP packets → the correct browser WebSocket
// Key: "roomId:userId" → WebSocket
const wsByUid = new Map()

udpRecv.on('message', (msg, rinfo) => {
  // SPA1 binary audio from server → forward to the browser WS that owns this user
  // The server sends SPA1 with userId="MIXER" in the header for mixed audio.
  // Parse the SPA1 header to get the target userId.
  if (msg.length < 76) return
  const magic = msg.readUInt32BE(0)
  if (magic !== 0x53415031) return  // Not 'SPA1' — ignore

  // Extract userId from offset 8 (64 bytes, null-terminated) — P1-1 format
  const uidBuf = msg.slice(8, 72)
  let uid = ''
  for (let i = 0; i < uidBuf.length; i++) {
    if (uidBuf[i] === 0) break
    uid += String.fromCharCode(uidBuf[i])
  }

  const ws = wsByUid.get(uid)
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(Buffer.from(msg), { binary: true })
  }
})

// ─── UDP: send audio to server ───────────────────────────────────────────────
// Use the same bound socket (udpRecv, port 9006) for sending so the server
// sees a consistent source port and sends mixed audio back to the same address.

// ─── TCP control-channel proxy ───────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress
  const path = req.url || ''
  console.log(`[WS-Mixer-Proxy] Connection from ${clientIp} (path: ${path})`)

  // Per-connection state
  let tcpClient = null
  let closing = false
  let uid = null  // "roomId:userId" for this browser session

  // ── TCP → WebSocket ────────────────────────────────────────────────────────
  tcpClient = net.createConnection({ host: TCP_HOST, port: TCP_PORT }, () => {
    console.log(`[WS-Mixer-Proxy] Connected to mixer TCP ${TCP_HOST}:${TCP_PORT}`)
  })

  tcpClient.setTimeout(0)
  tcpClient.setKeepAlive(true)

  tcpClient.on('data', (data) => {
    if (ws.readyState !== 1 /* OPEN */) return
    try {
      const firstByte = data[0]
      if (firstByte === 0x7B || firstByte === 0x7D) {
        ws.send(data.toString())  // JSON text
      } else {
        ws.send(Buffer.from(data), { binary: true })  // SPA1 binary
      }
    } catch (e) {
      console.error('[WS-Mixer-Proxy] Send to WS error:', e.message)
    }
  })

  tcpClient.on('close', () => {
    if (ws.readyState === 1 /* OPEN */) ws.close()
  })

  tcpClient.on('error', (err) => {
    console.error('[WS-Mixer-Proxy] TCP error:', err.message)
    closing = true
    ws.close()
  })

  // ── WebSocket → Server ──────────────────────────────────────────────────────
  ws.on('message', (msg) => {
    if (closing) return
    const path = req.url || ''

    if (path === '/mixer-udp') {
      // Browser sends SPA1 binary → forward to server via UDP
      // On first message (handshake), record the uid so we can route responses
      if (uid === null && msg.length >= 76) {
        const magic = msg.readUInt32BE(0)
        if (magic === 0x53415031) {
          const uidBuf = msg.slice(8, 72)
          let rawUid = ''
          for (let i = 0; i < uidBuf.length; i++) {
            if (uidBuf[i] === 0) break
            rawUid += String.fromCharCode(uidBuf[i])
          }
          uid = rawUid
          wsByUid.set(uid, ws)
          console.log(`[WS-Mixer-Proxy] Registered uid=${uid} for UDP relay`)
        }
      }
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg)
      udpRecv.send(buf, UDP_PORT, UDP_HOST, (err) => {
        if (err) console.error('[WS-Mixer-Proxy] UDP send error:', err.message)
      })
      return
    }

    // Default /mixer-tcp path: JSON control messages → TCP
    if (tcpClient) {
      const data = msg.toString().trim() + '\n'
      tcpClient.write(data)
    }
  })

  ws.on('close', () => {
    console.log('[WS-Mixer-Proxy] WebSocket closed')
    closing = true
    if (uid) wsByUid.delete(uid)
    if (tcpClient) tcpClient.destroy()
  })

  ws.on('error', (err) => {
    console.error('[WS-Mixer-Proxy] WS error:', err.message)
    closing = true
    if (uid) wsByUid.delete(uid)
    if (tcpClient) tcpClient.destroy()
  })
})

// ─── HTTP upgrade handler ─────────────────────────────────────────────────────

const httpServer = require('http').createServer()
httpServer.on('upgrade', (req, socket, head) => {
  const path = req.url || ''
  if (path === '/mixer-tcp' || path === '/mixer-udp') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

httpServer.listen(WS_PORT, () => {
  console.log(`[WS-Mixer-Proxy] HTTP/WS server ready on port ${WS_PORT}`)
})

wss.on('error', (err) => {
  console.error('[WS-Mixer-Proxy] Server error:', err.message)
})

process.on('SIGTERM', () => {
  console.log('[WS-Mixer-Proxy] SIGTERM, shutting down...')
  udpRecv.close()
  wss.close()
  httpServer.close()
  process.exit(0)
})
