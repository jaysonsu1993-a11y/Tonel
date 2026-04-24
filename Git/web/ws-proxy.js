#!/usr/bin/env node
/**
 * WebSocket to TCP Proxy for S1 Signaling Server
 * 
 * Web clients connect via WebSocket (wss://tonel.io/signaling)
 * This proxy translates WebSocket frames to raw TCP JSON messages
 * and forwards them to the signaling server on port 9001.
 * 
 * Run: node ws-proxy.js [ws_port] [tcp_host] [tcp_port]
 */

const { WebSocketServer } = require('ws')
const net = require('net')

const WS_PORT = parseInt(process.argv[2] || '9004', 10)
const TCP_HOST = process.argv[3] || '127.0.0.1'
const TCP_PORT = parseInt(process.argv[4] || '9001', 10)

const wss = new WebSocketServer({ port: WS_PORT }, () => {
  console.log(`[WS-Proxy] WebSocket server listening on port ${WS_PORT}`)
  console.log(`[WS-Proxy] Forwarding to ${TCP_HOST}:${TCP_PORT}`)
})

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress
  console.log(`[WS-Proxy] New connection from ${clientIp}`)

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

wss.on('error', (err) => {
  console.error('[WS-Proxy] Server error:', err.message)
})

process.on('SIGTERM', () => {
  console.log('[WS-Proxy] SIGTERM, shutting down...')
  wss.close()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[WS-Proxy] SIGINT, shutting down...')
  wss.close()
  process.exit(0)
})
