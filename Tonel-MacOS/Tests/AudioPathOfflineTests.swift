import XCTest
@testable import TonelMacOS

/// Offline harness for the macOS-client audio path.
///
/// Runs the production `JitterBuffer` (and a faithful reproduction of
/// `AudioEngine.fillPlayback`'s alone-branch) against scripted packet
/// arrival schedules — burst, jitter, clock drift — and measures the
/// playback output for the metrics that matter:
///   * `clicks`      — sample-to-sample jumps over the click threshold
///   * `maxJump`     — biggest discontinuity seen
///   * `silenceQuanta` — number of 120-sample blocks emitted as silence
///   * `plcEvents`   — successful PLC concealments (good)
///   * `dropOldest`  — frames dropped by the maxDepth safety cap (BAD)
///   * `trimEvents`  — target-trim fires (acceptable; concentrates clicks)
///   * `finalDepth`  — buffer depth at the end of the run
///
/// **Why this matters:** the user's real-app log showed `drop=908` in
/// the first second of room-join. Each `drop` is an audible click. We
/// can't reproduce that bug live without going through Network.framework
/// + actual server, but we CAN reproduce the **packet arrival pattern**
/// — burst followed by steady — and verify the JitterBuffer handles it
/// without dropping.
///
/// Replaces "user joins room, listens, reports 破音" with deterministic
/// numbers an automated CI could catch.
final class AudioPathOfflineTests: XCTestCase {

    // MARK: - End-to-end audio quality (algorithm-only, no network)

    /// Pushes a known sine through the full client-side DSP chain:
    ///   PCM16.encode (mac side) → PCM16.decode (round-trip simulation)
    ///   → JitterBuffer push → JitterBuffer pop → output soft-clip stage
    /// and measures SNR + THD on the recovered signal.
    ///
    /// Target: SNR ≥ 60 dB, THD ≤ 0.1 % at amp 0.3 (normal voice peak).
    /// Higher amps will engage soft-clip (knee 0.95) and add expected
    /// THD; we test 0.3 specifically because that's where there should
    /// be NO algorithm-induced distortion.
    ///
    /// Why this matters: the user reported volume-correlated distortion
    /// during voice but clean silence. With logged peaks well below the
    /// soft-clip knee (0.95), no clipping should engage. If this test
    /// shows SNR drop, the algorithm itself is introducing noise — and
    /// we can bisect which stage by toggling them off.
    func testEndToEndCleanSignal_amp03() {
        let result = roundTripSine(amp: 0.3, durSec: 1.0)
        XCTAssertGreaterThanOrEqual(result.snrDb, 60,
            "End-to-end SNR \(result.snrDb) dB below the 60 dB clean-path floor")
        XCTAssertLessThanOrEqual(result.thdPct, 0.1,
            "End-to-end THD \(result.thdPct) % above the 0.1 % clean-path ceiling")
    }

    /// Same chain, low amplitude (-40 dBFS, quiet voice). Quantization
    /// noise is at its worst here relative to signal; if 16-bit PCM is
    /// causing audible noise, this catches it.
    func testEndToEndCleanSignal_lowAmp() {
        let result = roundTripSine(amp: 0.01, durSec: 1.0)
        XCTAssertGreaterThanOrEqual(result.snrDb, 50,
            "Low-amp SNR \(result.snrDb) dB — quantization noise audible?")
    }

    /// Loud voice peak (-3 dBFS, near soft-clip knee). Soft-clip should
    /// barely engage; THD should still be sub-1%.
    func testEndToEndCleanSignal_highAmp() {
        let result = roundTripSine(amp: 0.7, durSec: 1.0)
        XCTAssertGreaterThanOrEqual(result.snrDb, 55,
            "High-amp SNR \(result.snrDb) dB unexpectedly low")
        XCTAssertLessThanOrEqual(result.thdPct, 0.5,
            "High-amp THD \(result.thdPct) % > 0.5% — saturation kicking in too early")
    }

    /// Past soft-clip knee. Expected to engage tanh saturation; THD
    /// rises but should stay below ~5 %. This is the target zone for
    /// soft-clip's transparency claim.
    func testEndToEndAtSoftClipKnee() {
        let result = roundTripSine(amp: 0.95, durSec: 1.0)
        // Soft-clip kicks in here; some THD expected. But it should
        // still be musical — server's own benchmark target was THD ≤ 5%.
        XCTAssertLessThanOrEqual(result.thdPct, 5.0,
            "At-knee THD \(result.thdPct) % > 5% — soft-clip too harsh")
    }

    /// Drive past 1.0 (overdrive). Soft-clip catches the overshoot;
    /// output should still avoid hard square-wave artifacts.
    func testEndToEndOverdrive() {
        let result = roundTripSine(amp: 1.5, durSec: 1.0)
        XCTAssertLessThan(result.thdPct, 30.0,
            "Overdrive THD \(result.thdPct) % — soft-clip becoming a brick wall")
    }

    // MARK: - Test scenarios

    /// Reproduces the user's room-join symptom: 370 ms worth of packets
    /// queued in the OS UDP buffer arrives in one burst, THEN the
    /// steady-state 400 fps stream begins. With the v0.1.7 target-trim,
    /// the burst should produce ONE trim event (one click) instead of
    /// 100+ drop_oldest events.
    func testRoomJoinBurst() {
        let r = runScenario(
            name: "room-join burst",
            scenario: .burstThenSteady(burstFrames: 150, steadyDurSec: 1.0)
        )
        // Expectation: trimMargin = maxDepth - target - 1 means trim
        // only fires when buffer would otherwise overflow. For a
        // 150-frame burst with target=2 and maxDepth=33, expect ~5
        // trim cycles (150 / 31 = 4.8). Legacy code (drop_oldest at
        // cap, no target-trim) would have produced 117 audible
        // `drop_oldest` events here; we're trading 23× fewer audible
        // discontinuities for one bigger sample-skip per event.
        XCTAssertLessThanOrEqual(r.trimEvents, 6,
            "burst should produce at most ~5 trim events; got \(r.trimEvents)")
        XCTAssertEqual(r.dropOldest, 0,
            "drop_oldest fallback should never engage; got \(r.dropOldest)")
        // After the burst, steady-state should see no further trims —
        // production fps == consumption fps with no drift in this
        // scenario.
        XCTAssertLessThan(r.finalDepth, JitterBuffer.targetDepth + JitterBuffer.trimMargin)
    }

    /// Steady producer at 400 fps, consumer at 401 fps (consumer faster
    /// — buffer drains, eventually underruns and PLC fires). Verifies
    /// PLC kicks in cleanly and silence is rare.
    func testConsumerFaster() {
        let r = runScenario(
            name: "consumer faster (400 vs 401 fps)",
            scenario: .steadyDrift(producerFps: 400, consumerFps: 401, durSec: 5)
        )
        // Buffer should drain occasionally; PLC should mask the gaps.
        // Silence quanta should be rare (only when PLC budget exhausts).
        XCTAssertLessThan(r.silenceQuanta, 100,
            "too much silence under mild underrun (\(r.silenceQuanta) quanta)")
    }

    /// Producer slightly faster than consumer (server NTP-drift case
    /// the user's logs revealed). Without target-trim, buffer fills to
    /// cap and drops continuously. With target-trim, single sparse
    /// trim events.
    func testProducerFaster() {
        let r = runScenario(
            name: "producer faster (401 vs 400 fps) — clock drift",
            scenario: .steadyDrift(producerFps: 401, consumerFps: 400, durSec: 5)
        )
        // 1 fps drift × 5 s = 5 extra frames over the run. With
        // target-trim catching things at target+margin=6, expect ~1
        // trim total. Definitely much less than the ~5 drop_oldest
        // events the legacy code would produce.
        XCTAssertLessThan(r.trimEvents, 3,
            "drift should produce at most a couple trims; got \(r.trimEvents)")
        XCTAssertEqual(r.dropOldest, 0,
            "drop_oldest should not engage under mild drift")
        XCTAssertLessThan(r.finalDepth, JitterBuffer.targetDepth + JitterBuffer.trimMargin)
    }

    /// No bursts, no drift — pure clean stream. Should emit ZERO
    /// trim/drop/silence events.
    func testCleanStream() {
        let r = runScenario(
            name: "clean stream (no burst, no drift)",
            scenario: .steadyDrift(producerFps: 400, consumerFps: 400, durSec: 2)
        )
        XCTAssertEqual(r.trimEvents, 0, "clean stream should not trim")
        XCTAssertEqual(r.dropOldest, 0, "clean stream should not drop")
        // ≤1 silence/PLC quantum is the cold-start case (consumer pops
        // once before the first push lands). Acceptable; produces one
        // sub-perceptual silence frame.
        XCTAssertLessThanOrEqual(r.silenceQuanta, 1, "clean stream silence \(r.silenceQuanta) > 1")
        XCTAssertLessThanOrEqual(r.plcEvents,     1, "clean stream PLC \(r.plcEvents) > 1")
    }

    /// Packet jitter (frames arriving at irregular times) — common on
    /// Wi-Fi / cellular. PLC should mask the brief gaps.
    func testWifiJitter() {
        let r = runScenario(
            name: "wifi jitter (±5 ms)",
            scenario: .jitter(producerFps: 400, jitterMs: 5, durSec: 3)
        )
        // PLC should fire occasionally to mask gaps; silence
        // (PLC-budget-exhausted) should be very rare.
        XCTAssertLessThan(r.silenceQuanta, 20,
            "wifi jitter shouldn't produce sustained outage")
    }

    // MARK: - End-to-end measurement helper

    private struct SnrResult {
        let snrDb: Double
        let thdPct: Double
        let recoveredAmp: Double
    }

    /// Pushes a 1 kHz sine of the requested amplitude through every
    /// algorithmic stage that's *not* the network: PCM16 encode (which
    /// includes our soft-clip on input), PCM16 decode (mirrors the
    /// server roundtrip from the receiver's POV), JitterBuffer push,
    /// JitterBuffer pop, and the output soft-clip stage. Discards
    /// transient frames (first 200 ms) before measuring SNR/THD via
    /// Goertzel against the 1 kHz fundamental + 19 harmonics.
    ///
    /// This is the bench-quality measurement that proves the algorithm
    /// is or isn't introducing distortion at a given amplitude. Pairs
    /// with the user's "volume-correlated distortion" report — if the
    /// numbers come back clean here but the user still hears
    /// distortion, the bug is somewhere outside this DSP chain
    /// (network, server, output device, mic hardware).
    private func roundTripSine(amp: Float, durSec: Double) -> SnrResult {
        let sampleRate = 48000.0
        let freq       = 1000.0
        let totalSamples = Int(durSec * sampleRate)
        let frameSize  = JitterBuffer.frameSamples   // 120

        // 1) Generate the test signal as a sequence of 120-sample frames.
        var frames: [[Float]] = []
        frames.reserveCapacity(totalSamples / frameSize)
        for f in 0..<(totalSamples / frameSize) {
            var fr = [Float](repeating: 0, count: frameSize)
            for i in 0..<frameSize {
                let phase = 2 * Float.pi * Float(freq) * Float(f * frameSize + i) / Float(sampleRate)
                fr[i] = amp * sin(phase)
            }
            frames.append(fr)
        }

        // 2) For each frame: encode (mac soft-clip + Int16) → simulate
        //    server-side full mix in solo (= identity since we're the
        //    only "user", but go through float_to_pcm16 round-trip
        //    server-side too, modeled by a second encode/decode cycle
        //    using a near-identical clamping helper) → decode.
        let jb = JitterBuffer()
        var recovered: [Float] = []
        recovered.reserveCapacity(totalSamples)
        for (i, fr) in frames.enumerated() {
            // Mac-side encode (soft-clip + PCM16).
            let pcm = PCM16.encode(fr)
            // Simulate server: decode, identity mix (we are the only
            // user in solo), server soft-clip (knee 0.95, matching
            // audio_mixer.h::softClipBuffer), then encode again. This
            // is what the wire-arriving payload looks like to the
            // playback path.
            var serverFloat = PCM16.decode(pcm)
            for j in 0..<serverFloat.count {
                let v = serverFloat[j]
                if v > 0.95       { serverFloat[j] = 0.95 + 0.05 * tanh((v - 0.95) / 0.05) }
                else if v < -0.95 { serverFloat[j] = -0.95 + 0.05 * tanh((v + 0.95) / 0.05) }
            }
            // v0.1.8: server float_to_pcm16 now ALSO does soft-clip before
            // the final safety clamp, matching the production C++ path.
            let serverPcm = serverFloat.withUnsafeBufferPointer { _ -> Data in
                var d = Data(count: serverFloat.count * 2)
                d.withUnsafeMutableBytes { raw in
                    let p = raw.baseAddress!.assumingMemoryBound(to: Int16.self)
                    for k in 0..<serverFloat.count {
                        var v = serverFloat[k]
                        let kKnee: Float = 0.95
                        let kRoom: Float = 0.05
                        if v > kKnee  { v = kKnee + kRoom * tanh((v - kKnee) / kRoom) }
                        else if v < -kKnee { v = -kKnee + kRoom * tanh((v + kKnee) / kRoom) }
                        v = max(-1.0, min(1.0, v))
                        p[k] = Int16(v * 32767).littleEndian
                    }
                }
                return d
            }
            // Push into JitterBuffer.
            let decoded = PCM16.decode(serverPcm)
            jb.push(decoded, sequence: UInt16(truncatingIfNeeded: i))
            // Pop one frame and apply the output soft-clip (matching
            // fillPlayback's final stage).
            switch jb.pop() {
            case .real(let f):
                for var sample in f {
                    if sample > 0.95       { sample = 0.95 + 0.05 * tanh((sample - 0.95) / 0.05) }
                    else if sample < -0.95 { sample = -0.95 + 0.05 * tanh((sample + 0.95) / 0.05) }
                    if sample >  1.0 { sample =  1.0 }
                    if sample < -1.0 { sample = -1.0 }
                    recovered.append(sample)
                }
            case .plc, .silence:
                // Algorithm-only test should not engage PLC/silence.
                // Append zeros for the missing frame to keep length
                // aligned; the analysis will see the "hole" as noise.
                recovered.append(contentsOf: [Float](repeating: 0, count: frameSize))
            }
        }

        // 3) Discard 200 ms of transient (jitter buffer prime, encode
        //    boundary effects).
        let skipSamples = Int(0.2 * sampleRate)
        let analysis = Array(recovered.dropFirst(skipSamples))

        // 4) Goertzel: compute fundamental + 19 harmonics.
        let fundMag    = goertzel(analysis, freq: freq, sampleRate: sampleRate)
        var thdPower: Double = 0
        for h in 2...20 {
            let f = freq * Double(h)
            if f >= sampleRate / 2 { break }
            let mag = goertzel(analysis, freq: f, sampleRate: sampleRate)
            thdPower += mag * mag
        }
        let thd = fundMag > 0 ? sqrt(thdPower) / fundMag * 100 : 100
        // SNR: total RMS minus fund-power → noise+distortion power.
        var totalSq = 0.0
        for s in analysis { totalSq += Double(s) * Double(s) }
        let totalP = totalSq / Double(analysis.count)
        let fundP  = (fundMag * fundMag) / 2
        let noiseP = max(1e-30, totalP - fundP)
        let snr    = 10 * log10(fundP / noiseP)

        let res = SnrResult(snrDb: snr, thdPct: thd, recoveredAmp: fundMag)
        print(String(format: "[end-to-end amp=%.3f] recoveredAmp=%.3f SNR=%.1f dB THD=%.3f %%",
                     amp, fundMag, snr, thd))
        return res
    }

    private func goertzel(_ buf: [Float], freq: Double, sampleRate: Double) -> Double {
        let k = 2 * Double.pi * freq / sampleRate
        let c = 2 * cos(k)
        var s0 = 0.0, s1 = 0.0, s2 = 0.0
        for sample in buf {
            s0 = Double(sample) + c * s1 - s2
            s2 = s1; s1 = s0
        }
        let real = s1 - s2 * cos(k)
        let imag = s2 * sin(k)
        return sqrt(real * real + imag * imag) / Double(buf.count / 2)
    }

    // MARK: - Harness

    private struct ScenarioResult {
        var clicks: Int          = 0
        var maxJump: Float       = 0
        var silenceQuanta: Int   = 0
        var plcEvents: Int       = 0
        var dropOldest: Int      = 0
        var trimEvents: Int      = 0
        var finalDepth: Int      = 0
    }

    private enum Scenario {
        /// `burstFrames` arrive in one shot at t=0; then steady 400 fps.
        case burstThenSteady(burstFrames: Int, steadyDurSec: Double)
        /// Producer + consumer at fixed (different) rates.
        case steadyDrift(producerFps: Double, consumerFps: Double, durSec: Double)
        /// Producer at fixed rate, ±jitterMs randomization on each push.
        case jitter(producerFps: Double, jitterMs: Double, durSec: Double)
    }

    /// Generates a 1 kHz sine at 0.3 amplitude. Matches the web
    /// `panel_tune_offline.js` test signal so cross-layer regressions
    /// reuse the same waveform.
    private func sineFrame(startSample: Int) -> [Float] {
        let n = JitterBuffer.frameSamples
        let freq: Float = 1000
        let rate: Float = 48000
        let amp: Float  = 0.3
        var f = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let phase = 2 * Float.pi * freq * Float(startSample + i) / rate
            f[i] = amp * sin(phase)
        }
        return f
    }

    private func runScenario(name: String, scenario: Scenario) -> ScenarioResult {
        let jb = JitterBuffer()
        var pushSeq: UInt16 = 0
        var nextProducerSampleIdx = 0
        var rng = SystemRandomNumberGenerator()

        // Schedule producer pushes. Each entry is `time_in_seconds`
        // when that push happens.
        var pushTimes: [Double] = []
        let consumerFps: Double
        let durSec: Double

        switch scenario {
        case .burstThenSteady(let burst, let steadyDur):
            for _ in 0..<burst { pushTimes.append(0) }
            let steadyCount = Int(steadyDur * 400)
            for i in 0..<steadyCount {
                pushTimes.append(Double(i) / 400.0)
            }
            consumerFps = 400
            durSec = steadyDur

        case .steadyDrift(let pFps, let cFps, let dur):
            let count = Int(pFps * dur)
            for i in 0..<count { pushTimes.append(Double(i) / pFps) }
            consumerFps = cFps
            durSec = dur

        case .jitter(let pFps, let jitMs, let dur):
            let count = Int(pFps * dur)
            for i in 0..<count {
                let nominal = Double(i) / pFps
                let noise = (Double(UInt16.random(in: 0...UInt16.max, using: &rng)) /
                             Double(UInt16.max) * 2 - 1) * (jitMs / 1000)
                pushTimes.append(max(0, nominal + noise))
            }
            pushTimes.sort()
            consumerFps = pFps
            durSec = dur
        }

        // Run the simulation. Time advances in 2.5 ms quanta (one
        // wire-frame's worth of consumer ticks). Each quantum: any
        // pushes whose time has passed get pushed; then consumer pops.
        let consumerInterval = 1.0 / consumerFps
        var t = 0.0
        var pushIdx = 0
        var output: [Float] = []
        var lastSample: Float = 0

        while t < durSec {
            // Drain any due pushes.
            while pushIdx < pushTimes.count && pushTimes[pushIdx] <= t {
                let f = sineFrame(startSample: nextProducerSampleIdx)
                nextProducerSampleIdx += JitterBuffer.frameSamples
                jb.push(f, sequence: pushSeq)
                pushSeq &+= 1
                pushIdx += 1
            }

            // Consumer pop.
            switch jb.pop() {
            case .real(let f):
                for s in f {
                    if abs(s - lastSample) > 0.10 {
                        // Click — count it.
                    }
                    lastSample = s
                }
                output.append(contentsOf: f)
            case .plc(let f, let decay):
                for s in f {
                    let scaled = s * decay
                    lastSample = scaled
                    output.append(scaled)
                }
            case .silence:
                output.append(contentsOf: [Float](repeating: 0, count: JitterBuffer.frameSamples))
                lastSample = 0
            }

            t += consumerInterval
        }

        // Compute click metrics over the assembled output.
        var clicks = 0
        var maxJump: Float = 0
        var silenceQuanta = 0
        for i in stride(from: 0, to: output.count, by: JitterBuffer.frameSamples) {
            let end = min(i + JitterBuffer.frameSamples, output.count)
            var blockMax: Float = 0
            for j in i..<end { if abs(output[j]) > blockMax { blockMax = abs(output[j]) } }
            if blockMax < 1e-6 { silenceQuanta += 1 }
        }
        for i in 1..<output.count {
            let d = abs(output[i] - output[i-1])
            if d > maxJump { maxJump = d }
            if d > 0.10 { clicks += 1 }
        }

        // Categorize result: silence-quanta from PLC budget exhausting
        // counts; PLC events that successfully masked gaps don't.
        let plcSuccess = jb.plcCount   // lifetime PLC starts (one per primed→empty transition)
        let r = ScenarioResult(
            clicks:        clicks,
            maxJump:       maxJump,
            silenceQuanta: silenceQuanta,
            plcEvents:     plcSuccess,
            dropOldest:    jb.dropOldestCount,
            trimEvents:    jb.trimCount,
            finalDepth:    jb.depth
        )
        print("""
            [\(name)] clicks=\(r.clicks) maxJump=\(String(format: "%.3f", r.maxJump)) \
            silence=\(r.silenceQuanta) plc=\(r.plcEvents) drop=\(r.dropOldest) \
            trim=\(r.trimEvents) finalDepth=\(r.finalDepth)
            """)
        return r
    }
}
