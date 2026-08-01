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

    @Test func closingEndsTheCall() async throws {
        let (model, service) = try await connected()
        service.yieldEvent(.closed)
        try await until { model.state == .ended }
        #expect(model.level == 0)
    }
}
