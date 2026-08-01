import Foundation
import Testing
@testable import Loop

struct InstrumentTests {

    private func answers(_ values: [Int]) -> [Answer] {
        values.enumerated().map { Answer(itemID: $0.offset + 1, value: $0.element) }
    }

    // MARK: - Scoring

    @Test func gad7SumsToTwentyOne() {
        #expect(Instruments.gad7.score(answers([3, 3, 3, 3, 3, 3, 3])) == 21)
        #expect(Instruments.gad7.score(answers([0, 0, 0, 0, 0, 0, 0])) == 0)
        #expect(Instruments.gad7.score(answers([1, 2, 0, 3, 1, 0, 2])) == 9)
    }

    @Test func phq9SumsToTwentySeven() {
        #expect(Instruments.phq9.score(answers(Array(repeating: 3, count: 9))) == 27)
    }

    /// A partial questionnaire is not a score and must never be recorded as one.
    @Test func incompleteOrOutOfRangeProducesNoScore() {
        #expect(Instruments.gad7.score(answers([1, 2, 3])) == nil)
        #expect(Instruments.gad7.score([]) == nil)
        #expect(Instruments.gad7.score(answers([0, 0, 0, 0, 0, 0, 4])) == nil)
        #expect(Instruments.gad7.score(answers([0, 0, 0, 0, 0, 0, -1])) == nil)
    }

    @Test(arguments: [(0, "Minimal"), (4, "Minimal"), (5, "Mild"), (9, "Mild"),
                      (10, "Moderate"), (14, "Moderate"), (15, "Severe"), (21, "Severe")])
    func gad7Bands(score: Int, expected: String) {
        #expect(Instruments.gad7.severity(for: score) == expected)
    }

    // MARK: - Safety

    /// PHQ-9 item 9 is suicidal ideation. Any non-zero answer is a safety event
    /// routed to 988, not a number that quietly adds to a total.
    @Test func phq9ItemNineEscalates() {
        let flagged = Instruments.phq9.safetyEvent(in: answers([0, 0, 0, 0, 0, 0, 0, 0, 1]))
        #expect(flagged?.action == .call988)
        #expect(flagged?.id == "RF-07-SELF-HARM")
    }

    @Test func phq9WithoutItemNineDoesNotEscalate() {
        #expect(Instruments.phq9.safetyEvent(in: answers([3, 3, 3, 3, 3, 3, 3, 3, 0])) == nil)
    }

    @Test func gad7HasNoSafetyItem() {
        #expect(Instruments.gad7.safetyEvent(in: answers([3, 3, 3, 3, 3, 3, 3])) == nil)
    }

    // MARK: - Catalogue

    @Test func everyInstrumentIsInternallyConsistent() {
        for instrument in Instruments.all {
            #expect(Set(instrument.items.map(\.loinc)).count == instrument.items.count,
                    "\(instrument.key) has duplicate item codes")
            #expect(Set(instrument.items.map(\.id)) == Set(1...instrument.items.count))
            #expect(instrument.severity(for: instrument.maximumScore) != nil,
                    "\(instrument.key) has no band covering its maximum")
            #expect(instrument.escalatingItems.allSatisfy { $0 <= instrument.items.count })
        }
    }

    /// The model names instruments in free text, so lookup has to be forgiving.
    @Test(arguments: ["GAD-7", "gad7", "GAD7", "gad-7"])
    func instrumentLookupIsTolerant(name: String) {
        #expect(Instruments.named(name)?.key == "GAD-7")
    }

    @Test func unknownInstrumentIsNotInvented() {
        #expect(Instruments.named("BDI-II") == nil)
        #expect(Instruments.named("") == nil)
    }

    @Test func summaryReportsANumberWithoutDiagnosing() {
        let text = Instruments.gad7.summary(for: 16).lowercased()
        #expect(text.contains("16"))
        #expect(!text.contains("you have"))
        #expect(!text.contains("disorder"))
    }

    // MARK: - Tool wire format

    /// Shapes captured from a live Deepgram session — `functions` is an array
    /// and `arguments` is a JSON string, not an object.
    @Test func decodesDeepgramFunctionCallRequest() {
        let payload: [String: Any] = [
            "type": "FunctionCallRequest",
            "functions": [[
                "id": "toolu_01ABC",
                "name": "administer_questionnaire",
                "arguments": #"{"instrument":"GAD-7","reason":"daily for three weeks"}"#,
                "client_side": true,
            ]],
        ]
        let calls = AgentTools.calls(in: payload)
        #expect(calls.count == 1)
        #expect(calls.first?.id == "toolu_01ABC")
        #expect(calls.first?.instrument?.key == "GAD-7")
        #expect(calls.first?.reason == "daily for three weeks")
    }

    @Test func buildsAFunctionCallResponse() {
        let call = AgentTools.Call(id: "toolu_1", name: "administer_questionnaire", arguments: [:])
        let response = AgentTools.response(for: call, content: ["score": 9])
        #expect(response["type"] as? String == "FunctionCallResponse")
        #expect(response["id"] as? String == "toolu_1")
        // content must be a JSON *string*, which is what tripped the earlier
        // hand-written message and got the session killed.
        #expect((response["content"] as? String)?.contains("\"score\"") == true)
    }
}
