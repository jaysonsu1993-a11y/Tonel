import Foundation

/// JSON-typed view of signaling messages — matches `signalService.ts`.
enum SignalMessage {
    case peerList([PeerInfo])
    case peerJoined(PeerInfo)
    case peerLeft(userId: String)
    case roomList([String])
    case joinRoomAck(roomId: String)
    case createRoomAck(roomId: String)
    case sessionReplaced(userId: String)
    case error(message: String)
    case heartbeatAck
    case unknown(type: String, raw: [String: Any])
}

struct PeerInfo: Equatable, Identifiable {
    let userId: String
    let ip: String
    let port: Int
    var id: String { userId }
}

/// WebSocket signaling client.
///
/// Wire protocol: JSON objects, newline-delimited (one or many per WS frame).
/// Reconnects after 3s on close (web parity), unless SESSION_REPLACED latched.
@MainActor
final class SignalClient: NSObject {
    typealias Handler = (SignalMessage) -> Void

    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var handlers: [(UUID, Handler)] = []

    private(set) var roomId = ""
    private(set) var userId = ""

    private var sessionReplaced = false
    private var heartbeatTimer: Timer?
    private var reconnectTask: Task<Void, Never>?

    private(set) var latencyMs: Int = -1
    /// Wire-level timestamps (Date().timeIntervalSinceReferenceDate, monotonic seconds).
    /// pingSentAt is stamped in URLSessionWebSocketTask.send's completion
    /// handler — i.e. when the kernel accepted the bytes for transmission.
    /// recvAt for ACK is stamped at the very top of the URLSession receive
    /// callback (before any `Task { @MainActor in ... }` hop). RTT is the
    /// difference. Without these explicit timestamps we'd be measuring
    /// "main-thread-busy-time", not network round-trip — that was the
    /// bug behind the spurious 500ms readout.
    nonisolated(unsafe) private var pingSentAt: TimeInterval = 0
    nonisolated private let pingLock = NSLock()

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    var isConnected: Bool { task?.state == .running }

    @discardableResult
    func onMessage(_ h: @escaping Handler) -> () -> Void {
        let id = UUID()
        handlers.append((id, h))
        return { [weak self] in
            self?.handlers.removeAll { $0.0 == id }
        }
    }

    func connect() async throws {
        if isConnected { return }
        let task = session.webSocketTask(with: Endpoints.signalingURL)
        self.task = task
        task.resume()
        startHeartbeat()
        receiveLoop()
        // Replay JOIN_ROOM after reconnect — same logic as web.
        if !roomId.isEmpty, !userId.isEmpty {
            send(["type": "JOIN_ROOM",
                  "room_id": roomId,
                  "user_id": userId,
                  "ip": "0.0.0.0",
                  "port": 9003])
        }
    }

    func disconnect() {
        reconnectTask?.cancel(); reconnectTask = nil
        stopHeartbeat()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    // MARK: - Room ops

    func joinRoom(roomId: String, userId: String, password: String? = nil) async throws {
        try await ensureConnected()
        self.roomId = roomId
        self.userId = userId
        var msg: [String: Any] = ["type": "JOIN_ROOM",
                                  "room_id": roomId,
                                  "user_id": userId,
                                  "ip": "0.0.0.0",
                                  "port": 9003]
        if let pw = password { msg["password"] = pw }
        try await sendAndWait(msg, ackType: "JOIN_ROOM_ACK")
    }

    func createRoom(roomId: String, userId: String, password: String? = nil) async throws {
        try await ensureConnected()
        self.roomId = roomId
        self.userId = userId
        var msg: [String: Any] = ["type": "CREATE_ROOM",
                                  "room_id": roomId,
                                  "user_id": userId]
        if let pw = password { msg["password"] = pw }
        try await sendAndWait(msg, ackType: "CREATE_ROOM_ACK")
    }

    func leaveRoom() {
        guard !roomId.isEmpty else { return }
        send(["type": "LEAVE_ROOM",
              "room_id": roomId,
              "user_id": userId])
        roomId = ""
        userId = ""
    }

    // MARK: - Internals

    private func ensureConnected() async throws {
        if isConnected { return }
        try await connect()
    }

    private func send(_ obj: [String: Any]) {
        guard let task = task, task.state == .running else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              var s = String(data: data, encoding: .utf8) else { return }
        s += "\n"
        task.send(.string(s)) { err in
            if let err = err { AppLog.log("[Signal] send error: \(err)") }
        }
    }

    private func sendAndWait(_ obj: [String: Any], ackType: String,
                             timeout: TimeInterval = 8) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            var done = false
            var unsub: (() -> Void)? = nil
            let timer = DispatchWorkItem {
                if done { return }
                done = true
                unsub?()
                cont.resume(throwing: SignalError.timeout)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: timer)

            unsub = self.onMessage { msg in
                if done { return }
                switch msg {
                case .joinRoomAck(let rid)   where ackType == "JOIN_ROOM_ACK"   && rid == self.roomId:
                    done = true; timer.cancel(); unsub?(); cont.resume()
                case .createRoomAck(let rid) where ackType == "CREATE_ROOM_ACK" && rid == self.roomId:
                    done = true; timer.cancel(); unsub?(); cont.resume()
                case .error(let m):
                    done = true; timer.cancel(); unsub?(); cont.resume(throwing: SignalError.serverError(m))
                default: break
                }
            }
            self.send(obj)
        }
    }

    enum SignalError: LocalizedError {
        case timeout
        case serverError(String)
        var errorDescription: String? {
            switch self {
            case .timeout: return "连接超时"
            case .serverError(let m): return m
            }
        }
    }

    // MARK: - Receive loop

    private func receiveLoop() {
        guard let task = task else { return }
        task.receive { [weak self] result in
            guard let self = self else { return }
            // Stamp ACK time HERE — on URLSession's own queue, before any
            // hop to main. Computing latency on the main actor would smear
            // it with whatever else main is doing (SwiftUI re-renders).
            let recvAt = Date().timeIntervalSinceReferenceDate
            // Pre-extract latency for any HEARTBEAT_ACK / PONG so we don't
            // depend on main-actor timing for the measurement.
            if case let .success(msg) = result {
                self.precomputeLatency(msg: msg, recvAt: recvAt)
            }
            Task { @MainActor in
                switch result {
                case .failure(let err):
                    AppLog.log("[Signal] receive error: \(err)")
                    self.handleClose()
                case .success(let msg):
                    self.handle(msg)
                    self.receiveLoop()
                }
            }
        }
    }

    /// Off-main quick scan for ACK frames so we can lock the wire-level
    /// RTT before any UI-thread hop.
    private nonisolated func precomputeLatency(msg: URLSessionWebSocketTask.Message,
                                               recvAt: TimeInterval) {
        let text: String
        switch msg {
        case .string(let s): text = s
        case .data(let d):   text = String(data: d, encoding: .utf8) ?? ""
        @unknown default:    return
        }
        guard text.contains("HEARTBEAT_ACK") || text.contains("PONG") else { return }
        pingLock.lock()
        let sent = pingSentAt
        pingSentAt = 0
        pingLock.unlock()
        guard sent > 0 else { return }
        let rttMs = Int((recvAt - sent) * 1000)
        Task { @MainActor in self.latencyMs = rttMs }
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) {
        let text: String
        switch msg {
        case .string(let s): text = s
        case .data(let d):   text = String(data: d, encoding: .utf8) ?? ""
        @unknown default:    return
        }
        for line in text.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let type = obj["type"] as? String else { continue }
            dispatch(type: type, obj: obj)
        }
    }

    private func dispatch(type: String, obj: [String: Any]) {
        if type == "PONG" || type == "HEARTBEAT_ACK" {
            // Latency was already computed off-main in precomputeLatency.
            broadcast(.heartbeatAck)
            return
        }
        if type == "SESSION_REPLACED" {
            sessionReplaced = true
            broadcast(.sessionReplaced(userId: obj["user_id"] as? String ?? ""))
            return
        }
        switch type {
        case "PEER_LIST":
            let peers = (obj["peers"] as? [[String: Any]] ?? []).compactMap(parsePeer)
            broadcast(.peerList(peers))
        case "PEER_JOINED":
            // Server flattens fields at top level; normalise here (web parity).
            let peer = PeerInfo(userId: obj["user_id"] as? String ?? "",
                                ip: obj["ip"] as? String ?? "",
                                port: obj["port"] as? Int ?? 0)
            broadcast(.peerJoined(peer))
        case "PEER_LEFT":
            broadcast(.peerLeft(userId: obj["user_id"] as? String ?? ""))
        case "ROOM_LIST":
            broadcast(.roomList(obj["rooms"] as? [String] ?? []))
        case "JOIN_ROOM_ACK":
            broadcast(.joinRoomAck(roomId: obj["room_id"] as? String ?? ""))
        case "CREATE_ROOM_ACK":
            broadcast(.createRoomAck(roomId: obj["room_id"] as? String ?? ""))
        case "ERROR":
            broadcast(.error(message: obj["message"] as? String ?? "unknown"))
        default:
            broadcast(.unknown(type: type, raw: obj))
        }
    }

    private func parsePeer(_ d: [String: Any]) -> PeerInfo? {
        guard let uid = d["user_id"] as? String else { return nil }
        return PeerInfo(userId: uid,
                        ip: d["ip"] as? String ?? "",
                        port: d["port"] as? Int ?? 0)
    }

    private func broadcast(_ msg: SignalMessage) {
        for (_, h) in handlers { h(msg) }
    }

    private func handleClose() {
        stopHeartbeat()
        task = nil
        if !sessionReplaced { scheduleReconnect() }
    }

    private func scheduleReconnect() {
        guard reconnectTask == nil else { return }
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self = self else { return }
            self.reconnectTask = nil
            try? await self.connect()
        }
    }

    private func startHeartbeat() {
        stopHeartbeat()
        let timer = Timer(timeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, self.isConnected else { return }
                self.sendHeartbeat()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        heartbeatTimer = timer
    }

    /// Send HEARTBEAT and stamp `pingSentAt` from inside the URLSession
    /// send completion handler — this is the closest point to "bytes on
    /// wire" the WebSocket task exposes, and it runs on URLSession's own
    /// queue (not main), so it doesn't get held up by SwiftUI work.
    private func sendHeartbeat() {
        guard let task = task, task.state == .running else { return }
        let payload = "{\"type\":\"HEARTBEAT\",\"user_id\":\"\(userId)\"}\n"
        task.send(.string(payload)) { [weak self] err in
            guard let self = self else { return }
            if err != nil { return }
            let now = Date().timeIntervalSinceReferenceDate
            self.pingLock.lock()
            self.pingSentAt = now
            self.pingLock.unlock()
        }
    }

    private func stopHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
    }
}

extension SignalClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession,
                                webSocketTask: URLSessionWebSocketTask,
                                didOpenWithProtocol protocol: String?) {
        AppLog.log("[Signal] connected")
    }
    nonisolated func urlSession(_ session: URLSession,
                                webSocketTask: URLSessionWebSocketTask,
                                didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                                reason: Data?) {
        Task { @MainActor in self.handleClose() }
    }
}
