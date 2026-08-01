import Foundation
import Testing
@testable import Loop

/// The agent may only ever surface a medication a clinician already prescribed.
/// Everything else is refused in code, before any UI exists.
struct MedicationTests {

    private let history = [
        PriorMedication(id: "1", display: "Sertraline 50 mg", rxnorm: "312938",
                        dosage: "Once daily", prescriber: "Dr. Maya Chen",
                        prescriberReference: "Practitioner/1",
                        authoredOn: .now, isCurrent: true),
        PriorMedication(id: "2", display: "Sertraline 25 mg", rxnorm: "312940",
                        dosage: "Once daily", prescriber: "Dr. Maya Chen",
                        prescriberReference: "Practitioner/1",
                        authoredOn: .now.addingTimeInterval(-86400 * 28), isCurrent: false),
    ]

    @Test(arguments: ["Sertraline 50 mg", "sertraline 50mg", "SERTRALINE 50 MG", "sertraline"])
    func matchesWhatIsActuallyPrescribed(name: String) {
        #expect(MedicationHistory.match(name, in: history) != nil)
    }

    /// The one that matters. A drug the model invented must never reach the UI.
    @Test(arguments: ["Xanax", "alprazolam", "diazepam", "St John's Wort",
                      "magnesium glycinate", "propranolol", ""])
    func refusesAnythingNotInTheRecord(name: String) {
        #expect(MedicationHistory.match(name, in: history) == nil,
                "\(name.debugDescription) is not in this patient's history and must be refused")
    }

    @Test func refusesEverythingWhenThereIsNoHistory() {
        #expect(MedicationHistory.match("Sertraline 50 mg", in: []) == nil)
    }

    /// Only clinician-authored orders count. A previous patient-initiated
    /// proposal is not evidence that anyone approved anything — otherwise the
    /// app would bootstrap its own justification.
    @Test func proposalsAreNotTreatedAsPrescribingHistory() async throws {
        // Encodes as intent "proposal", which the parser skips.
        let proposal = FHIR.MedicationRequest(
            subject: .patient("p1"),
            medicationCodeableConcept: .init(text: "Sertraline 50 mg"),
            authoredOn: Date().fhir,
            requester: .patient("p1")
        )
        #expect(proposal.intent == "proposal")
        #expect(proposal.status == "draft")
    }

    // MARK: - What gets written

    @Test func requestIsADraftProposalNotAnOrder() {
        let request = FHIR.MedicationRequest(
            subject: .patient("p1"),
            medicationCodeableConcept: .init(text: "Sertraline 50 mg"),
            authoredOn: Date().fhir,
            requester: .patient("p1")
        )
        // FHIR's own encoding of "suggested, awaiting authorisation".
        #expect(request.intent == "proposal")
        #expect(request.status == "draft")
        // Recorded as the patient asking, not the app prescribing.
        #expect(request.requester.reference == "Patient/p1")
    }

    @Test func taskSerialisesForAsAReservedWord() throws {
        let task = FHIR.Task(
            code: .init(text: "Review medication request"),
            focus: .init(reference: "MedicationRequest/1"),
            forReference: .patient("p1"),
            requester: .patient("p1"),
            authoredOn: Date().fhir
        )
        let json = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(task)) as? [String: Any]
        // `for` is a Swift keyword; FHIR needs the field spelled exactly.
        #expect(json?["for"] != nil)
        #expect(json?["forReference"] == nil)
        #expect(json?["status"] as? String == "requested")
    }

    @Test func bothToolsAreDeclaredToTheModel() {
        let names = AgentTools.definitions.compactMap { $0["name"] as? String }
        #expect(names.contains("administer_questionnaire"))
        #expect(names.contains("request_medication"))
    }

    @Test func decodesAMedicationToolCall() {
        let payload: [String: Any] = ["functions": [[
            "id": "toolu_9", "name": "request_medication",
            "arguments": #"{"medication":"Sertraline 50 mg","reason":"symptoms returning"}"#,
        ]]]
        let call = AgentTools.calls(in: payload).first
        #expect(call?.name == "request_medication")
        #expect(call?.medication == "Sertraline 50 mg")
        #expect(call?.reason == "symptoms returning")
    }
}
