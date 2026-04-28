#!/usr/bin/env node
// audio_quality_e2e.js — End-to-end audio-quality regression test.
//
// What it does:
//   1. Spins up two SPA1 clients (sender + receiver) against a running mixer.
//   2. Sender emits a known 1 kHz sine wave at PCM16 / 5 ms / 48 kHz cadence.
//   3. Receiver collects the mixer's broadcast back, reconstructs the wave.
//   4. Computes SNR and THD via Goertzel — if the mixer is clean, the
//      received signal should be a pure 1 kHz sine, no harmonics, no noise.
//
// Why we need this:
//   The "audio sounds bad" symptom is hard to reason about without numbers.
//   This test gives a quantitative pass/fail that lets us bisect where in
//   the pipeline distortion is introduced. A failing run prints the top
//   harmonics so we can tell hard-clip (lots of odd harmonics) from
//   subtle nonlinearity (one prominent 2nd harmonic) from packet jitter
//   (broadband noise) at a glance.
//
// Usage (from repo root):
//   node Git/server/test/audio_quality_e2e.js                     # against localhost:19002/19003
//   node Git/server/test/audio_quality_e2e.js --tcp 9002 --udp 9003
//
// Usually invoked via Git/server/test/run.sh which starts the mixer.

'use strict';

const net   = require('net');
const dgram = require('dgram');

// ── SPA1 protocol constants (mirrors Git/server/src/mixer_server.h) ─────────

const SPA1_HEADER_SIZE = 76;
const SPA1_MAGIC       = 0x53415031;
const CODEC_PCM16      = 0;
const CODEC_HANDSHAKE  = 0xFF;

const SAMPLE_RATE      = 48000;
const FRAME_SAMPLES    = 240;          // 5 ms @ 48 kHz mono
const FRAME_BYTES      = FRAME_SAMPLES * 2;
const FRAME_INTERVAL_MS = 5;

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    host:         '127.0.0.1',
    tcp:          19002,
    udp:          19003,
    room:         'qa-' + Math.random().toString(36).slice(2, 8),
    seconds:      1.0,
    freq:         1000,
    amp:          0.3,
    sigma:        0,           // additional white noise (0 = pure sine)
    snrPass:      40,          // dB
    thdPass:      0.01,        // ratio
  };
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i].replace(/^--/, '');
    const v = args[i + 1];
    if (k in opts) {
      opts[k] = (typeof opts[k] === 'number') ? Number(v) : v;
    }
  }
  return opts;
}

// ── SPA1 packet encoding ────────────────────────────────────────────────────

function encodeSpa1(seq, ts, userIdKey, codec, payload) {
  const buf = Buffer.alloc(SPA1_HEADER_SIZE + payload.length);
  buf.writeUInt32BE(SPA1_MAGIC, 0);
  buf.writeUInt16BE(seq & 0xFFFF, 4);
  buf.writeUInt16BE(ts  & 0xFFFF, 6);
  // userId is 64 bytes, null-padded
  const uidBuf = Buffer.from(userIdKey, 'utf8');
  uidBuf.copy(buf, 8, 0, Math.min(63, uidBuf.length));
  buf.writeUInt8(codec, 72);
  buf.writeUInt16BE(payload.length, 73);
  // reserved at 75
  if (payload.length) payload.copy(buf, SPA1_HEADER_SIZE);
  return buf;
}

function parseSpa1(buf) {
  if (buf.length < SPA1_HEADER_SIZE) return null;
  const magic = buf.readUInt32BE(0);
  if (magic !== SPA1_MAGIC) return null;
  return {
    sequence:   buf.readUInt16BE(4),
    timestamp:  buf.readUInt16BE(6),
    userId:     buf.slice(8, 72).toString('utf8').replace(/\0.*$/, ''),
    codec:      buf.readUInt8(72),
    dataSize:   buf.readUInt16BE(73),
    payload:    buf.slice(SPA1_HEADER_SIZE, SPA1_HEADER_SIZE + buf.readUInt16BE(73)),
  };
}

// ── SPA1 client (TCP join + UDP audio) ──────────────────────────────────────

class Spa1Client {
  constructor(host, tcpPort, udpPort, roomId, userId) {
    this.host       = host;
    this.tcpPort    = tcpPort;
    this.udpPort    = udpPort;
    this.roomId     = roomId;
    this.userId     = userId;
    this.userIdKey  = `${roomId}:${userId}`;
    this.tcp        = null;
    this.udp        = null;
    this.sequence   = 0;
    this.onAudio    = null;     // (Buffer) => void  (PCM16 payload)
  }

  async connect() {
    // 1. TCP join
    this.tcp = net.createConnection(this.tcpPort, this.host);
    await once(this.tcp, 'connect');
    const join = `{"type":"MIXER_JOIN","room_id":"${this.roomId}","user_id":"${this.userId}"}\n`;
    this.tcp.write(join);
    // Wait for the first newline-terminated JSON ack — server may also send
    // LEVELS shortly after, which is fine, we don't parse them here.
    const ack = await readLine(this.tcp, 2000);
    if (!ack || !ack.includes('ACK')) {
      throw new Error(`MIXER_JOIN ack missing for ${this.userIdKey}: ${ack}`);
    }

    // Continue draining TCP messages so server doesn't backpressure.
    this.tcp.on('data', () => {});

    // 2. UDP socket
    this.udp = dgram.createSocket('udp4');
    await new Promise((resolve) => this.udp.bind(0, resolve));

    this.udp.on('message', (buf) => {
      const pkt = parseSpa1(buf);
      if (!pkt || pkt.codec !== CODEC_PCM16 || pkt.dataSize === 0) return;
      if (this.onAudio) this.onAudio(pkt.payload, pkt);
    });

    // 3. SPA1 HANDSHAKE — registers our UDP source address with server
    const hs = encodeSpa1(0, 0, this.userIdKey, CODEC_HANDSHAKE, Buffer.alloc(0));
    this.udp.send(hs, this.udpPort, this.host);
  }

  sendPcm16(pcmBuf) {
    const ts = Date.now() & 0xFFFF;
    const pkt = encodeSpa1(this.sequence++ & 0xFFFF, ts, this.userIdKey, CODEC_PCM16, pcmBuf);
    this.udp.send(pkt, this.udpPort, this.host);
  }

  close() {
    if (this.udp) this.udp.close();
    if (this.tcp) this.tcp.destroy();
  }
}

function once(emitter, ev) {
  return new Promise((resolve, reject) => {
    emitter.once(ev, resolve);
    emitter.once('error', reject);
  });
}

function readLine(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let acc = '';
    const onData = (chunk) => {
      acc += chunk.toString('utf8');
      const nl = acc.indexOf('\n');
      if (nl !== -1) {
        sock.removeListener('data', onData);
        clearTimeout(timer);
        resolve(acc.slice(0, nl));
      }
    };
    const timer = setTimeout(() => {
      sock.removeListener('data', onData);
      reject(new Error('readLine timeout'));
    }, timeoutMs);
    sock.on('data', onData);
  });
}

// ── Signal generation ───────────────────────────────────────────────────────

function* sineFrames(freq, amp, sigma, sampleRate, framesTotal) {
  let phase = 0;
  const dPhase = 2 * Math.PI * freq / sampleRate;
  for (let f = 0; f < framesTotal; f++) {
    const out = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      let s = amp * Math.sin(phase);
      if (sigma) {
        // Box-Muller
        const u1 = Math.max(1e-9, Math.random()), u2 = Math.random();
        const n  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        s += sigma * n;
      }
      if (s >  1.0) s =  1.0;
      if (s < -1.0) s = -1.0;
      const v = Math.round(s * 32767);
      out.writeInt16LE(v, i * 2);
      phase += dPhase;
    }
    yield out;
  }
}

// ── Signal analysis (Goertzel for specific frequencies) ─────────────────────

function goertzelPower(samples, sampleRate, targetFreq) {
  const N = samples.length;
  const k = Math.round(N * targetFreq / sampleRate);
  const w = 2 * Math.PI * k / N;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let n = 0; n < N; n++) {
    s0 = samples[n] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  // Power (squared magnitude). Skip the sin term — magnitude is enough.
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function totalPower(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) p += samples[i] * samples[i];
  return p;
}

function pcm16BufToFloat(buf) {
  // Mixer is little-endian on all our hosts (x86_64, arm64). Server writes
  // PCM16 via reinterpret_cast of int16_t* so wire byte order is host order.
  const n = buf.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function analyse(samples, fundamental) {
  const sr = SAMPLE_RATE;
  const fundPower = goertzelPower(samples, sr, fundamental);
  const harmonics = [];
  for (let h = 2; h * fundamental < sr / 2; h++) {
    if (h > 20) break;
    harmonics.push({ freq: h * fundamental, power: goertzelPower(samples, sr, h * fundamental) });
  }
  const totalP    = totalPower(samples);
  const harmonicP = harmonics.reduce((a, h) => a + h.power, 0);
  const noiseP    = Math.max(0, totalP - fundPower - harmonicP);
  const thd       = Math.sqrt(harmonicP / Math.max(fundPower, 1e-30));
  const snrDb     = 10 * Math.log10(fundPower / Math.max(noiseP + harmonicP, 1e-30));
  // Goertzel returns |X[k]|², which equals (N·A/2)² for a sine of peak A.
  // Recover A so it is directly comparable to the input amplitude.
  const peakAmp   = 2 * Math.sqrt(fundPower) / samples.length;
  return { fundPower, harmonics, totalP, harmonicP, noiseP, thd, snrDb, peakAmp };
}

// ── Main test ──────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log(`[test] mixer @ ${opts.host}:${opts.tcp}/${opts.udp}, room=${opts.room}`);
  console.log(`[test] signal: ${opts.freq} Hz sine, amp=${opts.amp}, ${opts.seconds}s` +
              (opts.sigma ? `, +N(0,${opts.sigma}) noise` : ''));

  const sender   = new Spa1Client(opts.host, opts.tcp, opts.udp, opts.room, 'sender');
  const receiver = new Spa1Client(opts.host, opts.tcp, opts.udp, opts.room, 'receiver');

  // Capture buffer: enough samples for the full test plus a safety margin.
  const totalFrames = Math.ceil(opts.seconds * (1000 / FRAME_INTERVAL_MS));
  const captureFloat = new Float32Array((totalFrames + 200) * FRAME_SAMPLES);
  let captured = 0;
  let firstRxTime = 0n;
  const rxLossWindow = new Map();   // sequence → arrival index

  // Track first/last receive times so we can compute the server's actual
  // broadcast rate. With the v1.0.28 absolute-deadline timer, the rate
  // should be very close to 200/s; the previous `uv_timer_start(.., 5, 5)`
  // approach drifted by ~1 % depending on host load.
  let lastRxTime = 0n;
  receiver.onAudio = (payload, pkt) => {
    const t = process.hrtime.bigint();
    if (firstRxTime === 0n) firstRxTime = t;
    lastRxTime = t;
    rxLossWindow.set(pkt.sequence, captured);
    const f32 = pcm16BufToFloat(payload);
    if (captured + f32.length <= captureFloat.length) {
      captureFloat.set(f32, captured);
      captured += f32.length;
    }
  };

  await sender.connect();
  await receiver.connect();

  // Give the server a tick to register both UDP addresses.
  await new Promise((r) => setTimeout(r, 50));

  // Pace the sender at 5 ms intervals — the same cadence as a real client.
  const startTx = process.hrtime.bigint();
  const gen = sineFrames(opts.freq, opts.amp, opts.sigma, SAMPLE_RATE, totalFrames);
  let txCount = 0;
  await new Promise((resolve) => {
    const tick = () => {
      const target = Number(process.hrtime.bigint() - startTx) / 1e6;
      const want   = Math.floor(target / FRAME_INTERVAL_MS);
      while (txCount < want && txCount < totalFrames) {
        const next = gen.next();
        if (next.done) break;
        sender.sendPcm16(next.value);
        txCount++;
      }
      if (txCount < totalFrames) setImmediate(tick);
      else resolve();
    };
    tick();
  });

  // Allow a final 200 ms for in-flight packets to land.
  await new Promise((r) => setTimeout(r, 200));

  sender.close();
  receiver.close();

  // ── Skip the first 50 ms — playback rampup, server priming. ───────────
  const skipSamples = Math.floor(0.05 * SAMPLE_RATE);
  if (captured <= skipSamples + SAMPLE_RATE / 2) {
    console.log(`[test] FAIL: only captured ${captured} samples (need ≥ ${skipSamples + SAMPLE_RATE / 2})`);
    process.exit(2);
  }
  const useEnd = captured;
  // Round down to a multiple of (sampleRate / freq) for cleanest Goertzel binning
  const wholeCycles = Math.floor((useEnd - skipSamples) * opts.freq / SAMPLE_RATE);
  const useLen = Math.floor(wholeCycles * SAMPLE_RATE / opts.freq);
  const window = captureFloat.subarray(skipSamples, skipSamples + useLen);

  const r = analyse(window, opts.freq);
  console.log('');
  // Measure the server's actual broadcast rate from receive timestamps.
  // Should be ~200/s with the v1.0.28 absolute-deadline timer; significant
  // deviation indicates timer drift has crept back in.
  const rxDurationSec = Number(lastRxTime - firstRxTime) / 1e9;
  const broadcastRate = rxDurationSec > 0 ? rxLossWindow.size / rxDurationSec : 0;
  const ratePpm = broadcastRate > 0 ? Math.round((broadcastRate / 200 - 1) * 1e6) : 0;
  const ratePpmSign = ratePpm >= 0 ? '+' : '';
  const RATE_PPM_BUDGET = 5000;  // ≤ 0.5 % away from 200/s

  console.log(`[test] tx frames:  ${txCount}`);
  console.log(`[test] rx packets: ${rxLossWindow.size}`);
  console.log(`[test] broadcast rate: ${broadcastRate.toFixed(2)}/s ` +
              `(${ratePpmSign}${ratePpm} ppm vs 200/s, budget ±${RATE_PPM_BUDGET})`);
  console.log(`[test] window:     ${window.length} samples (${(window.length / SAMPLE_RATE).toFixed(3)} s, ${wholeCycles} cycles of ${opts.freq} Hz)`);
  console.log(`[test] peak amp:   ${r.peakAmp.toFixed(4)}  (sent amplitude=${opts.amp.toFixed(4)})`);
  console.log(`[test] SNR:        ${r.snrDb.toFixed(2)} dB    (pass ≥ ${opts.snrPass})`);
  console.log(`[test] THD:        ${(r.thd * 100).toFixed(3)} %    (pass ≤ ${(opts.thdPass * 100).toFixed(2)})`);
  console.log(`[test] top 5 harmonics (relative to fundamental):`);
  const ranked = r.harmonics
    .map((h, i) => ({ ...h, n: i + 2, rel: 10 * Math.log10(h.power / Math.max(r.fundPower, 1e-30)) }))
    .sort((a, b) => b.power - a.power)
    .slice(0, 5);
  for (const h of ranked) {
    console.log(`         H${h.n} (${h.freq} Hz):  ${h.rel.toFixed(2)} dB`);
  }

  const ratePass = Math.abs(ratePpm) <= RATE_PPM_BUDGET;
  const pass = r.snrDb >= opts.snrPass && r.thd <= opts.thdPass && ratePass;
  if (!ratePass) {
    console.log(`[test] rate FAIL: drift exceeds ±${RATE_PPM_BUDGET} ppm — server timer regression?`);
  }
  console.log('');
  console.log(`[test] ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[test] error:', e);
  process.exit(2);
});
