import Foundation

/// All network endpoints in one place. Matches v5.0.0 (酷番云 main prod) layout.
///
/// Web equivalents:
///   `audioService.ts`  → mixer TCP/UDP host (9002/9003)
///   `signalService.ts` → wss://api.tonel.io/signaling
enum Endpoints {
    /// Aliyun mixer host — desktop client 固定走 Aliyun,绕过 WSS/WT proxy
    /// (per memory `project_desktop_client` / `project_v5_migration`).
    /// 酷番云 (42.240.163.172) 是 web 主路径,desktop 不走它。
    static let mixerHost   = "8.163.21.207"
    static let mixerTCPPort: UInt16 = 9002      // MIXER_JOIN/LEAVE/TUNE
    static let mixerUDPPort: UInt16 = 9003      // SPA1 audio + handshake

    /// Signaling proxy via nginx — same fronts as web, untouched by v5 cutover.
    static let signalingURL = URL(string: "wss://api.tonel.io/signaling")!

    /// User service (phone login stub mirrors web; no real OTP yet).
    static let userServiceBase = URL(string: "https://api.tonel.io")!
}
