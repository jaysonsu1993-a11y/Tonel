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
    /// Hostname for the WSS-tunnelled path (`WSSMixerClient`). The proxy
    /// at this host wraps `mixerTCPPort` and `mixerUDPPort` behind
    /// `/mixer-tcp` and `/mixer-udp`. nil = no WSS path available
    /// for this location yet.
    let wssMixerHost: String?
    /// Set to false to grey out a placeholder entry (e.g. 广州2 = 酷番云
    /// while the box is still being un-banned). The picker still shows
    /// the row but the user can't select it; AppState refuses to
    /// connect.
    let isAvailable: Bool

    /// WSS endpoints derived from `wssMixerHost`. nil → not selectable.
    var wssMixerTCPURL: URL? {
        guard let h = wssMixerHost else { return nil }
        return URL(string: "wss://\(h)/mixer-tcp")
    }
    var wssMixerUDPURL: URL? {
        guard let h = wssMixerHost else { return nil }
        return URL(string: "wss://\(h)/mixer-udp")
    }
}

/// Transport mode for the audio path. UDP is the default and lowest-
/// latency choice; WSS is the fallback for users behind firewalls /
/// NATs that block direct UDP. **No auto-fallback** — when a connection
/// fails, the user picks the other mode manually.
enum TransportMode: String, CaseIterable, Identifiable {
    case udp
    case wss

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .udp: return "UDP（低延迟）"
        case .wss: return "WSS（兼容）"
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
        displayName: "广州1（阿里云）",
        mixerHost: "8.163.21.207",
        mixerTCPPort: 9002,
        mixerUDPPort: 9003,
        wssMixerHost: "srv-new.tonel.io",
        isAvailable: true
    )

    /// 广州2 = 酷番云 (42.240.163.172). v5.1.22 the IDC banned the box
    /// for hosting a foreign TLD without ICP filing — TCP RST'd from
    /// outside. Kept as a UI placeholder so the multi-server design is
    /// visible to the user, but `isAvailable = false` blocks selection
    /// until that situation is resolved (see memory
    /// `reference_kufan_test_server`). Hosts kept here for the day it
    /// flips back on; do not delete.
    static let guangzhou2 = ServerLocation(
        id: "guangzhou2",
        displayName: "广州2（酷番云 · 暂不可用）",
        mixerHost: "42.240.163.172",
        mixerTCPPort: 9002,
        mixerUDPPort: 9003,
        wssMixerHost: "srv.tonel.io",
        isAvailable: false
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
