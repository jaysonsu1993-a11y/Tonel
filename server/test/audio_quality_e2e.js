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
//   node server/test/audio_quality_e2e.js                     # against localhost:19002/19003
//   node server/test/audio_quality_e2e.js --tcp 9002 --udp 9003
//
// Usually invoked via server/test/run.sh which starts the mixer.

'use strict';

const net   = require('net');
const dgram = require('dgram');

// ── SPA1 protocol constants (mirrors server/src/mixer_server.h) ─────────

const SPA1_HEADER_SIZE = 76;
const SPA1_MAGIC       = 0x53415031;
const CODEC_PCM16      = 0;
const CODEC_HANDSHAKE  = 0xFF;

const SAMPLE_RATE      = 48000;
// Phase B v4.2.0: server now ticks at 2.5 ms (audio_frames=120). Test
// must produce frames at the SAME cadence the server consumes, otherwise
// the jitter buffer over/underfills and the SNR/THD measurement degrades
// for reasons unrelated to actual audio quality. Keep this in sync with
// `MIX_INTERVAL_US` in `mixer_server.h` and `FRAME_MS` in audioService.ts.
const FRAME_SAMPLES    = 120;          // 2.5 ms @ 48 kHz mono
const FRAME_BYTES      = FRAME_SAMPLES * 2;
const FRAME_INTERVAL_MS = 2.5;

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
    jitterSd:     0,           // Gaussian sender-side jitter, SD in ms (0 = no jitter)
    burstEvery:   0,           // every N frames, suspend then burst (0 = off). Simulates WSS-over-TCP main-thread stall.
    burstHoldMs:  20,          // when burstEvery > 0, this is the suspend duration in ms
    summary:      'human',     // 'human' | 'csv' (csv prints one line for sweep aggregation)
    signal:       'sine',      // 'sine' | 'noise' | 'voice'
    mode:         'raw',       // 'raw' (TCP+UDP, default) | 'wss' | 'wt'
    wssHost:      '',          // hostname for wss:// URLs when mode=wss
    tcpPath:      '/mixer-tcp',
    udpPath:      '/mixer-udp',
    wtHost:       '',          // hostname for https:// (WT) URLs when mode=wt
    wtPath:       '/mixer-wt',
    wtPort:       4433,
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

// Box-Muller. Returns N(0, 1).
function gaussianStd() {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
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
    // SPA1 byte 75 is "reserved" in production. The mixer (server)
    // repurposes it for test instrumentation: bit 0 set ⇨ at least one
    // track on this tick was PLC-filled (no fresh frame, replay-with-fade
    // path). Production clients don't read this byte, so it's safe.
    plcFired:   (buf.readUInt8(75) & 0x01) !== 0,
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

// Voice-like signal for jitter / PLC tests.
//
// Design: a 400 Hz carrier (period exactly 120 samples = one frame at
// the Phase B v4.2.0 frame size) with a 5 Hz amplitude-modulation
// envelope on top. Per-frame phase stays continuous, so a clean
// broadcast looks like a smooth AM-modulated sine — the click detector
// reports 0 events. But when a PLC tick fires, the mixer repeats the
// previous frame: the carrier phase still aligns at the boundary
// (because the period is one frame), but the *amplitude* is the prev
// frame's amplitude, while the next-real-frame's amplitude would have
// been different by a few percent. That mismatch shows up as a
// sample-step at the boundary, exactly the kind of signature the
// 6σ d2 detector flags.
//
// (Pre-v4.2.0 used a 200 Hz carrier matching the 240-sample frame.
// Frequency doubled when frame size halved so the "period == one
// frame" PLC-detection invariant still holds.)
//
// Why not noise: white noise's per-sample d2 magnitude is so large that
// the local-std threshold drowns out the PLC-boundary step entirely.
// The detector is unbiased but not informative.
//
// Why not pure sine: 1 kHz sine has period 48 samples (2.5 cycles per
// 120-sample frame), so PLC repeat is phase-aligned and looks bit-exact
// like a continuation. No detectable click even when PLC fires every
// frame.
function* voiceFrames(amp, sampleRate, framesTotal) {
  const f0 = 400;                                 // carrier — period = 120 samples
  const dPhase = 2 * Math.PI * f0 / sampleRate;
  const envHz = 5;                                // 5 Hz AM envelope (200 ms cycle)
  let phase = 0;
  for (let f = 0; f < framesTotal; f++) {
    const t = (f * FRAME_INTERVAL_MS) / 1000;     // seconds
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * envHz * t);
    const frameAmp = amp * env;
    const out = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const s = frameAmp * Math.sin(phase);
      out.writeInt16LE(Math.round(s * 32767), i * 2);
      phase += dPhase;
    }
    yield out;
  }
}

// White-noise frames (kept for completeness; click detector can't see
// PLC events on this signal because the signal's own d2 magnitude
// dominates the local-std threshold).
function* noiseFrames(amp, sampleRate, framesTotal) {
  void sampleRate;
  for (let f = 0; f < framesTotal; f++) {
    const out = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      // Uniform in [-amp, amp). Cheaper than Gaussian and the spectral
      // shape (white) is what we actually care about for the test.
      const s = (Math.random() * 2 - 1) * amp;
      out.writeInt16LE(Math.round(s * 32767), i * 2);
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

// Frame-boundary click detector for PLC / buffer-drop events.
//
// Failure modes we care about both manifest at the boundary between two
// 120-sample server-tick packets in the receiver's capture buffer (was
// 240 pre-v4.2.0). First-difference at that boundary is *not* a useful
// signature for our voice-like test signal: the AM-modulated 400 Hz
// sine has period equal to the frame, so sample[boundary] and
// sample[boundary+1] are both 0 either way (PLC fill or fresh frame). The signature shows up in the
// *second* derivative — the transition into the next sample's slope is
// where the amplitude change between A_prev and A_next becomes visible.
//
// Procedure:
//   d2[i] = x[i+1] − 2·x[i] + x[i−1]
//   threshold = 6 × median(|d2| within frames, ignoring boundaries)
//   click = |d2[k·FS]| > threshold, for each frame boundary k ≥ 1
//
// On a clean voice broadcast, frame-boundary d2 and within-frame d2 are
// drawn from the same distribution → 0 click events. Inject jitter or
// induce PLC and the boundary d2 jumps by a factor proportional to the
// amplitude change per frame, easily clearing the 6× threshold.
function detectClicks(samples) {
  const FS = FRAME_SAMPLES;
  const N = samples.length;
  if (N < FS * 4) return { count: 0, rate: 0, median: 0, p90: 0, max: 0, normEnergy: 0, signalRms: 0, durationSec: 0, threshold: 0, boundaryCount: 0 };

  let sigSumSq = 0;
  for (let i = 0; i < N; i++) sigSumSq += samples[i] * samples[i];
  const signalRms   = Math.sqrt(sigSumSq / N);
  const durationSec = N / SAMPLE_RATE;
  const signalPower = sigSumSq / durationSec;

  const numFrames = Math.floor(N / FS);

  // Calibrate threshold from within-frame |d2|, excluding a small guard
  // around boundaries so a single bad boundary doesn't pollute the median.
  const guard = 4;
  const withinD2 = [];
  for (let k = 0; k < numFrames; k++) {
    const start = k * FS + guard;
    const end   = (k + 1) * FS - guard;
    for (let i = start; i < end; i++) {
      const d2 = samples[i + 1] - 2 * samples[i] + samples[i - 1];
      withinD2.push(Math.abs(d2));
    }
  }
  if (withinD2.length === 0) return { count: 0, rate: 0, median: 0, p90: 0, max: 0, normEnergy: 0, signalRms, durationSec, threshold: 0, boundaryCount: 0 };
  withinD2.sort((a, b) => a - b);
  const medianD2 = withinD2[Math.floor(withinD2.length / 2)] || 1e-9;
  const threshold = 6 * medianD2;

  const jumps = [];
  let clickEnergy = 0;
  for (let k = 1; k < numFrames; k++) {
    const idx = k * FS;
    if (idx <= 0 || idx >= N - 1) continue;
    const d2 = Math.abs(samples[idx + 1] - 2 * samples[idx] + samples[idx - 1]);
    if (d2 > threshold) {
      jumps.push(d2);
      clickEnergy += d2 * d2;
    }
  }

  jumps.sort((a, b) => a - b);
  const normEnergy = signalPower > 0 ? clickEnergy / signalPower : 0;
  return {
    count:       jumps.length,
    rate:        jumps.length / durationSec,
    median:      jumps.length ? jumps[Math.floor(jumps.length / 2)] : 0,
    p90:         jumps.length ? jumps[Math.floor(jumps.length * 0.9)] : 0,
    max:         jumps.length ? jumps[jumps.length - 1] : 0,
    normEnergy,
    signalRms,
    durationSec,
    threshold,
    boundaryCount: numFrames - 1,
  };
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
  if (opts.summary !== 'csv') {
    if (opts.mode === 'wss') {
      console.log(`[test] WSS mixer @ ${opts.wssHost}${opts.tcpPath} + ${opts.udpPath}, room=${opts.room}`);
    } else if (opts.mode === 'wt') {
      console.log(`[test] WT mixer @ ${opts.wtHost}:${opts.wtPort}${opts.wtPath}, room=${opts.room}`);
    } else {
      console.log(`[test] mixer @ ${opts.host}:${opts.tcp}/${opts.udp}, room=${opts.room}`);
    }
    console.log(`[test] signal: ${opts.signal === 'sine' ? `${opts.freq} Hz sine` : opts.signal}, amp=${opts.amp}, ${opts.seconds}s` +
                (opts.sigma ? `, +N(0,${opts.sigma}) noise` : ''));
  }

  let sender, receiver;
  if (opts.mode === 'wss') {
    if (!opts.wssHost) throw new Error('--mode wss requires --wssHost <hostname>');
    const { Spa1WssClient } = require('./spa1_wss_client.js');
    sender   = new Spa1WssClient(opts.wssHost, opts.tcpPath, opts.udpPath, opts.room, 'sender');
    receiver = new Spa1WssClient(opts.wssHost, opts.tcpPath, opts.udpPath, opts.room, 'receiver');
  } else if (opts.mode === 'wt') {
    if (!opts.wtHost) throw new Error('--mode wt requires --wtHost <hostname>');
    const { Spa1WtClient } = require('./spa1_wt_client.js');
    sender   = new Spa1WtClient(opts.wtHost, opts.wtPath, opts.wtPort, opts.room, 'sender');
    receiver = new Spa1WtClient(opts.wtHost, opts.wtPath, opts.wtPort, opts.room, 'receiver');
  } else {
    sender   = new Spa1Client(opts.host, opts.tcp, opts.udp, opts.room, 'sender');
    receiver = new Spa1Client(opts.host, opts.tcp, opts.udp, opts.room, 'receiver');
  }

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
  let plcFiredCount = 0;       // packets where the server flagged ≥ 1 PLC track
  let primingTicks = 0;         // packets received before the first non-PLC tick (jitter-buffer priming)
  let primed = false;           // becomes true on the first non-PLC packet, after which PLC count is "real" misses
  receiver.onAudio = (payload, pkt) => {
    const t = process.hrtime.bigint();
    if (firstRxTime === 0n) firstRxTime = t;
    lastRxTime = t;
    rxLossWindow.set(pkt.sequence, captured);
    if (!primed) {
      if (pkt.plcFired) primingTicks++;
      else primed = true;
    } else if (pkt.plcFired) {
      plcFiredCount++;
    }
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
  // With jitter / burst options, we simulate adverse network conditions in
  // a controlled, repeatable way so we can measure jitter-buffer / PLC
  // behaviour locally instead of depending on a production recording.
  const startTx = process.hrtime.bigint();
  const gen =
      opts.signal === 'noise' ? noiseFrames(opts.amp, SAMPLE_RATE, totalFrames)
    : opts.signal === 'voice' ? voiceFrames(opts.amp, SAMPLE_RATE, totalFrames)
    :                           sineFrames(opts.freq, opts.amp, opts.sigma, SAMPLE_RATE, totalFrames);
  let txCount = 0;
  const generatedFrames = [];
  for (const f of gen) generatedFrames.push(f);

  // Build a per-frame send schedule (in ms from startTx).
  //
  // - `jitterSd` adds zero-mean Gaussian jitter to each frame's send time,
  //   simulating ordinary network jitter. Average TX rate stays exactly
  //   200/s because the schedule is anchored to ideal-time, not previous-send.
  //
  // - `burstEvery` simulates a main-thread stall + burst recovery: every N
  //   frames, the sender pauses for `burstHoldMs` and then sends all the
  //   queued frames back-to-back. This is the failure mode we suspect in
  //   WSS-over-TCP delivery (post-v1.0.34 residual clicks).
  const schedule = new Array(generatedFrames.length);
  for (let i = 0; i < schedule.length; i++) {
    const ideal = i * FRAME_INTERVAL_MS;
    let delay = 0;
    if (opts.jitterSd > 0) delay += gaussianStd() * opts.jitterSd;
    if (opts.burstEvery > 0) {
      const phase = i % opts.burstEvery;
      // Frames in [N-1 .. N-1 + ceil(holdMs/intervalMs)) are held back to
      // the boundary tick; they release in a single burst at frame index
      // N-1 + holdMs/intervalMs.
      if (phase < opts.burstEvery - 1) {
        // Normal frame, no extra delay (other than gauss jitter above).
      } else {
        // Last frame of every "stall window" — release right at the
        // burstHoldMs boundary along with the previous (burstHoldMs/5 - 1)
        // frames that were also released here.
        delay += opts.burstHoldMs;
      }
    }
    schedule[i] = Math.max(0, ideal + delay);
  }

  // Sort by schedule time so a frame whose jitter pushes it past the next
  // frame still goes out in chronological order — this matches typical
  // network behaviour (UDP can reorder, but TCP/WSS preserves order).
  const order = schedule.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);

  // Debug: report the actual jitter we'll inject. setTimeout has ~1 ms
  // granularity in Node, so an SD-1 ms request realises as ~1 ms minimum;
  // if injected jitter < 1 ms it's below pacing resolution.
  if (opts.summary !== 'csv' && (opts.jitterSd > 0 || opts.burstEvery > 0)) {
    const intervals = [];
    for (let i = 1; i < order.length; i++) intervals.push(order[i].t - order[i - 1].t);
    let mn = Infinity, mx = -Infinity, mean = 0;
    for (const v of intervals) { if (v < mn) mn = v; if (v > mx) mx = v; mean += v; }
    mean /= intervals.length;
    let varSum = 0;
    for (const v of intervals) varSum += (v - mean) * (v - mean);
    const sd = Math.sqrt(varSum / intervals.length);
    console.log(`[test] sched intervals (ms): mean=${mean.toFixed(3)} sd=${sd.toFixed(3)} min=${mn.toFixed(2)} max=${mx.toFixed(2)}`);
  }
  // Track actual send times to compare to schedule.
  const sendActualMs = new Float64Array(order.length);

  await new Promise((resolve) => {
    let next = 0;
    const tick = () => {
      const elapsedMs = Number(process.hrtime.bigint() - startTx) / 1e6;
      while (next < order.length && order[next].t <= elapsedMs) {
        sender.sendPcm16(generatedFrames[order[next].i]);
        sendActualMs[next] = elapsedMs;
        next++;
        txCount++;
      }
      if (next < order.length) {
        const sleepMs = Math.max(0.1, order[next].t - elapsedMs);
        // setImmediate when we're already past the schedule; setTimeout
        // for sleeps ≥ 1 ms (Node's resolution).
        if (sleepMs <= 0.1) setImmediate(tick);
        else setTimeout(tick, sleepMs);
      } else {
        resolve();
      }
    };
    tick();
  });

  if (opts.summary !== 'csv' && (opts.jitterSd > 0 || opts.burstEvery > 0)) {
    const actualIntervals = [];
    for (let i = 1; i < order.length; i++) {
      actualIntervals.push(sendActualMs[i] - sendActualMs[i - 1]);
    }
    let mn = Infinity, mx = -Infinity, mean = 0;
    for (const v of actualIntervals) { if (v < mn) mn = v; if (v > mx) mx = v; mean += v; }
    mean /= actualIntervals.length;
    let varSum = 0;
    for (const v of actualIntervals) varSum += (v - mean) * (v - mean);
    const sd = Math.sqrt(varSum / actualIntervals.length);
    console.log(`[test] actual send intervals (ms): mean=${mean.toFixed(3)} sd=${sd.toFixed(3)} min=${mn.toFixed(2)} max=${mx.toFixed(2)}`);
  }

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
  // For tonal signals we round down to a whole number of fundamental cycles
  // so Goertzel bins line up; for noise / voice (AM-modulated, not a pure
  // tone) just use everything we captured after the prime-skip.
  let useLen;
  if (opts.signal === 'sine') {
    const wholeCycles = Math.floor((useEnd - skipSamples) * opts.freq / SAMPLE_RATE);
    useLen = Math.floor(wholeCycles * SAMPLE_RATE / opts.freq);
  } else {
    useLen = useEnd - skipSamples;
  }
  const window = captureFloat.subarray(skipSamples, skipSamples + useLen);

  // Goertzel-based SNR/THD analysis only makes sense for tonal signals.
  // Noise has no fundamental and voice has an AM envelope that smears
  // the bin, so for those modes we skip Goertzel — click metrics carry
  // the useful information.
  const r = (opts.signal === 'sine')
    ? analyse(window, opts.freq)
    : { snrDb: NaN, thd: NaN, peakAmp: NaN, harmonics: [], fundPower: 0 };
  const clk = detectClicks(window);

  // Measure the server's actual broadcast rate from receive timestamps.
  // Should be ~400/s with v4.2.0's 2.5 ms tick (was 200/s pre-Phase B).
  // Nominal rate = 1000 / FRAME_INTERVAL_MS, derived so this stays
  // correct across future tick changes. Significant deviation indicates
  // timer drift has crept back in (the absolute-deadline scheduler
  // should keep us within ±5000 ppm).
  const NOMINAL_RATE = 1000 / FRAME_INTERVAL_MS;
  const rxDurationSec = Number(lastRxTime - firstRxTime) / 1e9;
  const broadcastRate = rxDurationSec > 0 ? rxLossWindow.size / rxDurationSec : 0;
  const ratePpm = broadcastRate > 0 ? Math.round((broadcastRate / NOMINAL_RATE - 1) * 1e6) : 0;
  const ratePpmSign = ratePpm >= 0 ? '+' : '';
  const RATE_PPM_BUDGET = 5000;  // ≤ 0.5 % away from nominal

  const ratePass = Math.abs(ratePpm) <= RATE_PPM_BUDGET;
  // SNR / THD pass criteria are skipped automatically when (a) jitter is
  // injected — PLC fills inevitably broaden the noise floor; or (b) the
  // signal is white noise — there's no fundamental to measure SNR
  // against. The click-rate / normalized-energy metrics are the primary
  // signal in those cases; SNR/THD remain useful for detecting pure-mixer
  // regressions on the no-jitter sine baseline.
  const jitterActive = opts.jitterSd > 0 || opts.burstEvery > 0;
  const skipTonal = jitterActive || opts.signal !== 'sine';
  const snrPass = skipTonal ? true : r.snrDb >= opts.snrPass;
  const thdPass = skipTonal ? true : r.thd <= opts.thdPass;
  const pass = snrPass && thdPass && ratePass;

  if (opts.summary === 'csv') {
    // One-line tab-separated record for sweep aggregation. Header (printed by
    // jitter_scenarios.sh) describes the columns.
    const plcRate = (clk.durationSec > 0) ? plcFiredCount / clk.durationSec : 0;
    const cols = [
      opts.signal,
      opts.freq,
      opts.amp.toFixed(3),
      opts.seconds.toFixed(2),
      opts.jitterSd.toFixed(1),
      opts.burstEvery,
      opts.burstHoldMs,
      Number.isFinite(r.snrDb) ? r.snrDb.toFixed(2) : 'n/a',
      Number.isFinite(r.thd)   ? (r.thd * 100).toFixed(3) : 'n/a',
      ratePpm,
      plcFiredCount,
      plcRate.toFixed(2),
      primingTicks,
      clk.count,
      clk.rate.toFixed(2),
      clk.normEnergy.toExponential(3),
      pass ? 'PASS' : 'FAIL',
    ];
    console.log(cols.join('\t'));
    process.exit(pass ? 0 : 1);
  }

  console.log('');
  console.log(`[test] tx frames:  ${txCount}`);
  console.log(`[test] rx packets: ${rxLossWindow.size}`);
  console.log(`[test] broadcast rate: ${broadcastRate.toFixed(2)}/s ` +
              `(${ratePpmSign}${ratePpm} ppm vs ${NOMINAL_RATE}/s, budget ±${RATE_PPM_BUDGET})`);
  console.log(`[test] signal:     ${opts.signal}` + (opts.signal === 'sine' ? ` ${opts.freq} Hz` : ''));
  console.log(`[test] window:     ${window.length} samples (${(window.length / SAMPLE_RATE).toFixed(3)} s)`);
  if (opts.signal === 'sine') {
    console.log(`[test] peak amp:   ${r.peakAmp.toFixed(4)}  (sent amplitude=${opts.amp.toFixed(4)})`);
    console.log(`[test] SNR:        ${r.snrDb.toFixed(2)} dB    (pass ≥ ${opts.snrPass}${skipTonal ? ', SKIPPED' : ''})`);
    console.log(`[test] THD:        ${(r.thd * 100).toFixed(3)} %    (pass ≤ ${(opts.thdPass * 100).toFixed(2)}${skipTonal ? ', SKIPPED' : ''})`);
  }
  if (jitterActive) {
    console.log(`[test] jitter:     SD=${opts.jitterSd} ms, burstEvery=${opts.burstEvery}, burstHold=${opts.burstHoldMs} ms`);
  }
  const plcRate = (clk.durationSec > 0) ? plcFiredCount / clk.durationSec : 0;
  console.log(`[test] PLC fires:  ${plcFiredCount} packets   (${plcRate.toFixed(2)}/s, after ${primingTicks} priming ticks)`);
  console.log(`[test] click rate: ${clk.rate.toFixed(2)}/s   (${clk.count} events in ${clk.durationSec.toFixed(2)} s)`);
  console.log(`[test] click jump: median=${clk.median.toFixed(5)}  p90=${clk.p90.toFixed(5)}  max=${clk.max.toFixed(5)}`);
  console.log(`[test] click jump / signal RMS: median=${(clk.signalRms ? clk.median / clk.signalRms : 0).toFixed(2)}×  p90=${(clk.signalRms ? clk.p90 / clk.signalRms : 0).toFixed(2)}×`);
  console.log(`[test] norm click energy / signal energy / s: ${clk.normEnergy.toExponential(3)}`);
  if (opts.signal === 'sine' && r.harmonics.length) {
    console.log(`[test] top 5 harmonics (relative to fundamental):`);
    const ranked = r.harmonics
      .map((h, i) => ({ ...h, n: i + 2, rel: 10 * Math.log10(h.power / Math.max(r.fundPower, 1e-30)) }))
      .sort((a, b) => b.power - a.power)
      .slice(0, 5);
    for (const h of ranked) {
      console.log(`         H${h.n} (${h.freq} Hz):  ${h.rel.toFixed(2)} dB`);
    }
  }

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
