import SwiftUI

/// The conversation. One central form, a transcript you're free to ignore,
/// two controls, and a disclosure that never leaves the screen.
struct VoiceView: View {
    @State var model: CallModel
    @Environment(MedplumAuth.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                Orb(state: model.state, level: model.level)

                if reduceMotion {
                    Text(model.state.label)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.white.opacity(0.75))
                        .padding(.top, 4)
                }

                transcript
                    .padding(.top, reduceMotion ? 20 : 8)

                Spacer()

                controls
                disclosure
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 16)
        }
        .overlay {
            if let flag = model.escalation {
                EmergencyView(flag: flag) { dismiss() }
                    .transition(.opacity)
            }
        }
        // The call stays open underneath: the model asked for this and is
        // waiting on the score so it can respond to it.
        // Presented by identity, not a constant binding: SwiftUI has to be able
        // to take it down when the model's request is answered.
        .sheet(item: Binding(
            get: { model.pendingQuestionnaire },
            set: { if $0 == nil { Task { await model.declineQuestionnaire() } } }
        )) { pending in
            QuestionnaireView(
                instrument: pending.instrument,
                onFinish: { score, answers, flag in
                    Task {
                        await model.finishQuestionnaire(
                            score: score, answers: answers, flag: flag,
                            recorder: InstrumentRecorder(medplum: MedplumClient(auth: auth))
                        )
                    }
                },
                onCancel: { Task { await model.declineQuestionnaire() } }
            )
            .interactiveDismissDisabled()
        }
        .sheet(item: Binding(
            get: { model.pendingMedication },
            set: { if $0 == nil { Task { await model.declineMedicationRequest() } } }
        )) { pending in
            MedicationRequestView(
                medication: pending.medication,
                reason: pending.call.reason,
                onRequest: {
                    Task {
                        await model.sendMedicationRequest(
                            recorder: MedicationRequestRecorder(medplum: MedplumClient(auth: auth))
                        )
                    }
                },
                onDismiss: { Task { await model.declineMedicationRequest() } }
            )
        }
        .animation(.smooth(duration: 0.2), value: model.escalation)
        .preferredColorScheme(.dark)
        .statusBarHidden()
        .task { model.start() }
        .onChange(of: model.state) { _, new in
            if new == .ended { Task { await close() } }
        }
    }

    // MARK: - Transcript

    /// Small, low contrast, below the orb. The last few turns only — this is
    /// not a chat log, it's a reassurance that you were heard.
    private var transcript: some View {
        VStack(spacing: 10) {
            let recent = model.transcript.suffix(3)
            ForEach(Array(recent.enumerated()), id: \.element.id) { index, turn in
                Text(turn.text)
                    .font(.subheadline)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(opacity(index: index, of: recent.count, speaker: turn.speaker)))
                    .transition(.opacity)
            }
        }
        // Anchored to the bottom so the newest turn is never the one clipped.
        .frame(height: 150, alignment: .bottom)
        .animation(.smooth(duration: 0.25), value: model.transcript.count)
    }

    /// Older turns fade; your own words sit quieter than the agent's. Kept dim
    /// on purpose — this is meant to be ignorable.
    private func opacity(index: Int, of count: Int, speaker: Turn.Speaker) -> Double {
        let age = Double(count - 1 - index)
        let fade = max(0.3, 1 - age * 0.38)
        return fade * (speaker == .agent ? 0.62 : 0.42)
    }

    // MARK: - Controls

    private var controls: some View {
        HStack(spacing: 28) {
            CircleControl(
                systemImage: model.isMuted ? "mic.slash.fill" : "mic.fill",
                label: model.isMuted ? "Unmute" : "Mute",
                emphasised: model.isMuted
            ) {
                model.isMuted.toggle()
            }

            CircleControl(systemImage: "xmark", label: "End", destructive: true) {
                Task { await close() }
            }
        }
    }

    private var disclosure: some View {
        Text("Not emergency care. In an emergency call 911, or 988 for thoughts of self-harm.")
            .font(.caption2)
            .foregroundStyle(.white.opacity(0.4))
            .multilineTextAlignment(.center)
            .padding(.top, 22)
    }

    private func close() async {
        await model.end()
        dismiss()
    }
}

/// The only two controls on the screen.
private struct CircleControl: View {
    let systemImage: String
    let label: String
    var emphasised = false
    var destructive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(emphasised ? .black : .white)
                .frame(width: 62, height: 62)
                .background {
                    if emphasised {
                        Circle().fill(.white)
                    } else if destructive {
                        Circle().fill(.red.opacity(0.85))
                    } else {
                        Circle().glassEffect(.regular, in: .circle)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

#Preview {
    VoiceView(model: CallModel(service: MockConversationService()))
}
