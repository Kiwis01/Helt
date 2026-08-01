// ActivityKit's `Activity` is a non-Sendable class, so handing one to its own
// concurrent `update`/`end` methods trips Swift 6 strict concurrency. Nothing
// to fix on our side — the type is Apple's and unaudited.
@preconcurrency import ActivityKit
import Foundation

/// Drives the Lock Screen / Dynamic Island presentation of a reading.
///
/// Best-effort throughout: if Live Activities are disabled, or the request
/// fails, the reading carries on regardless. Nothing here is allowed to be a
/// reason a reading doesn't happen.
@MainActor
final class ReadingLiveActivity {
    private var activity: Activity<ReadingActivityAttributes>?

    private var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func start(endsAt: Date) {
        guard enabled, activity == nil else { return }
        let state = ReadingActivityAttributes.ContentState(
            phase: .preparing,
            startedAt: .now,
            endsAt: endsAt
        )
        activity = try? Activity.request(
            attributes: ReadingActivityAttributes(),
            content: .init(state: state, staleDate: endsAt.addingTimeInterval(120)),
            pushType: nil
        )
    }

    /// The reading proper. `startedAt`/`endsAt` drive a self-updating timer, so
    /// this is the last update needed until the phase changes again — no
    /// per-second pushes to keep a locked screen accurate.
    func began(at start: Date, endsAt: Date) async {
        await update(.init(phase: .reading, startedAt: start, endsAt: endsAt),
                     staleDate: endsAt.addingTimeInterval(120))
    }

    func saving() async {
        guard let state = activity?.content.state else { return }
        await update(.init(phase: .saving, startedAt: state.startedAt, endsAt: state.endsAt))
    }

    func finish() async {
        guard let activity else { return }
        let state = activity.content.state
        await activity.end(
            .init(state: .init(phase: .done, startedAt: state.startedAt, endsAt: state.endsAt),
                  staleDate: nil),
            dismissalPolicy: .after(.now + 8)
        )
        self.activity = nil
    }

    /// Cancelled or failed — take it off the Lock Screen at once rather than
    /// leaving a stale reading sitting there.
    func abandon() async {
        guard let activity else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
        self.activity = nil
    }

    private func update(
        _ state: ReadingActivityAttributes.ContentState,
        staleDate: Date? = nil
    ) async {
        guard let activity else { return }
        await activity.update(.init(state: state, staleDate: staleDate))
    }
}
