import Foundation
import AVFoundation
import AudioToolbox
import Combine

/// Capture + playback engine. Owns the `AVAudioEngine` and bridges to
/// `MixerClient`. Does not know about networking errors — callers handle those.
///
/// Pipeline (matches web `audioService.ts` behaviour):
///   mic → engine.inputNode (48k float, any block size)
///       → tap → re-block to AudioWire.frameSamples (32 at v6.0.0) → PCM16 → MixerClient.sendAudio
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

    // ── Live tuning (mirrors web AudioDebugPanel) ──────────────────────────
    /// Client-side jitter prime threshold (frames). Setter routes to the
    /// `static var` on `JitterBuffer` so existing per-peer buffers pick it
    /// up immediately. Range exposed in the panel: 1…16.
    @Published var clientPrimeMin: Int = JitterBuffer.primeMin {
        didSet { JitterBuffer.primeMin = clientPrimeMin }
    }
    /// Server-side per-user jitter target (frames). Setter sends MIXER_TUNE
    /// over the mixer TCP control. Initial value is overwritten by the
    /// MIXER_JOIN_ACK value via `syncServerTuningFromMixer()` after join.
    @Published var serverJitterTarget: Int = 8 {     // v6.0.0: was 2 at 120-sample frames; ~5 ms steady-state floor
        didSet {
            guard serverJitterTarget != oldValue else { return }
            mixer?.sendMixerTune(["jitter_target": serverJitterTarget])
        }
    }
    /// Server-side per-user jitter cap (frames). Same MIXER_TUNE plumbing.
    @Published var serverJitterMaxDepth: Int = 124 {  // v6.0.0: was 8 at 120-sample frames; ~82 ms cap matching server default
        didSet {
            guard serverJitterMaxDepth != oldValue else { return }
            mixer?.sendMixerTune(["jitter_max_depth": serverJitterMaxDepth])
        }
    }

    /// Pull current values from MixerClient (post-JOIN_ACK) into the
    /// `@Published` mirrors so sliders open at the actual server defaults.
    /// Called once from `AppState.joinRoom` after `mixer.connect`. Don't
    /// re-call on every sheet open — that would clobber user edits.
    func syncServerTuningFromMixer() {
        guard let m = mixer else { return }
        if serverJitterTarget != m.serverJitterTargetFrames {
            serverJitterTarget = m.serverJitterTargetFrames
        }
        if serverJitterMaxDepth != m.serverJitterMaxFrames {
            serverJitterMaxDepth = m.serverJitterMaxFrames
        }
    }

    /// Sum of current per-peer jitter buffer depths (for the e2e formula's
    /// realtime client-jitter term). Falls back to `clientPrimeMin × 1`
    /// when no peers have joined yet so the display is non-zero before
    /// the first packet lands. Reads under `peersLock`.
    func currentJitterDepthFrames() -> Int {
        peersLock.lock(); defer { peersLock.unlock() }
        guard !peers.isEmpty else { return clientPrimeMin }
        // Average across peers — same dimension as web's `playRingFill`.
        let sum = peers.values.reduce(0) { $0 + $1.jitter.depth }
        return sum / peers.count
    }

    // ── Wiring ──────────────────────────────────────────────────────────────
    /// v6.1.0: typed as the `MixerTransport` protocol so we can swap
    /// between the UDP-direct (`MixerClient`) and WS-direct
    /// (`WSMixerClient`) implementations from Settings without
    /// touching the audio path.
    private weak var mixer: (any MixerTransport)?
    private let engine = AVAudioEngine()
    /// Standalone HAL output AudioUnit (kAudioUnitSubType_HALOutput).
    /// Replaces the AVAudioEngine sourceNode → mainMixerNode → outputNode
    /// chain for playback. The reason: AVAudioEngine on macOS uses a
    /// shared internal HAL AU for I/O which refuses CurrentDevice
    /// changes (returns -10851 / -19851) regardless of stop()/Uninit
    /// sequencing. A bare AUHAL we own outright accepts the standard
    /// Uninitialize → SetProperty(CurrentDevice) → Initialize dance.
    /// Capture stays on AVAudioEngine — only output is migrated.
    private var outputAU: AudioUnit?
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
    private var selfLoopRing: [Float] = []
    private let selfLoopLock = NSLock()
    /// Equivalent jitter target for the server-loopback path. 2 frames = 5ms.
    private static let selfLoopRingTrimSamples = 240
    private static let selfLoopMaxSamples = 9600
    private var captureLogCounter: Int = 0

    // Capture re-blocking — accumulate until we have AudioWire.frameSamples (32 at v6.0.0).
    private var captureAccum: [Float] = []
    private var captureSeq: UInt32   = 0  // for diagnostics only
    private var startWallClockMs: UInt64 = 0

    // Per-peer playback state.
    private struct PeerSink {
        var jitter = JitterBuffer()
        var lastFrame: [Float] = []  // for peer level meter
    }
    private var peers: [String: PeerSink] = [:]
    private let peersLock = NSLock()
    private var packetUnsub: (() -> Void)?

    // ── Setup ──────────────────────────────────────────────────────────────

    func attach(mixer: any MixerTransport) {
        self.mixer = mixer
        self.packetUnsub?()
        self.packetUnsub = mixer.onPacket { [weak self] pkt in
            self?.ingestPeerPacket(pkt)
        }
    }

    func start() throws {
        guard !isRunning else { return }
        try requestMicPermission()    // throws if denied

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

        // 3) Peer mix lane — driven by a STANDALONE HAL output AU now.
        // sourceNode left nil for the legacy AVAudioEngine path; nothing
        // references it after the rewrite.
        try setupOutputAU(wireFormat: wireFormat)

        // HW IO buffer size: user-tunable via Settings (`hwBufferFrames`
        // in UserDefaults). Default = wire frame (32 samples / 0.667 ms
        // at v6.0.0; was 120 / 2.5 ms pre-v6); every sinkNode callback
        // produces exactly one SPA1 packet, monitor latency = 1× HW
        // buffer. macOS clamps to the device's allowed range — SSL 2+
        // accepts 15, MacBook builtin needs 256+.
        let saved = UserDefaults.standard.integer(forKey: AudioEngine.bufferFramesKey)
        let target = saved > 0 ? saved : AudioWire.frameSamples
        setHardwareBufferFrames(target: UInt32(target))

        // Output device choice is handled inside `setupOutputAU` —
        // bare AUHAL accepts the standard Uninit/Set/Init dance.

        engine.prepare()
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
        deviceOutputLatencyMs = readDeviceLatencyMs(unit: outputAU ?? engine.outputNode.audioUnit,
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

    /// Build the standalone HAL output AU. Configured once per `start()`,
    /// torn down in `stop()`. Stream format on the input scope of bus 0
    /// is our wire format (48 kHz mono Float32) — AUHAL's internal
    /// AudioConverter handles the conversion to whatever the device wants.
    private func setupOutputAU(wireFormat: AVAudioFormat) throws {
        // 1. Find the HAL output component.
        var desc = AudioComponentDescription(
            componentType:         kAudioUnitType_Output,
            componentSubType:      kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags:        0,
            componentFlagsMask:    0)
        guard let comp = AudioComponentFindNext(nil, &desc) else {
            throw NSError(domain: "Tonel", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "HAL output component not found"])
        }
        var au: AudioUnit?
        var st = AudioComponentInstanceNew(comp, &au)
        guard st == noErr, let au = au else {
            throw NSError(domain: "Tonel", code: Int(st),
                          userInfo: [NSLocalizedDescriptionKey: "AudioComponentInstanceNew failed (\(st))"])
        }

        // 2. HALOutput defaults to "input disabled, output enabled". On
        // bus 0 (output side) input scope = output scope = output. Make
        // sure output is enabled and input is disabled — explicit so the
        // AU never tries to grab a microphone.
        var enable: UInt32 = 1
        AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO,
                             kAudioUnitScope_Output, 0,
                             &enable, UInt32(MemoryLayout<UInt32>.size))
        var disable: UInt32 = 0
        AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO,
                             kAudioUnitScope_Input, 1,
                             &disable, UInt32(MemoryLayout<UInt32>.size))

        // 3. Choose the device. Saved preference → fallback to system
        // default output if the saved ID isn't valid anymore (device
        // unplugged since last run).
        let saved = AudioDeviceID(UserDefaults.standard.integer(forKey: AudioEngine.outputDeviceIDKey))
        let device = (saved != 0 && AudioEngine.deviceExists(saved, scope: kAudioDevicePropertyScopeOutput))
            ? saved : AudioEngine.systemDefaultOutputDevice()
        if device != 0 {
            var did = device
            st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global, 0,
                                      &did, UInt32(MemoryLayout<AudioDeviceID>.size))
            if st != noErr {
                AppLog.log("[AudioEngine] outputAU initial CurrentDevice=\(device) failed status=\(st)")
            }
        }

        // 4. Stream format on input scope of bus 0 = what we render.
        // AUHAL converts to device's native format internally.
        var asbd = wireFormat.streamDescription.pointee
        st = AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat,
                                  kAudioUnitScope_Input, 0,
                                  &asbd, UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
        if st != noErr {
            AppLog.log("[AudioEngine] outputAU set wire format failed status=\(st)")
        }

        // 5. Render callback. Pass `self` via Unmanaged so the trampoline
        // can call back into `fillPlayback` without ARC retain cycles.
        var cb = AURenderCallbackStruct(
            inputProc: { (refCon, _, _, _, frameCount, ioData) -> OSStatus in
                guard let abl = ioData else { return noErr }
                let me = Unmanaged<AudioEngine>.fromOpaque(refCon).takeUnretainedValue()
                me.fillPlayback(frameCount: Int(frameCount), abl: UnsafePointer(abl))
                return noErr
            },
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        st = AudioUnitSetProperty(au, kAudioUnitProperty_SetRenderCallback,
                                  kAudioUnitScope_Input, 0,
                                  &cb, UInt32(MemoryLayout<AURenderCallbackStruct>.size))
        if st != noErr {
            AppLog.log("[AudioEngine] outputAU set render callback failed status=\(st)")
        }

        // 6. Initialize and start.
        st = AudioUnitInitialize(au)
        if st != noErr {
            AppLog.log("[AudioEngine] outputAU init failed status=\(st)")
        }
        st = AudioOutputUnitStart(au)
        if st != noErr {
            AppLog.log("[AudioEngine] outputAU start failed status=\(st)")
        }
        outputAU = au
        AppLog.log("[AudioEngine] outputAU running on device=\(device)")
    }

    /// Tear down the bare HAL output AU. Symmetric counterpart to setupOutputAU.
    private func teardownOutputAU() {
        guard let au = outputAU else { return }
        AudioOutputUnitStop(au)
        AudioUnitUninitialize(au)
        AudioComponentInstanceDispose(au)
        outputAU = nil
    }

    /// Read the system's current default output device.
    /// Used as a fallback when no preference saved or the saved one
    /// no longer exists.
    private static func systemDefaultOutputDevice() -> AudioDeviceID {
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return id
    }

    /// Sanity check a saved deviceID — devices can be unplugged between runs.
    private static func deviceExists(_ id: AudioDeviceID, scope: AudioObjectPropertyScope) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let st = AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size)
        return st == noErr && size > 0
    }

    /// No-op now that monitor is mixed in the playback callback. Kept as a
    /// hook for future device-side gain adjustments.
    private func applyMonitor() {}

    func stop() {
        guard isRunning else { return }
        teardownOutputAU()      // standalone HAL output AU
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
        selfLoopLock.lock();    selfLoopRing.removeAll(); selfLoopLock.unlock()
        peersLock.lock(); peers.removeAll(); peersLock.unlock()
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
        // Log mic peak + ring depths every ~1s so we can spot buffer drift.
        captureLogCounter &+= 1
        if captureLogCounter <= 3 || captureLogCounter % 400 == 0 {
            monitorRingLock.lock()
            let monDepth = monitorRing.count
            monitorRingLock.unlock()
            selfLoopLock.lock()
            let loopDepth = selfLoopRing.count
            selfLoopLock.unlock()
            AppLog.log("[AudioEngine] capture#\(captureLogCounter) peak=\(String(format: "%.4f", peak)) monRing=\(monDepth)smp selfLoop=\(loopDepth)smp")
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

        // Append and emit fixed-size frames (AudioWire.frameSamples = 32 at v6.0.0).
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

        // Server-side self-loopback. Server runs fullMix mode while we're
        // alone (gives us our own voice back so the user can hear that the
        // round-trip is alive) and switches to N-1 once peers join.
        // We don't add self to peerLevels — that would create a "peer
        // strip" for ourselves; instead we route into a dedicated ring
        // and the playback callback only mixes it when we're actually alone.
        if uid == mixer?.userId {
            selfLoopLock.lock()
            selfLoopRing.append(contentsOf: samples)
            // Trim to ~5ms target depth. The server-loopback path has no
            // explicit jitter buffer (unlike per-peer JitterBuffer); without
            // this, network bursts inflate the ring and listening latency
            // creeps up over the session. Trim is the same "drop oldest"
            // strategy JitterBuffer uses.
            if selfLoopRing.count > Self.selfLoopRingTrimSamples {
                selfLoopRing.removeFirst(selfLoopRing.count - Self.selfLoopRingTrimSamples)
            }
            selfLoopLock.unlock()
            Task { @MainActor in self.rxCount &+= 1 }
            return
        }

        peersLock.lock()
        var sink = peers[uid] ?? PeerSink()
        sink.jitter.push(samples, sequence: pkt.sequence)
        sink.lastFrame = samples
        peers[uid] = sink
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
            // of doubled audio when the mode actually does change.)
            selfLoopLock.lock()
            if !selfLoopRing.isEmpty { selfLoopRing.removeAll(keepingCapacity: true) }
            selfLoopLock.unlock()
        } else {
            // ── Server self-loopback mix-in (alone → server fullMix) ──────
            // Volume here is the same monitor knob — the user thinks "this
            // is my self-hear", regardless of which path delivers it.
            let monGain = monitorMuted ? 0 : monitorGain
            if monGain > 0 {
                selfLoopLock.lock()
                let take = min(frameCount, selfLoopRing.count)
                if take > 0 {
                    for i in 0..<take {
                        out[i] += selfLoopRing[i] * monGain
                    }
                    selfLoopRing.removeFirst(take)
                }
                selfLoopLock.unlock()
            }
            // Drain local monitor while alone — avoids a backlog explosion
            // before peers arrive. (Otherwise switching to with-peers mode
            // would suddenly play 1+ seconds of stale local monitor.)
            monitorRingLock.lock()
            if !monitorRing.isEmpty { monitorRing.removeAll(keepingCapacity: true) }
            monitorRingLock.unlock()
        }

        // ── Peer mix ──────────────────────────────────────────────────────
        // Pull a full frame from each peer; mix in. We pop at most one frame
        // per playback callback from each peer, sized to AudioWire.frameSamples.
        // If frameCount > AudioWire.frameSamples, we run the loop multiple times.
        var written = 0
        let frameSize = AudioWire.frameSamples
        while written < frameCount {
            let take = min(frameSize, frameCount - written)

            // Snapshot keys under lock — tiny window.
            peersLock.lock()
            let keys = Array(peers.keys)
            peersLock.unlock()

            for k in keys {
                peersLock.lock()
                var sink = peers[k]
                let result = sink?.jitter.pop()
                // Cache lastFrame on real frames so the meter has something
                // to display during silent stretches; PLC frames also count
                // since they ARE the most recent real audio.
                if case .real(let f) = result { sink?.lastFrame = f }
                if let s = sink { peers[k] = s }
                peersLock.unlock()
                if perPeerMuted[k] == true { continue }
                let g = perPeerGain[k] ?? 1.0
                // PopResult cases:
                //   .real(frame)         — fresh content from the ring
                //   .plc(frame, decay)   — last real frame, attenuated to
                //                          mask a brief gap (web parity)
                //   .silence             — gap exceeds PLC budget; skip
                switch result {
                case .real(let f):
                    let n = min(take, f.count)
                    for i in 0..<n { out[written + i] += f[i] * g }
                case .plc(let f, let decay):
                    let n = min(take, f.count)
                    let scaled = g * decay
                    for i in 0..<n { out[written + i] += f[i] * scaled }
                case .silence, .none:
                    continue
                }
            }
            written += take
        }

        // Output gain + soft clip.
        let g = outputGain
        for i in 0..<frameCount {
            var v = out[i] * g
            if v >  1.0 { v =  1.0 }
            if v < -1.0 { v = -1.0 }
            out[i] = v
        }
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

    /// UserDefaults key for the persisted HW IO buffer size (frames).
    /// 0 / missing = use `AudioWire.frameSamples` (32 at v6.0.0) default.
    static let bufferFramesKey   = "tonel.audio.hwBufferFrames"
    /// UserDefaults key for the persisted output device ID. Read at
    /// `start()` so the engine comes up routed to the user's choice
    /// even before `setOutputDevice()` is called explicitly.
    static let outputDeviceIDKey = "tonel.audio.outputDeviceID"
    /// UserDefaults key for the persisted requested sample rate (Double).
    /// 0 / missing = "auto" (use device's first available rate).
    static let sampleRateKey     = "tonel.audio.sampleRate"

    /// Public setter — applies a new HW IO buffer size live (no engine
    /// restart needed; CoreAudio accepts the property change on the
    /// running device) AND persists it for the next launch. The actual
    /// applied value is read back into `captureHwFrames` / `outputHwFrames`
    /// (both may differ from the requested value if the device clamps).
    func applyBufferFrames(_ frames: Int) {
        UserDefaults.standard.set(frames, forKey: AudioEngine.bufferFramesKey)
        setHardwareBufferFrames(target: UInt32(frames))
    }

    /// Read the device's `kAudioDevicePropertyBufferFrameSizeRange`. Picker
    /// in Settings filters its options against this so the user can't ask
    /// for something the driver will silently clamp anyway.
    /// Returns `(min, max)` in frames, or `(15, 4096)` as a safe fallback
    /// when the device can't be queried.
    func bufferFrameRange() -> (Int, Int) {
        // Prefer the bare outputAU's device. Fall back to whatever
        // AVAudioEngine reports if outputAU isn't up yet (Home screen
        // with engine stopped — we can still query a sensible range
        // through the AVAudioEngine outputNode placeholder).
        let au = outputAU ?? engine.outputNode.audioUnit
        guard let au = au else { return (15, 4096) }
        var deviceID: AudioDeviceID = 0
        var devSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                   kAudioUnitScope_Global, 0, &deviceID, &devSize) == noErr,
              deviceID != 0 else { return (15, 4096) }
        var range = AudioValueRange()
        var rangeSize = UInt32(MemoryLayout<AudioValueRange>.size)
        var rangeAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyBufferFrameSizeRange,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(deviceID, &rangeAddr, 0, nil, &rangeSize, &range) == noErr
        else { return (15, 4096) }
        return (Int(range.mMinimum), Int(range.mMaximum))
    }

    /// Drive the actual Core Audio device's IO buffer frame size as low as
    /// the device will permit — macOS will silently clamp if our target is
    /// outside the device's range. 256 frames ≈ 5.3 ms @ 48 kHz, suitable
    /// for live monitoring on USB pro interfaces (SSL 2+, RME, etc.).
    /// AVAudioEngine on its own often leaves this at 4096+ for power.
    private func setHardwareBufferFrames(target: UInt32) {
        // Output side now uses the standalone HAL AU; fall back to
        // AVAudioEngine.outputNode only if outputAU isn't up yet.
        let outputAUForBuffer = outputAU ?? engine.outputNode.audioUnit
        for which in [
            (engine.inputNode.audioUnit,  "input"),
            (outputAUForBuffer,            "output"),
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
        // Aligned with web `audioE2eLatency`:
        //   server-jitter avg wait = (target − 0.5) × frameMs
        //   server-tick           = frameMs (full tick, not half)
        // Total invariant vs the previous (target × F + F/2) split.
        let serverJitterMs   = max(0, (Double(serverJitterTargetFrames) - 0.5) * frameMs)
        let serverMixWaitMs  = frameMs
        // Realtime client-jitter = current JitterBuffer fill, mirroring
        // web's `playRingFill / sr`. Was static `primeMin × frameMs`,
        // i.e. a dead 5 ms that never reflected actual buffer depth.
        let clientJitterMs   = Double(currentJitterDepthFrames()) * frameMs
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
        let srvJ = Int((max(0, (Double(serverJitterTargetFrames) - 0.5) * frameMs)).rounded())
        let srvT = Int(frameMs.rounded())
        let cliJ = Int((Double(currentJitterDepthFrames()) * frameMs).rounded())
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

    /// Current output device the AU is routed to. The Settings picker
    /// reads this on appear so it shows the actual device, not just the
    /// first one in the enumeration. Returns 0 on failure.
    func currentOutputDeviceID() -> AudioDeviceID {
        // Prefer the live outputAU's CurrentDevice (running engine);
        // fall back to UserDefaults when the engine isn't started yet
        // so the picker on Home page can still seed the right value.
        if let au = outputAU {
            return currentAUDeviceID(unit: au)
        }
        let saved = AudioDeviceID(UserDefaults.standard.integer(forKey: AudioEngine.outputDeviceIDKey))
        if saved != 0 { return saved }
        return AudioEngine.systemDefaultOutputDevice()
    }
    func currentInputDeviceID() -> AudioDeviceID {
        currentAUDeviceID(unit: engine.inputNode.audioUnit)
    }
    private func currentAUDeviceID(unit: AudioUnit?) -> AudioDeviceID {
        guard let au = unit else { return 0 }
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global, 0, &deviceID, &size)
        return status == noErr ? deviceID : 0
    }

    /// Switch the engine's playback device.
    ///
    /// Earlier versions assumed AVAudioEngine could hot-swap the AUHAL's
    /// `kAudioOutputUnitProperty_CurrentDevice` live. In practice the AU
    /// returns `-19851` on macOS once it's been initialized — even when
    /// the engine is "stopped" the underlying AU may still be in an
    /// initialized state from a previous prepare(). The reliable pattern
    /// is the same one `setInputDevice` already uses: stop the engine,
    /// swap the device, restart. Persist the choice (via UserDefaults
    /// in the caller) so it survives across launches.
    func setOutputDevice(_ deviceID: AudioDeviceID) throws {
        // Persist immediately so the choice survives a restart even
        // when the engine isn't running (Home screen, before any join).
        UserDefaults.standard.set(Int(deviceID), forKey: AudioEngine.outputDeviceIDKey)
        // If we have a live HAL output AU, swap its device in place via
        // the documented Uninit/Set/Init dance. We OWN this AU outright
        // so it actually uninitializes when asked (unlike the AVAudioEngine
        // outputNode which kept stealing our state).
        if let au = outputAU {
            AudioOutputUnitStop(au)
            try setAUDevice(unit: au, deviceID: deviceID, label: "output")
            let st = AudioOutputUnitStart(au)
            if st != noErr {
                AppLog.log("[AudioEngine] outputAU restart after device swap failed: \(st)")
            }
        }
        // No-op when engine isn't running yet — the saved preference
        // gets read on the next `start()` → `setupOutputAU`.
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
        // CurrentDevice can only be changed when the AU is uninitialized.
        // `engine.stop()` pauses IO but doesn't uninitialize the AU on
        // macOS, so a naive set returns -10851 (InvalidPropertyValue) /
        // -19851 from AUHAL. Explicitly bracket the write with
        // Uninitialize / Initialize. The Uninitialize/Initialize calls
        // are idempotent and tolerate "already in this state" — checking
        // the return is informational only.
        let uninit = AudioUnitUninitialize(au)
        var did = deviceID
        let status = AudioUnitSetProperty(au,
                                          kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global,
                                          0, &did,
                                          UInt32(MemoryLayout<AudioDeviceID>.size))
        // Re-initialize regardless so we don't leave the AU in a
        // half-baked state when the set fails.
        let reinit = AudioUnitInitialize(au)
        if status != noErr {
            throw NSError(domain: "Tonel", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey:
                              "切换 \(label) 设备失败 (status=\(status), uninit=\(uninit), reinit=\(reinit))"])
        }
        AppLog.log("[AudioEngine] switched \(label) device → id=\(deviceID) uninit=\(uninit) reinit=\(reinit)")
    }

    /// Force a different device sample-rate via CoreAudio HAL's
    /// `kAudioDevicePropertyNominalSampleRate`. Applied to the input
    /// device the engine is currently routed to. The engine's wire
    /// format stays at 48 kHz — if the device sample rate doesn't match,
    /// AVAudioEngine inserts a linear resampler between the AU and the
    /// tap (visible as `mic native fmt: <rate>` in the audio log).
    ///
    /// `nil` = restore the device's default rate (typically the system
    /// preference set in Audio MIDI Setup).
    func setInputDeviceSampleRate(_ rate: Double?) {
        // Persist immediately. nil → 0 sentinel meaning "auto".
        UserDefaults.standard.set(rate ?? 0, forKey: AudioEngine.sampleRateKey)
        // Take a snapshot of which device we're talking to. Reading
        // the AU property each time means the picker can drive a rate
        // change after the user swapped the input device too.
        guard let au = engine.inputNode.audioUnit else {
            AppLog.log("[AudioEngine] setInputDeviceSampleRate: no inputNode AU")
            return
        }
        var deviceID: AudioDeviceID = 0
        var devSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        let getStatus = AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                             kAudioUnitScope_Global, 0, &deviceID, &devSize)
        guard getStatus == noErr, deviceID != 0 else {
            AppLog.log("[AudioEngine] setInputDeviceSampleRate: getCurrentDevice err \(getStatus)")
            return
        }

        // Resolve target rate. nil → first available rate from the device's
        // declared list as a "default" fallback (HAL doesn't expose a
        // single 'preferred' rate).
        let targetRate: Double = rate ?? deviceDefaultSampleRate(deviceID: deviceID)
                                           ?? Double(AudioWire.sampleRate)

        var newRate = targetRate
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let setStatus = AudioObjectSetPropertyData(deviceID, &addr, 0, nil,
                                                   UInt32(MemoryLayout<Double>.size), &newRate)
        if setStatus != noErr {
            AppLog.log("[AudioEngine] setInputDeviceSampleRate(\(targetRate)) failed status=\(setStatus) device=\(deviceID)")
            return
        }
        // Read back what the device actually applied (it may clamp or
        // pick the closest supported rate).
        var actual: Double = 0
        var actualSize = UInt32(MemoryLayout<Double>.size)
        AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &actualSize, &actual)
        AppLog.log("[AudioEngine] device=\(deviceID) sample rate set: req=\(targetRate) actual=\(actual)")
        Task { @MainActor in self.actualSampleRate = actual > 0 ? actual : targetRate }
    }

    /// Read the device's first available rate from
    /// `kAudioDevicePropertyAvailableNominalSampleRates`. Used as a
    /// fallback for the "auto" picker option.
    private func deviceDefaultSampleRate(deviceID: AudioDeviceID) -> Double? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyAvailableNominalSampleRates,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(deviceID, &addr, 0, nil, &size) == noErr,
              size > 0 else { return nil }
        let count = Int(size) / MemoryLayout<AudioValueRange>.size
        var ranges = [AudioValueRange](repeating: AudioValueRange(), count: count)
        guard AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &ranges) == noErr
        else { return nil }
        return ranges.first?.mMinimum
    }
}

/// Simple value type for output device picker.
struct AudioDeviceInfo: Hashable, Identifiable {
    let id: AudioDeviceID
    let name: String
}
