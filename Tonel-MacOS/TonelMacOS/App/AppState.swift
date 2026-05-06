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
    let audio  = AudioEngine()

    /// The active mixer transport. v6.1.0+ this is selected dynamically
    /// from `@AppStorage` settings — UDP-direct (`MixerClient`) for low
    /// latency, WSS-tunnelled (`WSSMixerClient`) for restricted networks.
    /// **Must only be reassigned outside an active room** — see
    /// `applyTransportSelection()`.
    @Published private(set) var mixer: any MixerTransport

    /// Currently-selected server. Mirrors the @AppStorage value but
    /// snapshotted here so a Settings change requires explicit
    /// `applyTransportSelection()` (we don't want a dropdown wobble
    /// while connecting).
    @Published private(set) var serverLocation: ServerLocation
    /// Currently-selected transport mode.
    @Published private(set) var transportMode: TransportMode

    private var unsubSignal: (() -> Void)?

    init() {
        // Read the user's last selection from UserDefaults. First-run
        // users get `Endpoints.defaultServer` / `defaultTransport`.
        let savedServerId   = UserDefaults.standard.string(forKey: Endpoints.serverIdKey)
                              ?? Endpoints.defaultServer.id
        let savedTransport  = UserDefaults.standard.string(forKey: Endpoints.transportModeKey)
                              .flatMap(TransportMode.init(rawValue:))
                              ?? Endpoints.defaultTransport
        let initialLoc      = Endpoints.server(byId: savedServerId)
        // Defensive: a saved id pointing at a now-disabled location
        // (e.g. user picked 广州2, then we marked it unavailable in a
        // later release) collapses back to the default. Avoids users
        // getting stuck unable to connect with no obvious cause.
        let resolvedLoc     = initialLoc.isAvailable ? initialLoc : Endpoints.defaultServer
        self.serverLocation = resolvedLoc
        self.transportMode  = savedTransport
        self.mixer          = AppState.makeMixer(serverLocation: resolvedLoc,
                                                 transport:      savedTransport)

        audio.attach(mixer: self.mixer)
        unsubSignal = signal.onMessage { [weak self] msg in
            self?.handleSignal(msg)
        }
    }

    /// Construct the right mixer for a (server, transport) pair. Pulled
    /// out as a static factory so init and `applyTransportSelection`
    /// share one path — keeps the "which class for which mode" mapping
    /// in one place.
    private static func makeMixer(serverLocation: ServerLocation,
                                  transport: TransportMode) -> any MixerTransport {
        switch transport {
        case .udp:
            return MixerClient(serverLocation: serverLocation)
        case .wss:
            return WSSMixerClient(serverLocation: serverLocation)
        }
    }

    /// Apply a Settings change. Refuses to swap while connected — the
    /// user must leave the room first. UI greys out the picker in
    /// that case so this guard is rarely tripped, but check defensively.
    /// Returns true if the swap happened.
    @discardableResult
    func applyTransportSelection(server: ServerLocation,
                                 transport: TransportMode) -> Bool {
        guard screen == .home else {
            AppLog.log("[AppState] applyTransportSelection refused — currently in room")
            return false
        }
        // Persist first so a crash mid-swap still leaves the user's
        // selection captured for next launch.
        UserDefaults.standard.set(server.id,         forKey: Endpoints.serverIdKey)
        UserDefaults.standard.set(transport.rawValue, forKey: Endpoints.transportModeKey)

        let same = (server.id == serverLocation.id) && (transport == transportMode)
        if same { return false }

        // Swap to a fresh mixer. The old one had no active connection
        // (we're on Home), so disconnect() is safe but mostly a no-op.
        mixer.disconnect()
        serverLocation = server
        transportMode  = transport
        mixer          = AppState.makeMixer(serverLocation: server, transport: transport)
        audio.attach(mixer: mixer)
        AppLog.log("[AppState] transport swapped → server=\(server.id) transport=\(transport.rawValue)")
        return true
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
        AppLog.log("[AppState] joinRoom called — roomId=\(roomId) create=\(create) currentUserId=\(userId.isEmpty ? "<empty>" : userId)")
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
            AppLog.log("[AppState] step1: signal.connect()")
            try await signal.connect()
            AppLog.log("[AppState] step2: signal.\(create ? "createRoom" : "joinRoom")")
            if create {
                try await signal.createRoom(roomId: roomId, userId: userId, password: password)
            } else {
                try await signal.joinRoom(roomId: roomId, userId: userId, password: password)
            }
            AppLog.log("[AppState] step3: mixer.connect()")
            try await mixer.connect(roomId: roomId, userId: userId)
            // Pull JOIN_ACK defaults into the AudioDebugSheet sliders ONCE
            // per join. Re-syncing on sheet open would clobber user edits.
            audio.syncServerTuningFromMixer()
            AppLog.log("[AppState] step4: audio.start()")
            try audio.start()
            self.roomId = roomId
            self.screen = .room
            statusText = "已连接"
            AppLog.log("[AppState] joinRoom DONE")
        } catch {
            AppLog.log("[AppState] joinRoom ERROR: \(error)")
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
