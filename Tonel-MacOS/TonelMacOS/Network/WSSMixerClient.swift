import Foundation

/// WSS-tunnelled twin of `MixerClient`. Same SPA1 wire format and
/// same `MIXER_JOIN` JSON control flow — what differs is the
/// underlying transport:
///
///   - control plane: `wss://<host>/mixer-tcp`  (text frames carry
///     newline-delimited JSON; identical to the TCP `:9002` path on
///     the proxy's other side)
///   - audio plane:   `wss://<host>/mixer-udp`  (binary frames carry
///     raw SPA1 packets; the proxy unwraps them and forwards to UDP
///     `:9003` on the mixer; broadcast packets come back the other
///     way)
///
/// The proxy at `<host>` is `web/ws-mixer-proxy.js` running as the
/// `tonel-ws-mixer-proxy` PM2 service — no protocol change vs. the
/// browser audio path; we just plug a native client into the same
/// pipe.
///
/// Why a parallel class instead of a transport-strategy field on
/// `MixerClient`: the underlying APIs are very different
/// (`Darwin.socket` POSIX TCP + `NWConnection` UDP vs.
/// `URLSessionWebSocketTask`), the receive-loop mechanics
/// (POSIX `recv` thread vs. async `receive()` chain) don't share
/// any state, and the user-facing pickers naturally produce a binary
/// "which class do I instantiate" decision in `AppState`. Splitting
/// at the class boundary keeps each implementation linear and easy
/// to read.
///
/// Connection sequence (mirrors `MixerClient.connect`):
///   1. Open `/mixer-tcp` WSS, await connection.
///   2. Send `{"type":"MIXER_JOIN", ...}` text frame, await ACK
///      JSON. Parse `udp_port` (proxy-side, ignored — the proxy
///      maps that to its own UDP socket already), `jitter_target`,
///      `jitter_max_depth`.
///   3. Open `/mixer-udp` WSS, await connection.
///   4. Send SPA1 handshake (codec 0xFF) binary frame so the proxy
///      learns our `(roomId:userId)` → WS mapping for return
///      broadcasts.
///   5. Start receive loops on both sockets + PING timer.
final class WSSMixerClient: MixerTransport {
    typealias PacketHandler = (MixerPacket) -> Void

    enum WSError: LocalizedError {
        case notConnected
        case missingURL(String)
        case ackTimeout
        case ackInvalid(String)
        case wsClosed(URLSessionWebSocketTask.CloseCode)
        case connectTimeout(String)

        var errorDescription: String? {
            switch self {
            case .notConnected:        return "未连接"
            case .missingURL(let id):  return "服务器 \(id) 未配置 WSS 路径"
            case .ackTimeout:          return "MIXER_JOIN 等待 ACK 超时"
            case .ackInvalid(let s):   return "MIXER_JOIN_ACK 解析失败：\(s)"
            case .wsClosed(let c):     return "WebSocket 关闭：\(c.rawValue)"
            case .connectTimeout(let h): return "WSS 连接超时（DNS 或握手不通）：\(h)"
            }
        }
    }

    /// Race the body against a deadline. `URLSessionWebSocketTask`'s
    /// async `send` / `receive` honour neither `URLSessionConfiguration
    /// .timeoutIntervalForRequest` nor `for resource:` reliably — they
    /// can hang indefinitely on a DNS-NXDOMAIN target (which is exactly
    /// the bug v6.2.1 hit when `srv-new.tonel.io` had no DNS record).
    /// This helper makes any `connect()` step bounded.
    private static func withDeadline<T>(_ seconds: TimeInterval,
                                        host: String,
                                        _ body: @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await body() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw WSError.connectTimeout(host)
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }

    // MARK: - Identity & endpoints

    let serverLocation: ServerLocation
    private let session: URLSession

    init(serverLocation: ServerLocation = Endpoints.defaultServer) {
        self.serverLocation = serverLocation
        // No-cookies, no-cache config — WSS upgrades only.
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest  = 10
        cfg.timeoutIntervalForResource = 0    // keep WS open indefinitely
        self.session = URLSession(configuration: cfg)
    }

    private(set) var roomId    = ""
    private(set) var userId    = ""
    private(set) var userIdKey = ""

    // MARK: - State observed by SwiftUI

    nonisolated(unsafe) private(set) var audioRttMs: Int = -1
    private(set) var serverJitterTargetFrames: Int = 8
    private(set) var serverJitterMaxFrames: Int = 124

    // MARK: - WS tasks

    private var controlTask: URLSessionWebSocketTask?
    private var audioTask:   URLSessionWebSocketTask?

    // MARK: - Inbound dispatch

    private var packetHandlers: [(UUID, PacketHandler)] = []

    func onPacket(_ h: @escaping PacketHandler) -> () -> Void {
        let id = UUID()
        packetHandlers.append((id, h))
        return { [weak self] in
            self?.packetHandlers.removeAll { $0.0 == id }
        }
    }

    // MARK: - Sequence + timing

    private var sequence: UInt16 = 0
    nonisolated(unsafe) private var pingSentAt: TimeInterval = 0
    nonisolated private let pingLock = NSLock()
    private var pingTimer: Timer?

    // MARK: - Lifecycle

    func connect(roomId: String, userId: String) async throws {
        self.roomId    = roomId
        self.userId    = userId
        self.userIdKey = "\(roomId):\(userId)"

        guard let ctlURL = serverLocation.wssMixerTCPURL,
              let audURL = serverLocation.wssMixerUDPURL else {
            throw WSError.missingURL(serverLocation.id)
        }
        let host = ctlURL.host ?? "<no-host>"

        AppLog.log("[WSSMixer] connect → \(ctlURL.absoluteString) (control)")
        AppLog.log("[WSSMixer]            \(audURL.absoluteString) (audio)")

        // The whole connect flow (control upgrade + JOIN + audio
        // upgrade + handshake) is bounded by a single 8s deadline. The
        // dominant failure modes (NXDOMAIN, dropped TCP, server not
        // running the proxy) all hang URLSessionWebSocketTask
        // indefinitely without this; the user would see the picker
        // change apply forever with no error.
        do {
            try await Self.withDeadline(8.0, host: host) {
                // 1. Control WS
                let ctl = self.session.webSocketTask(with: ctlURL)
                ctl.resume()
                self.controlTask = ctl

                // 2. MIXER_JOIN + ACK
                try await self.sendJoinAndAwaitAck()
                AppLog.log("[WSSMixer] MIXER_JOIN_ACK received")

                // 3. Audio WS
                let aud = self.session.webSocketTask(with: audURL)
                aud.resume()
                self.audioTask = aud

                // 4. Handshake (binary SPA1, codec=0xFF, dataSize=0)
                let hs = SPA1.build(payload: Data(),
                                    codec: .handshake,
                                    sequence: 0,
                                    timestamp: 0,
                                    userId: self.userIdKey)
                try await aud.send(.data(hs))
                AppLog.log("[WSSMixer] SPA1 handshake sent")
            }
        } catch {
            // Clean up half-open WS tasks so the next attempt starts
            // from a known state. AppState surfaces the error via its
            // own catch.
            controlTask?.cancel(with: .goingAway, reason: nil); controlTask = nil
            audioTask?.cancel(with: .goingAway, reason: nil);   audioTask = nil
            throw error
        }

        // 5. Receive loops + PING (started AFTER the bounded handshake
        // so the ping timer doesn't fire on a half-open connection).
        startControlReceive()
        startAudioReceive()
        startPing()
        AppLog.log("[WSSMixer] connected ✅")
    }

    func disconnect() {
        // Polite LEAVE on the control plane so the server frees the
        // room slot immediately; the WS close alone wouldn't trigger
        // the eviction path until TCP timeout.
        if !roomId.isEmpty, let ctl = controlTask {
            let leave = "{\"type\":\"MIXER_LEAVE\",\"room_id\":\"\(roomId)\",\"user_id\":\"\(userId)\"}\n"
            ctl.send(.string(leave)) { _ in }
        }
        stopPing()
        controlTask?.cancel(with: .goingAway, reason: nil); controlTask = nil
        audioTask?.cancel(with: .goingAway, reason: nil);   audioTask   = nil
    }

    // MARK: - Control plane (JSON over text frames)

    private func sendJoinAndAwaitAck() async throws {
        guard let ctl = controlTask else { throw WSError.notConnected }

        let join = "{\"type\":\"MIXER_JOIN\",\"room_id\":\"\(roomId)\",\"user_id\":\"\(userId)\"}\n"
        try await ctl.send(.string(join))

        // Loop until we see MIXER_JOIN_ACK or timeout. The control
        // proxy may interleave LEVELS/etc broadcasts even before the
        // ACK if another peer is mid-flight, so we drain & filter.
        let deadline = Date().addingTimeInterval(5.0)
        while Date() < deadline {
            let msg = try await ctl.receive()
            if case .string(let s) = msg {
                for line in s.split(separator: "\n") {
                    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard trimmed.contains("\"MIXER_JOIN_ACK\"") else { continue }
                    parseMixerJoinAck(trimmed)
                    return
                }
            }
        }
        throw WSError.ackTimeout
    }

    private func parseMixerJoinAck(_ line: String) {
        // Mirror MixerClient's regex parsing — we only need the two
        // jitter knobs for the latency display; everything else is
        // server-side state.
        if let r = line.range(of: "\"jitter_target\":") {
            let tail = line[r.upperBound...]
            let num = tail.prefix(while: { $0.isNumber || $0 == "-" })
            if let v = Int(num) { serverJitterTargetFrames = v }
        }
        if let r = line.range(of: "\"jitter_max_depth\":") {
            let tail = line[r.upperBound...]
            let num = tail.prefix(while: { $0.isNumber || $0 == "-" })
            if let v = Int(num) { serverJitterMaxFrames = v }
        }
    }

    func sendMixerTune(_ knobs: [String: Any]) {
        guard !roomId.isEmpty, let ctl = controlTask else { return }
        var body: [String: Any] = [
            "type": "MIXER_TUNE",
            "room_id": roomId,
            "user_id": userId,
        ]
        for (k, v) in knobs { body[k] = v }
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let s    = String(data: data, encoding: .utf8) else { return }
        ctl.send(.string(s + "\n")) { err in
            if let err = err { AppLog.log("[WSSMixer] MIXER_TUNE err: \(err)") }
        }
    }

    func sendPeerGain(targetUserId: String, gain: Float) {
        guard !roomId.isEmpty, let ctl = controlTask else { return }
        let body: [String: Any] = [
            "type": "PEER_GAIN",
            "room_id": roomId,
            "user_id": userId,
            "target_user_id": targetUserId,
            "gain": gain,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let s    = String(data: data, encoding: .utf8) else { return }
        ctl.send(.string(s + "\n")) { err in
            if let err = err { AppLog.log("[WSSMixer] PEER_GAIN err: \(err)") }
        }
    }

    // MARK: - Audio plane (binary SPA1 over WS frames)

    func sendAudio(pcm: Data, timestampMs: UInt16) {
        guard let aud = audioTask else { return }
        sequence &+= 1
        let pkt = SPA1.build(payload: pcm,
                             codec: .pcm16,
                             sequence: sequence,
                             timestamp: timestampMs,
                             userId: userIdKey)
        aud.send(.data(pkt)) { err in
            if let err = err {
                // Don't spam — log only the first couple of failures
                // per second by hooking into existing app log throttle.
                AppLog.log("[WSSMixer] audio send err: \(err)")
            }
        }
    }

    // MARK: - Receive loops

    private func startControlReceive() {
        guard let ctl = controlTask else { return }
        ctl.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let err):
                AppLog.log("[WSSMixer] control recv err: \(err)")
                return  // stop the loop on error
            case .success(let msg):
                if case .string(let s) = msg {
                    for line in s.split(separator: "\n") {
                        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                        if trimmed.isEmpty { continue }
                        self.handleControlLine(trimmed)
                    }
                }
                self.startControlReceive()  // chain
            }
        }
    }

    private func handleControlLine(_ line: String) {
        // PONG → finalise audio RTT
        if line.contains("\"PONG\"") {
            pingLock.lock()
            let sent = pingSentAt
            pingLock.unlock()
            if sent > 0 {
                let now = Date().timeIntervalSinceReferenceDate
                let rtt = Int((now - sent) * 1000)
                if rtt >= 0 && rtt < 10_000 {
                    audioRttMs = rtt
                }
            }
            return
        }
        // MIXER_JOIN_ACK can also arrive here (rejoin / TUNE-ack reflect)
        if line.contains("\"MIXER_JOIN_ACK\"") || line.contains("\"MIXER_TUNE_ACK\"") {
            parseMixerJoinAck(line)
        }
        // LEVELS, ROOM_UPDATE, etc — currently no-op. The native
        // client doesn't render LEVELS from the mixer (it computes
        // its own per-peer level from the post-jitter audio).
    }

    private func startAudioReceive() {
        guard let aud = audioTask else { return }
        aud.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let err):
                AppLog.log("[WSSMixer] audio recv err: \(err)")
                return
            case .success(let msg):
                if case .data(let d) = msg, let h = SPA1.parseHeader(d) {
                    let mp = MixerPacket(userId: h.userId,
                                         sequence: h.sequence,
                                         timestamp: h.timestamp,
                                         pcm: SPA1.payload(of: d, header: h))
                    for (_, handler) in self.packetHandlers { handler(mp) }
                }
                self.startAudioReceive()
            }
        }
    }

    // MARK: - PING (audio RTT)

    private func startPing() {
        stopPing()
        let timer = Timer(timeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.sendPing()
        }
        RunLoop.main.add(timer, forMode: .common)
        pingTimer = timer
        sendPing()
    }

    private func stopPing() {
        pingTimer?.invalidate(); pingTimer = nil
        pingLock.lock(); pingSentAt = 0; pingLock.unlock()
    }

    private func sendPing() {
        guard let ctl = controlTask else { return }
        pingLock.lock()
        pingSentAt = Date().timeIntervalSinceReferenceDate
        pingLock.unlock()
        ctl.send(.string("{\"type\":\"PING\"}\n")) { _ in }
    }
}
