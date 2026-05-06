import Foundation
import Combine

/// Top-level glue object — owns long-lived clients and the active room
/// session.
///
/// v6.2.0 dropped the login + home-page flow. The app now boots
/// directly into a room: `Identity.loadOrCreate()` lazily generates a
/// persistent `userId` + `myRoomId` on first launch, and `bootstrap()`
/// auto-joins the user's last-used room (defaults to their own personal
/// room) before the UI ever appears. There's no logout — identity
/// only resets via the Settings 重置身份 button.
@MainActor
final class AppState: ObservableObject {

    // MARK: - Identity

    /// Persistent user id — generated once on first launch, never
    /// changes unless the user explicitly resets identity. Used as
    /// the SPA1 `user_id` and the signaling `user_id` slot.
    @Published private(set) var userId: String
    /// The user's personal room (their "home base"). Stable for the
    /// lifetime of the identity. Doesn't change when the user
    /// switches rooms — `currentRoomId` does.
    @Published private(set) var myRoomId: String
    /// The room the user is currently in (or trying to join). Sticky
    /// across launches via `Identity.saveCurrentRoom`. Empty during
    /// the brief window between disconnect and reconnect when the
    /// user switches rooms.
    @Published private(set) var currentRoomId: String

    // MARK: - Room session state

    @Published var peers: [PeerVM] = []
    /// "正在加入…" / "已连接" / "正在重连…" — surfaced in the room header.
    @Published var statusText: String = ""
    @Published var isJoining: Bool = false
    /// Most recent error to surface as an alert. UI clears it back to nil
    /// after dismiss.
    @Published var lastError: String? = nil
    /// True once the initial bootstrap join has at least attempted; the
    /// UI uses this to render the connecting state instead of an empty
    /// peer list.
    @Published private(set) var hasBootstrapped: Bool = false

    // MARK: - Long-lived clients

    let signal = SignalClient()
    let audio  = AudioEngine()

    /// The active mixer transport. v6.1.0+ this is selected dynamically
    /// from `@AppStorage` settings — UDP-direct (`MixerClient`) for low
    /// latency, WSS-tunnelled (`WSSMixerClient`) for restricted networks.
    /// **Must only be reassigned outside an active connection** — see
    /// `applyTransportSelection()`.
    @Published private(set) var mixer: any MixerTransport

    /// Currently-selected server.
    @Published private(set) var serverLocation: ServerLocation
    /// Currently-selected transport mode.
    @Published private(set) var transportMode: TransportMode

    /// True while a connection (signal + mixer) is up.
    var isConnected: Bool { !currentRoomId.isEmpty && !isJoining }

    private var unsubSignal: (() -> Void)?

    // MARK: - Init

    init() {
        // Identity first (sync, UserDefaults).
        let id = Identity.loadOrCreate()
        self.userId        = id.userId
        self.myRoomId      = id.myRoomId
        self.currentRoomId = ""    // populated after successful join

        // Server / transport selection (UserDefaults).
        let savedServerId   = UserDefaults.standard.string(forKey: Endpoints.serverIdKey)
                              ?? Endpoints.defaultServer.id
        let savedTransport  = UserDefaults.standard.string(forKey: Endpoints.transportModeKey)
                              .flatMap(TransportMode.init(rawValue:))
                              ?? Endpoints.defaultTransport
        let initialLoc      = Endpoints.server(byId: savedServerId)
        // Defensive: a saved id pointing at a now-disabled location
        // collapses back to the default. Avoids users getting stuck
        // unable to connect with no obvious cause.
        let resolvedLoc     = initialLoc.isAvailable ? initialLoc : Endpoints.defaultServer
        self.serverLocation = resolvedLoc
        self.transportMode  = savedTransport
        self.mixer          = AppState.makeMixer(serverLocation: resolvedLoc,
                                                 transport:      savedTransport)

        audio.attach(mixer: self.mixer)
        unsubSignal = signal.onMessage { [weak self] msg in
            self?.handleSignal(msg)
        }

        // Kick off the initial join. Decoupled from init via Task so we
        // don't hold up window construction; the UI renders immediately
        // with `isJoining=true` and switches to "已连接" once joined.
        Task { @MainActor in
            await self.bootstrap()
        }
    }

    /// Construct the right mixer for a (server, transport) pair.
    private static func makeMixer(serverLocation: ServerLocation,
                                  transport: TransportMode) -> any MixerTransport {
        switch transport {
        case .udp:  return MixerClient(serverLocation: serverLocation)
        case .wss:  return WSSMixerClient(serverLocation: serverLocation)
        }
    }

    // MARK: - Bootstrap (auto-join on launch)

    /// First-launch / re-launch entry into a room. Joins the room
    /// `Identity.currentRoomId` points at — defaults to `myRoomId`
    /// for first-launch users, otherwise whichever room the user was
    /// last in.
    private func bootstrap() async {
        let target = Identity.loadOrCreate().currentRoomId
        AppLog.log("[AppState] bootstrap → room=\(target) user=\(userId)")
        await enterRoom(target)
        hasBootstrapped = true
    }

    // MARK: - Settings — server / transport selection

    /// Apply a Settings change. The new transport requires a fresh
    /// connection; we tear the current one down, swap mixers, and
    /// re-enter the same room. Returns true if the swap happened.
    @discardableResult
    func applyTransportSelection(server: ServerLocation,
                                 transport: TransportMode) -> Bool {
        // Persist first so a crash mid-swap leaves the user's
        // selection captured for next launch.
        UserDefaults.standard.set(server.id,         forKey: Endpoints.serverIdKey)
        UserDefaults.standard.set(transport.rawValue, forKey: Endpoints.transportModeKey)

        let same = (server.id == serverLocation.id) && (transport == transportMode)
        if same { return false }

        let roomToReenter = currentRoomId.isEmpty ? myRoomId : currentRoomId

        // Tear down current session, swap to the new transport class,
        // re-enter the same room. Keeps the user's experience seamless
        // — the picker change just feels like a brief reconnect blip.
        Task { @MainActor in
            await self.tearDownSession()
            self.serverLocation = server
            self.transportMode  = transport
            self.mixer          = AppState.makeMixer(serverLocation: server, transport: transport)
            self.audio.attach(mixer: self.mixer)
            AppLog.log("[AppState] transport swapped → server=\(server.id) transport=\(transport.rawValue), re-entering room=\(roomToReenter)")
            await self.enterRoom(roomToReenter)
        }
        return true
    }

    // MARK: - Room switching

    /// Switch to a different room. Used by the "切换房间" sheet — type
    /// a room id, hit confirm, we tear down and re-enter. Always uses
    /// `JOIN_ROOM` (not CREATE) since the user is joining someone
    /// else's room. If the room doesn't exist yet the server returns
    /// an error and we surface it.
    func switchToRoom(_ roomId: String) {
        let trimmed = roomId.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Identity.isPlausibleRoomId(trimmed) else {
            lastError = "房间号格式不对（3–32 位字母 / 数字）"
            return
        }
        Task { @MainActor in
            await self.tearDownSession()
            await self.enterRoom(trimmed, preferCreate: false)
        }
    }

    /// Re-enter the user's personal room. Use when bandmates have left
    /// and the user wants to come back to their own home base.
    func returnToMyRoom() {
        guard currentRoomId != myRoomId else { return }
        Task { @MainActor in
            await self.tearDownSession()
            await self.enterRoom(self.myRoomId)
        }
    }

    // MARK: - Connection lifecycle

    /// Connect signal + mixer + audio for the given room. Tries
    /// `CREATE_ROOM` first (so first-launch users implicitly create
    /// their own room), falls back to `JOIN_ROOM` if the server says
    /// it already exists. `preferCreate=false` skips the create
    /// attempt — used for switching to someone else's room.
    private func enterRoom(_ roomId: String, preferCreate: Bool = true) async {
        AppLog.log("[AppState] enterRoom roomId=\(roomId) preferCreate=\(preferCreate) userId=\(userId)")
        isJoining  = true
        statusText = "正在加入房间…"
        lastError  = nil
        defer { isJoining = false }

        do {
            try await signal.connect()

            // Try CREATE first when this is the user's own room (or any
            // first-time entry). Fall back to JOIN on "already exists".
            // This pattern handles both first-launch (server has no
            // record yet) and re-launch (server still holds the room
            // from <30 min ago), without the caller having to know
            // which case they're in.
            var joinedAsCreator = false
            if preferCreate {
                do {
                    try await signal.createRoom(roomId: roomId, userId: userId, password: nil)
                    joinedAsCreator = true
                } catch {
                    AppLog.log("[AppState] createRoom failed (\(error.localizedDescription)) — falling back to JOIN_ROOM")
                }
            }
            if !joinedAsCreator {
                try await signal.joinRoom(roomId: roomId, userId: userId, password: nil)
            }

            try await mixer.connect(roomId: roomId, userId: userId)
            audio.syncServerTuningFromMixer()
            try audio.start()

            self.currentRoomId = roomId
            Identity.saveCurrentRoom(roomId)
            statusText = "已连接"
            AppLog.log("[AppState] enterRoom DONE — roomId=\(roomId)")
        } catch {
            AppLog.log("[AppState] enterRoom ERROR: \(error)")
            lastError = error.localizedDescription
            mixer.disconnect()
            audio.stop()
            statusText = ""
        }
    }

    /// Tear down the active connection but leave the identity / mixer
    /// instance intact. Called before switching rooms or applying a
    /// transport change.
    private func tearDownSession() async {
        audio.stop()
        mixer.disconnect()
        signal.leaveRoom()
        signal.disconnect()
        currentRoomId = ""
        peers = []
        statusText = ""
        // Tiny delay so the server gets the LEAVE before the next
        // CREATE/JOIN tries to claim the same slot under the same uid.
        try? await Task.sleep(nanoseconds: 200_000_000)
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
        case .sessionReplaced:
            lastError = "你的账号在其它设备登录了"
            Task { @MainActor in await self.tearDownSession() }
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
