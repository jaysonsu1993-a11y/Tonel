import Foundation

/// All network endpoints in one place. Matches v5.0.0 (酷番云 main prod) layout.
///
/// Web equivalents:
///   `audioService.ts`  → mixer TCP/UDP host (9002/9003)
///   `signalService.ts` → wss://api.tonel.io/signaling
enum Endpoints {
    /// 酷番云 v5 main mixer host (per memory `project_v5_migration`).
    static let mixerHost   = "42.240.163.172"
    static let mixerTCPPort: UInt16 = 9002      // MIXER_JOIN/LEAVE/TUNE
    static let mixerUDPPort: UInt16 = 9003      // SPA1 audio + handshake

    /// Signaling proxy via nginx — same fronts as web, untouched by v5 cutover.
    static let signalingURL = URL(string: "wss://api.tonel.io/signaling")!

    /// User service (phone login stub mirrors web; no real OTP yet).
    static let userServiceBase = URL(string: "https://api.tonel.io")!
}
