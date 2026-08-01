import Foundation

/// Writes a patient-initiated medication request, and the clinician's job to
/// act on it.
///
/// Two resources on purpose. The `MedicationRequest` is a *proposal* in draft —
/// FHIR's own representation of "suggested, not authorised" — and the `Task` is
/// what puts it in a human's queue. Nothing here can become an active
/// prescription without a clinician changing it.
@MainActor
struct MedicationRequestRecorder {
    let medplum: MedplumClient

    /// Returns the id of the created proposal, if it reached Medplum.
    @discardableResult
    func request(_ medication: PriorMedication, reason: String?, at date: Date = .now) async -> String? {
        guard let patientID = medplum.patientID else { return nil }
        let subject = FHIR.Reference.patient(patientID)

        var coding: [FHIR.Coding] = []
        if let rxnorm = medication.rxnorm {
            coding.append(FHIR.Coding(
                system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                code: rxnorm, display: medication.display
            ))
        }

        let proposal = FHIR.MedicationRequest(
            subject: subject,
            medicationCodeableConcept: FHIR.CodeableConcept(
                coding: coding.isEmpty ? nil : coding, text: medication.display
            ),
            authoredOn: date.fhir,
            // Recorded honestly: the patient asked, not the app and not a model.
            requester: subject,
            performer: medication.prescriberReference.map {
                FHIR.Reference(reference: $0, display: medication.prescriber)
            },
            basedOn: [FHIR.Reference(reference: "MedicationRequest/\(medication.id)")],
            note: reason.map { [.init(text: "Raised during a HELT conversation: \($0)")] }
        )

        guard let proposalID = await medplum.create(proposal, type: "MedicationRequest") else { return nil }

        let task = FHIR.Task(
            code: FHIR.CodeableConcept(
                coding: [FHIR.Coding(
                    system: "http://hl7.org/fhir/CodeSystem/task-code",
                    code: "approve", display: "Activate/approve the focal resource"
                )],
                text: "Review medication request"
            ),
            description: "\(medication.display) — requested by the patient during a HELT conversation.",
            focus: FHIR.Reference(reference: "MedicationRequest/\(proposalID)"),
            forReference: subject,
            owner: medication.prescriberReference.map {
                FHIR.Reference(reference: $0, display: medication.prescriber)
            },
            requester: subject,
            authoredOn: date.fhir
        )
        await medplum.create(task, type: "Task")

        return proposalID
    }
}
