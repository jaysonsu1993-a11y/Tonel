import Foundation
import os.lock

/// Per-peer jitter buffer holding decoded float frames (120 samples each).
///
/// **Realtime-safety contract:** `pop()` is called from the Core Audio IO
/// thread. It must not allocate, must not block waiting on memory, and must
/// not call into Swift runtime methods that lock-internally (e.g.
/// `Array.removeFirst()` shifts and may reallocate). This rewrite hits that
/// contract via:
///   - Fixed-size pre-allocated `[[Float]]` of length `maxDepth`. Frames are
///     in place; head/tail are integer indices.
///   - `os_unfair_lock` instead of `NSLock`. The critical sections here
///     (push: copy `[Float]` reference + bump tail; pop: copy out + bump
///     head) are sub-microsecond uncontended, and `os_unfair_lock` is
///     significantly cheaper than `pthread_mutex` in that case. Real
///     RT-perfect would be lock-free, but Swift's atomics story is rough
///     and the contention pattern here (one writer, one reader) makes the
///     unfair lock essentially free.
///   - `pop()` returns a discriminated `PopResult` rather than `Optional`.
///     When the buffer is empty we don't dump silence — we hand back the
///     last real frame with a decay envelope (PLC), matching the web
///     client's `lastBlock` replay budget. Listener hears a soft tail
///     instead of a click.
///
/// **Capacity:** `maxDepth = 33` matches the web client's `JITTER_MAX_DEPTH`
/// after the v4.3.7 raise (was 8 in v1.0.38; `8` was actively dropping
/// frames under WSS-burst-style delivery, which is what reintroduced the
/// 破音 the user reported on macOS). At 2.5 ms/frame this is ~82.5 ms of
/// burst headroom — the server occasionally batches 8+ frames at a time
/// when running through Cloudflare WSS, and an 8-deep queue dumps the
/// oldest = an audible click. 33 absorbs the burst silently.
///
/// **PLC budget:** mirrors web `concealDecay = [1.0, 0.7, 0.4, 0.15]`. After
/// 4 consecutive empty pops the listener hears silence (the network
/// outage is real; PLC alone will sound stuttery beyond 4×).
final class JitterBuffer {
    static let maxDepth      = 33    // matches web v4.3.7+ JITTER_MAX_DEPTH
    static let primeMin      = 2     // start drain after this many frames
    static let frameSamples  = 120   // SPA1 wire frame size (informational)
    /// Decay envelope for consecutive PLC quanta. Matches web
    /// `concealDecay`. After this many in a row we emit silence.
    static let concealDecay: [Float] = [1.0, 0.7, 0.4, 0.15]

    enum PopResult {
        case real([Float])              // fresh frame from the ring
        case plc([Float], Float)        // last real frame, with decay multiplier
        case silence                    // PLC budget exhausted (real network outage)
    }

    // ── State ──────────────────────────────────────────────────────────────

    /// Pre-allocated slot array — slots beyond `count` are unused but the
    /// storage is fixed. Avoids the `removeFirst → shift` pattern and any
    /// allocation in `pop()`.
    private var ring: [[Float]] = Array(repeating: [], count: maxDepth)
    private var head: Int = 0           // next slot to pop from
    private var tail: Int = 0           // next slot to push into
    private var count: Int = 0
    private var primed: Bool = false
    /// Last successfully-popped real frame. Reused for PLC. Pre-sized to
    /// `frameSamples` so `pop` doesn't allocate on the PLC branch.
    private var lastFrame: [Float] = Array(repeating: 0, count: frameSamples)
    private var concealQuanta: Int = 0   // consecutive PLC count

    private(set) var lastSeq: UInt16? = nil
    private(set) var dropOldestCount = 0
    private(set) var seqGapCount = 0
    private(set) var plcCount = 0        // lifetime PLC events (one per "primed → empty" transition)

    // os_unfair_lock cannot be a stored Swift property directly with
    // value semantics — we hold a heap-allocated cell so &lock yields
    // a stable pointer across method calls. This is the standard
    // Swift idiom for unfair locks.
    private let lockPtr: UnsafeMutablePointer<os_unfair_lock>
    init() {
        lockPtr = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        lockPtr.initialize(to: os_unfair_lock())
    }
    deinit {
        lockPtr.deinitialize(count: 1)
        lockPtr.deallocate()
    }

    @inline(__always) private func lock()   { os_unfair_lock_lock(lockPtr) }
    @inline(__always) private func unlock() { os_unfair_lock_unlock(lockPtr) }

    // ── Push (network thread) ──────────────────────────────────────────────

    /// Push one decoded frame. If the ring is at capacity we drop the
    /// oldest (advance head) — the same trade the web/server jitter
    /// buffers make when their cap is hit. With `maxDepth = 33` this is
    /// essentially never reached in normal operation.
    func push(_ frame: [Float], sequence: UInt16) {
        lock(); defer { unlock() }
        if let prev = lastSeq {
            let expected = prev &+ 1
            if sequence != expected { seqGapCount += 1 }
        }
        lastSeq = sequence

        if count >= Self.maxDepth {
            // Drop oldest: advance head, slot at the old head is going to
            // be overwritten via tail in a moment.
            head = (head + 1) % Self.maxDepth
            count -= 1
            dropOldestCount += 1
        }
        ring[tail] = frame
        tail = (tail + 1) % Self.maxDepth
        count += 1
        if count >= Self.primeMin { primed = true }
    }

    // ── Pop (RT thread) ────────────────────────────────────────────────────

    /// Pop one frame for playback. Returns `.real` when there's network
    /// content available, `.plc` when masking a brief gap with the last
    /// real frame at decay, or `.silence` when the gap exceeded the PLC
    /// budget (caller should emit silence for this peer).
    ///
    /// **RT-thread safe:** no allocation, no blocking, sub-microsecond
    /// uncontended lock window. The `[Float]` returned in `.real` /
    /// `.plc` is the same heap buffer that was pushed in (no copy);
    /// the caller reads it under the assumption that the producer
    /// won't overwrite that slot for `maxDepth - count` more frames'
    /// worth of pushes — at 2.5 ms/frame and depth 33, that's ~80 ms,
    /// vastly more than a single Core Audio IO buffer pass.
    func pop() -> PopResult {
        lock()
        if !primed || count == 0 {
            // Underrun. PLC if we have history AND budget, else silence.
            if !lastFrame.isEmpty && concealQuanta < Self.concealDecay.count {
                let decay = Self.concealDecay[concealQuanta]
                concealQuanta += 1
                if concealQuanta == 1 { plcCount += 1 }
                let frame = lastFrame
                unlock()
                return .plc(frame, decay)
            }
            unlock()
            return .silence
        }
        // Real frame available.
        let frame = ring[head]
        ring[head] = []                                  // release reference
        head = (head + 1) % Self.maxDepth
        count -= 1
        // Don't reset `primed` on drain-to-empty — re-prime would force a
        // 2-frame wait on the next refill, which is ~5 ms of forced
        // silence after every transient gap. Keeping primed=true means a
        // single missed packet is masked by PLC (one decayed frame, then
        // back to real) instead of becoming silence + reprime. The
        // primed=false path is reserved for cold-start.
        concealQuanta = 0
        // Cache for future PLC. Copy semantics (the slot just released
        // its reference) so the producer can't mutate underneath us.
        lastFrame = frame
        unlock()
        return .real(frame)
    }

    // ── Diagnostics ────────────────────────────────────────────────────────

    var depth: Int {
        lock(); defer { unlock() }
        return count
    }
}
