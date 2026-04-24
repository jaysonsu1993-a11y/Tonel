#!/usr/bin/env node
/**
 * WebRTC DataChannel to TCP/UDP Proxy for Tonel Mixer Server
 *
 * Replaces ws-mixer-proxy.js — browsers connect via WebRTC DataChannel
 * instead of WebSocket, enabling direct DTLS/SCTP connections to the
 * server IP without needing a domain or CA-signed certificate.
 *
 * Architecture:
 *   1. Connects to signaling server (TCP:9001) and registers as __mixer__
 *   2. Receives MIXER_OFFER from browsers (relayed by signaling server)
 *   3. Creates PeerConnection, answers with SDP, exchanges ICE candidates
 *   4. Bridges two DataChannels per browser:
 *      - "control" (reliable)  → mixer TCP:9002
 *      - "audio"   (unreliable) → mixer UDP:9003
 *
 * Usage: node webrtc-mixer-proxy.js [signaling_port] [tcp_host] [tcp_port] [udp_host] [udp_port] [public_ip]
 */

const nodeDataChannel = require('node-datachannel')
const net = require('net')
const dgram = require('dgram')

const SIG_PORT   = parseInt(process.argv[2] || '9001', 10)
const TCP_HOST   = process.argv[3] || '127.0.0.1'
const TCP_PORT   = parseInt(process.argv[4] || '9002', 10)
const UDP_HOST   = process.argv[5] || '127.0.0.1'
const UDP_PORT   = parseInt(process.argv[6] || '9003', 10)
const PUBLIC_IP  = process.argv[7] || '8.163.21.207'
const RECV_PORT  = 9007  // Fixed UDP port for receiving mixed audio from mixer

// ─── UDP socket for mixer audio (shared across all peers) ──────────────────

const udpRecv = dgram.createSocket('udp4')
udpRecv.bind(RECV_PORT, () => {
  console.log(`[WebRTC-Proxy] UDP receive socket bound to port ${RECV_PORT}`)
})
udpRecv.on('error', (err) => {
  console.error('[WebRTC-Proxy] UDP recv error:', err.message)
})

// Route incoming server UDP packets → correct browser DataChannel
// Key: userId (from SPA1 header) → RTCDataChannel
const dcByUid = new Map()

udpRecv.on('message', (msg) => {
  if (msg.length < 44) return
  const magic = msg.readUInt32BE(0)
  if (magic !== 0x53415031) return  // Not 'SPA1'

  const uidBuf = msg.slice(8, 40)
  let uid = ''
  for (let i = 0; i < uidBuf.length; i++) {
    if (uidBuf[i] === 0) break
    uid += String.fromCharCode(uidBuf[i])
  }

  const dc = dcByUid.get(uid)
  if (dc && dc.isOpen()) {
    dc.sendMessageBinary(Buffer.from(msg))
  }
})

// ─── Per-peer state ────────────────────────────────────────────────────────

const peers = new Map()  // user_id → { pc, tcpClient, uid }

function createPeer(userId, offerSdp, sendSignaling) {
  console.log(`[WebRTC-Proxy] Creating peer for ${userId}`)

  const pc = new nodeDataChannel.PeerConnection(`peer-${userId}`, {
    iceServers: [
      'stun:stun.qq.com:3478',
      'stun:stun.l.google.com:19302',
      'stun:stun.miwifi.com:3478'
    ],
    bindAddress: '0.0.0.0',
    portRangeBegin: 10000,
    portRangeEnd: 10100,
  })

  const peerState = { pc, tcpClient: null, uid: null }
  peers.set(userId, peerState)

  // ── ICE candidate → relay to browser via signaling ──────────────────────
  pc.onLocalCandidate((candidate, mid) => {
    console.log(`[WebRTC-Proxy] Local ICE candidate for ${userId}: mid=${mid}, cand=${candidate ? candidate.substring(0, 60) + '...' : 'null'}`)
    const msg = {
      type: 'MIXER_ICE_RELAY',
      target_user_id: userId,
      candidate,
      sdpMid: mid,
    }
    sendSignaling(JSON.stringify(msg))
  })

  // ── Local description ready → send answer ───────────────────────────────
  pc.onLocalDescription((sdp, type) => {
    console.log(`[WebRTC-Proxy] Local desc ready for ${userId}: type=${type}, len=${sdp.length}`)
    if (type === 'answer') {
      const msg = {
        type: 'MIXER_ANSWER',
        target_user_id: userId,
        sdp: sdp,
      }
      sendSignaling(JSON.stringify(msg))
      console.log(`[WebRTC-Proxy] Sent answer to ${userId}`)
    }
  })

  pc.onStateChange((state) => {
    console.log(`[WebRTC-Proxy] Peer ${userId} state: ${state}`)
    if (state === 'closed' || state === 'failed' || state === 'disconnected') {
      cleanupPeer(userId)
    }
  })

  // ── DataChannel handlers ────────────────────────────────────────────────
  pc.onDataChannel((dc) => {
    const label = dc.getLabel()
    console.log(`[WebRTC-Proxy] DataChannel opened: ${label} (peer: ${userId})`)

    if (label === 'control') {
      // Bridge reliable DataChannel ↔ mixer TCP:9002
      const tcpClient = net.createConnection({ host: TCP_HOST, port: TCP_PORT }, () => {
        console.log(`[WebRTC-Proxy] TCP connected for ${userId}`)
      })
      tcpClient.setTimeout(0)
      tcpClient.setKeepAlive(true)
      peerState.tcpClient = tcpClient

      // TCP → DataChannel
      tcpClient.on('data', (data) => {
        if (dc.isOpen()) {
          dc.sendMessage(data.toString())
        }
      })
      tcpClient.on('close', () => {
        console.log(`[WebRTC-Proxy] TCP closed for ${userId}`)
      })
      tcpClient.on('error', (err) => {
        console.error(`[WebRTC-Proxy] TCP error for ${userId}:`, err.message)
      })

      // DataChannel → TCP (with PING short-circuit)
      dc.onMessage((msg) => {
        const str = msg.toString().trim()
        // Handle PING locally — no need to go to mixer server
        try {
          const parsed = JSON.parse(str)
          if (parsed.type === 'PING') {
            if (dc.isOpen()) {
              dc.sendMessage(JSON.stringify({ type: 'PONG' }))
            }
            return
          }
        } catch (_) {}
        if (tcpClient && !tcpClient.destroyed) {
          tcpClient.write(str + '\n')
        }
      })
    } else if (label === 'audio') {
      // Bridge unreliable DataChannel ↔ mixer UDP:9003
      dc.onMessage((msg) => {
        const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg)
        if (buf.length < 44) return

        // On first SPA1 packet, register uid for UDP return routing
        if (!peerState.uid) {
          const magic = buf.readUInt32BE(0)
          if (magic === 0x53415031) {
            const uidBuf = buf.slice(8, 40)
            let rawUid = ''
            for (let i = 0; i < uidBuf.length; i++) {
              if (uidBuf[i] === 0) break
              rawUid += String.fromCharCode(uidBuf[i])
            }
            peerState.uid = rawUid
            dcByUid.set(rawUid, dc)
            console.log(`[WebRTC-Proxy] Registered uid=${rawUid} for UDP relay`)
          }
        }

        // Forward to mixer UDP
        udpRecv.send(buf, UDP_PORT, UDP_HOST, (err) => {
          if (err) console.error('[WebRTC-Proxy] UDP send error:', err.message)
        })
      })
    }
  })

  // ── Set remote offer ────────────────────────────────────────────────────
  console.log(`[WebRTC-Proxy] Setting remote description for ${userId}`)
  pc.setRemoteDescription(offerSdp, 'offer')

  // Fallback: if localDescription is already available synchronously
  const answer = pc.localDescription()
  if (answer) {
    console.log(`[WebRTC-Proxy] Got sync answer for ${userId}, len=${answer.sdp.length}`)
    const msg = {
      type: 'MIXER_ANSWER',
      target_user_id: userId,
      sdp: answer.sdp,
    }
    sendSignaling(JSON.stringify(msg))
    console.log(`[WebRTC-Proxy] Sent sync answer to ${userId}`)
  }
}

function cleanupPeer(userId) {
  const peer = peers.get(userId)
  if (!peer) return
  console.log(`[WebRTC-Proxy] Cleaning up peer ${userId}`)

  if (peer.uid) dcByUid.delete(peer.uid)
  if (peer.tcpClient) peer.tcpClient.destroy()
  try { peer.pc.close() } catch (_) {}
  peers.delete(userId)
}

// ─── Signaling connection (TCP to signaling server) ────────────────────────

let sigBuffer = ''

function connectSignaling() {
  const sig = net.createConnection({ host: '127.0.0.1', port: SIG_PORT }, () => {
    console.log(`[WebRTC-Proxy] Connected to signaling server on port ${SIG_PORT}`)
    // Register as mixer proxy
    sig.write(JSON.stringify({ type: 'MIXER_REGISTER' }) + '\n')
  })

  sig.setTimeout(0)
  sig.setKeepAlive(true)

  const sendSignaling = (msg) => {
    sig.write(msg + '\n')
  }

  sig.on('data', (data) => {
    sigBuffer += data.toString()
    const lines = sigBuffer.split('\n')
    sigBuffer = lines.pop()  // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        handleSignalingMessage(msg, sendSignaling)
      } catch (e) {
        console.warn('[WebRTC-Proxy] Parse error:', line)
      }
    }
  })

  sig.on('close', () => {
    console.log('[WebRTC-Proxy] Signaling connection closed, reconnecting in 3s...')
    setTimeout(connectSignaling, 3000)
  })

  sig.on('error', (err) => {
    console.error('[WebRTC-Proxy] Signaling error:', err.message)
  })
}

function handleSignalingMessage(msg, sendSignaling) {
  switch (msg.type) {
    case 'MIXER_REGISTER_ACK':
      console.log('[WebRTC-Proxy] Registered with signaling server')
      break

    case 'MIXER_OFFER': {
      const userId = msg.user_id
      const sdp = msg.sdp
      if (!userId || !sdp) {
        console.warn('[WebRTC-Proxy] Invalid MIXER_OFFER: missing user_id or sdp')
        break
      }
      // Clean up existing peer if reconnecting
      if (peers.has(userId)) cleanupPeer(userId)
      createPeer(userId, sdp, sendSignaling)
      break
    }

    case 'MIXER_ICE': {
      const userId = msg.user_id
      const peer = peers.get(userId)
      if (peer && msg.candidate) {
        peer.pc.addRemoteCandidate(msg.candidate, msg.sdpMid || '0')
      }
      break
    }

    default:
      // Ignore other message types (HEARTBEAT_ACK, etc.)
      break
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────

console.log(`[WebRTC-Proxy] Starting...`)
console.log(`[WebRTC-Proxy] Mixer TCP: ${TCP_HOST}:${TCP_PORT}`)
console.log(`[WebRTC-Proxy] Mixer UDP: ${UDP_HOST}:${UDP_PORT}`)
console.log(`[WebRTC-Proxy] Public IP: ${PUBLIC_IP}`)
connectSignaling()

process.on('SIGTERM', () => {
  console.log('[WebRTC-Proxy] SIGTERM, shutting down...')
  for (const [userId] of peers) cleanupPeer(userId)
  udpRecv.close()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[WebRTC-Proxy] SIGINT, shutting down...')
  for (const [userId] of peers) cleanupPeer(userId)
  udpRecv.close()
  process.exit(0)
})
