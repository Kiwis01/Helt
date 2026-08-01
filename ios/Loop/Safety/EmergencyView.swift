import SwiftUI

/// Shown the moment a red flag fires. The conversation is already over by the
/// time this appears — the agent was stopped before it could reply.
struct EmergencyView: View {
    let flag: RedFlag
    let onDismiss: () -> Void

    @Environment(\.openURL) private var openURL

    private var primaryIs911: Bool { flag.action == .call911 }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                Spacer()

                Text(primaryIs911 ? "Call 911" : "Talk to someone now")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(.white)

                Text(flag.reason)
                    .font(.title3)
                    .foregroundStyle(.white.opacity(0.75))
                    .padding(.top, 12)

                Text("HELT has stopped. It can't help with this.")
                    .font(.body)
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.top, 20)

                Spacer()

                if primaryIs911 {
                    call("Call 911", number: "911", emphasis: .high)
                    call("Or call 988 for mental health support", number: "988", emphasis: .low)
                } else {
                    call("Call 988", number: "988", emphasis: .high)
                    call("Or call 911 if you're in immediate danger", number: "911", emphasis: .low)
                }

                Button("Close", action: onDismiss)
                    .font(.body)
                    .foregroundStyle(.white.opacity(0.5))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 22)

                Text(flag.id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.28))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 16)
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 20)
        }
        .preferredColorScheme(.dark)
    }

    private enum Emphasis { case high, low }

    @ViewBuilder
    private func call(_ title: String, number: String, emphasis: Emphasis) -> some View {
        Button {
            if let url = URL(string: "tel://\(number)") { openURL(url) }
        } label: {
            Text(title)
                .font(emphasis == .high ? .title3.weight(.semibold) : .callout)
                .foregroundStyle(emphasis == .high ? .white : .white.opacity(0.7))
                .frame(maxWidth: .infinity)
                .padding(.vertical, emphasis == .high ? 20 : 14)
                .background {
                    if emphasis == .high {
                        RoundedRectangle(cornerRadius: 14).fill(.red)
                    } else {
                        RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.25))
                    }
                }
        }
        .buttonStyle(.plain)
        .padding(.top, emphasis == .high ? 0 : 12)
    }
}

#Preview("911") {
    EmergencyView(
        flag: RedFlag(id: "RF-01-CHEST-PAIN-RADIATING", action: .call911,
                      reason: "You mentioned chest pain spreading to your arm or jaw."),
        onDismiss: {}
    )
}

#Preview("988") {
    EmergencyView(
        flag: RedFlag(id: "RF-07-SELF-HARM", action: .call988,
                      reason: "You mentioned wanting to hurt yourself."),
        onDismiss: {}
    )
}
