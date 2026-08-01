import SwiftUI

/// The screen before a conversation. Deliberately calm and nearly empty — the
/// person opening this may be having a bad time, and the only decision on the
/// page is whether to start.
///
/// The full-screen conversation view attaches to the button here next.
struct TalkView: View {
    @State private var inCall = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Spacer()

                VStack(spacing: 14) {
                    Text("Talk it through")
                        .font(.largeTitle.weight(.semibold))
                    Text("A conversation with what your care plan says and what your numbers are doing.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 32)

                Spacer()

                Button("Start a conversation") { inCall = true }
                    .buttonStyle(SolidButton())

                EmergencyDisclosure()
                    .padding(.top, 28)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
        .fullScreenCover(isPresented: $inCall) {
            VoiceView(model: CallFactory.make())
        }
    }
}

/// Shown wherever a conversation can start, and again during one.
struct EmergencyDisclosure: View {
    var body: some View {
        Text("Loop is not emergency care. If you're in danger, call 911. For thoughts of harming yourself, call or text 988.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 8)
    }
}

#Preview { TalkView() }
