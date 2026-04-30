import SwiftUI
import AppKit
import CoreAudio

/// Room screen — visual / functional parity with web `RoomPage.tsx`:
///   • header: room id (3-tap → debug panel) · 复制 · ⚙ 设置 · MIC ON/OFF
///     · 延迟 (e2e + RTT) · 离开房间
///   • optional output-latency banner / init-error banner
///   • monospace debug status line + TEST TONE
///   • MIXER section: self-monitor strip + peer strips (union of signaling
///     peers and mixer LEVELS, "等待其他乐手加入…" empty hint)
///   • INPUT TRACKS section: per-channel input strip + + 添加输入
///   • SettingsSheet (output device + sample rate)
struct RoomView: View {
    @EnvironmentObject var state: AppState

    /// Snapshot of audio-engine values that drive the UI. Refreshed in the
    /// `pollPub` tick. AppState doesn't republish when its `audio`
    /// `@Published` values change, so writing them into local `@State`
    /// is what actually causes SwiftUI to re-render the meter.
    @State private var inputLevelTick: Float = 0
    @State private var peerLevelsTick: [String: Float] = [:]
    @State private var txTick: Int = 0
    @State private var rxTick: Int = 0

    // Local UI state.
    @State private var settingsOpen = false
    @State private var debugOpen = false
    @State private var copied = false
    @State private var soloId: String? = nil
    @State private var monitorVolume: Double = 100   // default ON so user hears self
    @State private var monitorMuted: Bool = false
    @State private var showInitError = false
    @State private var initError: String? = nil

    // Per-peer fader state (volume 0–100 + mute), keyed by peer uid.
    @State private var peerVolumes: [String: Double] = [:]
    @State private var peerMuted:   [String: Bool]   = [:]
    @State private var peerSoloed:  [String: Bool]   = [:]

    // Local input channels — currently engine-side capture is single-channel.
    // The UI shows N stripping rows; channel 0 routes to the live engine.
    struct InputChannel: Identifiable, Hashable {
        let id: String
        var deviceId: AudioDeviceID = 0
        var volume: Double = 100
        var muted: Bool = false
    }
    @State private var inputChannels: [InputChannel] = [InputChannel(id: "ch-0")]
    @State private var inputDevices: [AudioDeviceInfo] = []

    @State private var debugLine = "starting…"
    private let pollPub = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            header
            banners
            debugBar
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    mixerSection
                    inputTracksSection
                }
                .padding(20)
            }
        }
        .background(Color(red: 0.07, green: 0.07, blue: 0.09))
        .onAppear { refreshInputDevices() }
        .onReceive(pollPub) { _ in
            // Pull the engine's published values into local @State so SwiftUI
            // re-renders. `state.audio` is owned by AppState and its @Published
            // updates do NOT bubble through AppState — without this the meter
            // is frozen at 0 even though capture is running.
            inputLevelTick = state.audio.inputLevel
            peerLevelsTick = state.audio.peerLevels
            txTick = state.audio.txCount
            rxTick = state.audio.rxCount
            state.refreshLevels()
            refreshDebug()
        }
        .sheet(isPresented: $settingsOpen) {
            SettingsSheet(audio: state.audio).environmentObject(state)
        }
        .sheet(isPresented: $debugOpen) {
            AudioDebugSheet(audio: state.audio).environmentObject(state)
        }
    }

    // ─── Header ───────────────────────────────────────────────────────────────

    private var header: some View {
        HStack(spacing: 16) {
            // Room id + copy
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("房间号").font(.system(size: 10))
                        .foregroundStyle(Color(white: 0.5))
                    Text(state.roomId)
                        .font(.system(size: 18, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                        .onTapGesture(count: 3) { debugOpen.toggle() }
                        .help("(三连点切换调试面板)")
                }
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(state.roomId, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }
                } label: {
                    Text(copied ? "已复制" : "复制")
                        .font(.system(size: 12))
                        .foregroundStyle(copied ? .green : Color(white: 0.85))
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Color(white: 0.13),
                                    in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
            }

            Spacer()

            // ⚙ 设置
            Button {
                settingsOpen = true
            } label: {
                Text("⚙ 设置").font(.system(size: 13))
                    .foregroundStyle(Color(white: 0.7))
            }
            .buttonStyle(.plain)

            // MIC ON/OFF
            Button {
                state.audio.isMicMuted.toggle()
            } label: {
                Text(state.audio.isMicMuted ? "MIC OFF" : "MIC ON")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(state.audio.isMicMuted ? .white : Color(white: 0.95))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(state.audio.isMicMuted
                                ? Color(red: 0.55, green: 0.10, blue: 0.10)
                                : Color(red: 0.10, green: 0.40, blue: 0.20),
                                in: RoundedRectangle(cornerRadius: 4))
            }
            .buttonStyle(.plain)

            latencyDisplay

            Button {
                state.leaveRoom()
            } label: {
                Text("离开房间")
                    .font(.system(size: 12))
                    .foregroundStyle(Color(white: 0.85))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Color(white: 0.15),
                                in: RoundedRectangle(cornerRadius: 4))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .background(Color(red: 0.10, green: 0.10, blue: 0.12))
        .overlay(Rectangle()
            .frame(height: 1)
            .foregroundStyle(Color.white.opacity(0.05)),
            alignment: .bottom)
    }

    private var latencyDisplay: some View {
        let e2e = state.audio.e2eLatencyMs
        let rtt = state.signal.latencyMs
        return HStack(spacing: 6) {
            Text("延迟").font(.system(size: 10))
                .foregroundStyle(Color(white: 0.5))
            Text(e2e > 0 ? "\(e2e)ms" : "--")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(latencyColor(e2e <= 0 ? -1 : e2e, good: 100, ok: 200))
            Text("·").foregroundStyle(Color(white: 0.4))
            Text("RTT").font(.system(size: 10))
                .foregroundStyle(Color(white: 0.5))
            Text(rtt >= 0 ? "\(rtt)ms" : "--")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(latencyColor(rtt < 0 ? -1 : rtt, good: 50, ok: 100))
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background(Color(white: 0.10),
                    in: RoundedRectangle(cornerRadius: 4))
        .help("端到端 = capture + RTT + server jitter + mix + client ring + output device")
    }

    private func latencyColor(_ ms: Int, good: Int, ok: Int) -> Color {
        if ms < 0     { return Color(white: 0.5) }
        if ms < good  { return .green }
        if ms < ok    { return .yellow }
        return .red
    }

    // ─── Banners ───────────────────────────────────────────────────────────

    @ViewBuilder
    private var banners: some View {
        if state.audio.outputLatencyMs > 30 {
            warningBanner(
                "⚠ 检测到高延迟输出设备（约 \(state.audio.outputLatencyMs)ms）。蓝牙耳机会让端到端延迟增加 100ms 以上，建议改用有线耳机或 USB 声卡。",
                color: Color(red: 0.23, green: 0.16, blue: 0.05)
            )
        }
        if let e = initError, !e.isEmpty {
            warningBanner("⚠ \(e)",
                          color: Color(red: 0.23, green: 0.05, blue: 0.05))
        }
    }

    private func warningBanner(_ text: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(.white)
            Spacer()
        }
        .padding(.horizontal, 24).padding(.vertical, 8)
        .background(color)
    }

    // ─── Debug bar ────────────────────────────────────────────────────────

    private var debugBar: some View {
        HStack(spacing: 8) {
            Text(debugLine)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.green)
                .lineLimit(1).truncationMode(.tail)
            Spacer()
            Button("TEST TONE") { playTestTone() }
                .buttonStyle(.borderless)
                .font(.system(size: 10))
                .foregroundStyle(.green)
        }
        .padding(.horizontal, 24).padding(.vertical, 4)
        .background(.black)
    }

    // ─── MIXER section ────────────────────────────────────────────────────

    private var peerCount: Int {
        // Union of signaling peers and active peerLevels, exclude self.
        var ids = Set(state.peers.map(\.userId))
        for k in state.audio.peerLevels.keys where k != state.userId {
            ids.insert(k)
        }
        return ids.count
    }

    private var mixerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader(label: "MIXER", count: peerCount + 1)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    // Self-monitor strip
                    ChannelStripView(
                        title: state.phone.isEmpty ? "YOU · Mon"
                                                   : "\(state.phone) · Mon",
                        subtitle: nil,
                        level: inputLevelTick,
                        isSelf: true,
                        volume: $monitorVolume,
                        muted: $monitorMuted,
                        soloed: .constant(false),
                        showSolo: false,
                        onVolumeChange: { v in
                            state.audio.monitorGain = Float(v / 100.0)
                        },
                        onMuteChange: { m in
                            state.audio.monitorMuted = m
                        }
                    )

                    // Union list of peer ids — signaling peers + mixer LEVELS keys.
                    let peerIds = unionPeerIds()
                    if peerIds.isEmpty {
                        Text("等待其他乐手加入…")
                            .foregroundStyle(Color(white: 0.45))
                            .font(.system(size: 13))
                            .padding(.horizontal, 24).padding(.vertical, 50)
                    } else {
                        ForEach(peerIds, id: \.self) { uid in
                            peerStrip(uid: uid)
                        }
                    }
                }
                .padding(.horizontal, 4)
            }
        }
    }

    private func unionPeerIds() -> [String] {
        var ids = Set(state.peers.map(\.userId))
        for k in state.audio.peerLevels.keys where k != state.userId {
            ids.insert(k)
        }
        ids.remove(state.userId)
        return ids.sorted()
    }

    private func peerStrip(uid: String) -> some View {
        let level = peerLevelsTick[uid] ?? 0
        let volBinding = Binding<Double>(
            get: { peerVolumes[uid] ?? 100 },
            set: { peerVolumes[uid] = $0 }
        )
        let muteBinding = Binding<Bool>(
            get: { peerMuted[uid] ?? false },
            set: { peerMuted[uid] = $0 }
        )
        let soloBinding = Binding<Bool>(
            get: { peerSoloed[uid] ?? false },
            set: { peerSoloed[uid] = $0 }
        )
        return ChannelStripView(
            title: String(uid.suffix(8)),
            subtitle: nil,
            level: level,
            isSelf: false,
            volume: volBinding,
            muted: muteBinding,
            soloed: soloBinding,
            onVolumeChange: { v in
                state.audio.setPeerGain(uid, gain: Float(v / 100.0))
            },
            onMuteChange: { m in
                state.audio.setPeerMuted(uid, muted: m)
            },
            onSoloChange: { s in
                soloId = s ? uid : nil
                state.audio.outputGain = (s && uid == state.userId) ? 0.0 : 1.0
            }
        )
    }

    // ─── INPUT TRACKS section ──────────────────────────────────────────────

    private var inputTracksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader(label: "INPUT TRACKS", count: inputChannels.count)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(Array(inputChannels.enumerated()), id: \.element.id) { idx, ch in
                        let channelBinding = bindingForChannel(at: idx)
                        InputChannelStripView(
                            channelLabel: "MIC \(idx + 1)",
                            inputDevices: inputDevices,
                            selectedDeviceId: Binding(
                                get: { inputChannels[idx].deviceId },
                                set: { inputChannels[idx].deviceId = $0 }
                            ),
                            canRemove: inputChannels.count > 1,
                            level: idx == 0 ? inputLevelTick : 0,
                            volume: channelBinding.volume,
                            muted: channelBinding.muted,
                            onDeviceChange: { newId in
                                inputChannels[idx].deviceId = newId
                                if idx == 0 {
                                    // Channel 0 drives the live engine.
                                    do {
                                        try state.audio.setInputDevice(newId)
                                    } catch {
                                        state.lastError =
                                            "切换输入设备失败：\(error.localizedDescription)"
                                    }
                                }
                            },
                            onRemove: {
                                inputChannels.remove(at: idx)
                            },
                            onVolumeChange: { v in
                                if idx == 0 {
                                    state.audio.inputGain = Float(v / 100.0)
                                }
                            },
                            onMuteChange: { m in
                                if idx == 0 { state.audio.isMicMuted = m }
                            }
                        )
                    }

                    Button {
                        let next = "ch-\(inputChannels.count)"
                        inputChannels.append(InputChannel(id: next))
                    } label: {
                        Text("＋ 添加输入")
                            .font(.system(size: 13))
                            .foregroundStyle(Color(red: 0.62, green: 0.95, blue: 0.62))
                            .frame(width: 96, height: 252)
                            .background(
                                RoundedRectangle(cornerRadius: 4)
                                    .strokeBorder(Color(red: 0.29, green: 0.48, blue: 0.29),
                                                  style: StrokeStyle(lineWidth: 2, dash: [4, 4]))
                            )
                            .background(
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color(red: 0.10, green: 0.23, blue: 0.10))
                            )
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 4)
            }
        }
    }

    private func bindingForChannel(at idx: Int)
    -> (volume: Binding<Double>, muted: Binding<Bool>) {
        return (
            volume: Binding(
                get: { inputChannels[idx].volume },
                set: { inputChannels[idx].volume = $0 }
            ),
            muted: Binding(
                get: { inputChannels[idx].muted },
                set: { inputChannels[idx].muted = $0 }
            )
        )
    }

    // ─── Misc helpers ──────────────────────────────────────────────────────

    private func sectionHeader(label: String, count: Int) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(Color(white: 0.55))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color(white: 0.12),
                            in: RoundedRectangle(cornerRadius: 3))
            Text("\(count) CH")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color(white: 0.5))
            Spacer()
        }
    }

    private func refreshDebug() {
        let a = state.audio
        let uid = String(state.userId.prefix(14))
        let muteFlag = a.isMicMuted ? " MUTED" : ""
        debugLine = "uid=\(uid) peers=\(state.peers.count) sr=\(Int(a.actualSampleRate)) " +
                    "tx=\(a.txCount) rx=\(a.rxCount) clip=\(a.captureClipCount) " +
                    "gap=\(a.seqGapCount) drop=\(a.ringDropCount)\(muteFlag)"
    }

    private func refreshInputDevices() {
        inputDevices = AudioEngine.listInputDevices()
    }

    private func playTestTone() {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: format)
        let frames = AVAudioFrameCount(48000 / 2)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        buf.frameLength = frames
        let data = buf.floatChannelData![0]
        let twoPi = 2.0 * Float.pi
        for i in 0..<Int(frames) {
            data[i] = sin(twoPi * 440.0 * Float(i) / 48000.0) * 0.3
        }
        try? engine.start()
        player.scheduleBuffer(buf, at: nil) { engine.stop() }
        player.play()
    }
}

import AVFoundation

// ─── Settings sheet ───────────────────────────────────────────────────────────

struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var audio: AudioEngine
    @State private var outputDevices: [AudioDeviceInfo] = []
    @State private var selectedOutput: AudioDeviceID = 0
    @State private var requestedRate: Double? = nil

    private let supportedRates: [Double] = [44100, 48000, 96000]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("设置").font(.system(size: 22, weight: .bold))
                Spacer()
                Button("×") { dismiss() }.buttonStyle(.borderless)
            }

            section("音频设备") {
                Text("输入设备已移至 INPUT TRACKS 内的每个通道条 — 每个输入通道可独立选择麦克风。")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.55))
                row("输出") {
                    Picker("", selection: $selectedOutput) {
                        ForEach(outputDevices, id: \.id) { d in
                            Text(d.name).tag(d.id)
                        }
                    }
                    .labelsHidden()
                    .onChange(of: selectedOutput) { _, new in
                        try? audio.setOutputDevice(new)
                    }
                }
            }

            section("采样率") {
                row("请求") {
                    Picker("", selection: Binding(
                        get: { requestedRate ?? -1 },
                        set: { requestedRate = $0 < 0 ? nil : $0 }
                    )) {
                        Text("自动 (系统默认)").tag(-1.0)
                        ForEach(supportedRates, id: \.self) { r in
                            Text("\(Int(r)) Hz\(r == 48000 ? " (匹配传输速率)" : "")")
                                .tag(r)
                        }
                    }
                    .labelsHidden()
                    .onChange(of: requestedRate) { _, new in
                        audio.setInputDeviceSampleRate(new)
                    }
                }
                Text("实际：\(Int(audio.actualSampleRate)) Hz" +
                     (audio.actualSampleRate == 48000
                      ? " — 与传输速率匹配，无重采样" : " — 链路两端会做线性重采样"))
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.6))
                Text("选择 48000 Hz 可绕过采集 / 播放两侧的重采样器。修改输出设备会立即生效。")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.45))
            }

            HStack { Spacer()
                Button("好") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 460)
        .background(Color(red: 0.10, green: 0.10, blue: 0.12))
        .onAppear {
            outputDevices = AudioEngine.listOutputDevices()
            if let first = outputDevices.first { selectedOutput = first.id }
        }
    }

    @ViewBuilder
    private func section<C: View>(_ title: String,
                                  @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color(white: 0.85))
            content()
        }
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private func row<C: View>(_ label: String,
                              @ViewBuilder content: () -> C) -> some View {
        HStack {
            Text(label).font(.system(size: 12))
                .foregroundStyle(Color(white: 0.7))
                .frame(width: 60, alignment: .leading)
            content()
        }
    }
}

// ─── Audio debug sheet (toggled via 3-tap on room id) ─────────────────────────

struct AudioDebugSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var audio: AudioEngine
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Audio Debug").font(.system(size: 18, weight: .bold))
                Spacer()
                Button("关闭") { dismiss() }.buttonStyle(.borderless)
            }
            Group {
                row("running",  "\(audio.isRunning)")
                row("input lvl", String(format: "%.3f", audio.inputLevel))
                row("tx",       "\(audio.txCount)")
                row("rx",       "\(audio.rxCount)")
                row("seq gap",  "\(audio.seqGapCount)")
                row("ring drop","\(audio.ringDropCount)")
                row("clip",     "\(audio.captureClipCount)")
                row("e2e ms",   "\(audio.e2eLatencyMs)")
                row("sr",       "\(Int(audio.actualSampleRate))")
                row("peers",    "\(audio.peerLevels.count)")
            }
        }
        .padding(20)
        .frame(width: 360)
        .background(Color.black)
        .foregroundStyle(.green)
        .font(.system(size: 12, design: .monospaced))
    }
    private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k).foregroundStyle(Color.green.opacity(0.6)); Spacer(); Text(v) }
    }
}

#Preview {
    RoomView().environmentObject(AppState())
        .preferredColorScheme(.dark)
}
