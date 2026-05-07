import Foundation

/// Where the user has chosen to connect. v6.1.0+ Tonel-MacOS supports
/// multi-server selection through Settings — each `ServerLocation` is
/// a self-contained bundle of the addresses needed by either transport
/// (UDP-direct or WSS-tunnelled).
struct ServerLocation: Identifiable, Hashable {
    /// Stable id used as the @AppStorage value. Don't rename — would
    /// orphan saved selections.
    let id: String
    /// User-facing name shown in the picker.
    let displayName: String
    /// Raw IP / hostname for the UDP-direct path (`MixerClient`).
    let mixerHost: String
    let mixerTCPPort: UInt16   // control
    let mixerUDPPort: UInt16   // SPA1 audio
    /// Server's UDP port for P2P NAT discovery
    /// (`SignalingServer::on_udp_recv`). Pre-v6.5.0 this concept didn't
    /// exist; it's the same number as the TCP signaling port (9001) on
    /// every deployed box but kept as a separate field for clarity in
    /// case the convention diverges later.
    let p2pDiscoveryUDPPort: UInt16
    /// Plain-WS endpoint URL for the TCP-fallback path (`WSMixerClient`).
    /// v6.3.0+ this points directly at the box's `tonel-ws-mixer-proxy`
    /// (Node, plain `ws://`, no TLS termination), bypassing both DNS
    /// and nginx — exactly the same direct-to-Aliyun philosophy as the
    /// UDP path. Pre-v6.3.0 this was a `wss://srv-new.tonel.io/...`
    /// hostname that turned out to have no DNS record.
    /// nil = no WS fallback path available yet for this location.
    let wsMixerURL: URL?
    /// Set to false to grey out a placeholder entry (e.g. 广州2 = 酷番云
    /// while the box is still being un-banned). The picker still shows
    /// the row but the user can't select it; AppState refuses to
    /// connect.
    let isAvailable: Bool

    /// WS endpoints derived from `wsMixerURL`. nil → not selectable.
    /// The path layout (`/mixer-tcp` for control, `/mixer-udp` for
    /// audio) matches `tonel-ws-mixer-proxy.js`'s upgrade routes so
    /// we plug straight into the same proxy the web client uses.
    var wsMixerTCPURL: URL? { wsMixerURL.flatMap { $0.appendingPathComponent("mixer-tcp") } }
    var wsMixerUDPURL: URL? { wsMixerURL.flatMap { $0.appendingPathComponent("mixer-udp") } }
}

/// Transport mode for the audio path. Three modes:
///
///   - `.udp` — direct UDP to the central mixer (lowest latency,
///             single hop). Default.
///   - `.ws`  — direct plain WebSocket to the central mixer's
///             `tonel-ws-mixer-proxy` port. For users whose network
///             blocks direct UDP. (TCP fallback; same mixing topology
///             as `.udp`.)
///   - `.p2p` — peer-to-peer mesh. Each peer sends audio directly
///             to every other peer over UDP, no mixer in the audio
///             path. Server is signaling-only (peer address
///             exchange). Fewest hops; works best on LAN or with
///             cone-NAT residential broadband. v6.5.0+
///
/// **No auto-fallback** — when a connection fails the user picks
/// another mode manually.
///
/// History:
///   v6.3.0 renamed `.wss` → `.ws` (plain ws:// directly to the box).
///   v6.5.0 added `.p2p`. Stale raw-values from older releases
///   collapse back to `.udp` via `init?(rawValue:)` returning nil
///   → AppState's default fallback.
enum TransportMode: String, CaseIterable, Identifiable {
    case udp
    case ws
    case p2p

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .udp: return "UDP（低延迟）"
        case .ws:  return "WS（兼容）"
        case .p2p: return "P2P（直连）"
        }
    }
}

/// All network endpoints in one place.
///
/// Pre-v6.1.0 this was a flat singleton with hard-coded Aliyun hosts.
/// v6.1.0 introduced `ServerLocation` so users can pick a region — the
/// hard-coded Aliyun box became `Endpoints.guangzhou1` (the only
/// available entry today), with `guangzhou2` reserved as a disabled
/// placeholder for the upcoming Kufan re-attachment.
enum Endpoints {
    /// 广州1 = Aliyun (8.163.21.207). Currently the only fully-online
    /// location. WSS path goes through `srv-new.tonel.io` (which DNS-
    /// points at this same Aliyun box; `srv.tonel.io` still points at
    /// HK as of v6.0.x). Don't change `mixerHost` — see memory
    /// `project_macos_posix_socket` for why we hold a literal IP.
    static let guangzhou1 = ServerLocation(
        id: "guangzhou1",
        displayName: "广州1",
        mixerHost: "8.163.21.207",
        mixerTCPPort: 9002,
        mixerUDPPort: 9003,
        p2pDiscoveryUDPPort: 9001,
        wsMixerURL: URL(string: "ws://8.163.21.207:9005"),
        isAvailable: true
    )

    /// 广州2 = 酷番云 (42.240.163.172). v5.1.22 the IDC banned the box
    /// for hosting a foreign TLD without ICP filing; v6.5.3 the ban
    /// was lifted and the box is back online. Server upgraded to
    /// v6.5.2 binary with v6.0+ 32-sample wire + v6.4+ JOIN auto-create
    /// + v6.5+ UDP discovery on 9001 — feature parity with 广州1.
    static let guangzhou2 = ServerLocation(
        id: "guangzhou2",
        displayName: "广州2",
        mixerHost: "42.240.163.172",
        mixerTCPPort: 9002,
        mixerUDPPort: 9003,
        p2pDiscoveryUDPPort: 9001,
        wsMixerURL: URL(string: "ws://42.240.163.172:9005"),
        isAvailable: true
    )

    /// All servers in the order they appear in the Settings picker.
    static let allServers: [ServerLocation] = [guangzhou1, guangzhou2]

    /// Look up by stored id. Falls back to the default if the saved id
    /// doesn't match any current entry (e.g. an entry was removed in a
    /// later release).
    static func server(byId id: String) -> ServerLocation {
        allServers.first { $0.id == id } ?? defaultServer
    }

    /// Default selection when the user has never made one. Pinned to
    /// `guangzhou1` because it's the only fully-online location at
    /// v6.1.0; revisit when 广州2 (or a third region) opens up.
    static let defaultServer: ServerLocation = guangzhou1

    /// Default transport when the user has never made one. UDP for the
    /// lowest latency — WSS exists only as a user-selectable fallback
    /// for restricted networks.
    static let defaultTransport: TransportMode = .udp

    // MARK: - Persisted-selection keys (UserDefaults / @AppStorage)

    /// @AppStorage key for the user's selected `ServerLocation.id`.
    static let serverIdKey      = "tonel.server.id"
    /// @AppStorage key for the user's selected `TransportMode.rawValue`.
    static let transportModeKey = "tonel.transport.mode"

    // MARK: - Signaling / user service (location-independent)

    /// Signaling proxy via nginx — same fronts as web, untouched by
    /// server-location selection (signaling is a single global pool).
    static let signalingURL    = URL(string: "wss://api.tonel.io/signaling")!
    static let userServiceBase = URL(string: "https://api.tonel.io")!
}
