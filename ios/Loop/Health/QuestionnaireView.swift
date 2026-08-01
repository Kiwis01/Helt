import SwiftUI

/// Renders any `Instrument`, one item at a time. Nothing here knows what GAD-7
/// is — adding a questionnaire never means touching this file.
struct QuestionnaireView: View {
    let instrument: Instrument
    /// Score, answers, and a safety event if one was triggered.
    let onFinish: (Int, [Answer], RedFlag?) -> Void
    let onCancel: () -> Void

    @State private var answers: [Int: Int] = [:]
    @State private var index = 0
    @State private var finished: (score: Int, flag: RedFlag?)?

    private var item: Instrument.Item { instrument.items[index] }

    var body: some View {
        NavigationStack {
            Group {
                if let finished {
                    result(finished.score, flag: finished.flag)
                } else {
                    question
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
            .navigationTitle(finished == nil ? "\(index + 1) of \(instrument.items.count)" : instrument.key)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if finished == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Not now", action: onCancel)
                    }
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private var question: some View {
        VStack(alignment: .leading, spacing: 0) {
            ProgressView(value: Double(index + 1), total: Double(instrument.items.count))
                .tint(.primary)
                .padding(.top, 8)

            Text(instrument.recall)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 26)

            Text(item.text)
                .font(.title2.weight(.semibold))
                .padding(.top, 8)

            VStack(spacing: 10) {
                ForEach(instrument.options, id: \.value) { option in
                    Button {
                        answers[item.id] = option.value
                        advance()
                    } label: {
                        HStack {
                            Text(option.text)
                            Spacer()
                            if answers[item.id] == option.value { Image(systemName: "checkmark") }
                        }
                        .padding(.vertical, 16)
                        .padding(.horizontal, 18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            answers[item.id] == option.value
                                ? Color.primary.opacity(0.12) : Color.primary.opacity(0.05),
                            in: .rect(cornerRadius: 12)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 26)

            Spacer()

            if index > 0 {
                Button("Back") { withAnimation { index -= 1 } }
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func advance() {
        guard index == instrument.items.count - 1 else {
            withAnimation { index += 1 }
            return
        }
        let collected = answers.map { Answer(itemID: $0.key, value: $0.value) }
        guard let score = instrument.score(collected) else { return }
        // Safety first: a flagged item outranks the total.
        let flag = instrument.safetyEvent(in: collected)
        finished = (score, flag)
        onFinish(score, collected, flag)
    }

    private func result(_ score: Int, flag: RedFlag?) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Text("\(score)")
                .font(.system(size: 72, weight: .medium, design: .rounded))
                .monospacedDigit()
            Text(instrument.summary(for: score))
                .font(.title3)
            Text("This is a screening score, not a diagnosis. It's saved to your record so you and your clinician can see how it moves.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Done", action: onCancel)
                .buttonStyle(SolidButton())
        }
    }
}

#Preview {
    QuestionnaireView(instrument: Instruments.gad7, onFinish: { _, _, _ in }, onCancel: {})
}
