import Testing
@testable import Loop

@MainActor
struct MockDataTests {
    @Test func trendCoversTheConfiguredWindow() async throws {
        let points = try await MockHealthProvider().weeklyReadingAverages(weeks: Config.trendWeeks)
        #expect(points.count == Config.trendWeeks)
        #expect(points == points.sorted { $0.weekStart < $1.weekStart })
    }

    /// The chart's whole job is showing numbers moving around a medication
    /// change. If the mock stops telling that story, the demo is empty.
    @Test func medicationEventsFallInsideTheTrend() async throws {
        let points = try await MockHealthProvider().weeklyReadingAverages(weeks: Config.trendWeeks)
        let events = try await MockClinicalDataService().medicationEvents()
        let first = try #require(points.first).weekStart
        let last = try #require(points.last).weekStart

        #expect(!events.isEmpty)
        for event in events {
            #expect(event.date >= first && event.date <= last)
        }
    }

    @Test func hrvIsSparseButNotEmpty() async throws {
        let hrv = try await MockHealthProvider().weeklyHRV(weeks: Config.trendWeeks)
        #expect(!hrv.isEmpty)
        #expect(hrv.count < Config.trendWeeks)
    }
}
