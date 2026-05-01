import Foundation

/// Visible peer in the current room, plus the latest input level (0…1).
struct PeerVM: Identifiable, Equatable {
    let userId: String
    var level: Float
    var gain: Float = 1.0
    var muted: Bool = false
    var id: String { userId }
}
