import Foundation

/// A medication this person has actually been prescribed.
nonisolated struct PriorMedication: Identifiable, Hashable, Sendable {
    let id: String
    let display: String
    let rxnorm: String?
    let dosage: String?
    let prescriber: String?
    let prescriberReference: String?
    let authoredOn: Date?
    let isCurrent: Bool
}

/// Reads what a clinician has prescribed before, and decides whether something
/// the model proposed is one of those things.
///
/// This is the guard on the whole feature: the agent may only ever surface a
/// medication that already exists in this person's record. A name it invented
/// gets rejected here, before any UI is shown.
@MainActor
struct MedicationHistory {
    let auth: MedplumAuth

    func all() async -> [PriorMedication] {
        guard let patientID = auth.patientID, let token = await auth.token() else { return [] }
        let path = "MedicationRequest?subject=\(patientID)&_sort=-authored&_count=25"
        guard let url = URL(string: Config.medplumBaseURL.absoluteString + "fhir/R4/" + path) else { return [] }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 6

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let bundle = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = bundle["entry"] as? [[String: Any]]
        else { return [] }

        return entries.compactMap { entry in
            guard let resource = entry["resource"] as? [String: Any],
                  let id = resource["id"] as? String
            else { return nil }

            // Only clinician-authored orders count as history. A previous
            // patient proposal is not evidence anyone approved anything.
            guard resource["intent"] as? String == "order" else { return nil }

            let concept = resource["medicationCodeableConcept"] as? [String: Any]
            let coding = (concept?["coding"] as? [[String: Any]])?.first
            guard let display = (concept?["text"] as? String) ?? (coding?["display"] as? String)
            else { return nil }

            let dosage = (resource["dosageInstruction"] as? [[String: Any]])?.first?["text"] as? String
            let requester = resource["requester"] as? [String: Any]

            return PriorMedication(
                id: id,
                display: display,
                rxnorm: coding?["code"] as? String,
                dosage: dosage,
                prescriber: requester?["display"] as? String,
                prescriberReference: requester?["reference"] as? String,
                authoredOn: (resource["authoredOn"] as? String).flatMap(Self.date),
                isCurrent: (resource["status"] as? String) == "active"
            )
        }
    }

    /// Loose name match against real history. "sertraline", "Sertraline 50mg"
    /// and "Sertraline 50 mg" all resolve; "Xanax" does not, and must not.
    nonisolated static func match(_ proposed: String, in history: [PriorMedication]) -> PriorMedication? {
        let needle = normalise(proposed)
        guard !needle.isEmpty else { return nil }
        if let exact = history.first(where: { normalise($0.display) == needle }) { return exact }
        // Fall back to the drug name alone, ignoring strength — someone asking
        // for "sertraline" means the one they're on.
        return history.first {
            let name = normalise($0.display)
            return name.contains(needle) || needle.contains(firstWord(name))
        }
    }

    private nonisolated static func firstWord(_ value: String) -> String {
        String(value.split(separator: " ").first ?? "")
    }

    private nonisolated static func normalise(_ value: String) -> String {
        value.lowercased()
            .replacingOccurrences(of: "mg", with: " mg ")
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .joined(separator: " ")
    }

    private nonisolated static func date(_ value: String) -> Date? {
        ISO8601DateFormatter().date(from: value)
            ?? {
                let formatter = DateFormatter()
                formatter.dateFormat = "yyyy-MM-dd"
                return formatter.date(from: value)
            }()
    }
}
