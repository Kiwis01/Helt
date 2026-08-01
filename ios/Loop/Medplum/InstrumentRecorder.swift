import Foundation

/// Writes a completed questionnaire to Medplum: the `QuestionnaireResponse` is
/// the evidence, the `Observation` is the number so it charts alongside heart
/// rate instead of being locked inside a form.
@MainActor
struct InstrumentRecorder {
    let medplum: MedplumClient

    func record(
        _ instrument: Instrument,
        score: Int,
        answers: [Answer],
        at date: Date = .now
    ) async {
        guard let patientID = medplum.patientID else { return }
        let subject = FHIR.Reference.patient(patientID)

        let response = FHIR.QuestionnaireResponse(
            questionnaire: instrument.id,
            subject: subject,
            authored: date.fhir,
            author: subject,
            item: answers.sorted { $0.itemID < $1.itemID }.compactMap { answer in
                guard let item = instrument.items.first(where: { $0.id == answer.itemID }),
                      let option = instrument.option(for: answer.value)
                else { return nil }
                return FHIR.QuestionnaireResponse.Item(
                    linkId: String(item.id),
                    text: item.text,
                    answer: [.init(valueCoding: FHIR.Coding(
                        system: "http://loinc.org", code: option.loinc, display: option.text
                    ))]
                )
            }
        )
        let responseID = await medplum.create(response, type: "QuestionnaireResponse")

        let observation = FHIR.Observation(
            category: [FHIR.Observation.surveyCategory],
            code: .loinc(instrument.totalScoreCode, "\(instrument.key) total score"),
            subject: subject,
            effectiveDateTime: date.fhir,
            valueInteger: score,
            interpretation: instrument.severity(for: score).map { [FHIR.CodeableConcept(text: $0)] },
            derivedFrom: responseID.map { [FHIR.Reference(reference: "QuestionnaireResponse/\($0)")] }
        )
        await medplum.create(observation, type: "Observation")
    }
}
