import Foundation
import Combine

/// Top-level glue object — owns long-lived clients and exposes the screen
/// the UI should currently render.
@MainActor
final class AppState: ObservableObject {

    enum Screen { case home, room }

    @Published var screen: Screen = .home

    var isLoggedIn: Bool { !userId.isEmpty }

    // Auth (phone-stub mirroring web `LoginPage.tsx`).
    @Published var userId: String = ""
    @Published var phone: String = ""

    // Room state.
    @Published var roomId: String = ""
    @Published var peers: [PeerVM] = []
    @Published var rooms: [String] = []
    @Published var statusText: String = ""
    @Published var isJoining: Bool = false
    @Published var lastError: String? = nil

    // Long-lived clients.
    let signal = SignalClient()
    let mixer  = MixerClient()
    let audio  = AudioEngine()

    private var unsubSignal: (() -> Void)?

    init() {
        audio.attach(mixer: mixer)
        unsubSignal = signal.onMessage { [weak self] msg in
            self?.handleSignal(msg)
        }
    }

    // MARK: - Auth

    func login(phone: String) {
        // Mirror web stub: ephemeral userId; no real OTP yet.
        let suffix = String(Int.random(in: 0..<99999)).padding(toLength: 5, withPad: "0", startingAt: 0)
        let uid = "user_\(Int(Date().timeIntervalSince1970 * 1000))_\(suffix)"
        self.phone  = phone
        self.userId = uid
        Task { await self.fetchRoomList() }
    }

    func logout() {
        leaveRoom()
        signal.disconnect()
        userId = ""; phone = ""; rooms = []
        screen = .home
    }

    // MARK: - Rooms

    func fetchRoomList() async {
        do {
            try await signal.connect()
            // Currently the server pushes ROOM_LIST on connect; nothing to do.
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func joinRoom(_ roomId: String, password: String? = nil, create: Bool = false) async {
        // Create flow doesn't require phone login — mint an ephemeral uid
        // on the fly. Matches web `LoginPage.tsx` ephemeral-uid behaviour.
        if userId.isEmpty {
            let suffix = String(Int.random(in: 0..<99999))
                            .padding(toLength: 5, withPad: "0", startingAt: 0)
            userId = "user_\(Int(Date().timeIntervalSince1970 * 1000))_\(suffix)"
        }
        isJoining = true
        statusText = "正在加入房间…"
        lastError = nil
        defer { isJoining = false }

        do {
            try await signal.connect()
            if create {
                try await signal.createRoom(roomId: roomId, userId: userId, password: password)
            } else {
                try await signal.joinRoom(roomId: roomId, userId: userId, password: password)
            }
            try await mixer.connect(roomId: roomId, userId: userId)
            try audio.start()
            self.roomId = roomId
            self.screen = .room
            statusText = "已连接"
        } catch {
            lastError = error.localizedDescription
            mixer.disconnect()
            audio.stop()
            statusText = ""
        }
    }

    func leaveRoom() {
        audio.stop()
        mixer.disconnect()
        signal.leaveRoom()
        roomId = ""
        peers = []
        if screen == .room { screen = .home }
    }

    // MARK: - Signal handling

    private func handleSignal(_ msg: SignalMessage) {
        switch msg {
        case .peerList(let list):
            self.peers = list
                .filter { $0.userId != userId }
                .map { PeerVM(userId: $0.userId, level: 0) }
        case .peerJoined(let p) where p.userId != userId:
            if !peers.contains(where: { $0.userId == p.userId }) {
                peers.append(PeerVM(userId: p.userId, level: 0))
            }
        case .peerLeft(let uid):
            peers.removeAll { $0.userId == uid }
        case .roomList(let list):
            self.rooms = list
        case .sessionReplaced:
            lastError = "你的账号在其它设备登录了"
            leaveRoom()
        case .error(let m):
            lastError = m
        default:
            break
        }
    }

    // Pull peer level from AudioEngine into the PeerVM view models.
    func refreshLevels() {
        for i in peers.indices {
            peers[i].level = audio.peerLevels[peers[i].userId] ?? 0
        }
    }
}
