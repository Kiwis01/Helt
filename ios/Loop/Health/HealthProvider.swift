import Foundation

enum HealthAccess: Equatable, Sendable {
    case notDetermined
    case granted
    case denied
    /// HealthKit is absent (Simulator, iPad without Health).
    case unavailable
}

/// Everything the Health view needs. A protocol because HealthKit workout
/// sessions do not exist in the Simulator — the mock is how this demos.
protocol HealthProvider {
    var access: HealthAccess { get async }

    /// Only called after the user has read what we're asking for and why.
    func requestAccess() async throws

    /// Average heart rate during each weekly reading, aggregated by HealthKit.
    func weeklyReadingAverages(weeks: Int) async throws -> [WeeklyPoint]

    /// Weekly HRV (SDNN). Apple Watch writes this; AirPods cannot produce it,
    /// so an empty array is a normal, expected answer.
    func weeklyHRV(weeks: Int) async throws -> [WeeklyPoint]

    /// The average heart rate during the most recent reading, and when it was
    /// taken. This is what gets pushed to Medplum — never shown during a
    /// reading, only recorded and seen later in the trend.
    func latestReading() async throws -> (date: Date, average: Double)?
}

struct MockHealthProvider: HealthProvider {
    var access: HealthAccess { .granted }
    func requestAccess() async throws {}
    func weeklyReadingAverages(weeks: Int) async throws -> [WeeklyPoint] {
        Array(MockData.readingAverages.suffix(weeks))
    }
    func weeklyHRV(weeks: Int) async throws -> [WeeklyPoint] {
        Array(MockData.hrv.suffix(weeks))
    }
    func latestReading() async throws -> (date: Date, average: Double)? {
        MockData.readingAverages.last.map { (date: $0.weekStart, average: $0.value) }
    }
}

/// For exercising the empty state.
struct EmptyHealthProvider: HealthProvider {
    var access: HealthAccess { .granted }
    func requestAccess() async throws {}
    func weeklyReadingAverages(weeks: Int) async throws -> [WeeklyPoint] { [] }
    func weeklyHRV(weeks: Int) async throws -> [WeeklyPoint] { [] }
    func latestReading() async throws -> (date: Date, average: Double)? { nil }
}
