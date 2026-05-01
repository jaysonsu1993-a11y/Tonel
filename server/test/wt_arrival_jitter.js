#!/usr/bin/env node
// wt_arrival_jitter.js — Measure per-datagram inter-arrival timing of WT
// audio packets against a remote server, from this vantage point.
//
// Why: server-side tcpdump showed no egress burst on either server;
// to localize whether the path between server and client introduces
// burst, we need the user-side equivalent. tcpdump on macOS needs
// sudo — this script bypasses that by timestamping each datagram in
// the read loop and computing a histogram. Slightly less precise
// than kernel-level capture (loses ≤ 1ms of scheduler jitter on a
// quiet box) but enough to see 10–20 ms bursts.
//
// Usage:
//   node server/test/wt_arrival_jitter.js --wtHost srv.tonel.io --seconds 15
//
// Spawns two WT sessions in the same room (sender + receiver) so the
// mixer broadcasts back; only the receiver's arrivals are timed.

'use strict';

const { Spa1WtClient } = require('./spa1_wt_client.js');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const HOST    = arg('wtHost', 'srv.tonel.io');
const SECONDS = parseFloat(arg('seconds', '15'));
const FREQ    = parseFloat(arg('freq', '400'));
const AMP     = parseFloat(arg('amp', '0.3'));

const SAMPLE_RATE   = 48000;
const FRAME_SAMPLES = 120;
const FRAME_BYTES   = FRAME_SAMPLES * 2;
const FRAME_MS      = 2.5;

// Sender: simple sine. Receiver: timestamp every onAudio call.
function* sineFrames(freq, amp, totalFrames) {
  let phase = 0;
  const dPhase = 2 * Math.PI * freq / SAMPLE_RATE;
  for (let f = 0; f < totalFrames; f++) {
    const out = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      let s = amp * Math.sin(phase);
      if (s >  1.0) s =  1.0;
      if (s < -1.0) s = -1.0;
      out.writeInt16LE(Math.round(s * 32767), i * 2);
      phase += dPhase;
    }
    yield out;
  }
}

(async () => {
  const room = 'jit-' + Math.random().toString(36).slice(2, 8);
  const sender   = new Spa1WtClient(HOST, '/mixer-wt', 4433, room, 'sender');
  const receiver = new Spa1WtClient(HOST, '/mixer-wt', 4433, room, 'receiver');

  const arrivals = [];   // hrtime in ns since process start
  receiver.onAudio = () => {
    arrivals.push(process.hrtime.bigint());
  };

  await sender.connect();
  await receiver.connect();
  // Brief warm-up (UDP HANDSHAKE registration takes a tick).
  await new Promise(r => setTimeout(r, 300));

  const totalFrames = Math.ceil(SECONDS * 1000 / FRAME_MS);
  const gen = sineFrames(FREQ, AMP, totalFrames);
  const startTx = Date.now();
  // Cooperative pace: setTimeout on the next-due-frame deadline. A
  // spin-wait monopolizes the event loop and starves the receiver's
  // onAudio callbacks — the WT read loop can't drain and datagrams
  // queue or drop, which collapses the measurement to "first ~1 s
  // of data, then silence." Critical for measurements that DEPEND on
  // receiver responsiveness; the small jitter (≤1 ms) setTimeout
  // adds is well below the gaps we're trying to measure.
  await new Promise((resolve) => {
    let f = 0;
    const tick = () => {
      while (f < totalFrames && Date.now() - startTx >= f * FRAME_MS) {
        const pcm = gen.next().value;
        if (pcm) sender.sendPcm16(pcm);
        f++;
      }
      if (f >= totalFrames) return resolve();
      const dueAt = startTx + f * FRAME_MS;
      const wait = Math.max(1, dueAt - Date.now());
      setTimeout(tick, wait);
    };
    tick();
  });
  // Drain — wait one second to catch trailing arrivals.
  await new Promise(r => setTimeout(r, 1000));
  await sender.close();
  await receiver.close();

  if (arrivals.length < 100) {
    console.log(`[jitter] only ${arrivals.length} arrivals — connection issue?`);
    process.exit(1);
  }

  // Inter-arrival gaps in ms.
  const gaps = [];
  for (let i = 1; i < arrivals.length; i++) {
    const dNs = arrivals[i] - arrivals[i - 1];
    gaps.push(Number(dNs) / 1e6);
  }

  // Stats.
  const n = gaps.length;
  const sum = gaps.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / n);
  const max = Math.max(...gaps);
  const min = Math.min(...gaps);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const p50  = sorted[Math.floor(n * 0.5)];
  const p99  = sorted[Math.floor(n * 0.99)];
  const p999 = sorted[Math.floor(n * 0.999)];
  const p9999 = sorted[Math.min(n - 1, Math.floor(n * 0.9999))];

  // Histogram in 1 ms buckets up to 30 ms, then bins for >30 ms.
  const buckets = new Array(32).fill(0);
  for (const g of gaps) {
    if (g >= 30)        buckets[31]++;
    else                buckets[Math.floor(g)]++;
  }

  console.log(`[jitter] host=${HOST}  arrivals=${arrivals.length}  duration=${SECONDS}s`);
  console.log(`[jitter] gap mean=${mean.toFixed(3)}ms  sd=${sd.toFixed(3)}ms  min=${min.toFixed(3)}  max=${max.toFixed(3)}`);
  console.log(`[jitter] p50=${p50.toFixed(3)}  p99=${p99.toFixed(3)}  p999=${p999.toFixed(3)}  p9999=${p9999.toFixed(3)}`);
  // Long-gap exceedances (these are the audible-click candidates).
  let over5  = 0, over10 = 0, over20 = 0;
  for (const g of gaps) { if (g >= 5) over5++; if (g >= 10) over10++; if (g >= 20) over20++; }
  console.log(`[jitter] gaps >5ms=${over5}  >10ms=${over10}  >20ms=${over20}  (n=${n})`);
  console.log('[jitter] histogram (gap ms → count):');
  for (let i = 0; i < 31; i++) {
    if (buckets[i] === 0) continue;
    const bar = '#'.repeat(Math.min(60, Math.round(buckets[i] / Math.max(...buckets) * 60)));
    console.log(`  [${String(i).padStart(2)}-${String(i+1).padStart(2)}ms] ${String(buckets[i]).padStart(6)}  ${bar}`);
  }
  if (buckets[31] > 0) console.log(`  [>=30ms]    ${String(buckets[31]).padStart(6)}`);
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
