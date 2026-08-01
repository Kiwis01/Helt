import Foundation

/// A canned exchange so the voice UI is testable with no backend and no audio.
///
/// The script is written to exercise the states the UI has to get right: an
/// opening that cites real numbers, a pause for thinking, and a barge-in where
/// the user talks over the agent mid-sentence.
struct MockConversationService: ConversationService {
    enum Script {
        /// Contextual conversation with a barge-in. No red flag fires.
        case ordinary
        /// The safety path: the person describes radiating chest pain and the
        /// agent is cut off before it can reply.
        case redFlag
    }

    var script: Script = .ordinary
    /// Speed multiplier — 1 is realistic pacing.
    var pace: Double = 1

    private enum Beat {
        case agent(String)
        case you(String)
        /// The user cuts in this many seconds into the agent's current turn.
        case youInterrupting(String, after: Double)
        case pause(Double)
    }

    /// The agent's closing line here is never heard: the red flag fires on the
    /// user's turn and the call is torn down before this reaches the speaker.
    /// Its presence in the script is the point — it proves the model does not
    /// get to decide.
    private static let redFlagBeats: [Beat] = [
        .agent("Your heart rate is 124 and your average is 68. Your care plan starts with box breathing — want to try it with me?"),
        .pause(1.3),
        .you("My chest hurts and it's spreading down my left arm."),
        .pause(0.6),
        .agent("Let's start with four counts in — that usually settles things down."),
    ]

    private static let ordinaryBeats: [Beat] = [
        .agent("Your heart rate is 118. Your average is 68. Your care plan starts with box breathing — want to do it together?"),
        .pause(1.4),
        .you("I can't slow it down. It's been like this for twenty minutes."),
        .pause(1.3),
        .agent("Twenty minutes. Your breathing is at 24 a minute; usually you sit around 14. Let's take the first cycle together. Breathe in for four —"),
        .youInterrupting("Wait, my chest feels tight.", after: 2.2),
        .pause(1.1),
        .agent("I stopped. Does the tightness spread to your arm or your jaw, or is it staying in the middle?"),
        .pause(1.5),
        .you("It's just in the middle. It happens when I panic."),
        .pause(1.2),
        .agent("Your care plan has box breathing first, then grounding. Your heart rate is 112 now, down from 118. Want to keep going?"),
    ]

    func connect() async throws -> AsyncThrowingStream<ConversationEvent, Error> {
        let beats = script == .redFlag ? Self.redFlagBeats : Self.ordinaryBeats
        let pace = pace
        return AsyncThrowingStream { continuation in
            let task = Task {
                for beat in beats {
                    if Task.isCancelled { break }
                    switch beat {
                    case .pause(let seconds):
                        try? await Task.sleep(for: .seconds(seconds / pace))

                    case .you(let text):
                        continuation.yield(.transcript(Turn(speaker: .you, text: text, isFinal: true)))

                    case .agent(let text):
                        continuation.yield(.transcript(Turn(speaker: .agent, text: text, isFinal: true)))
                        try? await Task.sleep(for: .seconds(Self.spokenDuration(text) / pace))
                        continuation.yield(.agentSpeechEnded)

                    case .youInterrupting(let text, let after):
                        try? await Task.sleep(for: .seconds(after / pace))
                        // No agentSpeechEnded: the agent is cut off, not finished.
                        continuation.yield(.transcript(Turn(speaker: .you, text: text, isFinal: true)))
                    }
                }
                continuation.yield(.closed)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func send(audio: Data) async throws {}
    func interrupt() async {}
    func answer(_ call: AgentTools.Call, with content: [String: Any]) async {}
    func disconnect() async {}

    /// Roughly 165 words a minute, the pace of someone talking calmly.
    private static func spokenDuration(_ text: String) -> Double {
        let words = text.split(whereSeparator: \.isWhitespace).count
        return max(1.4, Double(words) / 165 * 60)
    }
}
