import Foundation

/// Records the two questions asked after a reading.
///
/// These were previously handed to a `HealthSyncService` that returned a fake
/// id and discarded them. They are the only thing in the app the person tells
/// us directly, so they belong on the record next to what the sensor measured.
@MainActor
struct CheckInRecorder {
    let medplum: MedplumClient

    /// No LOINC exists for "how hard was this week", so these carry a local
    /// code. Local codes are legitimate FHIR as long as the system is declared.
    static let system = "https://helt.app/fhir/CodeSystem/check-in"

    func record(_ answers: CheckInAnswers, at date: Date = .now) async {
        guard let patientID = medplum.patientID else { return }
        let subject = FHIR.Reference.patient(patientID)

        let difficulty = FHIR.Observation(
            category: [FHIR.Observation.surveyCategory],
            code: FHIR.CodeableConcept(
                coding: [FHIR.Coding(system: Self.system, code: "week-difficulty",
                                     display: "Self-reported difficulty of the past week")],
                text: "How hard was this week? (0–10)"
            ),
            subject: subject,
            effectiveDateTime: date.fhir,
            valueInteger: answers.difficulty
        )
        await medplum.create(difficulty, type: "Observation")

        // Only when it happened. A stream of "no" adds nothing to a record and
        // makes the real signal harder to see.
        guard answers.medicationChanged else { return }

        let changed = FHIR.Observation(
            category: [FHIR.Observation.surveyCategory],
            code: FHIR.CodeableConcept(
                coding: [FHIR.Coding(system: Self.system, code: "medication-changed",
                                     display: "Patient reports a medication change")],
                text: "Medication changed this week"
            ),
            subject: subject,
            effectiveDateTime: date.fhir,
            valueBoolean: true
        )
        await medplum.create(changed, type: "Observation")
    }
}
