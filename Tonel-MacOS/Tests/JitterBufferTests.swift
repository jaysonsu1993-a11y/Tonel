import XCTest
@testable import TonelMacOS

/// Locks in the v5.1.3 JitterBuffer invariants. Each test pins a property
/// the user-reported 破音 fix relies on; if a future change breaks one,
/// `swift test` flags it before the build ships.
final class JitterBufferTests: XCTestCase {

    /// Sized to swallow the WSS-burst-style delivery the production
    /// server sees through Cloudflare. The previous value (8) was the
    /// v1.0.38-era cap that triggered the original 破音 under bursts.
    func testMaxDepthMatchesV4_3_7Cap() {
        XCTAssertEqual(JitterBuffer.maxDepth, 33,
            "maxDepth must match the web client's JITTER_MAX_DEPTH=33; bumping or shrinking is a release-gate decision (see CHANGELOG v4.3.7).")
    }

    /// PLC must mask isolated-packet network gaps with a decayed replay
    /// of the last real frame. Without this, every dropped packet is a
    /// hard silence-quantum = audible click.
    func testPlcReplaysLastFrameWithDecay() {
        let jb = JitterBuffer()
        let realFrame: [Float] = (0..<JitterBuffer.frameSamples).map { _ in 0.42 }
        jb.push(realFrame, sequence: 0)
        jb.push(realFrame, sequence: 1)
        // Pop the two real frames.
        guard case .real = jb.pop() else { XCTFail("first pop not real"); return }
        guard case .real = jb.pop() else { XCTFail("second pop not real"); return }
        // Now buffer is empty. The next 4 pops should be PLC with
        // decreasing decay; the 5th should be silence.
        let expectedDecays: [Float] = [1.0, 0.7, 0.4, 0.15]
        for (i, expected) in expectedDecays.enumerated() {
            switch jb.pop() {
            case .plc(let f, let decay):
                XCTAssertEqual(decay, expected, accuracy: 1e-6,
                    "PLC quantum #\(i) decay mismatch")
                XCTAssertEqual(f.first, 0.42,
                    "PLC quantum #\(i) frame content not the last real frame")
            default:
                XCTFail("PLC quantum #\(i) expected .plc")
            }
        }
        if case .silence = jb.pop() {
            // expected
        } else {
            XCTFail("after PLC budget, pop must return .silence")
        }
    }

    /// Single missed packet (one quantum gap, then immediate refill)
    /// must be transparently masked: one PLC quantum, then real audio
    /// resumes — no `primed=false` reset that forces a 2-frame silence.
    func testSinglePacketGapIsTransparent() {
        let jb = JitterBuffer()
        let frame: [Float] = (0..<JitterBuffer.frameSamples).map { _ in 0.1 }
        jb.push(frame, sequence: 0)
        jb.push(frame, sequence: 1)
        _ = jb.pop()    // real
        _ = jb.pop()    // real
        // Gap.
        if case .plc = jb.pop() { /* expected */ } else {
            XCTFail("first pop after empty must be .plc")
        }
        // Producer catches up — single fresh frame arrives.
        jb.push(frame, sequence: 2)
        // Pop must be .real, NOT another PLC and NOT silence. This is the
        // "no reprime after drain-to-empty" invariant.
        if case .real = jb.pop() {
            // expected
        } else {
            XCTFail("post-gap pop with fresh content must be .real")
        }
    }

    /// Dropping oldest at capacity must NOT crash and must not leak
    /// frames. Verifies the head-advance trim path.
    func testDropOldestOnOverflow() {
        let jb = JitterBuffer()
        let frame: [Float] = [1, 2, 3]
        for i in 0..<(JitterBuffer.maxDepth + 5) {
            jb.push(frame, sequence: UInt16(i))
        }
        XCTAssertEqual(jb.depth, JitterBuffer.maxDepth)
        XCTAssertGreaterThanOrEqual(jb.dropOldestCount, 5)
    }

    /// Sequence-gap detection counts non-consecutive arrivals. Useful
    /// for the e2e debug bar.
    func testSeqGapCount() {
        let jb = JitterBuffer()
        let frame: [Float] = [0]
        jb.push(frame, sequence: 0)
        jb.push(frame, sequence: 1)         // contiguous
        jb.push(frame, sequence: 5)         // gap
        jb.push(frame, sequence: 6)         // contiguous after gap
        XCTAssertEqual(jb.seqGapCount, 1)
    }
}
