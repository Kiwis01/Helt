import SwiftUI

/// The weekly reading, then two questions. No heart rate is shown at any point
/// — only elapsed time and a completion state.
struct ReadingView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let controller: any ReadingSessionController
    let onComplete: (ReadingSummary) -> Void

    @State private var startedAt = Date()
    @State private var askingQuestions = false
    @State private var difficulty = 5.0
    @State private var medicationChanged = false

    var body: some View {
        VStack(spacing: 32) {
            if askingQuestions {
                questions
            } else {
                reading
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        .task {
            startedAt = .now
            await controller.start()
            if controller.state == .done { askingQuestions = true }
        }
        .interactiveDismissDisabled(!askingQuestions)
    }

    // MARK: - Reading

    private var reading: some View {
        VStack(spacing: 0) {
            Spacer()

            ZStack {
                Circle()
                    .stroke(.quaternary, lineWidth: 3)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(reduceMotion ? nil : .linear(duration: 1), value: progress)

                Text(centreText)
                    .font(.system(size: 44, weight: .light, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(reduceMotion ? .identity : .numericText())
            }
            .frame(width: 220, height: 220)

            Text(caption)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 28)

            Spacer()

            Button("Stop") {
                Task { await controller.cancel(); dismiss() }
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .controlSize(.large)
        }
    }

    private var progress: CGFloat {
        guard case .reading(let elapsed) = controller.state else {
            return controller.state == .done || controller.state == .saving ? 1 : 0
        }
        return min(1, elapsed / Config.readingSeconds)
    }

    private var centreText: String {
        switch controller.state {
        case .preparing(let seconds): "\(seconds)"
        case .reading(let elapsed): Self.clock(Config.readingSeconds - elapsed)
        case .saving, .done: "Done"
        case .idle, .failed: "—"
        }
    }

    private var caption: String {
        switch controller.state {
        case .idle: "Getting ready."
        case .preparing: "Put your AirPods in and sit still."
        case .reading: "Sit still. You can put the phone down."
        case .saving: "Saving your reading."
        case .done: "Reading complete."
        case .failed(let reason): reason
        }
    }

    private static func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    // MARK: - Questions

    private var questions: some View {
        VStack(alignment: .leading, spacing: 28) {
            Text("Two questions")
                .font(.largeTitle.weight(.semibold))

            VStack(alignment: .leading, spacing: 12) {
                Text("How hard was this week?")
                    .font(.headline)
                Slider(value: $difficulty, in: 0...10, step: 1)
                    .tint(.primary)
                HStack {
                    Text("Easy")
                    Spacer()
                    Text("\(Int(difficulty))").monospacedDigit().foregroundStyle(.primary)
                    Spacer()
                    Text("Hard")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Toggle("My medication changed this week", isOn: $medicationChanged)
                .font(.headline)
                .tint(.primary)

            Spacer()

            Button("Save") {
                onComplete(ReadingSummary(
                    startedAt: startedAt,
                    durationSeconds: Date().timeIntervalSince(startedAt),
                    answers: CheckInAnswers(
                        difficulty: Int(difficulty),
                        medicationChanged: medicationChanged
                    )
                ))
                dismiss()
            }
            .buttonStyle(SolidButton())
        }
    }
}

#Preview {
    ReadingView(controller: MockReadingSession()) { _ in }
}
