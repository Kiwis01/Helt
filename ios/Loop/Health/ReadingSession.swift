import Foundation
import HealthKit
import Observation

enum ReadingState: Equatable {
    case idle
    case preparing(secondsRemaining: Int)
    case reading(elapsed: TimeInterval)
    case saving
    case done
    case failed(String)
}

/// A weekly reading. Deliberately has no way to read out a heart rate — the
/// number goes into the weekly aggregate and is seen later, in the trend.
/// Body-checking maintains panic disorder, so this is enforced by the type,
/// not by remembering not to show it.
@MainActor
protocol ReadingSessionController: AnyObject {
    var state: ReadingState { get }
    func start() async
    func cancel() async
}

// MARK: - Live

/// Runs an `HKWorkoutSession` on iPhone (iOS 26+). That session is what causes
/// AirPods Pro 3 to start measuring; there is no other way to turn the sensor on.
@MainActor
@Observable
final class LiveReadingSession: NSObject, ReadingSessionController {
    private(set) var state: ReadingState = .idle

    private let store = HKHealthStore()
    private let liveActivity = ReadingLiveActivity()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var ticker: Task<Void, Never>?

    func start() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            state = .failed("This device can't record a reading.")
            return
        }
        // Started from the foreground, before the session, so the reading is on
        // the Lock Screen the moment the person puts the phone down.
        liveActivity.start(endsAt: .now
            + Double(Config.readingCountdownSeconds) + Config.readingSeconds)
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .mindAndBody
        configuration.locationType = .indoor

        do {
            let session = try HKWorkoutSession(healthStore: store, configuration: configuration)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: configuration)
            self.session = session
            self.builder = builder

            // Give the sensor time to come up before anything is collected.
            session.prepare()
            for remaining in stride(from: Config.readingCountdownSeconds, through: 1, by: -1) {
                state = .preparing(secondsRemaining: remaining)
                try await Task.sleep(for: .seconds(1))
            }

            let began = Date()
            session.startActivity(with: began)
            try await builder.beginCollection(at: began)
            await liveActivity.began(at: began, endsAt: began + Config.readingSeconds)
            await runTimer(from: began)
            try await finish(startedAt: began)
        } catch {
            state = .failed(error.localizedDescription)
            await liveActivity.abandon()
            await teardown()
        }
    }

    func cancel() async {
        ticker?.cancel()
        await liveActivity.abandon()
        await teardown()
        state = .idle
    }

    private func runTimer(from began: Date) async {
        let task = Task { @MainActor in
            while !Task.isCancelled {
                let elapsed = Date().timeIntervalSince(began)
                guard elapsed < Config.readingSeconds else { break }
                state = .reading(elapsed: elapsed)
                try? await Task.sleep(for: .seconds(1))
            }
        }
        ticker = task
        await task.value
    }

    private func finish(startedAt began: Date) async throws {
        guard let session, let builder else { return }
        state = .saving
        await liveActivity.saving()
        let ended = Date()
        session.stopActivity(with: ended)
        try await builder.endCollection(at: ended)
        _ = try await builder.finishWorkout()
        session.end()
        self.session = nil
        self.builder = nil
        await liveActivity.finish()
        state = .done
    }

    private func teardown() async {
        session?.end()
        session = nil
        builder = nil
    }
}

// MARK: - Mock

/// Same states, same timings, no HealthKit. This is what runs in the Simulator.
@MainActor
@Observable
final class MockReadingSession: ReadingSessionController {
    private(set) var state: ReadingState = .idle
    private var task: Task<Void, Never>?

    func start() async {
        let work = Task { @MainActor in
            for remaining in stride(from: Config.readingCountdownSeconds, through: 1, by: -1) {
                state = .preparing(secondsRemaining: remaining)
                try? await Task.sleep(for: .seconds(1))
            }
            let began = Date()
            while !Task.isCancelled {
                let elapsed = Date().timeIntervalSince(began)
                guard elapsed < Config.readingSeconds else { break }
                state = .reading(elapsed: elapsed)
                try? await Task.sleep(for: .seconds(1))
            }
            guard !Task.isCancelled else { return }
            state = .saving
            try? await Task.sleep(for: .milliseconds(600))
            state = .done
        }
        task = work
        await work.value
    }

    func cancel() async {
        task?.cancel()
        task = nil
        state = .idle
    }
}
