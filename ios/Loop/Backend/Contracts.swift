import Foundation

// MARK: - Models

struct WeeklyPoint: Identifiable, Hashable, Sendable {
    let weekStart: Date
    let value: Double

    var id: Date { weekStart }
}

/// A medication start or change. These are the marks on the trend chart, and
/// the reason the chart exists.
struct MedicationEvent: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable {
        case started, doseChanged, stopped

        var label: String {
            switch self {
            case .started: "Started"
            case .doseChanged: "Dose changed"
            case .stopped: "Stopped"
            }
        }
    }

    let id: String
    let date: Date
    let kind: Kind
    let medication: String
    let dose: String?

    var summary: String {
        if let dose { "\(kind.label) \(medication), \(dose)" } else { "\(kind.label) \(medication)" }
    }
}

struct Medication: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let dose: String
    let startedOn: Date
}

/// What the user reports after a reading. Two questions, no more.
struct CheckInAnswers: Hashable, Sendable {
    /// 0–10, how hard the week was.
    let difficulty: Int
    let medicationChanged: Bool
}

struct ReadingSummary: Hashable, Sendable {
    let startedAt: Date
    let durationSeconds: TimeInterval
    let answers: CheckInAnswers?
}

/// One turn of a conversation.
struct Turn: Identifiable, Hashable, Sendable {
    enum Speaker: Sendable { case you, agent }
    let id = UUID()
    let speaker: Speaker
    let text: String
    let isFinal: Bool
}

enum ConversationEvent: Sendable {
    case transcript(Turn)
    case agentAudio(Data)
    case agentSpeechEnded
    /// The model wants the app to do something and is waiting for the result.
    case toolCall(AgentTools.Call)
    case closed
}

// MARK: - Services

/// Opens a voice session, streams audio up, receives transcript and audio down.
protocol ConversationService {
    /// Turns arrive as they are recognised, partials first.
    func connect() async throws -> AsyncThrowingStream<ConversationEvent, Error>
    func send(audio: Data) async throws
    /// Stop the agent mid-sentence — used on barge-in and on red flags.
    func interrupt() async
    /// Return a tool result so the model can reason about it and reply.
    func answer(_ call: AgentTools.Call, with content: [String: Any]) async
    func disconnect() async
}

/// Fetches medication list and weekly outcome history.
protocol ClinicalDataService {
    func medications() async throws -> [Medication]
    func medicationEvents() async throws -> [MedicationEvent]
}
