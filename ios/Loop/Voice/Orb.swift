import SwiftUI

/// One circle, four states. The shape itself carries the state so it reads
/// from across a room: a dim thin ring waiting, a ring breathing with your
/// voice, an arc sweeping while it thinks, a solid disc while it talks.
///
/// Not a waveform. Deliberately.
struct Orb: View {
    let state: CallState
    /// 0–1 audio level.
    let level: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spin = 0.0

    private let base: CGFloat = 200

    var body: some View {
        ZStack {
            halo
            core
        }
        .frame(width: base * 1.6, height: base * 1.6)
        .animation(reduceMotion ? nil : .smooth(duration: 0.18), value: level)
        .animation(.smooth(duration: 0.35), value: state)
        .onAppear { startSpin() }
        .onChange(of: reduceMotion) { _, _ in startSpin() }
        .accessibilityElement()
        .accessibilityLabel(state.label)
    }

    // MARK: - Core

    @ViewBuilder
    private var core: some View {
        switch state {
        case .connecting, .ended, .failed, .escalated:
            Circle()
                .stroke(Color.brandAqua.opacity(0.30), lineWidth: 2)
                .frame(width: base, height: base)

        case .listening:
            Circle()
                .stroke(Color.brandAqua, lineWidth: 6)
                .frame(width: base, height: base)
                .scaleEffect(reduceMotion ? 1 : 1 + level * 0.16)

        case .thinking:
            Circle()
                .trim(from: 0, to: reduceMotion ? 0.72 : 0.26)
                .stroke(Color.brandAqua, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .frame(width: base, height: base)
                .rotationEffect(.degrees(reduceMotion ? -90 : spin))

        case .speaking:
            Circle()
                .fill(Color.brandAqua)
                .frame(width: base, height: base)
                .scaleEffect(reduceMotion ? 1 : 1 + level * 0.1)
        }
    }

    /// A soft bloom behind the core. Absent when idle, brightest while speaking.
    @ViewBuilder
    private var halo: some View {
        let strength: Double = switch state {
        case .speaking: 0.5
        case .listening: 0.28
        case .thinking: 0.16
        default: 0
        }

        if strength > 0 {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color.brandAqua.opacity(strength), .clear],
                        center: .center,
                        startRadius: base * 0.35,
                        endRadius: base * 0.82
                    )
                )
                .frame(width: base * 1.6, height: base * 1.6)
                .scaleEffect(reduceMotion ? 1 : 1 + level * 0.12)
                .blur(radius: 12)
        }
    }

    private func startSpin() {
        guard !reduceMotion else { return }
        spin = 0
        withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) {
            spin = 360
        }
    }
}

#Preview {
    VStack(spacing: 0) {
        ForEach([CallState.listening, .thinking, .speaking], id: \.label) { state in
            Orb(state: state, level: 0.6)
        }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.black)
}
