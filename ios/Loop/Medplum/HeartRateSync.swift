import Foundation

/// Heart rate in and out of Medplum.
///
/// Medplum is the record. A reading taken on this phone is pushed up as an
/// `Observation`; the trend is then read back from Medplum, so readings taken
/// anywhere — this phone, another device, a clinic — all appear together.
@MainActor
struct HeartRateSync {
    let auth: MedplumAuth
    let medplum: MedplumClient

    static let heartRateCode = "8867-4"

    // MARK: - Push

    /// Writes one reading. Idempotent by timestamp: re-running a sync will not
    /// duplicate a reading that already reached Medplum.
    @discardableResult
    func push(average: Double, at date: Date) async -> String? {
        guard let patientID = medplum.patientID else { return nil }
        if await exists(at: date, patientID: patientID) { return nil }

        let observation = FHIR.Observation(
            category: [FHIR.Observation.vitalsCategory],
            code: .loinc(Self.heartRateCode, "Heart rate"),
            subject: .patient(patientID),
            effectiveDateTime: date.fhir,
            valueQuantity: FHIR.Quantity(
                value: (average * 10).rounded() / 10,
                unit: "beats/minute",
                system: "http://unitsofmeasure.org",
                code: "/min"
            )
        )
        return await medplum.create(observation, type: "Observation")
    }

    /// A reading is the same reading if it lands within a minute of one we
    /// already sent — so a retry after a dropped connection can't duplicate it.
    private func exists(at date: Date, patientID: String) async -> Bool {
        let from = date.addingTimeInterval(-30).fhir
        let to = date.addingTimeInterval(30).fhir
        let query = "Observation?subject=\(patientID)&code=http://loinc.org|\(Self.heartRateCode)"
            + "&date=ge\(from)&date=le\(to)&_count=1"
        return (await fetch(query))?.isEmpty == false
    }

    // MARK: - Pull

    /// Every heart-rate reading Medplum holds, newest last.
    func readings(limit: Int = 200) async -> [(date: Date, value: Double)] {
        guard let patientID = medplum.patientID else { return [] }
        let query = "Observation?subject=\(patientID)&code=http://loinc.org|\(Self.heartRateCode)"
            + "&_sort=-date&_count=\(limit)"
        guard let resources = await fetch(query) else { return [] }

        return resources.compactMap { resource -> (Date, Double)? in
            guard let quantity = resource["valueQuantity"] as? [String: Any],
                  let value = quantity["value"] as? Double,
                  let when = (resource["effectiveDateTime"] as? String).flatMap(Self.date)
            else { return nil }
            return (when, value)
        }
        .sorted { $0.0 < $1.0 }
        .map { (date: $0.0, value: $0.1) }
    }

    /// Bucketed into the weeks the trend chart draws. Several readings in one
    /// week average together — which is the point of a weekly trend.
    func weeklyPoints(weeks: Int) async -> [WeeklyPoint] {
        let calendar = Calendar.current
        let cutoff = calendar.date(byAdding: .weekOfYear, value: -(weeks - 1),
                                   to: calendar.dateInterval(of: .weekOfYear, for: .now)!.start)!

        let grouped = Dictionary(grouping: await readings().filter { $0.date >= cutoff }) {
            calendar.dateInterval(of: .weekOfYear, for: $0.date)?.start ?? $0.date
        }
        return grouped
            .map { WeeklyPoint(weekStart: $0.key, value: $0.value.map(\.value).reduce(0, +) / Double($0.value.count)) }
            .sorted { $0.weekStart < $1.weekStart }
    }

    // MARK: - Plumbing

    private func fetch(_ query: String) async -> [[String: Any]]? {
        guard let token = await auth.token(),
              let url = URL(string: Config.medplumBaseURL.absoluteString + "fhir/R4/" + query)
        else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 8

        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let bundle = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let entries = bundle["entry"] as? [[String: Any]] ?? []
        return entries.compactMap { $0["resource"] as? [String: Any] }
    }

    private nonisolated static func date(_ value: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
