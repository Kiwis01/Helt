import SwiftUI

/// The app's only filled control, and the one place brand teal carries a tap
/// target. Everything else on the page stays monochrome so this reads first.
struct SolidButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Content(configuration: configuration)
    }

    /// A nested view so the style can see `isEnabled`; `makeBody` can't.
    private struct Content: View {
        @Environment(\.isEnabled) private var isEnabled
        let configuration: Configuration

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .foregroundStyle(isEnabled ? Color.white : Color.secondary)
                .background(
                    Color.accentColor.opacity(opacity),
                    in: .rect(cornerRadius: 14)
                )
        }

        private var opacity: Double {
            if !isEnabled { return 0.18 }
            return configuration.isPressed ? 0.7 : 1
        }
    }
}
