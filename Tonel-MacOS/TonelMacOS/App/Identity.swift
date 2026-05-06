import Foundation

/// Persistent identity for an unregistered Tonel-MacOS user.
///
/// v6.2.0 dropped the login + home-page flow. The app now boots directly
/// into a room. To make that work without an account system, every user
/// gets a locally-generated `userId` on first launch (saved in
/// UserDefaults) plus a personal `myRoomId` — a 6-character uppercase
/// alphanumeric room number that's short enough to share verbally with
/// bandmates.
///
/// Identity persists across launches; the only way to reset it is the
/// "重置身份" button in Settings (which regenerates both ids and forces
/// a reconnect).
enum Identity {

    // MARK: - Storage keys

    /// Internal user id — long, opaque, used in SPA1 `userId` slot
    /// alongside the room id. Never shown to the user.
    static let userIdKey    = "tonel.identity.userId"
    /// User-facing personal room number — short, shareable. Always
    /// uppercase A-Z and digits 2-9 (skipping 0/1/I/O to avoid the
    /// "did you say zero or oh" verbal-share trap).
    static let myRoomIdKey  = "tonel.identity.myRoomId"
    /// Last room the user was in (sticky across launches). Defaults to
    /// `myRoomId` on first launch; set by `AppState` whenever the user
    /// switches rooms so re-launches return them where they left off.
    static let currentRoomIdKey = "tonel.identity.currentRoomId"

    // MARK: - Reads

    /// Load (and lazily create) the persistent identity. First call
    /// after install generates and stores fresh values; later calls
    /// return what's stored.
    static func loadOrCreate() -> (userId: String, myRoomId: String, currentRoomId: String) {
        let defaults = UserDefaults.standard

        let userId: String
        if let saved = defaults.string(forKey: userIdKey), !saved.isEmpty {
            userId = saved
        } else {
            userId = generateUserId()
            defaults.set(userId, forKey: userIdKey)
        }

        let myRoom: String
        if let saved = defaults.string(forKey: myRoomIdKey), !saved.isEmpty {
            myRoom = saved
        } else {
            myRoom = generateRoomId()
            defaults.set(myRoom, forKey: myRoomIdKey)
        }

        let current: String
        if let saved = defaults.string(forKey: currentRoomIdKey), !saved.isEmpty {
            current = saved
        } else {
            current = myRoom
            defaults.set(current, forKey: currentRoomIdKey)
        }

        return (userId: userId, myRoomId: myRoom, currentRoomId: current)
    }

    /// Update the sticky current-room pointer (called whenever the user
    /// successfully joins / switches rooms).
    static func saveCurrentRoom(_ roomId: String) {
        UserDefaults.standard.set(roomId, forKey: currentRoomIdKey)
    }

    /// Wipe the saved identity. Caller is responsible for forcing a
    /// reconnect afterwards (the audio stream stays valid until the
    /// user-facing pieces of state regenerate).
    static func reset() {
        UserDefaults.standard.removeObject(forKey: userIdKey)
        UserDefaults.standard.removeObject(forKey: myRoomIdKey)
        UserDefaults.standard.removeObject(forKey: currentRoomIdKey)
    }

    // MARK: - Generators

    /// `user_<ms>_<5-digit>` — same shape we used pre-v6.2.0 for the
    /// ephemeral phone-stub uids, so server-side parsing / logs don't
    /// have to change. Internal id; never shown to the user.
    private static func generateUserId() -> String {
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let suffix = String(Int.random(in: 0..<99999)).padding(toLength: 5, withPad: "0", startingAt: 0)
        return "user_\(ms)_\(suffix)"
    }

    /// 6-character uppercase room id from a "speakable" alphabet.
    /// Excludes `0/1/I/O` to remove the verbal-share ambiguity ("zero
    /// or oh", "one or el"). 32 chars × 6 positions ≈ 1.07 billion
    /// possible ids — enough to keep collisions astronomically rare
    /// for hobby use without a server-side uniqueness check.
    private static let roomIdAlphabet = Array("23456789ABCDEFGHJKLMNPQRSTUVWXYZ")

    static func generateRoomId() -> String {
        String((0..<6).map { _ in roomIdAlphabet.randomElement()! })
    }

    /// Validate a user-typed room id when switching rooms. We don't
    /// enforce the strict alphabet here (older / web-created rooms may
    /// use other characters) — just basic length + non-empty + ASCII
    /// alphanumeric so the wire packet doesn't carry junk.
    static func isPlausibleRoomId(_ s: String) -> Bool {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (3...32).contains(trimmed.count) else { return false }
        return trimmed.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }
}
