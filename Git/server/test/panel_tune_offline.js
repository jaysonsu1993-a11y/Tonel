#!/usr/bin/env node
// Offline harness that runs the production playback worklet (extracted from
// audioService.ts) and simulates a user dragging the AudioDebugPanel sliders
// while a steady 1 kHz sine streams in. Measures:
//   - click_count   : large sample-to-sample jumps in the output (>0.10)
//   - reprime/plc   : worklet-reported events
//   - jump_total    : cumulative samples skipped by tune-trim
//   - autocorr_peak : peak autocorrelation at lag 128 (PLC-replay signature)
//   - SNR / THD     : Goertzel against the sent fundamental over clean window
//
// Usage:  node panel_tune_offline.js [scenario]
//   scenarios: baseline | drag_down | drag_round | tight_scale | grow_only

const fs = require('fs')
const path = require('path')

// ─── Extract worklet source from audioService.ts ──────────────────────────
const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'web', 'src', 'services', 'audioService.ts'),
  'utf8'
).split('\n')

// File has three worklet templates (monitor, playback, capture). Find the
// playback one by anchoring on registerProcessor('playback-processor', ...)
// and walking back to the matching `const code = \`` opener.
const playbackRegLine = SRC.findIndex(l =>
  l.includes("registerProcessor('playback-processor'"))
if (playbackRegLine < 0) throw new Error('playback registerProcessor line not found')
let endIdx = -1
for (let i = playbackRegLine + 1; i < SRC.length; i++) {
  if (SRC[i].match(/^\s*`\s*$/)) { endIdx = i; break }
}
if (endIdx < 0) throw new Error('playback worklet close backtick not found')
let startIdx = -1
for (let i = playbackRegLine - 1; i >= 0; i--) {
  if (SRC[i].match(/^\s*const code\s*=\s*`\s*$/)) { startIdx = i; break }
}
if (startIdx < 0) throw new Error('playback worklet const-code opener not found')
const TEMPLATE = SRC.slice(startIdx + 1, endIdx).join('\n')

// Substitute the four template variables. Values match audioService.ts.
const RING_SIZE = 48000
const WORKLET_SRC = TEMPLATE
  .replace(/\$\{RING_SIZE\}/g,   String(RING_SIZE))
  .replace(/\$\{PRIME_TARGET\}/g, '576')
  .replace(/\$\{PRIME_MIN\}/g,    '48')
  .replace(/\$\{MAX_SCALE\}/g,    '1.025')
  .replace(/\$\{MIN_SCALE\}/g,    '0.975')
  .replace(/\$\{RATE_STEP\}/g,    '0.00002')

// ─── Fake AudioWorkletProcessor harness ───────────────────────────────────
class FakePort {
  constructor() {
    this.onmessage = null
    this.outbox = { reprime: 0, plc: 0, lastStats: null }
  }
  postMessage(m) {
    if (m && m.type === 'reprime') this.outbox.reprime = m.count
    else if (m && m.type === 'plc') this.outbox.plc = m.count
    else if (m && m.type === 'stats') this.outbox.lastStats = m
  }
}

class AudioWorkletProcessor {
  constructor() { this.port = new FakePort() }
}

const SAMPLE_RATE = 48000
let registered = null
function registerProcessor(name, cls) { registered = cls }

// Eval the production worklet inside a scope where AudioWorkletProcessor and
// sampleRate exist. Wrap in (function(){ ... }) so `class` declarations are
// allowed without strict-mode global-leak issues.
// `eval` of a `class … extends AudioWorkletProcessor` binds AudioWorkletProcessor
// from its surrounding eval scope — so we use `new Function(...)` and pass the
// base class + sampleRate + registerProcessor explicitly. This avoids the
// global-vs-eval-scope class-binding wart.
try {
  const factory = new Function('AudioWorkletProcessor', 'sampleRate', 'registerProcessor',
    WORKLET_SRC)
  factory(AudioWorkletProcessor, SAMPLE_RATE, registerProcessor)
} catch (err) {
  console.error('worklet eval failed:', err)
  throw err
}
if (!registered) throw new Error('worklet did not registerProcessor')

// ─── Test driver ──────────────────────────────────────────────────────────
function makeSine(samples, freq, amp = 0.3, rate = SAMPLE_RATE) {
  const buf = new Float32Array(samples)
  for (let i = 0; i < samples; i++) buf[i] = amp * Math.sin(2 * Math.PI * freq * i / rate)
  return buf
}

const DEBUG = process.env.DBG === '1'
function runScenario({ name, durationSec = 5, freq = 1000, amp = 0.3, tuneSchedule = () => [] }) {
  // ratio = 48000 / sampleRate = 1.0; one output sample per input sample.
  const proc = new registered()
  if (DEBUG) {
    console.log('proc keys:', Object.keys(proc).slice(0, 30))
    console.log('proc.count =', proc.count, 'buf =', !!proc.buf, 'targetCount=', proc.targetCount)
  }
  const QUANTUM = 128
  const TICK_FRAME = 120          // server tick = 2.5 ms = 120 samples @ 48k
  const TICK_INTERVAL_OUT = 120   // produce one input frame every 120 output samples (since ratio=1, tick = 120 output samples = 2.5ms wall time)

  const totalOutSamples = Math.floor(durationSec * SAMPLE_RATE)
  const totalQuanta = Math.floor(totalOutSamples / QUANTUM)

  // Pre-generate the source signal. Phase-continuous across the whole run.
  const SRC_LEN = Math.ceil(totalOutSamples * 1.05) + 2 * RING_SIZE
  const source = makeSine(SRC_LEN, freq, amp)
  let srcCursor = 0

  const out = new Float32Array(totalQuanta * QUANTUM)
  let outWritePos = 0

  // For autocorrelation lag-128 detection.
  // We'll compute autocorr at the end on the full output.

  // Drive feed timer: emit a frame every 120 output-samples-elapsed (matches
  // server's 2.5 ms tick).
  let nextFeedAtSample = 0
  let jumpTotal = 0
  const tuneEvents = tuneSchedule(totalQuanta)
  // tuneEvents is an array of {atQuantum, msg}

  // Run.
  const inputs = []   // worklet ignores inputs[0], but signature requires.
  const outArr = [[new Float32Array(QUANTUM)]]

  for (let q = 0; q < totalQuanta; q++) {
    if (DEBUG && q < 20) {
      console.log(`q=${q} count=${proc.count} primed=${proc.primed} onmsg=${typeof proc.port.onmessage}`)
    }
    const elapsedSamples = q * QUANTUM
    // Feed input frames whose tick deadline has passed.
    while (nextFeedAtSample <= elapsedSamples) {
      const frame = source.subarray(srcCursor, srcCursor + TICK_FRAME)
      srcCursor += TICK_FRAME
      const f32 = new Float32Array(frame)
      proc.port.onmessage({ data: f32 })
      nextFeedAtSample += TICK_FRAME
    }
    // Apply any tune events scheduled for this quantum.
    while (tuneEvents.length && tuneEvents[0].atQuantum === q) {
      const ev = tuneEvents.shift()
      const before = proc.count
      proc.port.onmessage({ data: ev.msg })
      const after = proc.count
      if (before > after) jumpTotal += (before - after)
    }
    // Run process().
    outArr[0][0].fill(0)
    proc.process(inputs, outArr)
    out.set(outArr[0][0], outWritePos)
    outWritePos += QUANTUM
  }

  // ── Metrics ────────────────────────────────────────────────────────────
  // Click count: |s[i] - s[i-1]| > 0.10. For a 0.3-amp 1 kHz sine at 48k,
  // max derivative is ~0.3 * 2π * 1000 / 48000 ≈ 0.04 per sample. So 0.10
  // is a 2.5× over-threshold — clear discontinuity.
  let clicks = 0
  let maxJump = 0
  for (let i = 1; i < out.length; i++) {
    const d = Math.abs(out[i] - out[i-1])
    if (d > 0.10) clicks++
    if (d > maxJump) maxJump = d
  }
  // Autocorrelation at lag 128 — PLC replay signature. Compute on a 1 s
  // window starting at sample 48000 (after settling).
  function autocorr(buf, start, len, lag) {
    let num = 0, denom = 0
    for (let i = 0; i < len; i++) {
      const a = buf[start + i]
      const b = buf[start + i + lag]
      num   += a * b
      denom += a * a
    }
    return denom > 0 ? num / denom : 0
  }
  const winStart = 48000     // skip first second (settling)
  const winLen   = Math.min(96000, out.length - winStart - 256)
  const ac128 = winLen > 0 ? autocorr(out, winStart, winLen, 128) : 0
  // The expected autocorr-128 for pure 1 kHz sine = cos(2π·1000·128/48000)
  // = cos(2.6667π) ≈ -0.5. Anything noticeably above that suggests PLC
  // replay of stale 128-sample blocks.
  const expectedAc128 = Math.cos(2 * Math.PI * freq * 128 / SAMPLE_RATE)
  const acDelta = ac128 - expectedAc128

  // Goertzel SNR/THD on the same window.
  function goertzel(buf, start, len, freq, rate) {
    const k = (2 * Math.PI * freq) / rate
    const c = 2 * Math.cos(k)
    let s0 = 0, s1 = 0, s2 = 0
    for (let i = 0; i < len; i++) {
      s0 = buf[start + i] + c * s1 - s2
      s2 = s1
      s1 = s0
    }
    const real = s1 - s2 * Math.cos(k)
    const imag = s2 * Math.sin(k)
    const mag = Math.sqrt(real * real + imag * imag) / (len / 2)
    return mag
  }
  const fundMag = goertzel(out, winStart, winLen, freq, SAMPLE_RATE)
  let harmonicPower = 0
  for (let h = 2; h <= 19; h++) {
    const f = freq * h
    if (f > SAMPLE_RATE / 2) break
    const m = goertzel(out, winStart, winLen, f, SAMPLE_RATE)
    harmonicPower += m * m
  }
  const thd = fundMag > 0 ? Math.sqrt(harmonicPower) / fundMag : 1
  // Total RMS minus fund-power = noise+distortion power.
  let totalSq = 0
  for (let i = 0; i < winLen; i++) totalSq += out[winStart + i] * out[winStart + i]
  const totalP = totalSq / winLen
  const fundP  = (fundMag * fundMag) / 2
  const noiseP = Math.max(1e-30, totalP - fundP)
  const snrDb  = 10 * Math.log10(fundP / noiseP)

  console.log(
    `  ${name.padEnd(18)} | clicks=${String(clicks).padStart(5)} | maxJump=${maxJump.toFixed(3)} | ` +
    `reprime=${proc.port.outbox.reprime} | plc=${proc.port.outbox.plc} | jumpTot=${jumpTotal} | ` +
    `SNR=${snrDb.toFixed(1)}dB | THD=${(thd*100).toFixed(2)}% | ac128Δ=${acDelta.toFixed(3)}`
  )
  return { clicks, maxJump, reprime: proc.port.outbox.reprime, plc: proc.port.outbox.plc,
           jumpTotal, snrDb, thd, acDelta }
}

// ─── Tune-schedule generators ─────────────────────────────────────────────
// "User drags slider" — emit one tune message per quantum.
function dragSchedule({ field, fromValue, toValue, startQ, endQ, fixed = {} }) {
  return function (totalQuanta) {
    const evs = []
    const N = endQ - startQ
    for (let i = 0; i < N; i++) {
      const t = i / N
      const v = fromValue + (toValue - fromValue) * t
      const msg = { type: 'tune', primeTarget: 576, primeMin: 48,
                    maxScale: 1.025, minScale: 0.975, rateStep: 0.00002,
                    ...fixed, [field]: v }
      evs.push({ atQuantum: startQ + i, msg })
    }
    return evs
  }
}

// "User wiggles slider back and forth N times"
function wiggleSchedule({ field, lo, hi, startQ, endQ, cycles, fixed = {} }) {
  return function (totalQuanta) {
    const evs = []
    const N = endQ - startQ
    for (let i = 0; i < N; i++) {
      const phase = (i / N) * cycles * 2 * Math.PI
      const t = (Math.sin(phase) + 1) / 2     // 0..1
      const v = lo + (hi - lo) * t
      const msg = { type: 'tune', primeTarget: 576, primeMin: 48,
                    maxScale: 1.025, minScale: 0.975, rateStep: 0.00002,
                    ...fixed, [field]: v }
      evs.push({ atQuantum: startQ + i, msg })
    }
    return evs
  }
}

// ─── Run scenarios ─────────────────────────────────────────────────────────
console.log('\n=== panel_tune_offline — production worklet, 5 s 1 kHz @ 0.3 amp ===\n')

runScenario({ name: 'baseline_no_tune', durationSec: 5, tuneSchedule: () => [] })

// "Drag down" — primeTarget 1600 → 144 over 1 s, starting at t=2 s.
runScenario({
  name: 'drag_target_down',
  durationSec: 5,
  tuneSchedule: dragSchedule({
    field: 'primeTarget',
    fromValue: 1600, toValue: 144,
    startQ: Math.floor(2 * 48000 / 128),
    endQ:   Math.floor(3 * 48000 / 128),
  }),
})

// "Drag up" — primeTarget 144 → 1600 over 1 s.
runScenario({
  name: 'drag_target_up',
  durationSec: 5,
  tuneSchedule: dragSchedule({
    field: 'primeTarget',
    fromValue: 144, toValue: 1600,
    startQ: Math.floor(2 * 48000 / 128),
    endQ:   Math.floor(3 * 48000 / 128),
  }),
})

// "Wiggle" — back-and-forth 144↔1200 across 2 s, 5 round-trips.
runScenario({
  name: 'wiggle_target',
  durationSec: 5,
  tuneSchedule: wiggleSchedule({
    field: 'primeTarget', lo: 144, hi: 1200,
    startQ: Math.floor(1.5 * 48000 / 128),
    endQ:   Math.floor(3.5 * 48000 / 128),
    cycles: 5,
  }),
})

// "Tighten scale" — slow drag of maxScale to ~rail (1.0001) and minScale up
// to 0.9999. Tests rate-controller saturation hypothesis from earlier.
runScenario({
  name: 'tighten_scale',
  durationSec: 5,
  tuneSchedule: function (totalQuanta) {
    const evs = []
    const startQ = Math.floor(1 * 48000 / 128)
    const endQ   = Math.floor(2 * 48000 / 128)
    const N = endQ - startQ
    for (let i = 0; i < N; i++) {
      const t = i / N
      const maxS = 1.025 - (1.025 - 1.0001) * t
      const minS = 0.975 + (0.9999 - 0.975) * t
      evs.push({ atQuantum: startQ + i,
                 msg: { type: 'tune', primeTarget: 576, primeMin: 48,
                        maxScale: maxS, minScale: minS, rateStep: 0.00002 } })
    }
    return evs
  },
})

// "Realistic wiggle" — primeTarget jiggles 400↔800 (both well above
// primeMin+128 invariant), 5 round-trips over 2 s.
runScenario({
  name: 'wiggle_realistic',
  durationSec: 5,
  tuneSchedule: wiggleSchedule({
    field: 'primeTarget', lo: 400, hi: 800,
    startQ: Math.floor(1.5 * 48000 / 128),
    endQ:   Math.floor(3.5 * 48000 / 128),
    cycles: 5,
  }),
})

// "Mild drag down" — 1000 → 400 (still > primeMin+128).
runScenario({
  name: 'drag_down_mild',
  durationSec: 5,
  tuneSchedule: dragSchedule({
    field: 'primeTarget',
    fromValue: 1000, toValue: 400,
    startQ: Math.floor(2 * 48000 / 128),
    endQ:   Math.floor(3 * 48000 / 128),
  }),
})

// "Drag jitterMaxDepth field" — same primeTarget, but tunes with a
// jitterMaxDepth value (which the worklet ignores). Tests whether ANY
// tune message has side-effects beyond the field changed.
runScenario({
  name: 'drag_unrelated',
  durationSec: 5,
  tuneSchedule: dragSchedule({
    field: 'primeTarget',     // pretend, but value is constant
    fromValue: 576, toValue: 576,
    startQ: Math.floor(2 * 48000 / 128),
    endQ:   Math.floor(3 * 48000 / 128),
  }),
})

// "Spam tune" — every quantum, send the SAME tune message (no-change drag).
// Should be a no-op — measures whether per-message overhead alone breaks
// audio.
runScenario({
  name: 'spam_no_change',
  durationSec: 5,
  tuneSchedule: function (totalQuanta) {
    const evs = []
    const startQ = Math.floor(1 * 48000 / 128)
    const endQ   = Math.floor(4 * 48000 / 128)
    for (let q = startQ; q < endQ; q++) {
      evs.push({ atQuantum: q,
                 msg: { type: 'tune', primeTarget: 576, primeMin: 48,
                        maxScale: 1.025, minScale: 0.975, rateStep: 0.00002 } })
    }
    return evs
  },
})

console.log()
