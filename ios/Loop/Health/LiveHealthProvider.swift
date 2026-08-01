import Foundation
import HealthKit

/// Real HealthKit. Reads heart rate recorded during Loop's own readings, plus
/// HRV if an Apple Watch has written any.
///
/// Note on write access: Loop requests share permission for `workoutType` only.
/// Starting a workout session is the sole way to turn on the AirPods Pro 3
/// sensor, and a session must save a workout. No health *measurement* is ever
/// written by this app.
final class LiveHealthProvider: HealthProvider {
    private let store = HKHealthStore()

    private let heartRate = HKQuantityType(.heartRate)
    private let hrvSDNN = HKQuantityType(.heartRateVariabilitySDNN)
    private let bpm = HKUnit.count().unitDivided(by: .minute())

    private var readTypes: Set<HKObjectType> { [heartRate, hrvSDNN, HKObjectType.workoutType()] }
    private var shareTypes: Set<HKSampleType> { [HKObjectType.workoutType()] }

    var access: HealthAccess {
        get async {
            guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
            if store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingDenied {
                return .denied
            }
            let status = try? await store.statusForAuthorizationRequest(toShare: shareTypes, read: readTypes)
            // HealthKit never reveals read denial. `.unnecessary` means we have
            // already asked; whether data arrives is answered by the empty state.
            return status == .unnecessary ? .granted : .notDetermined
        }
    }

    func requestAccess() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        try await store.requestAuthorization(toShare: shareTypes, read: readTypes)
    }

    func weeklyReadingAverages(weeks: Int) async throws -> [WeeklyPoint] {
        let readings = try await loopReadings(weeks: weeks)
        guard !readings.isEmpty else { return [] }
        // HealthKit only predicates one workout at a time, so OR them.
        let fromReadings = NSCompoundPredicate(orPredicateWithSubpredicates:
            readings.map { HKQuery.predicateForObjects(from: $0) })
        return try await weeklyAverages(of: heartRate, in: bpm, matching: fromReadings, weeks: weeks)
    }

    func weeklyHRV(weeks: Int) async throws -> [WeeklyPoint] {
        try await weeklyAverages(of: hrvSDNN, in: .secondUnit(with: .milli), matching: nil, weeks: weeks)
    }

    // MARK: - Queries

    /// Loop's own readings — this app, mind-and-body, inside the window. Heart
    /// rate is filtered to these so a run recorded by a Watch never lands in a
    /// trend that is supposed to measure the user sitting still.
    private func loopReadings(weeks: Int) async throws -> [HKWorkout] {
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForObjects(from: .default()),
            HKQuery.predicateForWorkouts(with: .mindAndBody),
            HKQuery.predicateForSamples(withStart: Self.windowStart(weeks: weeks), end: nil),
        ])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.workout(predicate)],
            sortDescriptors: []
        )
        return try await descriptor.result(for: store)
    }

    /// HealthKit does the bucketing and the averaging. We never pull raw
    /// samples and average them ourselves.
    private func weeklyAverages(
        of type: HKQuantityType,
        in unit: HKUnit,
        matching predicate: NSPredicate?,
        weeks: Int
    ) async throws -> [WeeklyPoint] {
        let start = Self.windowStart(weeks: weeks)
        let descriptor = HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: predicate),
            options: .discreteAverage,
            anchorDate: start,
            intervalComponents: DateComponents(weekOfYear: 1)
        )
        let collection = try await descriptor.result(for: store)

        var points: [WeeklyPoint] = []
        collection.enumerateStatistics(from: start, to: .now) { statistics, _ in
            guard let average = statistics.averageQuantity() else { return }
            points.append(WeeklyPoint(
                weekStart: statistics.startDate,
                value: average.doubleValue(for: unit)
            ))
        }
        return points
    }

    private static func windowStart(weeks: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = Calendar.current.firstWeekday
        let thisWeek = calendar.dateInterval(of: .weekOfYear, for: .now)!.start
        return calendar.date(byAdding: .weekOfYear, value: -(weeks - 1), to: thisWeek)!
    }
}
