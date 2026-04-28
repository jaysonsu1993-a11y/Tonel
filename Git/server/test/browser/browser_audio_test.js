#!/usr/bin/env node
// browser_audio_test.js — Web-playback audio quality regression test.
//
// What it covers (that the Node-only audio_quality_e2e.js does NOT):
//   • The exact AudioWorklet code that ships in production.
//   • linearResample at the producer side.
//   • Web Audio's actual audio-thread behaviour (worklet process(), ring
//     buffer drain timing, sample-rate handling).
//
// What it does NOT cover:
//   • Network path (WebSocket, WS-proxy, UDP).  The Node test covers that.
//   • mic capture path (getUserMedia, ScriptProcessorNode).
//
// Strategy:
//   Real Chromium → OfflineAudioContext renders the same worklet that
//   ships in production → we feed PCM16 frames through the same code
//   path as `audioService.playPcm16` → captured rendered output → FFT
//   on the Node side → SNR/THD report.
//
// Run:
//   node browser_audio_test.js                       # default suite
//   node browser_audio_test.js --rate 44100 --amp 0.3
//
// Suite (default): tests at multiple AudioContext rates, because the
// v1.0.12 regression specifically depends on context rate vs. 48 kHz.

import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Chromium refuses to load an AudioWorklet from a file:// origin (the
// Worklet spec requires a same-origin secure-ish context). Serve the
// test page from a tiny localhost HTTP server so the import resolves.
async function serveTestPage() {
  const html = await fs.readFile(path.join(__dirname, 'test_page.html'), 'utf8');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/` };
}

const WIRE_RATE       = 48000;
const FRAME_SAMPLES   = 240;
const FRAME_INTERVAL_MS = 5;

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const o = {
    rate:    null,           // null → run a sweep of rates
    amp:     0.3,
    freq:    1000,
    seconds: 1.0,
    snrPass: 40,
    thdPass: 0.01,
    headed:  false,
  };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'headed') { o.headed = true; continue; }
    const v = a[i + 1]; i++;
    if (k in o) o[k] = (typeof o[k] === 'number') ? Number(v) : v;
  }
  return o;
}

// ── Signal generation ──────────────────────────────────────────────────────

function generateSinePcmFrames(freq, amp, seconds) {
  const totalFrames = Math.floor(seconds * (1000 / FRAME_INTERVAL_MS));
  const frames = [];
  let phase = 0;
  const dPhase = 2 * Math.PI * freq / WIRE_RATE;
  for (let f = 0; f < totalFrames; f++) {
    const buf = Buffer.alloc(FRAME_SAMPLES * 2);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      let s = amp * Math.sin(phase);
      if (s >  1.0) s =  1.0;
      if (s < -1.0) s = -1.0;
      buf.writeInt16LE(Math.round(s * 32767), i * 2);
      phase += dPhase;
    }
    frames.push(new Uint8Array(buf));
  }
  return frames;
}

// ── Goertzel analysis (mirrors audio_quality_e2e.js) ───────────────────────

function goertzelPower(samples, sampleRate, targetFreq) {
  const N = samples.length;
  const k = Math.round(N * targetFreq / sampleRate);
  const w = 2 * Math.PI * k / N;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s1 = 0, s2 = 0;
  for (let n = 0; n < N; n++) {
    const s0 = samples[n] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function totalPower(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) p += samples[i] * samples[i];
  return p;
}

function analyse(samples, sampleRate, fundamental) {
  const fundPower = goertzelPower(samples, sampleRate, fundamental);
  const harmonics = [];
  for (let h = 2; h * fundamental < sampleRate / 2 && h <= 20; h++) {
    harmonics.push({ n: h, freq: h * fundamental, power: goertzelPower(samples, sampleRate, h * fundamental) });
  }
  const totalP    = totalPower(samples);
  const harmonicP = harmonics.reduce((a, h) => a + h.power, 0);
  const noiseP    = Math.max(0, totalP - fundPower - harmonicP);
  const thd       = Math.sqrt(harmonicP / Math.max(fundPower, 1e-30));
  const snrDb     = 10 * Math.log10(fundPower / Math.max(noiseP + harmonicP, 1e-30));
  const peakAmp   = 2 * Math.sqrt(fundPower) / samples.length;
  return { peakAmp, thd, snrDb, harmonics, fundPower };
}

// ── Browser-side test driver ───────────────────────────────────────────────

async function runOneRate(page, opts, contextRate) {
  const pcmFrames = generateSinePcmFrames(opts.freq, opts.amp, opts.seconds);

  // pcmFrames are Uint8Array → serialise as plain arrays for IPC robustness.
  const flat = pcmFrames.map((u) => Array.from(u));

  const rendered = await page.evaluate(async (args) => {
    const frames = args.flat.map((arr) => new Uint8Array(arr));
    return await window.runWebPlaybackTest({
      pcmFrames:    frames,
      contextRate:  args.contextRate,
      wireRate:     args.wireRate,
      totalSeconds: args.totalSeconds,
    });
  }, {
    flat,
    contextRate:  contextRate,
    wireRate:     WIRE_RATE,
    totalSeconds: opts.seconds + 0.1,
  });

  const left  = new Float32Array(rendered.left);
  const right = new Float32Array(rendered.right);

  // Per-channel peak so the right-silent regression is visible.
  let peakL = 0, peakR = 0;
  for (let i = 0; i < left.length; i++) {
    const a = Math.abs(left[i]);  if (a > peakL) peakL = a;
    const b = Math.abs(right[i]); if (b > peakR) peakR = b;
  }
  console.log(`    raw render: peakL=${peakL.toFixed(4)} peakR=${peakR.toFixed(4)}` +
              (peakR < 0.001 ? '  ❌ RIGHT CHANNEL SILENT' : ''));
  // Find the boundaries between non-silence and silence
  let firstNonZero = -1, lastNonZero = -1;
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(left[i]) > 1e-4) { if (firstNonZero === -1) firstNonZero = i; lastNonZero = i; }
  }
  console.log(`    signal range: [${firstNonZero}..${lastNonZero}] = ${lastNonZero - firstNonZero + 1} samples (${((lastNonZero - firstNonZero + 1) / contextRate * 1000).toFixed(1)} ms)`);

  // Use channel 0 for the spectral analysis (where the worklet writes).
  const samples = left;

  // The playback worklet runs adaptive rate compensation (drift correction
  // — see audioService.ts PlaybackProcessor). In OfflineAudioContext the
  // ring is pre-filled, so the adaptation nudges output rate up by up to
  // 0.5 %, shifting the rendered fundamental by ≤0.5 %. Goertzel at the
  // exact target frequency would then under-report due to spectral
  // leakage. Sweep ±2 % to find the actual peak so the test reflects
  // the real signal quality rather than this test-only artifact. (In
  // production the ring is never sustained-full, so this rate-pull
  // doesn't happen in real listening.)
  function findPeak(buf, sr, target) {
    let best = goertzelPower(buf, sr, target);
    let bestF = target;
    for (let f = target * 0.98; f <= target * 1.02; f += 0.5) {
      const p = goertzelPower(buf, sr, f);
      if (p > best) { best = p; bestF = f; }
    }
    return { freq: bestF, power: best };
  }

  // Skip the first 50 ms to dodge worklet warmup.
  const skip = Math.floor(0.05 * contextRate);
  // Round the analysis window to whole cycles of `freq`.
  const usable = samples.length - skip;
  const wholeCycles = Math.floor(usable * opts.freq / contextRate);
  const winLen = Math.floor(wholeCycles * contextRate / opts.freq);
  if (winLen < contextRate / 4) {
    return { ok: false, reason: `not enough samples to analyse (${samples.length})` };
  }
  const window = samples.subarray(skip, skip + winLen);

  // Find the actual fundamental (may be slightly shifted by adaptive rate).
  const peak = findPeak(window, contextRate, opts.freq);
  const r = analyse(window, contextRate, peak.freq);
  const pass = r.snrDb >= opts.snrPass && r.thd <= opts.thdPass;

  const shiftPct = ((peak.freq - opts.freq) / opts.freq) * 100;
  console.log(`  rate=${contextRate} Hz | window=${(winLen / contextRate).toFixed(3)}s ` +
              `| peak=${peak.freq.toFixed(1)} Hz (shift ${shiftPct >= 0 ? '+' : ''}${shiftPct.toFixed(2)} %) ` +
              `| peakAmp=${r.peakAmp.toFixed(4)} (sent ${opts.amp}) ` +
              `| SNR=${r.snrDb.toFixed(2)} dB | THD=${(r.thd * 100).toFixed(3)} % ` +
              `=> ${pass ? 'PASS' : 'FAIL'}`);

  if (!pass) {
    console.log('    top 5 harmonics:');
    const top = r.harmonics
      .map((h) => ({ ...h, rel: 10 * Math.log10(h.power / Math.max(r.fundPower, 1e-30)) }))
      .sort((a, b) => b.power - a.power)
      .slice(0, 5);
    for (const h of top) console.log(`      H${h.n} (${h.freq} Hz): ${h.rel.toFixed(2)} dB`);
  }
  return { ok: pass, snrDb: r.snrDb, thd: r.thd, peakAmp: r.peakAmp };
}

// ── Capture-path test: confirms the wire-rate label is honest ─────────────
//
// The bug we're hunting: ScriptProcessorNode delivers samples at the
// AudioContext's *real* rate, but production (pre-fix) sliced them into
// 240-sample frames and labeled them "5 ms of 48 kHz" regardless. If the
// context is at 44.1 kHz, the receiver's worklet then plays the audio at
// 48000/44100 = +8.8 % pitch — that's the "源信号 + 失真噪音" the user
// hears as their own voice echoes back through the server mix.
//
// Each context rate is tested twice: once with the resampler off (this
// is what production v1.0.13 ships — should fail at non-48 k rates) and
// once with the resampler on (what the fix enables — should pass).
async function runCaptureTest(page, opts, contextRate, useResampler) {
  const samples = await page.evaluate((args) => {
    return window.runCaptureTest(args);
  }, {
    contextRate, freq: opts.freq, amp: opts.amp,
    seconds: opts.seconds, useResampler,
  });
  const audio = new Float32Array(samples);
  // Analyse at the wire rate (48 kHz) — that is how the server and
  // every receiver interprets the bytes.
  const skip   = Math.floor(0.05 * 48000);
  const usable = audio.length - skip;
  const wholeCycles = Math.floor(usable * opts.freq / 48000);
  const winLen = Math.floor(wholeCycles * 48000 / opts.freq);
  if (winLen < 8000) return { ok: false, reason: 'too short' };
  const window = audio.subarray(skip, skip + winLen);
  const r = analyse(window, 48000, opts.freq);
  // Sweep ±10% to find the actual fundamental — exposes pitch shift.
  let bestPower = r.fundPower, bestFreq = opts.freq;
  for (let f = opts.freq * 0.9; f <= opts.freq * 1.10; f += 1) {
    const p = goertzelPower(window, 48000, f);
    if (p > bestPower) { bestPower = p; bestFreq = f; }
  }
  const pitchShiftPct = ((bestFreq - opts.freq) / opts.freq) * 100;
  const pass = Math.abs(pitchShiftPct) < 0.5;   // 0.5 % tolerance
  const tag  = useResampler ? 'with resampler' : 'no resampler';
  console.log(`  capture rate=${contextRate} (${tag}): peak fundamental at ${bestFreq.toFixed(1)} Hz ` +
              `(shift ${pitchShiftPct >= 0 ? '+' : ''}${pitchShiftPct.toFixed(2)} %) ` +
              `=> ${pass ? 'PASS' : 'FAIL'}`);
  return { ok: pass, pitchShiftPct, bestFreq };
}

async function main() {
  const opts = parseArgs();
  console.log(`[browser-test] ${opts.freq} Hz sine, amp=${opts.amp}, ${opts.seconds}s` +
              ` | pass: SNR≥${opts.snrPass} dB, THD≤${(opts.thdPass * 100).toFixed(2)} %`);
  console.log('');

  const browser = await chromium.launch({ headless: !opts.headed });
  const ctx     = await browser.newContext();
  const page    = await ctx.newPage();
  page.on('console', (m) => { if (m.type() !== 'log') console.log(`  [browser ${m.type()}] ${m.text()}`); });

  const { server, url: pageUrl } = await serveTestPage();
  await page.goto(pageUrl);

  // Default: sweep representative AudioContext rates so a regression
  // shows which rate(s) it affects. v1.0.12's claim was that the
  // worklet path fixes the boundary discontinuity that the createBuffer
  // path produced specifically at non-48 kHz contexts, so 44100 is the
  // most diagnostic rate to test.
  const rates = opts.rate ? [opts.rate] : [48000, 44100];

  let allOk = true;
  console.log('── PLAYBACK PATH (PCM → worklet → speaker) ──');
  for (const r of rates) {
    const res = await runOneRate(page, opts, r);
    if (!res.ok) allOk = false;
  }
  console.log('');
  console.log('── CAPTURE PATH (mic → ScriptProcessor → wire) ──');
  // For capture, only non-48 k contexts are interesting (48 k is a no-op).
  for (const r of rates) {
    if (r === 48000) {
      const a = await runCaptureTest(page, opts, r, false);
      if (!a.ok) allOk = false;
    } else {
      // Show the bug (no resampler) AND the fix (with resampler).
      const a = await runCaptureTest(page, opts, r, false);
      const b = await runCaptureTest(page, opts, r, true);
      if (!b.ok) allOk = false;   // The fix must pass.
      if (a.ok && r !== 48000) {
        // Surprising — the bug should manifest at non-48 k. Note it.
        console.log(`    note: capture without resampler unexpectedly clean at ${r} Hz`);
      }
    }
  }

  await browser.close();
  server.close();
  console.log('');
  console.log(`[browser-test] ${allOk ? 'PASS' : 'FAIL'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('[browser-test] error:', e);
  process.exit(2);
});
