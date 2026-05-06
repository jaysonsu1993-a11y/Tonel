import Foundation
import Network

/// One incoming SPA1 packet decoded from UDP — handed to AudioEngine.
struct MixerPacket {
    let userId: String      // composite "room_id:user_id" — strip room prefix as needed
    let sequence: UInt16
    let timestamp: UInt16
    let pcm: Data           // raw PCM16 LE bytes (64 bytes for a 0.667 ms frame at v6.0.0; was 240 at 120-sample frames)
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
final class MixerClient: MixerTransport {
    typealias PacketHandler = (MixerPacket) -> Void

    enum State { case idle, connecting, connected, failed(String), disconnected }

    /// Where this client is connecting to. Captured at construction so
    /// the user can change `Endpoints.guangzhou1` ↔ `guangzhou2` in
    /// Settings without affecting an in-flight connection (AppState
    /// recreates the mixer on selection change).
    let serverLocation: ServerLocation

    init(serverLocation: ServerLocation = Endpoints.defaultServer) {
        self.serverLocation = serverLocation
        self.udpPort = serverLocation.mixerUDPPort
    }

    private(set) var state: State = .idle
    private(set) var roomId = ""
    private(set) var userId = ""
    /// "room_id:user_id" — what goes in the SPA1 userId slot.
    private(set) var userIdKey = ""

    // TCP now uses POSIX sockets to bypass system proxies (Clash, etc.)
    // that add 300-400ms latency to NWConnection.
    private var tcpSocket: Int32 = -1
    private var tcpReadThread: Thread?
    private var tcpWriteQueue = DispatchQueue(label: "io.tonel.tcpwrite", qos: .userInitiated)
    private var udp: NWConnection?
    private var udpPort: UInt16

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
        AppLog.log("[Mixer] connect → tcp \(serverLocation.mixerHost):\(serverLocation.mixerTCPPort) room=\(roomId) user=\(userId)")

        try await openTCP()
        AppLog.log("[Mixer] TCP ready, sending MIXER_JOIN")
        try await sendJoinAndAwaitAck()
        AppLog.log("[Mixer] MIXER_JOIN_ACK received, udpPort=\(udpPort)")
        try openUDP()
        AppLog.log("[Mixer] UDP socket open → \(serverLocation.mixerHost):\(udpPort)")
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
        closeTCPSocket()
        udp?.cancel(); udp = nil
        state = .disconnected
    }

    private func closeTCPSocket() {
        if tcpSocket >= 0 {
            Darwin.shutdown(tcpSocket, SHUT_RDWR)
            Darwin.close(tcpSocket)
            tcpSocket = -1
        }
        tcpReadThread?.cancel()
        tcpReadThread = nil
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
        guard tcpSocket >= 0 else { return }
        pingLock.lock()
        pingSentAt = Date().timeIntervalSinceReferenceDate
        pingLock.unlock()
        let line = "{\"type\":\"PING\"}\n"
        tcpWriteQueue.async { [weak self] in
            guard let self = self, self.tcpSocket >= 0 else { return }
            _ = line.withCString { cstr in
                Darwin.send(self.tcpSocket, cstr, strlen(cstr), MSG_DONTWAIT)
            }
        }
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

    /// Send one PCM16 frame (`AudioWire.frameSamples × 2` bytes payload —
    /// 64 bytes / 0.667 ms at v6.0.0; was 240 bytes / 2.5 ms pre-v6).
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

    // MARK: - TCP (POSIX sockets — bypasses system proxies)

    private func openTCP() async throws {
        AppLog.log("[Mixer] openTCP (POSIX) → \(serverLocation.mixerHost):\(serverLocation.mixerTCPPort)")
        
        // Create socket
        let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else {
            throw MixerError.serverError("socket creation failed")
        }
        
        // Disable Nagle
        var noDelay: Int32 = 1
        Darwin.setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &noDelay, socklen_t(MemoryLayout<Int32>.size))
        
        // Set non-blocking for connect timeout
        var flags = Darwin.fcntl(sock, F_GETFL, 0)
        Darwin.fcntl(sock, F_SETFL, flags | O_NONBLOCK)
        
        // Resolve host
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = serverLocation.mixerTCPPort.bigEndian
        addr.sin_addr.s_addr = inet_addr(serverLocation.mixerHost)
        
        // Connect
        let connResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        
        if connResult < 0 && errno != EINPROGRESS {
            Darwin.close(sock)
            throw MixerError.serverError("connect failed: \(String(cString: strerror(errno)))")
        }
        
        // Wait for connection with 5s timeout
        var pollfd = Darwin.pollfd(fd: sock, events: Int16(POLLOUT), revents: 0)
        let pollResult = Darwin.poll(&pollfd, 1, 5000)
        
        if pollResult <= 0 || (pollfd.revents & Int16(POLLOUT)) == 0 {
            Darwin.close(sock)
            throw MixerError.serverError("connect timeout")
        }
        
        // Check connection success
        var soError: Int32 = 0
        var soErrLen = socklen_t(MemoryLayout<Int32>.size)
        Darwin.getsockopt(sock, SOL_SOCKET, SO_ERROR, &soError, &soErrLen)
        if soError != 0 {
            Darwin.close(sock)
            throw MixerError.serverError("connect error: \(String(cString: strerror(Int32(soError))))")
        }
        
        // Set back to blocking mode for simpler read logic
        flags = Darwin.fcntl(sock, F_GETFL, 0)
        Darwin.fcntl(sock, F_SETFL, flags & ~O_NONBLOCK)
        
        tcpSocket = sock
        AppLog.log("[Mixer] TCP connected (POSIX) fd=\(sock)")
    }

    private func sendJoinAndAwaitAck() async throws {
        let join = "{\"type\":\"MIXER_JOIN\",\"room_id\":\"\(roomId)\",\"user_id\":\"\(userId)\"}\n"
        guard tcpSocket >= 0 else { throw MixerError.notConnected }
        
        // Send JOIN
        _ = join.withCString { cstr in
            Darwin.send(tcpSocket, cstr, strlen(cstr), 0)
        }
        
        // Read ACK with 8s timeout
        let deadline = Date().addingTimeInterval(8)
        var accum = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        
        while !accum.contains(where: { $0 == 10 }) && Date() < deadline {
            let bytesRead = Darwin.recv(tcpSocket, &buffer, bufferSize, MSG_DONTWAIT)
            if bytesRead > 0 {
                accum.append(contentsOf: buffer.prefix(Int(bytesRead)))
            } else if bytesRead < 0 && errno != EAGAIN && errno != EWOULDBLOCK {
                throw MixerError.serverError("recv error: \(String(cString: strerror(errno)))")
            } else {
                // No data yet, small sleep to avoid busy-wait
                try await Task.sleep(nanoseconds: 10_000_000) // 10ms
            }
        }
        
        guard let line = String(data: accum, encoding: .utf8)?.split(separator: "\n").first.map(String.init) else {
            throw MixerError.serverError("ACK timeout or invalid")
        }
        
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
        guard tcpSocket >= 0 else { return }
        
        let thread = Thread { [weak self] in
            guard let self = self else { return }
            let sock = self.tcpSocket
            let bufferSize = 8192
            var buffer = [UInt8](repeating: 0, count: bufferSize)
            
            while !Thread.current.isCancelled && self.tcpSocket >= 0 {
                let bytesRead = Darwin.recv(sock, &buffer, bufferSize, 0)
                if bytesRead > 0 {
                    let data = Data(buffer.prefix(Int(bytesRead)))
                    if let s = String(data: data, encoding: .utf8) {
                        let recvAt = Date().timeIntervalSinceReferenceDate
                        self.handleTCPChunk(s, recvAt: recvAt)
                    }
                } else if bytesRead == 0 {
                    // Connection closed
                    Task { @MainActor in self.state = .disconnected }
                    break
                } else {
                    // Error
                    if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
                        AppLog.log("[Mixer] TCP read error: \(String(cString: strerror(errno)))")
                        Task { @MainActor in self.state = .disconnected }
                        break
                    }
                }
            }
        }
        thread.name = "io.tonel.tcpread"
        thread.start()
        tcpReadThread = thread
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
        guard tcpSocket >= 0,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              var s = String(data: data, encoding: .utf8) else { return }
        s += "\n"
        tcpWriteQueue.async { [weak self] in
            guard let self = self, self.tcpSocket >= 0 else { return }
            _ = s.withCString { cstr in
                Darwin.send(self.tcpSocket, cstr, strlen(cstr), MSG_DONTWAIT)
            }
        }
    }

    // MARK: - UDP

    private func openUDP() throws {
        let host = NWEndpoint.Host(serverLocation.mixerHost)
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
