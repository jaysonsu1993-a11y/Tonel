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
    @State private var rttTick: Int = -1
    @State private var e2eTick: Int = 0

    // Local UI state.
    @State private var settingsOpen = false
    @State private var debugOpen = false
    @State private var switchRoomOpen = false
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
            rttTick = state.mixer.audioRttMs
            e2eTick = state.audio.computeE2eLatencyMs(
                audioRttMs: state.mixer.audioRttMs,
                serverJitterTargetFrames: state.mixer.serverJitterTargetFrames)
            state.refreshLevels()
            refreshDebug()
        }
        .sheet(isPresented: $settingsOpen) {
            SettingsSheet(audio: state.audio).environmentObject(state)
        }
        .sheet(isPresented: $debugOpen) {
            AudioDebugSheet(audio: state.audio).environmentObject(state)
        }
        .sheet(isPresented: $switchRoomOpen) {
            SwitchRoomSheet().environmentObject(state)
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
                    Text(state.currentRoomId)
                        .font(.system(size: 18, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                        .onTapGesture(count: 3) { debugOpen.toggle() }
                        .help("(三连点切换调试面板)")
                }
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(state.currentRoomId, forType: .string)
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

            // v6.2.0: 离开房间 → 切换房间. There is no "logged out"
            // state anymore — the user is always in some room. This
            // button opens a sheet to enter a different room id.
            Button {
                switchRoomOpen = true
            } label: {
                Text("切换房间")
                    .font(.system(size: 12))
                    .foregroundStyle(Color(white: 0.85))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Color(white: 0.15),
                                in: RoundedRectangle(cornerRadius: 4))
            }
            .buttonStyle(.plain)
            // Quick path home: when the user is in someone else's room
            // and wants back to their own, this is one click instead of
            // typing the room id.
            if state.currentRoomId != state.myRoomId {
                Button {
                    state.returnToMyRoom()
                } label: {
                    Text("返回我的房间")
                        .font(.system(size: 12))
                        .foregroundStyle(Color(white: 0.85))
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Color(red: 0.10, green: 0.30, blue: 0.50),
                                    in: RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .background(Color(red: 0.10, green: 0.10, blue: 0.12))
        .overlay(Rectangle()
            .frame(height: 1)
            .foregroundStyle(Color.white.opacity(0.05)),
            alignment: .bottom)
    }

    private var latencyDisplay: some View {
        // RTT = mixer TCP-direct PING/PONG (~8ms to Kufan), NOT signaling
        // WS RTT (which routes through Cloudflare AMS and is irrelevant
        // for audio). Web does the same — the displayed RTT is `audioLatency`.
        let e2e = e2eTick
        let rtt = rttTick
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
        .help("延迟 (e2e) = 采集 HW + RTT + 服务器 jitter + mix tick + 客户端 jitter + 输出 HW；RTT = 与 mixer 的 TCP 直连往返（不经 CF）")
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
                    // Self-monitor strip. v6.2.0: there's no `phone` field
                    // anymore (removed with the login flow). Show "YOU"
                    // labelled with the last 4 chars of the user id so
                    // the user can tell their own strip apart at a glance.
                    ChannelStripView(
                        title: "YOU · \(String(state.userId.suffix(4)))",
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
        // e2e breakdown: visualise each component so the user sees what
        // dominates the audio delay.
        let bd = a.e2eBreakdown(
            audioRttMs: state.mixer.audioRttMs,
            serverJitterTargetFrames: state.mixer.serverJitterTargetFrames)
        let bdStr = bd.map { "\($0.0)=\($0.1)" }.joined(separator: " ")
        debugLine = "uid=\(uid) peers=\(state.peers.count) sr=\(Int(a.actualSampleRate)) " +
                    "tx=\(a.txCount) rx=\(a.rxCount) clip=\(a.captureClipCount) " +
                    "gap=\(a.seqGapCount) drop=\(a.ringDropCount)\(muteFlag) | e2e: \(bdStr)"
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
    @EnvironmentObject var state: AppState
    @ObservedObject var audio: AudioEngine
    @State private var outputDevices: [AudioDeviceInfo] = []
    @State private var selectedOutput: AudioDeviceID = 0
    @State private var requestedRate: Double? = nil
    @State private var outputError: String? = nil
    @AppStorage(AudioEngine.bufferFramesKey) private var bufferFrames: Int = AudioWire.frameSamples
    @State private var deviceFrameRange: (Int, Int) = (15, 4096)
    /// Bound to @AppStorage so the picker reflects the user's last
    /// selection persistently. Selection-time changes flow through
    /// `state.applyTransportSelection(...)` which actually swaps the
    /// live mixer.
    @AppStorage(Endpoints.serverIdKey)      private var serverId: String      = Endpoints.defaultServer.id
    @AppStorage(Endpoints.transportModeKey) private var transportRaw: String  = Endpoints.defaultTransport.rawValue

    private let supportedRates: [Double] = [44100, 48000, 96000]
    /// Common IO buffer sizes shown in the picker. Each value is the
    /// "official" size for typical low-latency audio drivers — picking
    /// outside these is fine but rarely useful. Sample rate is 48 kHz so
    /// the ms readout is `frames / 48`.
    private let bufferOptions: [Int] = [32, 64, 96, 120, 128, 240, 256, 480, 512, 1024, 2048, 4096]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("设置").font(.system(size: 22, weight: .bold))
                Spacer()
                Button("×") { dismiss() }.buttonStyle(.borderless)
            }

            // ── 服务器 / 传输模式 ─────────────────────────────────────
            // v6.2.0: changing either picker now triggers an automatic
            // tear-down + reconnect (`AppState.applyTransportSelection`),
            // so the user can change them anytime — no need to leave a
            // room first. The `lastError` alert covers reconnect
            // failure.
            section("服务器与传输模式") {
                row("服务器") {
                    Picker("", selection: $serverId) {
                        ForEach(Endpoints.allServers) { s in
                            Text(s.displayName)
                                .tag(s.id)
                                .foregroundStyle(s.isAvailable ? .primary : .secondary)
                        }
                    }
                    .labelsHidden()
                    .onChange(of: serverId) { _, _ in applyServerTransportChange() }
                }
                row("协议") {
                    Picker("", selection: $transportRaw) {
                        ForEach(TransportMode.allCases) { t in
                            Text(t.displayName).tag(t.rawValue)
                        }
                    }
                    .labelsHidden()
                    .onChange(of: transportRaw) { _, _ in applyServerTransportChange() }
                }
                Text("UDP 是默认（最低延迟）；WSS 是兜底，仅当所在网络封锁直连 UDP 时使用。连不上不会自动切换 —— 由你手动改。切换会重连当前房间。")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.45))
            }

            // ── 身份 (v6.2.0) ─────────────────────────────────────────
            // The user has a persistent local identity (userId +
            // myRoomId) generated on first launch. 重置身份 wipes both
            // and forces a reconnect with fresh ids — useful when
            // bandmates' clients are stuck on the user's old uid
            // (session-replaced loops) or the user just wants a new
            // personal room number.
            section("身份") {
                row("用户ID") {
                    Text(state.userId)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color(white: 0.6))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                row("我的房间") {
                    Text(state.myRoomId)
                        .font(.system(size: 13, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                    Spacer()
                    Button("复制") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(state.myRoomId, forType: .string)
                    }
                    .buttonStyle(.borderless)
                    .font(.system(size: 11))
                }
                Button {
                    state.resetIdentity()
                    dismiss()
                } label: {
                    Text("重置身份（生成新的用户 ID 与房间号）")
                        .font(.system(size: 12))
                        .foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
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
                    .onChange(of: selectedOutput) { old, new in
                        // Skip the spurious onChange that fires when we
                        // seed `selectedOutput` to the current device on
                        // appear — old==0 is the SwiftUI initial state
                        // before `.onAppear` runs.
                        guard old != 0, old != new else { return }
                        do {
                            try audio.setOutputDevice(new)
                        } catch {
                            AppLog.log("[Settings] setOutputDevice(\(new)) failed: \(error)")
                            outputError = error.localizedDescription
                        }
                    }
                }
                if let outputError = outputError {
                    Text("输出切换失败: \(outputError)")
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                }
            }

            section("硬件缓冲块大小") {
                row("frames") {
                    Picker("", selection: $bufferFrames) {
                        // Filter to options the driver can actually accept;
                        // anything outside [min, max] gets silently clamped
                        // by CoreAudio so showing it would mislead the user.
                        ForEach(bufferOptions.filter {
                            $0 >= deviceFrameRange.0 && $0 <= deviceFrameRange.1
                        }, id: \.self) { f in
                            Text("\(f) (\(String(format: "%.1f", Double(f) / 48.0)) ms)")
                                .tag(f)
                        }
                    }
                    .labelsHidden()
                    .onChange(of: bufferFrames) { _, new in
                        audio.applyBufferFrames(new)
                    }
                }
                Text("实际：input \(audio.captureHwFrames) / output \(audio.outputHwFrames) (\(String(format: "%.1f", Double(audio.captureHwFrames) / 48.0)) / \(String(format: "%.1f", Double(audio.outputHwFrames) / 48.0)) ms)")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.6))
                Text("设备允许范围：\(deviceFrameRange.0) – \(deviceFrameRange.1) frames。值越小延迟越低，但越容易出现 underrun 破音；笔记本内置麦/扬声器通常需要 256+。修改立即生效，重启 app 后保留。")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(white: 0.45))
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
            // Seed selectedOutput to the device the AU is currently using,
            // not just the first enumerated one — otherwise picking the
            // current device looks like a no-op (onChange doesn't fire
            // when value stays the same).
            let current = audio.currentOutputDeviceID()
            if outputDevices.contains(where: { $0.id == current }) {
                selectedOutput = current
            } else if let first = outputDevices.first {
                selectedOutput = first.id
            }
            deviceFrameRange = audio.bufferFrameRange()
            // Restore the user's last sample-rate choice from UserDefaults.
            // 0 (or missing) means "auto" → leave requestedRate=nil so the
            // Binding's get returns -1.0 and the "自动" tag gets selected.
            let savedRate = UserDefaults.standard.double(forKey: AudioEngine.sampleRateKey)
            requestedRate = savedRate > 0 ? savedRate : nil
        }
    }

    /// Push the picker selections through to AppState. The picker uses
    /// raw String tags (so @AppStorage can be String-typed across
    /// AppStorage limitations); we map back to the typed values here.
    /// AppState refuses the swap if the user is in a room — UI greys
    /// the pickers in that case so it shouldn't fire, but we still
    /// guard defensively.
    private func applyServerTransportChange() {
        let server = Endpoints.server(byId: serverId)
        let mode   = TransportMode(rawValue: transportRaw) ?? Endpoints.defaultTransport
        // If user picked a disabled location, snap selection back to
        // the previously-applied value. The Picker rendered the row
        // greyed so this is rare, but iOS/macOS still allows .tag()
        // selection on a disabled-foreground row.
        guard server.isAvailable else {
            AppLog.log("[Settings] picked unavailable server \(serverId), reverting")
            serverId = state.serverLocation.id
            return
        }
        _ = state.applyTransportSelection(server: server, transport: mode)
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

            // ── CLIENT — per-peer JitterBuffer ───────────────────────────
            Text("CLIENT — per-peer jitter buffer")
                .bold().foregroundStyle(Color.green.opacity(0.85))
            slider(label: "primeMin",
                   value: Binding(get: { Double(audio.clientPrimeMin) },
                                  set: { audio.clientPrimeMin = Int($0) }),
                   range: 1...16, step: 1,
                   display: "\(audio.clientPrimeMin) fr · \(String(format: "%.1f", Double(audio.clientPrimeMin) * AudioWire.frameMs)) ms")

            Divider().background(Color.green.opacity(0.4))

            // ── SERVER — MIXER_TUNE ───────────────────────────────────────
            Text("SERVER — per-user jitter buffer (MIXER_TUNE)")
                .bold().foregroundStyle(Color.green.opacity(0.85))
            // v6.1.0: ranges scaled to match server's
            // JITTER_TARGET_MAX=60 / JITTER_MAX_DEPTH_MAX=240 at the
            // 32-sample wire frame. Pre-v6 had target_max=16 / cap=64
            // at 120-sample frames; the ms-equivalent ceilings (~40 ms
            // / ~160 ms) survive the rescale unchanged.
            slider(label: "jitterTarget",
                   value: Binding(get: { Double(audio.serverJitterTarget) },
                                  set: { audio.serverJitterTarget = Int($0) }),
                   range: 1...60, step: 1,
                   display: "\(audio.serverJitterTarget) fr · \(String(format: "%.1f", Double(audio.serverJitterTarget) * AudioWire.frameMs)) ms")
            slider(label: "jitterMaxDepth",
                   value: Binding(get: { Double(audio.serverJitterMaxDepth) },
                                  set: { audio.serverJitterMaxDepth = Int($0) }),
                   range: 1...240, step: 1,
                   display: "\(audio.serverJitterMaxDepth) fr · \(String(format: "%.1f", Double(audio.serverJitterMaxDepth) * AudioWire.frameMs)) ms cap")

            Divider().background(Color.green.opacity(0.4))

            // ── LIVE readouts ─────────────────────────────────────────────
            Text("LIVE").bold().foregroundStyle(Color.green.opacity(0.85))
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
        .frame(width: 380)
        .background(Color.black)
        .foregroundStyle(.green)
        .font(.system(size: 12, design: .monospaced))
        // NOTE: do NOT call syncServerTuningFromMixer here — that would
        // overwrite user edits every reopen. Initial sync happens once
        // in AppState.joinRoom right after mixer.connect.
    }
    private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k).foregroundStyle(Color.green.opacity(0.6)); Spacer(); Text(v) }
    }
    private func slider(label: String,
                        value: Binding<Double>,
                        range: ClosedRange<Double>,
                        step: Double,
                        display: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label)
                Spacer()
                Text(display).foregroundStyle(.yellow)
            }
            Slider(value: value, in: range, step: step)
                .tint(.green)
        }
    }
}

#Preview {
    RoomView().environmentObject(AppState())
        .preferredColorScheme(.dark)
}

// ─── Switch-room sheet (v6.2.0) ──────────────────────────────────────────
// Replaces the old HomeView "加入房间" sheet. Type a room id and confirm;
// AppState tears down the current session and re-enters the new room.

struct SwitchRoomSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var state: AppState
    @State private var input: String = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("切换房间").font(.system(size: 22, weight: .bold))
                Spacer()
                Button("×") { dismiss() }.buttonStyle(.borderless)
            }

            Text("输入想加入的房间号。如果该房间不存在，连接会失败 —— 请向房主确认房间号是否输错。")
                .font(.system(size: 12))
                .foregroundStyle(Color(white: 0.6))
                .fixedSize(horizontal: false, vertical: true)

            TextField("如 K7M4P2", text: $input)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 16, design: .monospaced))
                .focused($inputFocused)
                .onSubmit { submit() }

            HStack {
                // Convenience: paste-button + show the user's own room
                // number so they can fall back to it if they paste the
                // wrong thing.
                if let pasted = NSPasteboard.general.string(forType: .string),
                   Identity.isPlausibleRoomId(pasted), pasted.uppercased() != state.currentRoomId {
                    Button("粘贴 \(pasted.uppercased())") {
                        input = pasted.uppercased()
                    }
                    .buttonStyle(.borderless)
                    .font(.system(size: 11))
                }
                Spacer()
                Text("我的房间: \(state.myRoomId)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color(white: 0.5))
            }

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("加入") {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!Identity.isPlausibleRoomId(input))
            }
        }
        .padding(24)
        .frame(width: 460)
        .background(Color(red: 0.10, green: 0.10, blue: 0.12))
        .onAppear { inputFocused = true }
    }

    private func submit() {
        let target = input.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Identity.isPlausibleRoomId(target) else { return }
        state.switchToRoom(target)
        dismiss()
    }
}
