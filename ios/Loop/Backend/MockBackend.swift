import Foundation

/// Plausible, well-shaped data so the UI can be built and demoed with no backend.
/// The shape is the contract; the numbers are invented.
enum MockData {
    static let calendar = Calendar(identifier: .gregorian)

    static func weekStart(_ weeksAgo: Int) -> Date {
        let thisWeek = calendar.dateInterval(of: .weekOfYear, for: .now)!.start
        return calendar.date(byAdding: .weekOfYear, value: -weeksAgo, to: thisWeek)!
    }

    static let medicationStart = weekStart(7)
    static let doseChange = weekStart(3)

    /// Heart rate during the weekly reading. Drifts down after the medication
    /// starts, then again after the dose change — the story the chart tells.
    static var readingAverages: [WeeklyPoint] {
        let values: [Double] = [74, 73, 75, 72, 74, 71, 69, 68, 66, 67, 64, 63]
        return values.enumerated().map { index, value in
            WeeklyPoint(weekStart: weekStart(Config.trendWeeks - 1 - index), value: value)
        }
    }

    /// Sparse on purpose: HRV only exists on weeks the user wore a Watch.
    static var hrv: [WeeklyPoint] {
        let values: [Double?] = [41, 39, nil, 42, 40, nil, 45, 47, nil, 49, 52, 51]
        return values.enumerated().compactMap { index, value in
            guard let value else { return nil }
            return WeeklyPoint(weekStart: weekStart(Config.trendWeeks - 1 - index), value: value)
        }
    }

    static let events: [MedicationEvent] = [
        MedicationEvent(id: "me-1", date: medicationStart, kind: .started,
                        medication: "Sertraline", dose: "25 mg"),
        MedicationEvent(id: "me-2", date: doseChange, kind: .doseChanged,
                        medication: "Sertraline", dose: "50 mg"),
    ]

    static let medications: [Medication] = [
        Medication(id: "med-1", name: "Sertraline", dose: "50 mg daily", startedOn: medicationStart)
    ]
}

struct MockClinicalDataService: ClinicalDataService {
    func medications() async throws -> [Medication] { MockData.medications }
    func medicationEvents() async throws -> [MedicationEvent] { MockData.events }
}

