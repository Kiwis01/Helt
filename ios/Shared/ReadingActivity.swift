import ActivityKit
import Foundation

/// Shared between the app and the widget extension.
///
/// Note what is *not* here: a heart rate. The reading's whole discipline is
/// that the number is never shown while it is being taken, and the Lock Screen
/// is no exception. The Live Activity carries time and phase only, so there is
/// nothing for a glance at a locked phone to fixate on.
nonisolated struct ReadingActivityAttributes: ActivityAttributes, Sendable {
    public struct ContentState: Codable, Hashable, Sendable {
        var phase: Phase
        var startedAt: Date
        var endsAt: Date
    }

    /// Nothing static varies yet; kept so the attributes can grow.
    var name: String = "Reading"
}

nonisolated extension ReadingActivityAttributes.ContentState {
    enum Phase: String, Codable, Hashable, Sendable {
        case preparing
        case reading
        case saving
        case done

        var label: String {
            switch self {
            case .preparing: "Getting ready"
            case .reading: "Reading"
            case .saving: "Saving"
            case .done: "Done"
            }
        }

        var isCounting: Bool { self == .reading }
    }
}
