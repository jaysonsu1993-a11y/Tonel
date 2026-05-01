#!/usr/bin/env node
/**
 * Signaling integration test — catches regressions in the
 * peer-list / PEER_JOINED / PEER_LEFT machinery against a real
 * `signaling_server` binary.
 *
 * Spawns a local signaling server, runs three scripted scenarios,
 * each of which both REPRODUCES a real-world failure mode and
 * exercises the fix. Fails fast (exit 1) on first scenario failure.
 *
 * Run via:
 *   server/test/signaling_integration.js
 *
 * Used as one of the gates in `scripts/pretest.sh` (run before
 * every release).
 */

const net  = require('net')
const cp   = require('child_process')
const path = require('path')

const SIG_PORT  = process.env.SIG_PORT  ? Number(process.env.SIG_PORT)  : 9095
const SIG_BIN   = process.env.SIG_BIN   || path.resolve(__dirname, '..', 'build', 'signaling_server')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Tiny line-framed JSON client ──────────────────────────────────────────

function makeClient (label) {
  const s = new net.Socket()
  s.label    = label
  s.received = []          // { type, raw, parsed } per inbound line
  s.peerCount = 0           // running peer-list size, mirrors useSignal hook
  s.buf = ''
  s.on('data', (d) => {
    s.buf += d.toString()
    let i
    while ((i = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1)
      if (!line.trim()) continue
      let parsed = null
      try { parsed = JSON.parse(line) } catch {}
      s.received.push({ raw: line, parsed })
      if (parsed) {
        if (parsed.type === 'PEER_LIST')   s.peerCount = parsed.peers.length
        if (parsed.type === 'PEER_JOINED') s.peerCount += 1
        if (parsed.type === 'PEER_LEFT')   s.peerCount = Math.max(0, s.peerCount - 1)
      }
    }
  })
  s.send = (obj) => s.write(JSON.stringify(obj) + '\n')
  s.dump = () => {
    console.error(`  --- recv@${label} ---`)
    s.received.forEach(m => console.error('   ', m.raw))
  }
  return s
}

const connectClient = async (label) => {
  const s = makeClient(label)
  await new Promise(res => s.connect(SIG_PORT, '127.0.0.1', res))
  return s
}

// ── Assertions ────────────────────────────────────────────────────────────

class AssertionError extends Error {}
const assert = (cond, msg) => { if (!cond) throw new AssertionError(msg) }
const assertEq = (actual, expected, label) => {
  if (actual !== expected) throw new AssertionError(`${label}: expected ${expected}, got ${actual}`)
}

// ── Scenarios ─────────────────────────────────────────────────────────────

async function scenarioCreateThenJoin () {
  // The basic case: A creates a room, B joins. Each sees the other.
  // Pre-v3.2.3 bug: process_create_room never added the creator to
  // `room.users`, so PEER_LIST went to B with 0 peers. Verified fix
  // in v3.2.3 by `room->add_user(user_id)` in CREATE_ROOM handler.
  const a = await connectClient('A')
  a.send({ type:'CREATE_ROOM', room_id:'r-create', user_id:'a' })
  await sleep(150)

  const b = await connectClient('B')
  b.send({ type:'JOIN_ROOM', room_id:'r-create', user_id:'b', ip:'0.0.0.0', port:9003 })
  await sleep(300)

  try {
    assertEq(a.peerCount, 1, 'A.peerCount after B joins')
    assertEq(b.peerCount, 1, 'B.peerCount after JOIN_ROOM_ACK')
  } catch (err) { a.dump(); b.dump(); throw err }
  a.destroy(); b.destroy()
}

async function scenarioReconnectReplay () {
  // The bug: A joins, A's WebSocket drops, A's reconnected ctx is not
  // re-bound to the room. New peer B's PEER_JOINED never reaches A.
  // Fix in v3.6.2: signalService.connect()'s onopen replays JOIN_ROOM
  // when roomId+userId are set. This test simulates that replay
  // explicitly (since the test client can't re-use the JS service).
  const a1 = await connectClient('A1')
  a1.send({ type:'CREATE_ROOM', room_id:'r-recon', user_id:'a' })
  await sleep(150)

  // Drop A's WS — server's on_close does leave_room + PEER_LEFT broadcast.
  a1.destroy()
  await sleep(200)

  // Reconnect WITH the v3.6.2 onopen replay — simulating the fix.
  const a2 = await connectClient('A2')
  a2.send({ type:'JOIN_ROOM', room_id:'r-recon', user_id:'a', ip:'0.0.0.0', port:9003 })
  await sleep(150)

  // A new peer joins. A's reconnected ctx must receive PEER_JOINED.
  const b = await connectClient('B')
  b.send({ type:'JOIN_ROOM', room_id:'r-recon', user_id:'b', ip:'0.0.0.0', port:9003 })
  await sleep(400)

  try {
    assertEq(a2.peerCount, 1, 'A.peerCount after reconnect+B-joins (the v3.6.2 regression)')
    assertEq(b.peerCount,  1, 'B.peerCount sees A in PEER_LIST')
  } catch (err) { a2.dump(); b.dump(); throw err }
  a2.destroy(); b.destroy()
}

async function scenarioPeerLeft () {
  // Three-way: A + B + C, then C leaves cleanly. A and B should each
  // see PEER_LEFT for C and decrement their peer count to 1.
  const a = await connectClient('A')
  a.send({ type:'CREATE_ROOM', room_id:'r-leave', user_id:'a' })
  await sleep(100)

  const b = await connectClient('B')
  b.send({ type:'JOIN_ROOM', room_id:'r-leave', user_id:'b', ip:'0.0.0.0', port:9003 })
  await sleep(100)

  const c = await connectClient('C')
  c.send({ type:'JOIN_ROOM', room_id:'r-leave', user_id:'c', ip:'0.0.0.0', port:9003 })
  await sleep(200)

  try {
    assertEq(a.peerCount, 2, 'A.peerCount with B+C')
    assertEq(b.peerCount, 2, 'B.peerCount with A+C')
    assertEq(c.peerCount, 2, 'C.peerCount sees A+B in PEER_LIST')
  } catch (err) { a.dump(); b.dump(); c.dump(); throw err }

  c.send({ type:'LEAVE_ROOM', room_id:'r-leave', user_id:'c' })
  await sleep(200)

  try {
    assertEq(a.peerCount, 1, 'A.peerCount after C leaves')
    assertEq(b.peerCount, 1, 'B.peerCount after C leaves')
  } catch (err) { a.dump(); b.dump(); throw err }
  a.destroy(); b.destroy(); c.destroy()
}

// ── Driver ────────────────────────────────────────────────────────────────

async function waitReady () {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    try { await new Promise((res, rej) => {
      const s = new net.Socket()
      s.once('connect', () => { s.destroy(); res() })
      s.once('error',   (e) => { s.destroy(); rej(e) })
      s.connect(SIG_PORT, '127.0.0.1')
    }); return } catch {}
    await sleep(50)
  }
  throw new Error('signaling_server never came up')
}

async function main () {
  const server = cp.spawn(SIG_BIN, [String(SIG_PORT)], { stdio: ['ignore','pipe','pipe'] })
  let serverLog = ''
  server.stdout.on('data', d => serverLog += d)
  server.stderr.on('data', d => serverLog += d)
  process.on('exit', () => { try { server.kill() } catch {} })

  try {
    await waitReady()
  } catch (err) {
    console.error('[signal-itest] FAIL: server bring-up\n', serverLog)
    process.exit(1)
  }

  const scenarios = [
    ['create-then-join',    scenarioCreateThenJoin],
    ['reconnect-replay',    scenarioReconnectReplay],
    ['peer-left',           scenarioPeerLeft],
  ]
  let failed = 0
  for (const [name, fn] of scenarios) {
    process.stdout.write(`[signal-itest] ${name}: `)
    try {
      await fn()
      console.log('PASS')
    } catch (err) {
      console.log('FAIL')
      console.error(`  ${err.message}`)
      failed++
    }
  }

  server.kill()
  if (failed) {
    console.error(`[signal-itest] ${failed} scenario(s) failed`)
    process.exit(1)
  }
  console.log('[signal-itest] all scenarios passed')
}

main().catch(err => {
  console.error('[signal-itest] driver error:', err)
  process.exit(1)
})
