import SwiftUI

/// Shown when the agent surfaces a medication from this person's own history.
///
/// The framing is deliberate throughout: this is a *request to a clinician*,
/// not a recommendation to take something. The person taps to ask; a human
/// decides.
struct MedicationRequestView: View {
    let medication: PriorMedication
    let reason: String?
    let onRequest: () -> Void
    let onDismiss: () -> Void

    @State private var sent = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                if sent { sentState } else { proposal }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
            .navigationTitle(sent ? "" : "From your record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !sent {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Not now", action: onDismiss)
                    }
                }
            }
        }
    }

    // MARK: - Proposal

    private var proposal: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            artwork
                .frame(maxWidth: .infinity)

            Text(medication.display)
                .font(.title.weight(.semibold))
                .padding(.top, 24)

            if let dosage = medication.dosage {
                Text(dosage)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }

            VStack(alignment: .leading, spacing: 6) {
                if let prescriber = medication.prescriber {
                    detail("Prescribed by", prescriber)
                }
                if let date = medication.authoredOn {
                    detail("Last prescribed", date.formatted(.dateTime.month(.wide).day().year()))
                }
                detail("Status", medication.isCurrent ? "Current" : "Not currently active")
            }
            .padding(.top, 20)

            if let reason {
                Text(reason)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.top, 18)
            }

            Spacer()

            Button("Request from doctor") {
                sent = true
                onRequest()
            }
            .buttonStyle(SolidButton())

            Text("This asks Dr. \(surname) to review it. Nothing changes about your medication unless they approve it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, 12)
        }
    }

    /// No photograph. A picture of the wrong tablet is worse than no picture —
    /// people match what's in their hand against it. Until there's an image
    /// attached to the medication in the record, this stays a symbol.
    private var artwork: some View {
        ZStack {
            Circle()
                .fill(Color.primary.opacity(0.06))
                .frame(width: 140, height: 140)
            Image(systemName: "pills.fill")
                .font(.system(size: 56))
                .foregroundStyle(.primary.opacity(0.7))
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
        .font(.subheadline)
    }

    private var surname: String {
        (medication.prescriber ?? "your clinician")
            .replacingOccurrences(of: "Dr. ", with: "")
            .split(separator: " ").last.map(String.init) ?? "your clinician"
    }

    // MARK: - Sent

    private var sentState: some View {
        VStack(alignment: .leading, spacing: 14) {
            Spacer()
            Image(systemName: "paperplane.fill")
                .font(.system(size: 44))
                .foregroundStyle(.primary)
            Text("Sent to Dr. \(surname)")
                .font(.title2.weight(.semibold))
            Text("They'll approve or decline it. You'll see the outcome in your record — nothing changes until they do.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Done", action: onDismiss)
                .buttonStyle(SolidButton())
        }
    }
}

#Preview {
    MedicationRequestView(
        medication: PriorMedication(
            id: "1", display: "Sertraline 50 mg", rxnorm: "312938",
            dosage: "Once daily, in the morning", prescriber: "Dr. Maya Chen",
            prescriberReference: "Practitioner/1",
            authoredOn: .now.addingTimeInterval(-86400 * 21), isCurrent: true
        ),
        reason: "You've mentioned the same symptoms returning over the last few weeks.",
        onRequest: {}, onDismiss: {}
    )
}
