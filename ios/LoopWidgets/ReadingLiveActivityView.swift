import ActivityKit
import SwiftUI
import WidgetKit

@main
struct LoopWidgetsBundle: WidgetBundle {
    var body: some Widget {
        ReadingLiveActivity()
    }
}

/// Lock Screen and Dynamic Island presentation for a reading in progress.
/// Time and state only — never a heart rate.
struct ReadingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ReadingActivityAttributes.self) { context in
            lockScreen(context.state)
                .activityBackgroundTint(.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("HELT", systemImage: "waveform.path.ecg")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    countdown(context.state)
                        .font(.title3.weight(.medium))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        progress(context.state)
                        Text(caption(context.state))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                Image(systemName: "waveform.path.ecg")
            } compactTrailing: {
                countdown(context.state)
                    .monospacedDigit()
                    .frame(width: 44)
            } minimal: {
                Image(systemName: "waveform.path.ecg")
            }
        }
    }

    // MARK: - Pieces

    private func lockScreen(_ state: ReadingActivityAttributes.ContentState) -> some View {
        HStack(spacing: 16) {
            Image(systemName: "waveform.path.ecg")
                .font(.title2)
                .foregroundStyle(.white)

            VStack(alignment: .leading, spacing: 6) {
                Text(state.phase.label)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(caption(state))
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.65))
                progress(state)
            }

            Spacer()

            countdown(state)
                .font(.title.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(.white)
        }
        .padding(16)
    }

    /// `Text(timerInterval:)` and `ProgressView(timerInterval:)` tick on their
    /// own, so the app never has to push an update per second to keep the
    /// Lock Screen honest.
    @ViewBuilder
    private func countdown(_ state: ReadingActivityAttributes.ContentState) -> some View {
        if state.phase.isCounting {
            Text(timerInterval: state.startedAt...state.endsAt, countsDown: true)
                .multilineTextAlignment(.trailing)
        } else if state.phase == .done {
            Image(systemName: "checkmark")
        } else {
            Text("—")
        }
    }

    @ViewBuilder
    private func progress(_ state: ReadingActivityAttributes.ContentState) -> some View {
        if state.phase.isCounting {
            ProgressView(timerInterval: state.startedAt...state.endsAt, countsDown: false) {
                EmptyView()
            } currentValueLabel: {
                EmptyView()
            }
            .progressViewStyle(.linear)
            .tint(.white)
        }
    }

    private func caption(_ state: ReadingActivityAttributes.ContentState) -> String {
        switch state.phase {
        case .preparing: "Put your AirPods in"
        case .reading: "Sit still — you can put the phone down"
        case .saving: "Saving your reading"
        case .done: "Reading complete"
        }
    }
}
