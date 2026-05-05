import Foundation

/// Per-peer jitter buffer holding decoded float frames (120 samples each).
///
/// Mirrors web client's behaviour: depth-capped FIFO with `JITTER_MAX_DEPTH=8`
/// (≈20 ms) — the cap that fixed the v1.0.38 burst breakup. We drop oldest
/// when full so a single TCP/UDP burst can't permanently inflate latency.
///
/// Prime target = enqueue this many frames before draining begins. Mirrors
/// web `primeTarget` minimum from the v4.3.8 panel-drag invariant.
final class JitterBuffer {
    static let maxDepth   = 8     // hard cap
    /// Cold-start prime threshold (frames). `static var` so the
    /// AudioDebugSheet sliders can tune it live across all per-peer
    /// buffers without recreating them.
    static var primeMin   = 2     // start drain after this many frames

    private let lock = NSLock()
    private var frames: [[Float]] = []
    private var primed = false
    private(set) var lastSeq: UInt16? = nil
    private(set) var dropOldestCount = 0
    private(set) var seqGapCount = 0

    func push(_ frame: [Float], sequence: UInt16) {
        lock.lock(); defer { lock.unlock() }
        if let prev = lastSeq {
            let expected = prev &+ 1
            if sequence != expected { seqGapCount += 1 }
        }
        lastSeq = sequence
        if frames.count >= Self.maxDepth {
            frames.removeFirst()
            dropOldestCount += 1
        }
        frames.append(frame)
        if frames.count >= Self.primeMin { primed = true }
    }

    /// Pop one frame, or nil if not yet primed / empty. The caller is the
    /// realtime audio thread, which should fall back to silence on nil.
    func pop() -> [Float]? {
        lock.lock(); defer { lock.unlock() }
        guard primed, !frames.isEmpty else { return nil }
        let f = frames.removeFirst()
        if frames.isEmpty { primed = false }   // re-prime after underrun
        return f
    }

    var depth: Int {
        lock.lock(); defer { lock.unlock() }
        return frames.count
    }
}
