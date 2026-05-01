#!/usr/bin/env node
// opus_tandem_ab.js
//
// Compare audio quality after 1x Opus encode/decode (single-pass, equivalent
// to a SFU forwarding architecture) vs 2x (tandem, equivalent to the current
// server-side mix architecture: client encode → server decode → mix → server
// re-encode → client decode).
//
// Codec parameters mirror Tonel's mixer_server.cpp settings:
//   48000 Hz, 2 channels, RESTRICTED_LOWDELAY, 96 kbps VBR, 480 samples/frame.
//
// Reports per (signal × bitrate):
//   single SNR / THD vs original
//   tandem SNR / THD vs original
//   delta = single - tandem  (positive = tandem worse, single-pass better)

'use strict';

const OpusScript = require('opusscript');

const SAMPLE_RATE = 48000;
const CHANNELS    = 2;
const FRAME_SIZE  = 480;          // 10 ms @ 48 kHz
const APPLICATION = OpusScript.Application.RESTRICTED_LOWDELAY;
const TEST_SECONDS = 2.0;
const TOTAL_FRAMES = Math.floor(SAMPLE_RATE * TEST_SECONDS / FRAME_SIZE) * FRAME_SIZE;

function genSineStereo(freq, amp, n) {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
    out[i * 2]     = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

function genChord(amps, freqs, n) {
  const out = new Float32Array(n * 2);
  const norm = amps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < freqs.length; k++) {
      v += amps[k] * Math.sin(2 * Math.PI * freqs[k] * i / SAMPLE_RATE);
    }
    v /= norm;
    out[i * 2]     = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

// Tonel's voice-like test signal: 200 Hz carrier with 5 Hz amplitude envelope.
function genVoiceLike(amp, n) {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * i / SAMPLE_RATE);
    const v = amp * env * Math.sin(2 * Math.PI * 200 * i / SAMPLE_RATE);
    out[i * 2]     = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

// White noise, deterministic for reproducibility.
function genNoise(amp, n, seed = 1) {
  const out = new Float32Array(n * 2);
  let s = seed >>> 0;
  for (let i = 0; i < n * 2; i++) {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    out[i] = amp * ((s / 0xFFFFFFFF) * 2 - 1);
  }
  return out;
}

function floatToPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = Math.round(v * 32767);
  }
  return out;
}

function pcm16ToFloat(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

function bufferConcat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Encode→decode the full PCM stream using a fresh codec pair.
// Returns Int16Array PCM with the same shape as input.
function opusRoundTrip(pcm16, bitrate, complexity) {
  const enc = new OpusScript(SAMPLE_RATE, CHANNELS, APPLICATION);
  enc.setBitrate(bitrate);
  // Complexity: opusscript may not expose it; encoderCTL with OPUS_SET_COMPLEXITY=4010
  try { enc.encoderCTL(4010, complexity); } catch (e) {}
  // VBR: OPUS_SET_VBR=4006, value 1
  try { enc.encoderCTL(4006, 1); } catch (e) {}

  const dec = new OpusScript(SAMPLE_RATE, CHANNELS, APPLICATION);

  const frames = pcm16.length / (FRAME_SIZE * CHANNELS);
  const decodedParts = [];
  for (let f = 0; f < frames; f++) {
    const slice = pcm16.slice(f * FRAME_SIZE * CHANNELS,
                              (f + 1) * FRAME_SIZE * CHANNELS);
    const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
    const encoded = enc.encode(buf, FRAME_SIZE);
    const decBuf  = dec.decode(encoded, FRAME_SIZE);
    // decBuf is a Buffer of Int16 LE; reinterpret.
    const i16 = new Int16Array(decBuf.buffer, decBuf.byteOffset,
                               decBuf.byteLength / 2);
    decodedParts.push(i16);
  }
  enc.delete();
  dec.delete();
  return bufferConcat(decodedParts);
}

// Trim leading samples to skip codec warm-up before computing metrics.
const WARMUP_FRAMES = 10;  // skip first 100 ms

function trimWarmup(f32) {
  const skip = WARMUP_FRAMES * FRAME_SIZE * CHANNELS;
  return f32.subarray(skip);
}

// Find integer-sample lag (in stereo-interleaved units, but multi-of-2) that
// maximizes correlation between orig and processed. Opus low-delay has ~240
// samples of algorithmic delay; we search a window around that.
function findBestLag(orig, processed, maxLagSamples) {
  // Use L channel only for the search; lag in mono samples → return as
  // interleaved offset (×2) since stride is 2.
  const n = Math.min(orig.length, processed.length) / 2;
  // Skip warmup samples to avoid the codec's startup transient.
  const skipMono = WARMUP_FRAMES * FRAME_SIZE;
  const winMono  = Math.min(8192, n - skipMono - maxLagSamples - 1);
  let bestLag = 0, bestCorr = -Infinity;
  for (let lag = 0; lag <= maxLagSamples; lag++) {
    let corr = 0;
    for (let i = 0; i < winMono; i++) {
      const o = orig[(skipMono + i) * 2];
      const p = processed[(skipMono + i + lag) * 2];
      corr += o * p;
    }
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  return bestLag;  // in mono samples
}

function computeSnr(orig, processed, lagMono = 0) {
  const lag = lagMono * 2;  // interleaved offset
  const o = trimWarmup(orig);
  // Apply lag: processed[i + lagMono] aligns with orig[i].
  const skipP = WARMUP_FRAMES * FRAME_SIZE * CHANNELS + lag;
  const pAligned = processed.subarray(skipP);
  const n = Math.min(o.length, pAligned.length);
  let sigPow = 0, errPow = 0;
  for (let i = 0; i < n; i++) {
    sigPow += o[i] * o[i];
    const e = pAligned[i] - o[i];
    errPow += e * e;
  }
  if (errPow === 0) return Infinity;
  return 10 * Math.log10(sigPow / errPow);
}

// Goertzel single-bin power.
function goertzelPower(samples, freq, sr) {
  const k = Math.round(samples.length * freq / sr);
  const w = 2 * Math.PI * k / samples.length;
  const cos2 = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + cos2 * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - cos2 * s1 * s2;
}

function computeThd(processed, fundamental) {
  const p = trimWarmup(processed);
  // Take L channel only.
  const mono = new Float32Array(p.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = p[i * 2];

  const fundPow = goertzelPower(mono, fundamental, SAMPLE_RATE);
  let harmPow = 0;
  for (let h = 2; h <= 20; h++) {
    const f = fundamental * h;
    if (f >= SAMPLE_RATE / 2) break;
    harmPow += goertzelPower(mono, f, SAMPLE_RATE);
  }
  if (fundPow === 0) return NaN;
  return 100 * Math.sqrt(harmPow / fundPow);
}

const SIGNALS = [
  { name: 'sine 1kHz @0.30',    fund: 1000, gen: () => genSineStereo(1000, 0.30, TOTAL_FRAMES) },
  { name: 'sine 1kHz @0.05',    fund: 1000, gen: () => genSineStereo(1000, 0.05, TOTAL_FRAMES) },
  { name: 'sine 440Hz @0.30',   fund:  440, gen: () => genSineStereo(440,  0.30, TOTAL_FRAMES) },
  { name: 'chord A4+E5+A5',     fund:  440, gen: () => genChord([1,1,1], [440, 659.25, 880], TOTAL_FRAMES) },
  { name: 'voice 200Hz+5Hz AM', fund:  200, gen: () => genVoiceLike(0.30, TOTAL_FRAMES) },
  { name: 'white noise @0.10',  fund: null, gen: () => genNoise(0.10, TOTAL_FRAMES, 1) },
];

const BITRATES = [32000, 64000, 96000];
const COMPLEXITY = 3;  // matches mixer_server.cpp:121

function fmt(n, w) {
  if (!Number.isFinite(n)) return 'inf'.padStart(w);
  if (Number.isNaN(n)) return 'NaN'.padStart(w);
  return n.toFixed(2).padStart(w);
}

console.log(`Opus tandem A/B — ${SAMPLE_RATE} Hz, ${CHANNELS}ch, ${FRAME_SIZE}/frame, RESTRICTED_LOWDELAY, complexity=${COMPLEXITY}`);
console.log(`Test duration: ${TEST_SECONDS}s, warmup skipped: ${WARMUP_FRAMES * 10}ms`);
console.log('');

const header = ['signal'.padEnd(24), 'bitrate', '  1xSNR', '  2xSNR', '  ΔSNR', '  1xTHD%', '  2xTHD%', '  ΔTHD%'].join(' ');
console.log(header);
console.log('-'.repeat(header.length));

for (const sig of SIGNALS) {
  const orig = sig.gen();
  const origPcm = floatToPcm16(orig);

  for (const br of BITRATES) {
    const single = opusRoundTrip(origPcm, br, COMPLEXITY);
    const tandem = opusRoundTrip(single,  br, COMPLEXITY);

    const singleF = pcm16ToFloat(single);
    const tandemF = pcm16ToFloat(tandem);

    // Search a generous window: each Opus pass has ~5ms algorithmic delay
    // plus encoder lookahead; allow up to 30 ms = 1440 samples per pass.
    const lag1 = findBestLag(orig, singleF, 1440);
    const lag2 = findBestLag(orig, tandemF, 2880);

    const snr1 = computeSnr(orig, singleF, lag1);
    const snr2 = computeSnr(orig, tandemF, lag2);

    let thd1 = NaN, thd2 = NaN;
    if (sig.fund !== null) {
      thd1 = computeThd(singleF, sig.fund);
      thd2 = computeThd(tandemF, sig.fund);
    }

    const dSnr = snr1 - snr2;
    const dThd = (Number.isNaN(thd1) || Number.isNaN(thd2)) ? NaN : thd2 - thd1;

    console.log([
      sig.name.padEnd(24),
      String(br / 1000 + 'k').padStart(7),
      fmt(snr1, 7),
      fmt(snr2, 7),
      fmt(dSnr, 6),
      fmt(thd1, 8),
      fmt(thd2, 8),
      fmt(dThd, 7),
      `lag=${lag1}/${lag2}`,
    ].join(' '));
  }
}

console.log('');
console.log('Legend: 1x = single-pass (SFU); 2x = tandem (server-side mix)');
console.log('        ΔSNR > 0 means tandem is worse (single-pass keeps more signal vs error)');
console.log('        ΔTHD > 0 means tandem adds more harmonic distortion');
