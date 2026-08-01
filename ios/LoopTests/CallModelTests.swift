import Foundation
import Testing
@testable import Loop

/// A service the test drives by hand, so state transitions can be checked
/// without waiting on the canned script.
@MainActor
final class FakeConversationService: ConversationService {
    var continuation: AsyncThrowingStream<ConversationEvent, Error>.Continuation?
    private(set) var interruptions = 0

    func connect() async throws -> AsyncThrowingStream<ConversationEvent, Error> {
        AsyncThrowingStream { self.continuation = $0 }
    }
    func send(audio: Data) async throws {}
    func interrupt() async { interruptions += 1 }
    func disconnect() async {}

    private(set) var answered: [(AgentTools.Call, [String: Any])] = []
    func answer(_ call: AgentTools.Call, with content: [String: Any]) async {
        answered.append((call, content))
    }

    func yieldEvent(_ event: ConversationEvent) { continuation?.yield(event) }
}

@MainActor
struct CallModelTests {
    private func connected() async throws -> (CallModel, FakeConversationService) {
        let service = FakeConversationService()
        let model = CallModel(service: service)
        model.start()
        try await until { service.continuation != nil }
        return (model, service)
    }

    private func until(_ condition: @escaping () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("condition never became true")
    }

    @Test func agentTurnStartsSpeaking() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.transcript(Turn(speaker: .agent, text: "Hello.", isFinal: true)))
        try await until { model.state == .speaking }
    }

    /// The one that matters: talking over the agent must stop playback
    /// immediately, not after the current turn finishes.
    @Test func speakingOverTheAgentInterruptsIt() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.transcript(Turn(speaker: .agent, text: "Breathe in for four —", isFinal: true)))
        try await until { model.state == .speaking }

        service.yieldEvent(.transcript(Turn(speaker: .you, text: "Wait, my chest feels tight.", isFinal: true)))

        try await until { service.interruptions == 1 }
        #expect(model.state == .thinking)
    }

    @Test func speakingWhenNotInterruptedDoesNotCallInterrupt() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.transcript(Turn(speaker: .agent, text: "Hello.", isFinal: true)))
        try await until { model.state == .speaking }

        service.yieldEvent(.agentSpeechEnded)
        try await until { model.state == .listening }

        service.yieldEvent(.transcript(Turn(speaker: .you, text: "Okay.", isFinal: true)))
        try await until { model.state == .thinking }
        #expect(service.interruptions == 0)
    }

    /// Interim results refine the turn in place instead of stacking up.
    @Test func partialTurnsAreReplacedNotAppended() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.transcript(Turn(speaker: .you, text: "I can't", isFinal: false)))
        try await until { model.transcript.count == 1 }

        service.yieldEvent(.transcript(Turn(speaker: .you, text: "I can't slow it down.", isFinal: true)))
        try await until { model.transcript.last?.isFinal == true }

        #expect(model.transcript.count == 1)
        #expect(model.transcript.last?.text == "I can't slow it down.")
    }

    /// The safety guarantee: a red flag stops the agent and the reply queued
    /// behind it never becomes a turn.
    @Test func redFlagStopsTheAgentBeforeItCanReply() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.transcript(Turn(speaker: .agent, text: "Want to try box breathing?", isFinal: true)))
        try await until { model.state == .speaking }

        service.yieldEvent(.transcript(Turn(
            speaker: .you,
            text: "My chest hurts and it's spreading down my left arm.",
            isFinal: true
        )))
        try await until { model.escalation != nil }

        #expect(model.escalation?.id == "RF-01-CHEST-PAIN-RADIATING")
        #expect(model.escalation?.action == .call911)
        #expect(model.state == .escalated)
        #expect(service.interruptions == 1)

        // Anything the model had queued must not reach the transcript.
        let turnsAtEscalation = model.transcript.count
        service.yieldEvent(.transcript(Turn(speaker: .agent, text: "Let's start with four counts in.", isFinal: true)))
        try await Task.sleep(for: .milliseconds(120))
        #expect(model.transcript.count == turnsAtEscalation)
        #expect(model.state == .escalated)
    }

    @Test func ordinaryDistressDoesNotEscalate() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.transcript(Turn(speaker: .you, text: "My chest feels tight and I can't breathe.", isFinal: true)))
        try await until { model.state == .thinking }
        #expect(model.escalation == nil)
    }

    /// The agentic loop: the model asks for an instrument, the app presents it,
    /// and the score goes back so the model can respond to it.
    @Test func toolCallSurfacesTheQuestionnaireAndReturnsTheScore() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.toolCall(.init(
            id: "toolu_1",
            name: "administer_questionnaire",
            arguments: ["instrument": "GAD-7", "reason": "three weeks"]
        )))
        try await until { model.pendingQuestionnaire != nil }
        #expect(model.pendingQuestionnaire?.instrument.key == "GAD-7")

        let answers = (1...7).map { Answer(itemID: $0, value: 1) }
        await model.finishQuestionnaire(score: 7, answers: answers, flag: nil, recorder: nil)

        #expect(model.pendingQuestionnaire == nil)
        let (call, content) = try #require(service.answered.last)
        #expect(call.id == "toolu_1")
        #expect(content["score"] as? Int == 7)
        #expect(content["severity"] as? String == "Mild")
    }

    /// A PHQ-9 item-9 hit outranks the score: it escalates like a spoken red flag.
    @Test func questionnaireSafetyItemEscalates() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.toolCall(.init(
            id: "toolu_2", name: "administer_questionnaire", arguments: ["instrument": "PHQ-9"]
        )))
        try await until { model.pendingQuestionnaire != nil }

        let answers = (1...9).map { Answer(itemID: $0, value: $0 == 9 ? 2 : 0) }
        let flag = try #require(Instruments.phq9.safetyEvent(in: answers))
        await model.finishQuestionnaire(score: 2, answers: answers, flag: flag, recorder: nil)

        #expect(model.escalation?.action == .call988)
        #expect(model.state == .escalated)
        // The model is told it escalated, but never gets the score to talk about.
        #expect(service.answered.last?.1["escalated"] as? Bool == true)
        #expect(service.answered.last?.1["score"] == nil)
    }

    /// Declining must release the model, or it waits on a reply that never comes.
    @Test func decliningAnswersTheToolCall() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.toolCall(.init(
            id: "toolu_3", name: "administer_questionnaire", arguments: ["instrument": "GAD-7"]
        )))
        try await until { model.pendingQuestionnaire != nil }

        await model.declineQuestionnaire()
        #expect(model.pendingQuestionnaire == nil)
        #expect(service.answered.last?.1["completed"] as? Bool == false)
    }

    /// An instrument we don't have must get a reply too, not silence.
    @Test func unknownInstrumentIsRefusedNotIgnored() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.toolCall(.init(
            id: "toolu_4", name: "administer_questionnaire", arguments: ["instrument": "BDI-II"]
        )))
        try await until { service.answered.isEmpty == false }
        #expect(model.pendingQuestionnaire == nil)
        #expect(service.answered.last?.1["error"] != nil)
    }

    @Test func closingEndsTheCall() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.closed)
        try await until { model.state == .ended }
        #expect(model.level == 0)
    }
}
