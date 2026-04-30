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

    private var sequence: UInt16 = 0
    private var packetHandlers: [(UUID, PacketHandler)] = []

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
        state = .connected
        AppLog.log("[Mixer] connected ✅")
    }

    func disconnect() {
        if !roomId.isEmpty {
            send(json: ["type": "MIXER_LEAVE",
                        "room_id": roomId,
                        "user_id": userId])
        }
        tcp?.cancel(); tcp = nil
        udp?.cancel(); udp = nil
        state = .disconnected
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
            conn.start(queue: .main)
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
    }

    private func startTCPRead() {
        guard let conn = tcp else { return }
        func loop() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, err in
                guard let self = self else { return }
                if let err = err { AppLog.log("[Mixer] TCP recv err: \(err)"); return }
                // We currently consume LEVELS broadcasts silently; AudioEngine
                // computes meters locally from received PCM, so this is fine.
                _ = data
                if isComplete {
                    Task { @MainActor in self.state = .disconnected }
                    return
                }
                loop()
            }
        }
        loop()
    }

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
        conn.start(queue: .main)
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
