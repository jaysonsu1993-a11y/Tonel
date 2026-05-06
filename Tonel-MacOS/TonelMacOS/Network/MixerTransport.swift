import Foundation

/// Transport-agnostic surface that the rest of the app talks to. Two
/// concrete implementations:
///
///   - `MixerClient`     — direct TCP `:9002` + UDP `:9003` to the
///                         mixer host (lowest latency; UDP-default).
///   - `WSMixerClient`  — WS-direct SPA1 via the same proxy that
///                         serves the web client (`/mixer-tcp` and
///                         `/mixer-udp`); for users behind firewalls
///                         that block direct UDP.
///
/// Switching is **explicit and user-initiated** via Settings. There is
/// no auto-fallback (per design — see CHANGELOG v6.1.0): a connection
/// failure surfaces as an error and the user picks the other transport.
///
/// `AnyObject` because `AudioEngine` holds a `weak var mixer:` and
/// SwiftUI `state.mixer.audioRttMs` reads expect a stable identity.
protocol MixerTransport: AnyObject {

    // ── State (read-only, observed by SwiftUI via tick polling) ──────────────

    /// "room_id:user_id" composite — what goes in SPA1 `userId` slot.
    var userIdKey: String { get }
    /// Current room id (empty when disconnected).
    var roomId: String { get }
    /// Current user id (empty when disconnected).
    var userId: String { get }

    /// PING/PONG round-trip over the mixer's TCP control channel,
    /// in milliseconds. `-1` until the first PONG lands. This is the
    /// "audio RTT" — same physical path SPA1 audio rides.
    var audioRttMs: Int { get }
    /// Server-side per-user jitter target (frames), parsed from
    /// `MIXER_JOIN_ACK`. Drives the e2e latency display.
    var serverJitterTargetFrames: Int { get }
    /// Server-side per-user jitter cap (frames), parsed from
    /// `MIXER_JOIN_ACK`. Diagnostic only.
    var serverJitterMaxFrames: Int { get }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Connect to the mixer for the given room / user. Throws on any
    /// transport-level failure (TCP refused, WSS upgrade rejected,
    /// MIXER_JOIN timeout, etc.). Caller (`AppState.joinRoom`) is
    /// responsible for surfacing the error to the user.
    func connect(roomId: String, userId: String) async throws

    /// Tear down the connection. Idempotent — safe to call when not
    /// connected.
    func disconnect()

    // ── Audio plane ──────────────────────────────────────────────────────────

    /// Hand off one PCM16 frame to the wire. Called from the Core
    /// Audio capture thread — must be lock-free / non-blocking.
    func sendAudio(pcm: Data, timestampMs: UInt16)

    /// Subscribe for inbound mixer broadcasts (the N−1 mix). Returns
    /// an `unsubscribe` closure.
    func onPacket(_ handler: @escaping (MixerPacket) -> Void) -> () -> Void

    // ── Control plane ────────────────────────────────────────────────────────

    /// Push a `MIXER_TUNE` JSON over the control channel. Used by the
    /// AudioDebugSheet sliders to live-tune server jitter knobs.
    func sendMixerTune(_ knobs: [String: Any])

    /// Push a `PEER_GAIN` JSON over the control channel. Per-recipient
    /// per-source gain map; clamped server-side to [0, 2].
    func sendPeerGain(targetUserId: String, gain: Float)
}
