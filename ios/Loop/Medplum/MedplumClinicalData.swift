import Foundation

/// Real prescriptions from Medplum, turned into the markers on the trend chart.
///
/// Nothing here knows any drug by name. Whatever a clinician prescribes shows
/// up; the "started / dose changed / stopped" story is derived from the shape
/// of the record, not from a table of medications we know about.
@MainActor
struct MedplumClinicalDataService: ClinicalDataService {
    let auth: MedplumAuth

    func medications() async throws -> [Medication] {
        prescriptions(from: await history())
            .filter(\.isCurrent)
            .map { Medication(id: $0.id, name: $0.display, dose: $0.dosage ?? "", startedOn: $0.authoredOn ?? .now) }
    }

    func medicationEvents() async throws -> [MedicationEvent] {
        let all = prescriptions(from: await history())
            .filter { $0.authoredOn != nil }
            .sorted { ($0.authoredOn ?? .distantPast) < ($1.authoredOn ?? .distantPast) }

        // Grouped by drug, so a strength change reads as a change rather than
        // a second, unrelated medication appearing.
        var seen: Set<String> = []
        return all.map { prescription in
            let drug = Self.drugName(prescription.display)
            let isFirst = seen.insert(drug).inserted
            let kind: MedicationEvent.Kind = isFirst
                ? .started
                : (prescription.isCurrent ? .doseChanged : .stopped)
            return MedicationEvent(
                id: prescription.id,
                date: prescription.authoredOn ?? .now,
                kind: kind,
                medication: drug,
                dose: Self.strength(prescription.display)
            )
        }
    }

    private func history() async -> [PriorMedication] {
        await MedicationHistory(auth: auth).all()
    }

    private func prescriptions(from history: [PriorMedication]) -> [PriorMedication] { history }

    /// "Sertraline 50 mg" → "Sertraline". Naive on purpose: the first token of
    /// a medication description is the drug in every form we write.
    nonisolated static func drugName(_ display: String) -> String {
        String(display.split(separator: " ").first ?? Substring(display))
    }

    /// Everything after the drug name, if there is any.
    nonisolated static func strength(_ display: String) -> String? {
        let parts = display.split(separator: " ").dropFirst()
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}
