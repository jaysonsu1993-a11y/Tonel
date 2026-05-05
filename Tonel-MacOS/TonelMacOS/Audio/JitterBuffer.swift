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
    static let maxDepth      = 33    // absolute cap (~82.5 ms) — disaster ceiling
    /// Cold-start prime threshold (frames). `static var` so the
    /// AudioDebugSheet sliders tune it live across all per-peer
    /// buffers without recreating them.
    static var primeMin      = 2     // start drain after this many frames
    static let frameSamples  = 120   // SPA1 wire frame size (informational)
    /// v0.1.7: target steady-state depth. When a push lands the buffer
    /// above `targetDepth + trimMargin`, we trim **down to targetDepth
    /// in one shot** (instead of relying on `drop_oldest` per push to
    /// dribble it back at cap). Reasoning:
    ///
    /// At room-join, the OS UDP recv buffer has queued ~370 ms worth
    /// of self-loopback packets while the audio engine was setting up.
    /// As soon as the receive loop runs, those packets all flush in a
    /// burst. Without target-trim, the buffer fills to `maxDepth=33`
    /// and `drop_oldest` fires once per excess packet — observed in
    /// real logs as `drop=908` in the first second = **908 audible
    /// clicks at room-join**. With target-trim, we get ONE big trim
    /// (one click) and immediately resume at the desired latency
    /// floor.
    ///
    /// Steady-state: any clock drift between server (NTP-synced) and
    /// client (audio-crystal) accumulates over time. Without active
    /// drain, the buffer drifts up to `maxDepth` and then drips at
    /// cap (the `drop=930` settling pattern in the logs). Target-trim
    /// catches drift before it accumulates: when count exceeds
    /// `targetDepth + trimMargin`, drain back. Sparse single clicks
    /// instead of continuous dribble.
    /// Steady-state floor (frames). `static var` so the AudioDebugSheet
    /// can tune it live; `trimMargin` below is computed off this value
    /// so the `target + margin + 1 == maxDepth` invariant always holds.
    static var targetDepth   = 2     // primeMin = 5 ms steady-state floor
    /// Generous headroom — only trim when buffer is near `maxDepth`.
    /// Each trim is one audible discontinuity regardless of how many
    /// frames it drops; we want **one fat trim per burst** rather than
    /// many small ones (`trimMargin=4` was overly twitchy and produced
    /// ~30 trim events per room-join burst). Set so trim fires only
    /// when count would otherwise overflow `maxDepth`:
    ///   `target + margin + 1 >= maxDepth`  ⇒  margin = maxDepth - target - 1
    /// The buffer holds up to ~75 ms of jitter headroom before trim;
    /// normal wifi jitter (5–15 ms) and sustained drift (a few frames)
    /// are absorbed silently. Trim fires only on bursts large enough
    /// to fill the absolute cap — same audibility profile as a single
    /// `drop_oldest` event but recovers latency in one shot rather
    /// than dripping.
    /// Trim threshold — computed so `target + margin + 1 == maxDepth`
    /// always holds even when `targetDepth` is tuned at runtime.
    static var trimMargin: Int { max(0, maxDepth - targetDepth - 1) }
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
    private(set) var trimCount = 0       // lifetime target-trim events (one per buffer-too-deep concentration)

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

    /// Push one decoded frame.
    ///
    /// Two depth-management policies layered:
    ///   1. **Target-trim** (the productive one): if after this push the
    ///      buffer would land above `targetDepth + trimMargin`, drain
    ///      to `targetDepth` in one shot. Concentrates many small
    ///      `drop_oldest` events into single trims; far fewer
    ///      audible clicks under burst delivery / clock drift.
    ///   2. **maxDepth fallback**: if somehow we still hit the absolute
    ///      cap (only possible if a single push would overshoot
    ///      target+margin AND the trim logic is bypassed — shouldn't
    ///      happen but kept as a safety net), drop oldest. Same
    ///      `drop_oldest` semantics as before.
    func push(_ frame: [Float], sequence: UInt16) {
        lock(); defer { unlock() }
        if let prev = lastSeq {
            let expected = prev &+ 1
            if sequence != expected { seqGapCount += 1 }
        }
        lastSeq = sequence

        // Layer 2 fallback: hard cap at maxDepth.
        if count >= Self.maxDepth {
            head = (head + 1) % Self.maxDepth
            count -= 1
            dropOldestCount += 1
        }
        ring[tail] = frame
        tail = (tail + 1) % Self.maxDepth
        count += 1

        // Layer 1: target-trim. If we just pushed past target+margin,
        // drain back to target in one shot. ONE click event instead of
        // (count - target) drop_oldest events.
        if count > Self.targetDepth + Self.trimMargin {
            let drop = count - Self.targetDepth
            head = (head + drop) % Self.maxDepth
            count = Self.targetDepth
            trimCount += 1
        }

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

    // ── Reset ──────────────────────────────────────────────────────────────

    /// Drop all queued frames + reset prime state. Called on engine
    /// stop+restart (e.g. device change) so stale frames captured
    /// during the gap don't replay when the new audio path comes up.
    /// Diagnostic counters are preserved for the session log.
    func clear() {
        lock(); defer { unlock() }
        for i in 0..<ring.count { ring[i] = [] }
        head = 0
        tail = 0
        count = 0
        primed = false
        concealQuanta = 0
    }

    // ── Diagnostics ────────────────────────────────────────────────────────

    var depth: Int {
        lock(); defer { unlock() }
        return count
    }
}
