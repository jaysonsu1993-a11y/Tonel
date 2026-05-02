import Foundation
import AVFoundation
import AudioToolbox
import Combine

/// Capture + playback engine. Owns the `AVAudioEngine` and bridges to
/// `MixerClient`. Does not know about networking errors — callers handle those.
///
/// Pipeline (matches web `audioService.ts` behaviour):
///   mic → engine.inputNode (48k float, any block size)
///       → tap → re-block to 120-sample frames → PCM16 → MixerClient.sendAudio
///
///   MixerClient.onPacket(...) → JitterBuffer per peer
///       → mix all peer frames → AVAudioSourceNode → engine.outputNode
///
/// Local input level: peak from the most recent capture block.
/// Per-peer level: peak from the most recent decoded frame.
/// Not `@MainActor` — the realtime audio callback runs on a Core Audio
/// IO thread and reads `peers`/`outputGain` directly. Properties that drive
/// the UI (`isRunning`, `inputLevel`, `peerLevels`) are mutated via
/// `Task { @MainActor in ... }` so SwiftUI sees coherent updates on main.
final class AudioEngine: ObservableObject {

    // ── Public observable state ─────────────────────────────────────────────
    @Published private(set) var isRunning = false
    @Published private(set) var inputLevel: Float = 0          // 0…1 peak
    @Published private(set) var peerLevels: [String: Float] = [:]
    @Published var inputGain: Float = 1.0                       // user-tunable
    @Published var outputGain: Float = 1.0
    /// Self-monitor (hear yourself).
    /// `monitorGain` is the user-tunable knob (the YOU·Mon fader).
    /// Effective monitor volume in the playback callback is:
    ///     (peerLevels.count >= 1 && !monitorMuted) ? monitorGain : 0
    /// When alone the local monitor is silenced — we let the server's
    /// solo-loopback path bring our voice back instead, which mirrors the
    /// web client's `updateMonitorGain` (`engaged = peerLevels.size >= 2`).
    @Published var monitorGain: Float = 1.0
    @Published var monitorMuted: Bool = false
    @Published var isMicMuted: Bool = false                     // master MIC ON/OFF
    @Published var perPeerGain: [String: Float] = [:]
    @Published var perPeerMuted: [String: Bool] = [:]
    @Published private(set) var actualSampleRate: Double = Double(AudioWire.sampleRate)
    @Published private(set) var outputLatencyMs: Int = 0
    /// Capture HW IO buffer size in frames (set by setHardwareBufferFrames,
    /// clamped to device range). Used for the e2e latency breakdown.
    @Published private(set) var captureHwFrames: Int = AudioWire.frameSamples
    @Published private(set) var outputHwFrames: Int = AudioWire.frameSamples
    /// Device-reported latency (ADC + USB transport + AU internals, ms).
    /// Read from CoreAudio HAL's `kAudioDevicePropertyLatency + SafetyOffset
    /// + StreamLatency`. NOT counted by HW-buffer math alone — this is what
    /// our 27 ms naive estimate was missing.
    @Published private(set) var deviceInputLatencyMs: Int = 0
    @Published private(set) var deviceOutputLatencyMs: Int = 0
    // Debug counters — surfaced in the room debug bar.
    @Published private(set) var txCount: Int = 0
    @Published private(set) var rxCount: Int = 0
    @Published private(set) var captureClipCount: Int = 0
    @Published private(set) var seqGapCount: Int = 0
    @Published private(set) var ringDropCount: Int = 0
    @Published private(set) var e2eLatencyMs: Int = 0

    // ── Wiring ──────────────────────────────────────────────────────────────
    private weak var mixer: MixerClient?
    private let engine = AVAudioEngine()
    private var sourceNode: AVAudioSourceNode!
    /// Capture sink — runs per HW IO buffer (5–10 ms granularity), unlike
    /// `installTap` which aggregates ~100 ms. Replacing the tap drops
    /// monitor latency from ~100 ms to ~5 ms.
    private var captureSink: AVAudioSinkNode!
    /// Self-monitor: sink pushes captured samples here, fillPlayback consumes.
    /// We can't connect inputNode → mainMixerNode via the graph because that
    /// connection silently disables the capture tap on the same bus on macOS.
    /// So monitor is mixed into the playback callback alongside peer audio.
    private var monitorRing: [Float] = []
    private let monitorRingLock = NSLock()
    /// Drop oldest above this depth — keeps monitor latency bounded even
    /// if capture / playback rates drift. 240 samples = 2 wire frames = 5 ms.
    private static let monitorRingTrimSamples = 240
    private static let monitorRingMaxSamples = 9600
    /// Server-side self-loopback queue. Used only when alone in the room
    /// (web parity: when peers.count == 0 we let the server's fullMix
    /// route bring our voice back instead of using local monitor — proves
    /// the round-trip is alive and gives a server-confirmed audio path).
    /// v0.1.5: was a raw `[Float]` ring with hard trim and no PLC. When a
    /// self-loop packet was delayed by even a single quantum (2.5 ms),
    /// `fillPlayback` would find the ring empty, emit silence for that
    /// quantum → audible click. Network jitter on cellular / Cloudflare /
    /// any congested path made this fire several times/sec — the 破音
    /// the user kept reporting on solo playback.
    ///
    /// Now a `JitterBuffer` (same as the per-peer path), so the
    /// alone-branch gets `.real / .plc / .silence` semantics with the
    /// 4-quanta lastBlock replay budget. Single-quantum gaps are masked
    /// inaudibly; only sustained outages drop to silence.
    private let selfLoopJitter = JitterBuffer()
    private var captureLogCounter: Int = 0

    // Capture re-blocking — accumulate until we have 120 samples.
    private var captureAccum: [Float] = []
    private var captureSeq: UInt32   = 0  // for diagnostics only
    private var startWallClockMs: UInt64 = 0

    // Per-peer playback state. Reference type so `peers` dictionary
    // lookups don't have to copy-write the JitterBuffer through the
    // dictionary (which Swift's CoW would otherwise force every time we
    // mutate the buffer). `final class` keeps method dispatch direct.
    private final class PeerSink {
        let jitter = JitterBuffer()
        var lastFrame: [Float] = []  // for peer level meter, written off RT
    }
    private var peers: [String: PeerSink] = [:]
    private let peersLock = NSLock()
    /// Pre-allocated snapshot of `peers.keys` — refreshed only when a
    /// peer joins or leaves, never per RT callback. Avoids the
    /// `Array(peers.keys)` allocation inside `fillPlayback` (was running
    /// at ~187 callbacks/sec → ~187 heap allocs/sec on the Core Audio
    /// thread, which can wedge the audio scheduler under load and
    /// produce the audible 破音 the user reports).
    private var peerKeysSnapshot: [String] = []
    private var packetUnsub: (() -> Void)?

    /// Composite "<roomId>:<userId>" key for self-detection in the
    /// playback ingest path. Set in `start()` from the attached
    /// MixerClient; read on the network thread by `ingestPeerPacket`.
    /// Storing it locally — rather than dereferencing
    /// `mixer?.userIdKey` every packet — avoids the weak-ref +
    /// optional-unwrap path. If `mixer` ever races to `nil` between
    /// attach and packet arrival, `mixer?.userId == nil` while
    /// `uid == String` is non-nil → comparison evaluates to `false` →
    /// self-loopback packets get routed into `peers` as if they were
    /// a peer. The room then thinks "I have a peer", drops
    /// `selfLoopRing`, and the user hears nothing because there's
    /// no actual peer audio to render. Caching the key here closes
    /// that race.
    private var selfUserIdKey: String = ""
    private let selfUserIdKeyLock = NSLock()
    /// Diagnostics — first few packets' routing decision logged so
    /// alone-no-self issues are observable from logs without
    /// instrumenting the build.
    private var ingestLogCounter: Int = 0
    /// Diagnostics — first few alone-branch playback callbacks logged
    /// with selfLoop depth + take so we can tell if loopback packets
    /// are arriving but not being mixed (or vice versa).
    private var alonePlaybackLogCounter: Int = 0
    // Per-second running stats for the periodic log.
    // peak* track the max magnitude observed in the window; clip*
    // count samples in the soft-clip "knee" region (≥ 0.95). Reset
    // each time the periodic log fires.
    private var inPeakWindow:  Float = 0
    private var inClipWindow:  Int   = 0
    private var outPeakWindow: Float = 0
    private var outClipWindow: Int   = 0

    // ── Setup ──────────────────────────────────────────────────────────────

    func attach(mixer: MixerClient) {
        self.mixer = mixer
        self.packetUnsub?()
        self.packetUnsub = mixer.onPacket { [weak self] pkt in
            self?.ingestPeerPacket(pkt)
        }
    }

    func start() throws {
        guard !isRunning else { return }
        try requestMicPermission()    // throws if denied

        // Capture the self-userId composite key at start time (after
        // mixer.connect has set it). The packet ingest path uses this
        // for self-loopback detection — see `selfUserIdKey` field doc.
        selfUserIdKeyLock.lock()
        selfUserIdKey = mixer?.userIdKey ?? ""
        selfUserIdKeyLock.unlock()
        ingestLogCounter = 0
        alonePlaybackLogCounter = 0
        AppLog.log("[AudioEngine] selfUserIdKey set: '\(selfUserIdKey)' (mixer=\(mixer == nil ? "nil" : "ok"))")

        let wireFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(AudioWire.sampleRate),
            channels: 1,
            interleaved: false)!
        let mic = engine.inputNode

        // 0) Disable Apple's voice processing on the input node.
        // macOS sometimes auto-promotes input to VoiceProcessingIO, which
        // applies AGC + echo cancellation — wrong DSP for live band rehearsal.
        do {
            try mic.setVoiceProcessingEnabled(false)
            AppLog.log("[AudioEngine] voice processing disabled on inputNode")
        } catch {
            AppLog.log("[AudioEngine] could not disable voice processing: \(error)")
        }

        // 1) Now read the post-toggle format. Use it for both the tap and the
        // monitor-lane connection so they line up with what the AU actually
        // produces.
        let micFmt = mic.inputFormat(forBus: 0)
        AppLog.log("[AudioEngine] mic native fmt: \(micFmt.sampleRate)Hz \(micFmt.channelCount)ch interleaved=\(micFmt.isInterleaved)")
        if micFmt.sampleRate <= 0 || micFmt.channelCount == 0 {
            throw NSError(domain: "Tonel", code: 2,
                          userInfo: [NSLocalizedDescriptionKey:
                              "麦克风未提供有效输入格式 — 检查输入设备 / 麦克风权限"])
        }

        // 2) Capture lane: AVAudioSinkNode receives one HW IO buffer per
        // callback (240 frames ≈ 5 ms here), feeds the same handler that
        // the old `installTap` used. Sink is a *terminal* node — connecting
        // mic → sink does not loop into output, so it doesn't conflict
        // with the playback graph the way an inputNode→mainMixerNode
        // connection did.
        captureSink = AVAudioSinkNode { [weak self] _, frameCount, abl -> OSStatus in
            self?.handleCaptureRT(frameCount: Int(frameCount), abl: abl, format: micFmt)
            return noErr
        }
        engine.attach(captureSink)
        engine.connect(mic, to: captureSink, format: micFmt)
        AppLog.log("[AudioEngine] capture sink connected to inputNode")

        applyMonitor()                       // initial monitor gain (no-op now)

        // 3) Peer mix lane: sourceNode (peer audio) → mainMixerNode.
        sourceNode = AVAudioSourceNode(format: wireFormat) {
            [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            self?.fillPlayback(frameCount: Int(frameCount), abl: audioBufferList)
            return noErr
        }
        engine.attach(sourceNode)
        engine.connect(sourceNode, to: engine.mainMixerNode, format: wireFormat)

        // `prepare()` instantiates the AUHALs (input + output) so we
        // can mutate their properties below before `start()` actually
        // begins streaming.
        engine.prepare()

        // Apply any output-device choice queued before the engine was
        // running (e.g. the home-screen picker fires before joinRoom →
        // audio.start). After prepare() the AU is real but not yet
        // streaming; setting CurrentDevice now means start() brings up
        // the user's chosen device from frame zero, no renegotiation.
        if let pending = pendingOutputDevice {
            do {
                try setAUDevice(unit: engine.outputNode.audioUnit,
                                deviceID: pending,
                                label: "output (queued)")
            } catch {
                AppLog.log("[AudioEngine] queued output device apply failed: \(error)")
            }
        }

        // Match HW IO buffer to the wire frame (120 samples / 2.5 ms): every
        // sinkNode callback produces exactly one SPA1 packet, capture
        // accumulator stays empty, and monitor latency = 1× HW buffer ≈ 2.5 ms.
        // macOS clamps to the device's allowed range — SSL 2+ accepts 15.
        setHardwareBufferFrames(target: UInt32(AudioWire.frameSamples))

        try engine.start()
        startWallClockMs = nowMs()
        captureAccum.removeAll(keepingCapacity: true)
        isRunning = true
        let outFmt = engine.outputNode.outputFormat(forBus: 0)
        // Read AVAudio's reported presentationLatency — Apple's only public
        // hook for "real device-reported delay" (includes ADC/DAC, USB
        // transport, AU-internal buffers). This is the missing piece our
        // raw HW-buffer math couldn't see.
        readDeviceLatencies()
        AppLog.log("[AudioEngine] started — mic: \(micFmt.sampleRate)Hz \(micFmt.channelCount)ch / out: \(outFmt.sampleRate)Hz \(outFmt.channelCount)ch / monitor=\(monitorGain) muted=\(monitorMuted)")
        AppLog.log("[AudioEngine] reported latency — input: \(deviceInputLatencyMs)ms, output: \(deviceOutputLatencyMs)ms")
    }

    /// Pull device-reported latency in ms from CoreAudio HAL: the AU's
    /// `kAudioDevicePropertyLatency` + `SafetyOffset` give the path
    /// from "frame submitted to driver" to "frame at speaker" (or the
    /// inverse for input). These are the numbers AVAudio uses for
    /// `presentationLatency` under the hood, but exposed in a way that
    /// doesn't need a running engine context.
    private func readDeviceLatencies() {
        deviceInputLatencyMs = readDeviceLatencyMs(unit: engine.inputNode.audioUnit,
                                                   inputScope: true)
        deviceOutputLatencyMs = readDeviceLatencyMs(unit: engine.outputNode.audioUnit,
                                                    inputScope: false)
    }

    private func readDeviceLatencyMs(unit: AudioUnit?, inputScope: Bool) -> Int {
        guard let au = unit else { return 0 }
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                   kAudioUnitScope_Global, 0, &deviceID, &size) == noErr,
              deviceID != 0 else { return 0 }
        let scope: AudioObjectPropertyScope = inputScope
            ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput

        // Total = device latency + safety offset + buffer (already counted)
        // + stream latency. We pull device + safety + stream here; the
        // buffer-period delay stays in our explicit formula.
        var total: UInt32 = 0

        for selector in [kAudioDevicePropertyLatency, kAudioDevicePropertySafetyOffset] {
            var addr = AudioObjectPropertyAddress(mSelector: selector,
                                                  mScope: scope,
                                                  mElement: kAudioObjectPropertyElementMain)
            var value: UInt32 = 0
            var sz = UInt32(MemoryLayout<UInt32>.size)
            if AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &sz, &value) == noErr {
                total += value
            }
        }
        // Stream latency (per-stream, often 0 on USB pro)
        var streamsAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
                                                     mScope: scope,
                                                     mElement: kAudioObjectPropertyElementMain)
        var streamsSize: UInt32 = 0
        if AudioObjectGetPropertyDataSize(deviceID, &streamsAddr, 0, nil, &streamsSize) == noErr,
           streamsSize > 0 {
            let count = Int(streamsSize) / MemoryLayout<AudioObjectID>.size
            var ids = [AudioObjectID](repeating: 0, count: count)
            if AudioObjectGetPropertyData(deviceID, &streamsAddr, 0, nil, &streamsSize, &ids) == noErr {
                for sid in ids {
                    var lat: UInt32 = 0
                    var lsz = UInt32(MemoryLayout<UInt32>.size)
                    var addr = AudioObjectPropertyAddress(mSelector: kAudioStreamPropertyLatency,
                                                          mScope: kAudioObjectPropertyScopeGlobal,
                                                          mElement: kAudioObjectPropertyElementMain)
                    if AudioObjectGetPropertyData(sid, &addr, 0, nil, &lsz, &lat) == noErr {
                        total += lat
                        break  // Single primary stream is enough.
                    }
                }
            }
        }
        return Int(Double(total) / Double(AudioWire.sampleRate) * 1000.rounded())
    }

    /// No-op now that monitor is mixed in the playback callback. Kept as a
    /// hook for future device-side gain adjustments.
    private func applyMonitor() {}

    func stop() {
        guard isRunning else { return }
        engine.stop()
        if let s = sourceNode {
            engine.disconnectNodeInput(s)
            engine.detach(s)
        }
        if let s = captureSink {
            engine.disconnectNodeInput(s)
            engine.detach(s)
        }
        sourceNode = nil
        captureSink = nil
        monitorRingLock.lock(); monitorRing.removeAll(); monitorRingLock.unlock()
        selfLoopJitter.clear()
        peersLock.lock()
        peers.removeAll()
        peerKeysSnapshot.removeAll(keepingCapacity: false)
        peersLock.unlock()
        peerLevels = [:]
        isRunning = false
    }

    // ── Capture path ───────────────────────────────────────────────────────

    /// Realtime capture callback (AVAudioSinkNode). Runs on Core Audio IO
    /// thread, called once per HW IO buffer (~5 ms here). Must not allocate
    /// in the hot path; `[Float](repeating:count:)` is fine because the
    /// allocator is fast and Swift typically reuses the slab.
    private func handleCaptureRT(frameCount: Int,
                                 abl: UnsafePointer<AudioBufferList>,
                                 format: AVAudioFormat) {
        guard let mixer = mixer else { return }
        let listPtr = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: abl))
        guard let chan0Raw = listPtr.first?.mData else { return }
        let n = frameCount
        let channels = Int(format.channelCount)
        let interleaved = format.isInterleaved

        var frame = [Float](repeating: 0, count: n)
        var clipped = 0
        if !interleaved {
            // One AudioBuffer per channel (deinterleaved Float32).
            // Mono fold-down (avg of all channels).
            for i in 0..<n {
                var s: Float = 0
                for cIdx in 0..<channels {
                    let buf = listPtr[cIdx]
                    let p = buf.mData!.assumingMemoryBound(to: Float.self)
                    s += p[i]
                }
                let v = (s / Float(channels)) * inputGain
                if abs(v) >= 0.999 { clipped += 1 }
                frame[i] = v
            }
        } else {
            // Single AudioBuffer with channels interleaved frame-by-frame.
            let p = chan0Raw.assumingMemoryBound(to: Float.self)
            for i in 0..<n {
                var s: Float = 0
                for cIdx in 0..<channels { s += p[i * channels + cIdx] }
                let v = (s / Float(channels)) * inputGain
                if abs(v) >= 0.999 { clipped += 1 }
                frame[i] = v
            }
        }

        // Update level meter (peak).
        var peak: Float = 0
        for v in frame { let a = abs(v); if a > peak { peak = a } }
        let muted = isMicMuted
        let clipDelta = clipped
        Task { @MainActor in
            self.inputLevel = muted ? 0 : peak
            if clipDelta > 0 { self.captureClipCount &+= clipDelta }
        }
        // Accumulate window-max so the periodic log shows the *max*
        // peak in the second, not just the latest 2.5ms's peak (which
        // misses brief transients between log emits).
        if peak > inPeakWindow { inPeakWindow = peak }
        inClipWindow &+= clipped

        // Log mic peak + ring depths every ~1s so we can spot buffer drift.
        // Includes self-loop JitterBuffer stats (depth + drop / PLC counts),
        // input/output max-peak, clip-event counts, and audio RTT — all
        // needed to triage 破音 / latency reports without shipping a
        // separate instrumentation build.
        captureLogCounter &+= 1
        if captureLogCounter <= 3 || captureLogCounter % 400 == 0 {
            monitorRingLock.lock()
            let monDepth = monitorRing.count
            monitorRingLock.unlock()
            let loopDepth = selfLoopJitter.depth
            let loopPlc   = selfLoopJitter.plcCount
            let loopDrop  = selfLoopJitter.dropOldestCount
            let loopTrim  = selfLoopJitter.trimCount
            let rtt = mixer.audioRttMs
            let inP = inPeakWindow, outP = outPeakWindow
            let inC = inClipWindow, outC = outClipWindow
            let iGain = inputGain, oGain = outputGain
            AppLog.log("[AudioEngine] cap#\(captureLogCounter) inPeak=\(String(format: "%.3f", inP)) outPeak=\(String(format: "%.3f", outP)) inClip=\(inC) outClip=\(outC) iGain=\(String(format: "%.2f", iGain)) oGain=\(String(format: "%.2f", oGain)) self.depth=\(loopDepth)fr self.plc=\(loopPlc) self.drop=\(loopDrop) self.trim=\(loopTrim) monRing=\(monDepth) rtt=\(rtt)ms")
            // Reset window stats for the next second.
            inPeakWindow  = 0
            outPeakWindow = 0
            inClipWindow  = 0
            outClipWindow = 0
        }

        // Feed the self-monitor ring. Hard upper bound at 200ms is just a
        // safety; the AGGRESSIVE trim to 5ms (`monitorRingTrimSamples`)
        // keeps live monitor latency bounded under capture/playback drift.
        // Without this, a brief stall of fillPlayback would let the ring
        // accumulate, permanently inflating monitor latency.
        monitorRingLock.lock()
        monitorRing.append(contentsOf: frame)
        if monitorRing.count > Self.monitorRingTrimSamples {
            monitorRing.removeFirst(monitorRing.count - Self.monitorRingTrimSamples)
        }
        monitorRingLock.unlock()

        // If muted: feed silence onto the wire so the mixer still sees a
        // live sender (matches web behaviour — keeps mixer's room timing).
        if muted {
            for i in 0..<frame.count { frame[i] = 0 }
        }

        // Append and emit fixed-size 120-sample frames.
        captureAccum.append(contentsOf: frame)
        let frameSize = AudioWire.frameSamples
        var sent = 0
        while captureAccum.count >= frameSize {
            let chunk = Array(captureAccum.prefix(frameSize))
            captureAccum.removeFirst(frameSize)
            let pcm = PCM16.encode(chunk)
            let ts = UInt16((nowMs() - startWallClockMs) / 100 & 0xFFFF)
            mixer.sendAudio(pcm: pcm, timestampMs: ts)
            captureSeq &+= 1
            sent += 1
        }
        if sent > 0 {
            Task { @MainActor in self.txCount &+= sent }
        }
    }

    // ── Playback path ──────────────────────────────────────────────────────

    private func ingestPeerPacket(_ pkt: MixerPacket) {
        // userId arrives as "room_id:user_id" — strip room prefix for keying.
        let uid = pkt.userId.split(separator: ":", maxSplits: 1).last.map(String.init) ?? pkt.userId
        let samples = PCM16.decode(pkt.pcm)

        // Server-side self-loopback detection.
        //
        // Compare against the cached composite "<room>:<user>" key (set
        // in start() from `mixer.userIdKey`) — NOT against the bare
        // `mixer?.userId`. Two reasons:
        //   1. Robustness: `mixer` is a weak ref; `mixer?.userId == nil`
        //      while `uid != nil` evaluates to `false` and silently
        //      misroutes the self packet into the `peers` map. The room
        //      then thinks it has a peer, fillPlayback's alone-branch
        //      drains selfLoopRing, and the user hears nothing.
        //   2. Skip the split: comparing the full composite avoids the
        //      bare-userId extraction entirely. The 64-byte SPA1 userId
        //      field is exactly the composite key; just compare bytes.
        //
        // Server runs fullMix mode while we're alone (gives us our own
        // voice back so the user can hear the round-trip is alive) and
        // switches to N-1 once peers join. We don't add self to
        // peerLevels — that would create a "peer strip" for ourselves;
        // instead we route into a dedicated ring and the playback
        // callback only mixes it when we're actually alone.
        selfUserIdKeyLock.lock()
        let myKey = selfUserIdKey
        selfUserIdKeyLock.unlock()
        let isSelf = !myKey.isEmpty && pkt.userId == myKey

        // Cold-start diagnostic: log the first 5 packets' routing
        // decision. Lets us tell at a glance whether a "no self audio
        // when alone" report is (a) packets aren't arriving from the
        // server, (b) packets arrive but routing-as-self is failing,
        // or (c) packets arrive and route correctly but downstream
        // mix is silent. Only first 5 to keep logs quiet thereafter.
        ingestLogCounter &+= 1
        if ingestLogCounter <= 5 {
            AppLog.log("[AudioEngine] ingest #\(ingestLogCounter) pkt.userId='\(pkt.userId)' uid='\(uid)' myKey='\(myKey)' isSelf=\(isSelf) sampleN=\(samples.count)")
        }

        if isSelf {
            // v0.1.5: route into a JitterBuffer so the playback path gets
            // PLC. `push()` does the depth-cap + drop-oldest internally;
            // we don't need an explicit trim here.
            selfLoopJitter.push(samples, sequence: pkt.sequence)
            Task { @MainActor in self.rxCount &+= 1 }
            return
        }

        peersLock.lock()
        let sink: PeerSink
        if let existing = peers[uid] {
            sink = existing
        } else {
            sink = PeerSink()
            peers[uid] = sink
            // Refresh the RT-side snapshot exactly when membership
            // changes. Allocation here is fine — runs on the network
            // ingest task, not the Core Audio thread.
            peerKeysSnapshot = Array(peers.keys)
        }
        sink.jitter.push(samples, sequence: pkt.sequence)
        sink.lastFrame = samples
        let gapDelta = sink.jitter.seqGapCount
        let dropDelta = sink.jitter.dropOldestCount
        peersLock.unlock()

        // Update meter on main.
        var peak: Float = 0
        for v in samples { let a = abs(v); if a > peak { peak = a } }
        Task { @MainActor in
            self.peerLevels[uid] = peak
            self.rxCount &+= 1
            self.seqGapCount = gapDelta
            self.ringDropCount = dropDelta
        }
    }

    /// Realtime callback: pull mixed audio for `frameCount` frames into buf.
    /// Runs on Core Audio thread — no locks beyond the cheap NSLock above.
    private func fillPlayback(frameCount: Int, abl: UnsafePointer<AudioBufferList>) {
        let listPtr = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: abl))
        guard let chan = listPtr.first?.mData else { return }
        let out = chan.assumingMemoryBound(to: Float.self)
        for i in 0..<frameCount { out[i] = 0 }

        // ── Self path: alone → server loopback; with peers → local monitor ─
        // Web parity (`updateMonitorGain`): engaged = peerLevels.size >= 2,
        // i.e. there is at least one OTHER peer.
        let hasOtherPeers: Bool = {
            peersLock.lock(); defer { peersLock.unlock() }
            return !peers.isEmpty
        }()
        if hasOtherPeers {
            // ── Local monitor mix-in (low latency, capture-direct) ────────
            let monGain = monitorMuted ? 0 : monitorGain
            if monGain > 0 {
                monitorRingLock.lock()
                let take = min(frameCount, monitorRing.count)
                if take > 0 {
                    for i in 0..<take {
                        out[i] += monitorRing[i] * monGain
                    }
                    monitorRing.removeFirst(take)
                }
                monitorRingLock.unlock()
            }
            // Drain server self-loopback so it doesn't pile up while unused.
            // (When peers join we still receive a couple of self-loop frames
            // before the server flips to N-1; tossing them avoids a slug
            // of doubled audio when the mode actually does change.) The
            // JitterBuffer doesn't expose a drop-all method; pop until
            // .silence so the queue empties without producing audible
            // mix contribution.
            while case .real = selfLoopJitter.pop() { /* drain */ }
        } else {
            // ── Server self-loopback mix-in (alone → server fullMix) ──────
            // v0.1.5: pop from `selfLoopJitter` (a JitterBuffer) instead
            // of reading raw samples. Gives us PLC for free — single-
            // quantum network jitter no longer drops to silence. Same
            // PopResult semantics as the per-peer path.
            let monGain = monitorMuted ? 0 : monitorGain
            if alonePlaybackLogCounter < 5 {
                alonePlaybackLogCounter &+= 1
                AppLog.log("[AudioEngine] fillPlayback alone #\(alonePlaybackLogCounter) frameCount=\(frameCount) selfLoopDepth=\(selfLoopJitter.depth) monGain=\(monGain) monitorMuted=\(monitorMuted)")
            }
            if monGain > 0 {
                // Pop one wire-frame's worth at a time; if `frameCount`
                // exceeds 120 we loop. Matches the per-peer mix loop.
                var written = 0
                let frameSize = AudioWire.frameSamples
                while written < frameCount {
                    let take = min(frameSize, frameCount - written)
                    switch selfLoopJitter.pop() {
                    case .real(let f):
                        let n = min(take, f.count)
                        for i in 0..<n { out[written + i] += f[i] * monGain }
                    case .plc(let f, let decay):
                        let g = monGain * decay
                        let n = min(take, f.count)
                        for i in 0..<n { out[written + i] += f[i] * g }
                    case .silence:
                        break       // leave zeros from the initial fill
                    }
                    written += take
                }
            }
            // Drain local monitor while alone — avoids a backlog explosion
            // before peers arrive. (Otherwise switching to with-peers mode
            // would suddenly play 1+ seconds of stale local monitor.)
            monitorRingLock.lock()
            if !monitorRing.isEmpty { monitorRing.removeAll(keepingCapacity: true) }
            monitorRingLock.unlock()
        }

        // ── Peer mix ──────────────────────────────────────────────────────
        // Pop one wire frame from each peer per loop iteration, mix in.
        // RT-thread invariants:
        //   - No `Array(peers.keys)` in the hot path: we use the cached
        //     `peerKeysSnapshot` updated only on join/leave. Snapshot
        //     read under a tiny lock at the top of the callback, then
        //     used for the rest of the call.
        //   - `pop()` is now PLC-aware: `.real` is fresh, `.plc` masks a
        //     missed packet by replaying the last real frame at decay
        //     (1.0 → 0.7 → 0.4 → 0.15 over 4 quanta, matches web).
        //     `.silence` only fires after the PLC budget is exhausted —
        //     i.e. a real network outage, not a single-packet hiccup.
        //     Each `.silence` historically read as a click; with PLC the
        //     listener hears a soft tail instead.
        //   - Per-frame `JitterBuffer.pop()` does not allocate; the
        //     returned `[Float]` aliases the slot we just vacated, which
        //     the producer can't overwrite for at least `maxDepth` more
        //     pushes (~80 ms with depth 33).
        peersLock.lock()
        let keys = peerKeysSnapshot
        // Snapshot per-peer gain/mute too — reading SwiftUI @Published
        // dicts directly on RT thread is unsafe in the abstract (CoW
        // races) and produces a dictionary alloc on first hash anyway.
        // Cheap copy once per callback.
        let gainSnapshot = perPeerGain
        let mutedSnapshot = perPeerMuted
        peersLock.unlock()

        var written = 0
        let frameSize = AudioWire.frameSamples
        while written < frameCount {
            let take = min(frameSize, frameCount - written)

            for k in keys {
                if mutedSnapshot[k] == true { continue }
                peersLock.lock()
                let sink = peers[k]
                peersLock.unlock()
                guard let s = sink else { continue }
                let result = s.jitter.pop()
                let g = gainSnapshot[k] ?? 1.0
                switch result {
                case .real(let f):
                    let n = min(take, f.count)
                    for i in 0..<n { out[written + i] += f[i] * g }
                case .plc(let f, let decay):
                    let scaled = g * decay
                    let n = min(take, f.count)
                    for i in 0..<n { out[written + i] += f[i] * scaled }
                case .silence:
                    continue
                }
            }
            written += take
        }

        // Output gain + tanh soft-clip (knee=0.95, matches server's
        // `audio_mixer.h::softClipBuffer`). The previous hard-clamp at
        // ±1.0 produced volume-correlated harmonic distortion for any
        // sample that overshot — server fixed the same issue in
        // v1.0.15; the macOS client was still hard-clamping every
        // output quantum. Track output peak + clip-event count for the
        // periodic capture log.
        let g = outputGain
        var peakOut: Float = 0
        var clipOut = 0
        for i in 0..<frameCount {
            let raw = out[i] * g
            let mag = abs(raw)
            if mag > peakOut { peakOut = mag }
            if mag >= 0.95 { clipOut &+= 1 }   // entered tanh region
            // Inline soft-clip — knee 0.95.
            var v = raw
            if v > 0.95       { v = 0.95 + 0.05 * tanh((v - 0.95) / 0.05) }
            else if v < -0.95 { v = -0.95 + 0.05 * tanh((v + 0.95) / 0.05) }
            // Final safety in case tanh + FP precision produced > 1.
            if v >  1.0 { v =  1.0 }
            if v < -1.0 { v = -1.0 }
            out[i] = v
        }
        outPeakWindow = max(outPeakWindow, peakOut)
        outClipWindow &+= clipOut
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private func requestMicPermission() throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        switch status {
        case .authorized: return
        case .notDetermined:
            let sem = DispatchSemaphore(value: 0)
            var ok = false
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                ok = granted; sem.signal()
            }
            sem.wait()
            if !ok { throw NSError(domain: "Tonel", code: 1,
                                   userInfo: [NSLocalizedDescriptionKey: "需要麦克风权限"]) }
        case .denied, .restricted:
            throw NSError(domain: "Tonel", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "麦克风权限被拒绝，请在系统设置中开启"])
        @unknown default: return
        }
    }

    /// Drive the actual Core Audio device's IO buffer frame size as low as
    /// the device will permit — macOS will silently clamp if our target is
    /// outside the device's range. 256 frames ≈ 5.3 ms @ 48 kHz, suitable
    /// for live monitoring on USB pro interfaces (SSL 2+, RME, etc.).
    /// AVAudioEngine on its own often leaves this at 4096+ for power.
    private func setHardwareBufferFrames(target: UInt32) {
        for which in [
            (engine.inputNode.audioUnit,  "input"),
            (engine.outputNode.audioUnit, "output"),
        ] {
            guard let au = which.0 else { continue }
            var deviceID: AudioDeviceID = 0
            var devSize = UInt32(MemoryLayout<AudioDeviceID>.size)
            let getDevStatus = AudioUnitGetProperty(au,
                                                    kAudioOutputUnitProperty_CurrentDevice,
                                                    kAudioUnitScope_Global,
                                                    0, &deviceID, &devSize)
            guard getDevStatus == noErr, deviceID != 0 else { continue }

            // Clamp request to device's allowed range.
            var range = AudioValueRange()
            var rangeSize = UInt32(MemoryLayout<AudioValueRange>.size)
            var rangeAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyBufferFrameSizeRange,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            AudioObjectGetPropertyData(deviceID, &rangeAddr, 0, nil, &rangeSize, &range)
            var size = UInt32(max(range.mMinimum, min(range.mMaximum, Double(target))))

            var sizeAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyBufferFrameSize,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            let status = AudioObjectSetPropertyData(deviceID, &sizeAddr, 0, nil,
                                                    UInt32(MemoryLayout<UInt32>.size), &size)
            // Read back the actual size the device accepted (it may clamp).
            var actual: UInt32 = 0
            var actualSize = UInt32(MemoryLayout<UInt32>.size)
            AudioObjectGetPropertyData(deviceID, &sizeAddr, 0, nil, &actualSize, &actual)
            let actualInt = Int(actual)
            Task { @MainActor in
                if which.1 == "input"  { self.captureHwFrames = actualInt }
                if which.1 == "output" { self.outputHwFrames  = actualInt }
            }
            AppLog.log("[AudioEngine] \(which.1) device=\(deviceID) set bufferFrames=\(actualInt) (req=\(size), range=\(Int(range.mMinimum))…\(Int(range.mMaximum))) status=\(status)")
        }
    }

    private func nowMs() -> UInt64 {
        UInt64(Date().timeIntervalSince1970 * 1000)
    }

    // MARK: - E2E latency

    /// Estimated mouth-to-ear latency in ms for audio that goes through the
    /// server (peer's voice arriving at me, OR my own voice when alone via
    /// server fullMix loopback). Components, all measured / device-reported:
    ///
    ///   deviceInputLatencyMs   ← ADC + USB transport + input AU internals
    ///   captureBufMs           ← input HW IO buffer (period delay)
    ///   networkUpMs            ← RTT/2
    ///   serverJitterMs         ← server's own jitter buffer target (from ACK)
    ///   serverMixHalfTickMs    ← average wait inside server mix loop = ½ tick
    ///   networkDownMs          ← RTT/2
    ///   clientJitterMs         ← our JitterBuffer.primeMin × wire frame ms
    ///   outputBufMs            ← output HW IO buffer (period delay)
    ///   deviceOutputLatencyMs  ← DAC + USB transport + output AU internals
    ///
    /// We can't observe the SENDER side's device latency (a peer's mic
    /// hardware), so we approximate it by reusing OUR own input device
    /// latency. Reasonable when both ends are macOS / similar; when alone
    /// it's exact (we ARE the sender too, server-loopback mode).
    func computeE2eLatencyMs(audioRttMs: Int, serverJitterTargetFrames: Int) -> Int {
        guard audioRttMs >= 0, isRunning else { return 0 }
        let frameMs = AudioWire.frameMs
        let captureBufMs = Double(captureHwFrames) / Double(AudioWire.sampleRate) * 1000
        let outputBufMs  = Double(outputHwFrames)  / Double(AudioWire.sampleRate) * 1000
        let serverJitterMs   = Double(serverJitterTargetFrames) * frameMs
        let serverMixWaitMs  = frameMs / 2.0   // average half-tick wait
        let clientJitterMs   = Double(JitterBuffer.primeMin) * frameMs
        let total = Double(deviceInputLatencyMs)
                  + captureBufMs
                  + Double(audioRttMs)
                  + serverJitterMs
                  + serverMixWaitMs
                  + clientJitterMs
                  + outputBufMs
                  + Double(deviceOutputLatencyMs)
        return Int(total.rounded())
    }

    /// Returns each component (ms) for diagnostic display.
    func e2eBreakdown(audioRttMs: Int, serverJitterTargetFrames: Int) -> [(String, Int)] {
        let frameMs = AudioWire.frameMs
        let cap = Int((Double(captureHwFrames) / Double(AudioWire.sampleRate) * 1000).rounded())
        let out = Int((Double(outputHwFrames)  / Double(AudioWire.sampleRate) * 1000).rounded())
        let srvJ = Int((Double(serverJitterTargetFrames) * frameMs).rounded())
        let srvT = Int((frameMs / 2.0).rounded())
        let cliJ = Int((Double(JitterBuffer.primeMin) * frameMs).rounded())
        return [
            ("dev-in",   deviceInputLatencyMs),
            ("cap-buf",  cap),
            ("net",      max(0, audioRttMs)),
            ("srv-jit",  srvJ),
            ("srv-tick", srvT),
            ("cli-jit",  cliJ),
            ("out-buf",  out),
            ("dev-out",  deviceOutputLatencyMs),
        ]
    }

    // MARK: - Per-peer controls (UI helpers)

    func setPeerGain(_ uid: String, gain: Float) {
        perPeerGain[uid] = gain
        mixer?.sendPeerGain(targetUserId: uid, gain: gain)
    }

    func setPeerMuted(_ uid: String, muted: Bool) {
        perPeerMuted[uid] = muted
    }

    // MARK: - Devices

    /// Available audio output devices on macOS, via Core Audio HAL.
    static func listOutputDevices() -> [AudioDeviceInfo] {
        return enumerateDevices(scope: kAudioDevicePropertyScopeOutput)
    }

    /// Available audio input devices.
    static func listInputDevices() -> [AudioDeviceInfo] {
        return enumerateDevices(scope: kAudioDevicePropertyScopeInput)
    }

    private static func enumerateDevices(scope: AudioObjectPropertyScope) -> [AudioDeviceInfo] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
        let count = Int(size) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)

        var result: [AudioDeviceInfo] = []
        for id in ids {
            // Skip devices that have no streams in the requested scope.
            var streamsAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreams,
                mScope: scope,
                mElement: kAudioObjectPropertyElementMain)
            var streamsSize: UInt32 = 0
            AudioObjectGetPropertyDataSize(id, &streamsAddr, 0, nil, &streamsSize)
            if streamsSize == 0 { continue }

            // Name. CFString is an object reference — get it via Unmanaged
            // to avoid forming an UnsafeMutableRawPointer to a refcounted slot.
            var nameAddr = AudioObjectPropertyAddress(
                mSelector: kAudioObjectPropertyName,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            var nameRef: Unmanaged<CFString>?
            var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            let status = withUnsafeMutablePointer(to: &nameRef) { ptr -> OSStatus in
                AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, ptr)
            }
            let name: String = (status == noErr)
                ? (nameRef?.takeRetainedValue() as String? ?? "Unknown")
                : "Unknown"

            result.append(AudioDeviceInfo(id: id, name: name))
        }
        return result
    }

    /// User-requested output device. Stored separately from the AU's
    /// `CurrentDevice` because:
    ///   1. The home-screen picker fires BEFORE `engine.start()` has
    ///      run. At that point `engine.outputNode.audioUnit` is `nil`
    ///      (AVAudioEngine creates the AU lazily on prepare/start), so
    ///      a direct `AudioUnitSetProperty(...)` call would no-op
    ///      silently. We need to remember the choice and apply it
    ///      inside `start()`.
    ///   2. The room-screen picker fires while the engine IS running.
    ///      The AU exists, so we can apply immediately, but
    ///      AVAudioEngine often needs a stop+start cycle for the new
    ///      device's format to be renegotiated end-to-end (matching
    ///      the existing `setInputDevice` behaviour).
    ///   3. The settings UI needs to render "current selection" — we
    ///      return this preference if set, falling back to the AU's
    ///      live value, falling back to system default, falling back
    ///      to "first device in the enumeration." Eliminates the
    ///      "picker shows wrong device" symptom.
    private var pendingOutputDevice: AudioDeviceID? = nil

    /// Switch the engine's playback device. Works whether or not the
    /// engine is currently running:
    ///   • Engine not running (home screen) → save preference, apply
    ///     during `start()`.
    ///   • Engine running (in-room) → save preference, set the AU
    ///     property, restart the engine so format renegotiation takes
    ///     full effect.
    func setOutputDevice(_ deviceID: AudioDeviceID) throws {
        pendingOutputDevice = deviceID
        guard isRunning else {
            // Engine not started yet — preference is recorded; will be
            // applied at start() time. AU may be nil at this point.
            AppLog.log("[AudioEngine] output device queued (engine not running) → id=\(deviceID)")
            return
        }
        // Engine running: stop+set+restart, mirroring setInputDevice.
        // Hot-swap-while-running on macOS is theoretically supported
        // but produces clicks / format mismatches in practice.
        let wasRunning = isRunning
        if wasRunning { stop() }
        try setAUDevice(unit: engine.outputNode.audioUnit,
                        deviceID: deviceID,
                        label: "output")
        if wasRunning { try start() }
    }

    /// Resolves the "currently-effective" output device for the
    /// settings picker, in this priority:
    ///   1. The user's pending choice (if any) — what we'll apply
    ///      next time the engine starts.
    ///   2. The running engine's actual device, if engine is up.
    ///   3. macOS system-default output device — what the AU will
    ///      pick up at start() if no preference is set.
    /// Returns nil only if all three sources fail (degenerate state).
    func currentOutputDevice() -> AudioDeviceID? {
        if let pending = pendingOutputDevice { return pending }
        if let au = engine.outputNode.audioUnit {
            var deviceID: AudioDeviceID = 0
            var size = UInt32(MemoryLayout<AudioDeviceID>.size)
            let status = AudioUnitGetProperty(au,
                                              kAudioOutputUnitProperty_CurrentDevice,
                                              kAudioUnitScope_Global,
                                              0, &deviceID, &size)
            if status == noErr && deviceID != 0 { return deviceID }
        }
        return Self.systemDefaultOutputDevice()
    }

    /// macOS system-default output device, queried via Core Audio HAL.
    /// Lets the home-screen picker render the right "current" choice
    /// before any AU has been instantiated.
    static func systemDefaultOutputDevice() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &addr, 0, nil, &size, &deviceID)
        return (status == noErr && deviceID != 0) ? deviceID : nil
    }

    /// Switch the engine's input device (the mic feeding inputNode).
    /// Caller must restart the engine if it's currently running — we tear
    /// the tap down + restart so the inputFormat is renegotiated.
    func setInputDevice(_ deviceID: AudioDeviceID) throws {
        let wasRunning = isRunning
        if wasRunning { stop() }
        try setAUDevice(unit: engine.inputNode.audioUnit, deviceID: deviceID,
                        label: "input")
        if wasRunning { try start() }
    }

    private func setAUDevice(unit: AudioUnit?, deviceID: AudioDeviceID,
                             label: String) throws {
        guard let au = unit else {
            throw NSError(domain: "Tonel", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "\(label) AudioUnit 不可用"])
        }
        var did = deviceID
        let status = AudioUnitSetProperty(au,
                                          kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global,
                                          0, &did,
                                          UInt32(MemoryLayout<AudioDeviceID>.size))
        if status != noErr {
            throw NSError(domain: "Tonel", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey:
                              "切换 \(label) 设备失败 (status=\(status))"])
        }
        AppLog.log("[AudioEngine] switched \(label) device → id=\(deviceID)")
    }

    /// Force a different device sample-rate (Core Audio device-side; the
    /// engine's wire format stays at 48 kHz). 0 / nil means restore default.
    func setInputDeviceSampleRate(_ rate: Double?) {
        // Setting per-device sample rate via HAL is intricate and platform
        // version-sensitive; for now this is a hook the UI can flip but the
        // actual Core Audio call is a TODO. The wire frame size never changes.
        actualSampleRate = rate ?? Double(AudioWire.sampleRate)
    }
}

/// Simple value type for output device picker.
struct AudioDeviceInfo: Hashable, Identifiable {
    let id: AudioDeviceID
    let name: String
}
