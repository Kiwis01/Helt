import Foundation

/// Builds the clinical brief the agent starts a conversation already knowing.
///
/// Deliberately de-identified: no name, no patient id, no date of birth. The
/// model needs to reason about *what is going on*, not about who this is, and
/// this text crosses into Deepgram and Anthropic. Send the clinically useful
/// minimum and nothing more.
@MainActor
struct PatientContext {
    let auth: MedplumAuth

    /// Total time this may spend before the call proceeds without it. A slow
    /// record must never be the reason someone waits to be heard.
    private static let budget: TimeInterval = 4

    func build() async -> String? {
        guard let patientID = auth.patientID, let token = await auth.token() else { return nil }
        let deadline = Date().addingTimeInterval(Self.budget)
        var lines: [String] = []

        if let conditions = await search("Condition?patient=\(patientID)&clinical-status=active&_count=5", token, before: deadline) {
            let names = conditions.compactMap { text(($0["code"] as? [String: Any])) }
            if !names.isEmpty { lines.append("Active conditions: \(names.joined(separator: ", ")).") }
        }

        if let meds = await search("MedicationRequest?subject=\(patientID)&status=active&_count=5", token, before: deadline) {
            let names = meds.compactMap { text(($0["medicationCodeableConcept"] as? [String: Any])) }
            if !names.isEmpty { lines.append("Current medication: \(names.joined(separator: ", ")).") }
        }

        // Prior questionnaire scores — the single most useful thing for deciding
        // whether to run another one.
        for instrument in Instruments.all {
            let path = "Observation?subject=\(patientID)&code=http://loinc.org|\(instrument.totalScoreCode)"
                + "&_sort=-date&_count=3"
            guard let scores = await search(path, token, before: deadline), !scores.isEmpty else { continue }
            let described = scores.compactMap { observation -> String? in
                guard let value = observation["valueInteger"] as? Int else { return nil }
                let when = (observation["effectiveDateTime"] as? String)?.prefix(10) ?? "?"
                let band = instrument.severity(for: value).map { " (\($0.lowercased()))" } ?? ""
                return "\(value)\(band) on \(when)"
            }
            if !described.isEmpty {
                lines.append("Previous \(instrument.key) scores, most recent first: \(described.joined(separator: "; ")).")
            }
        }

        guard !lines.isEmpty else { return nil }
        lines.append("Instruments you can administer: \(Instruments.all.map(\.key).joined(separator: ", ")).")
        return lines.joined(separator: "\n")
    }

    private func search(_ path: String, _ token: String, before deadline: Date = .distantFuture) async -> [[String: Any]]? {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0.3 else { return nil }
        guard let url = URL(string: Config.medplumBaseURL.absoluteString + "fhir/R4/" + path) else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = min(remaining, 3)

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let bundle = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = bundle["entry"] as? [[String: Any]]
        else { return nil }
        return entries.compactMap { $0["resource"] as? [String: Any] }
    }

    private func text(_ concept: [String: Any]?) -> String? {
        guard let concept else { return nil }
        if let text = concept["text"] as? String { return text }
        let coding = concept["coding"] as? [[String: Any]]
        return coding?.first?["display"] as? String
    }
}
