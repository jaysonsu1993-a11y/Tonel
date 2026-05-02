import Foundation
import Network

/// One incoming SPA1 packet decoded from UDP — handed to AudioEngine.
struct MixerPacket {
    let userId: String      // composite "room_id:user_id" — strip room prefix as needed
    let sequence: UInt16
    let timestamp: UInt16
    let pcm: Data           // raw PCM16 LE bytes (240 bytes for a 2.5 ms frame)
}

/// Mixer transport.
///   • TCP 9002 — control: MIXER_JOIN/LEAVE/TUNE plus LEVELS broadcast.
///   • UDP 9003 — SPA1 audio + handshake.
///
/// Connection sequence (matches `MixerBridge.mm`):
///   1. TCP connect.
///   2. Send `{"type":"MIXER_JOIN", "room_id":..., "user_id":...}\n`.
///   3. Read ACK; parse `"udp_port":<n>` if present, else default 9003.
///   4. Open UDP listener, send SPA1 HANDSHAKE (codec 0xFF) so the mixer
///      learns our public source-addr.
///   5. Start UDP receive loop and TCP read loop.
/// Not `@MainActor`. Real-time audio code calls `sendAudio(...)` from a Core
/// Audio thread, so the network sends must remain accessible off-main.
final class MixerClient {
    typealias PacketHandler = (MixerPacket) -> Void

    enum State { case idle, connecting, connected, failed(String), disconnected }

    private(set) var state: State = .idle
    private(set) var roomId = ""
    private(set) var userId = ""
    /// "room_id:user_id" — what goes in the SPA1 userId slot.
    private(set) var userIdKey = ""

    private var tcp: NWConnection?
    private var udp: NWConnection?
    private var udpPort: UInt16 = Endpoints.mixerUDPPort

    /// **Critical: dedicated network queue (NOT main).**
    ///
    /// Previously TCP+UDP started with `queue: .main`, which routed every
    /// audio receive callback through the main thread. At 400 packets/sec
    /// (PCM16 decode + JitterBuffer.push + Task hop per packet) the main
    /// thread was buried under continuous audio work — especially under
    /// any UI re-render. The visible symptom: opening the output-device
    /// picker froze the app, because AVAudioEngine's reconfigure on
    /// device-change ALSO ran on main and competed with the packet
    /// firehose. Moving the receives to a userInitiated background queue
    /// frees main entirely; SwiftUI updates that need main still hop via
    /// `Task { @MainActor in ... }` from inside the handlers.
    private let networkQueue = DispatchQueue(label: "io.tonel.network",
                                              qos: .userInitiated)

    private var sequence: UInt16 = 0
    private var packetHandlers: [(UUID, PacketHandler)] = []

    /// Latest measured PING→PONG round-trip over mixer TCP (port 9002).
    /// This is the meaningful "audio RTT" — same physical path the
    /// SPA1 UDP stream takes, ~8ms direct to Kufan. (Signaling RTT
    /// goes through Cloudflare AMS and is irrelevant for audio.)
    nonisolated(unsafe) private(set) var audioRttMs: Int = -1
    /// Server-side jitter buffer target depth in frames, parsed out of
    /// `MIXER_JOIN_ACK` (`"jitter_target":<n>`). Used by AudioEngine to
    /// compute the e2e latency display.
    private(set) var serverJitterTargetFrames: Int = 2
    /// Server-side jitter buffer cap, parsed out of `MIXER_JOIN_ACK`
    /// (`"jitter_max_depth":<n>`). Diagnostic only.
    private(set) var serverJitterMaxFrames: Int = 8
    nonisolated(unsafe) private var pingSentAt: TimeInterval = 0
    nonisolated private let pingLock = NSLock()
    private var pingTimer: Timer?
    private var tcpReadAccum = ""

    func onPacket(_ h: @escaping PacketHandler) -> () -> Void {
        let id = UUID()
        packetHandlers.append((id, h))
        return { [weak self] in
            self?.packetHandlers.removeAll { $0.0 == id }
        }
    }

    // MARK: - Connect

    func connect(roomId: String, userId: String) async throws {
        self.roomId    = roomId
        self.userId    = userId
        self.userIdKey = "\(roomId):\(userId)"
        self.state     = .connecting
        AppLog.log("[Mixer] connect → tcp \(Endpoints.mixerHost):\(Endpoints.mixerTCPPort) room=\(roomId) user=\(userId)")

        try await openTCP()
        AppLog.log("[Mixer] TCP ready, sending MIXER_JOIN")
        try await sendJoinAndAwaitAck()
        AppLog.log("[Mixer] MIXER_JOIN_ACK received, udpPort=\(udpPort)")
        try openUDP()
        AppLog.log("[Mixer] UDP socket open → \(Endpoints.mixerHost):\(udpPort)")
        sendHandshake()
        startUDPReceive()
        startTCPRead()
        startPing()
        state = .connected
        AppLog.log("[Mixer] connected ✅")
    }

    func disconnect() {
        if !roomId.isEmpty {
            send(json: ["type": "MIXER_LEAVE",
                        "room_id": roomId,
                        "user_id": userId])
        }
        stopPing()
        tcp?.cancel(); tcp = nil
        udp?.cancel(); udp = nil
        state = .disconnected
    }

    // MARK: - Audio RTT (PING/PONG over mixer TCP)

    private func startPing() {
        stopPing()
        let timer = Timer(timeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.sendPing()
        }
        RunLoop.main.add(timer, forMode: .common)
        pingTimer = timer
        // Fire one immediately so we get a number within 3s of joining.
        sendPing()
    }

    private func stopPing() {
        pingTimer?.invalidate(); pingTimer = nil
        pingLock.lock(); pingSentAt = 0; pingLock.unlock()
    }

    private func sendPing() {
        guard let conn = tcp else { return }
        pingLock.lock()
        pingSentAt = Date().timeIntervalSinceReferenceDate
        pingLock.unlock()
        let line = "{\"type\":\"PING\"}\n"
        conn.send(content: line.data(using: .utf8),
                  completion: .contentProcessed { _ in })
    }

    // MARK: - Control (TCP JSON)

    /// Per-peer gain — recipient-side mix attenuation. Mirrors web
    /// `audioService.setPeerGain` → server `PEER_GAIN`.
    func sendPeerGain(targetUserId: String, gain: Float) {
        guard !roomId.isEmpty else { return }
        send(json: ["type": "PEER_GAIN",
                    "room_id": roomId,
                    "user_id": userId,
                    "target_user_id": targetUserId,
                    "gain": gain])
    }

    /// Mixer-side tuning knobs (`MIXER_TUNE`). The server accepts a free-form
    /// dictionary; web sends e.g. `{"jitter_target_ms": 20}`.
    func sendMixerTune(_ knobs: [String: Any]) {
        guard !roomId.isEmpty else { return }
        var msg = knobs
        msg["type"]    = "MIXER_TUNE"
        msg["room_id"] = roomId
        msg["user_id"] = userId
        send(json: msg)
    }

    // MARK: - Outgoing audio

    /// Send one 2.5 ms PCM16 frame (240 bytes payload).
    func sendAudio(pcm: Data, timestampMs: UInt16) {
        guard case .connected = state, let udp = udp else { return }
        let pkt = SPA1.build(payload: pcm,
                             codec: .pcm16,
                             sequence: sequence,
                             timestamp: timestampMs,
                             userId: userIdKey)
        sequence &+= 1
        udp.send(content: pkt, completion: .contentProcessed { err in
            if let err = err { AppLog.log("[Mixer] UDP send err: \(err)") }
        })
    }

    // MARK: - TCP

    private func openTCP() async throws {
        let host = NWEndpoint.Host(Endpoints.mixerHost)
        let port = NWEndpoint.Port(integerLiteral: Endpoints.mixerTCPPort)
        let params = NWParameters.tcp
        // Realtime path: disable Nagle so a 2.5 ms frame goes out immediately.
        if let tcpOptions = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcpOptions.noDelay = true
            tcpOptions.connectionTimeout = 5
        }
        let conn = NWConnection(host: host, port: port, using: params)
        self.tcp = conn
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.stateUpdateHandler = { st in
                switch st {
                case .ready:  cont.resume()
                case .failed(let e): cont.resume(throwing: e)
                case .cancelled: cont.resume(throwing: MixerError.cancelled)
                default: break
                }
            }
            conn.start(queue: self.networkQueue)
        }
        conn.stateUpdateHandler = nil
    }

    private func sendJoinAndAwaitAck() async throws {
        let join = "{\"type\":\"MIXER_JOIN\",\"room_id\":\"\(roomId)\",\"user_id\":\"\(userId)\"}\n"
        guard let conn = tcp else { throw MixerError.notConnected }
        conn.send(content: join.data(using: .utf8), completion: .contentProcessed { err in
            if let err = err { AppLog.log("[Mixer] MIXER_JOIN send err: \(err)") }
        })
        // Read until we have a newline-terminated JSON line (the ACK), or 8s timeout.
        let deadline = Date().addingTimeInterval(8)
        var accum = ""
        while !accum.contains("\n") && Date() < deadline {
            let chunk: String = try await withCheckedThrowingContinuation { cont in
                conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, err in
                    if let err = err { cont.resume(throwing: err); return }
                    cont.resume(returning: String(data: data ?? Data(), encoding: .utf8) ?? "")
                }
            }
            if chunk.isEmpty { throw MixerError.serverError("ACK closed") }
            accum.append(chunk)
        }
        let line = accum.split(separator: "\n").first.map(String.init) ?? accum
        AppLog.log("[Mixer] ACK: \(line)")
        if line.contains("\"error\"") {
            throw MixerError.serverError(line)
        }
        if let r = line.range(of: "\"udp_port\":") {
            let tail = line[r.upperBound...]
            let digits = tail.prefix(while: { $0.isNumber })
            if let v = UInt16(digits) { udpPort = v }
        }
        if let r = line.range(of: "\"jitter_target\":") {
            let tail = line[r.upperBound...]
            let digits = tail.prefix(while: { $0.isNumber })
            if let v = Int(digits) { serverJitterTargetFrames = v }
        }
        if let r = line.range(of: "\"jitter_max_depth\":") {
            let tail = line[r.upperBound...]
            let digits = tail.prefix(while: { $0.isNumber })
            if let v = Int(digits) { serverJitterMaxFrames = v }
        }
    }

    private func startTCPRead() {
        guard let conn = tcp else { return }
        func loop() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, err in
                guard let self = self else { return }
                let recvAt = Date().timeIntervalSinceReferenceDate
                if let err = err { AppLog.log("[Mixer] TCP recv err: \(err)"); return }
                if let data = data, !data.isEmpty,
                   let s = String(data: data, encoding: .utf8) {
                    self.handleTCPChunk(s, recvAt: recvAt)
                }
                if isComplete {
                    Task { @MainActor in self.state = .disconnected }
                    return
                }
                loop()
            }
        }
        loop()
    }

    /// Buffer TCP bytes into newline-separated JSON lines and dispatch each.
    /// Runs on Network.framework's connection queue (off-main).
    private nonisolated func handleTCPChunk(_ s: String, recvAt: TimeInterval) {
        // (LEVELS broadcasts are consumed silently — AudioEngine derives
        // peer meters from decoded PCM. Only PONG affects state here.)
        // Quick check: does this chunk contain a PONG? Most of the time
        // the chunk is exactly one line, so a substring scan is enough.
        if s.contains("\"PONG\"") {
            pingLock.lock()
            let sent = pingSentAt
            pingSentAt = 0
            pingLock.unlock()
            if sent > 0 {
                let rtt = Int((recvAt - sent) * 1000)
                audioRttMs = rtt
                // Surface to UI on main.
                Task { @MainActor in self.notifyRttChanged(rtt) }
            }
        }
    }

    /// Hook for any `@MainActor` consumer (RoomView reads `audioRttMs`
    /// directly; this gives a future place for callbacks if we need them).
    @MainActor private func notifyRttChanged(_ rtt: Int) {}

    private func send(json obj: [String: Any]) {
        guard let conn = tcp,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              var s = String(data: data, encoding: .utf8) else { return }
        s += "\n"
        conn.send(content: s.data(using: .utf8), completion: .contentProcessed { _ in })
    }

    // MARK: - UDP

    private func openUDP() throws {
        let host = NWEndpoint.Host(Endpoints.mixerHost)
        let port = NWEndpoint.Port(integerLiteral: udpPort)
        let params = NWParameters.udp
        params.serviceClass = .interactiveVoice    // QoS hint for low-latency RT
        let conn = NWConnection(host: host, port: port, using: params)
        self.udp = conn
        conn.start(queue: networkQueue)
    }

    private func sendHandshake() {
        guard let udp = udp else { return }
        let pkt = SPA1.build(payload: Data(),
                             codec: .handshake,
                             sequence: 0,
                             timestamp: 0,
                             userId: userIdKey)
        udp.send(content: pkt, completion: .contentProcessed { err in
            if let err = err { AppLog.log("[Mixer] handshake err: \(err)") }
        })
    }

    private func startUDPReceive() {
        guard let conn = udp else { return }
        func loop() {
            conn.receiveMessage { [weak self] data, _, _, err in
                guard let self = self else { return }
                if let err = err { AppLog.log("[Mixer] UDP recv err: \(err)"); return }
                if let data = data { self.handleUDP(data) }
                loop()
            }
        }
        loop()
    }

    private func handleUDP(_ data: Data) {
        guard let h = SPA1.parseHeader(data) else { return }
        guard h.codec == .pcm16 else { return }       // ignore handshake echo & opus for now
        let payload = SPA1.payload(of: data, header: h)
        let pkt = MixerPacket(userId: h.userId,
                              sequence: h.sequence,
                              timestamp: h.timestamp,
                              pcm: payload)
        for (_, h) in packetHandlers { h(pkt) }
    }

    enum MixerError: LocalizedError {
        case notConnected
        case cancelled
        case serverError(String)
        var errorDescription: String? {
            switch self {
            case .notConnected:        return "未连接到混音服务器"
            case .cancelled:           return "连接已取消"
            case .serverError(let m):  return "服务器错误: \(m)"
            }
        }
    }
}
