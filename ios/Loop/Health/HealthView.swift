import SwiftUI

@MainActor
@Observable
final class HealthModel {
    private let health: any HealthProvider
    private let clinical: any ClinicalDataService
    private let sync: any HealthSyncService

    private(set) var access: HealthAccess = .notDetermined
    private(set) var weekly: [WeeklyPoint] = []
    private(set) var hrv: [WeeklyPoint] = []
    private(set) var events: [MedicationEvent] = []
    private(set) var medications: [Medication] = []
    private(set) var loaded = false
    private(set) var error: String?
    private(set) var nextReminder: Date?

    init(
        health: any HealthProvider,
        clinical: any ClinicalDataService = MockClinicalDataService(),
        sync: any HealthSyncService = MockHealthSyncService()
    ) {
        self.health = health
        self.clinical = clinical
        self.sync = sync
    }

    func load() async {
        access = await health.access
        nextReminder = Reminders.next
        guard access == .granted else { loaded = true; return }
        do {
            weekly = try await health.weeklyReadingAverages(weeks: Config.trendWeeks)
            hrv = try await health.weeklyHRV(weeks: Config.trendWeeks)
            events = try await clinical.medicationEvents()
            medications = try await clinical.medications()
            error = nil
        } catch {
            self.error = "Couldn't load your data. Pull down to try again."
        }
        loaded = true
    }

    func grantAccess() async {
        do {
            try await health.requestAccess()
            await load()
        } catch {
            self.error = "Health access couldn't be set up. Open Settings › Health › Data Access to change it."
        }
    }

    func record(_ reading: ReadingSummary) async {
        try? await sync.post(reading: reading, weekly: weekly)
        await load()
    }

}

// MARK: - View

struct HealthView: View {
    @State var model: HealthModel
    let readingSession: () -> any ReadingSessionController

    @State private var session: (any ReadingSessionController)?

    var body: some View {
        NavigationStack {
            Group {
                if !model.loaded {
                    ProgressView().controlSize(.large)
                } else {
                    switch model.access {
                    case .notDetermined: AccessExplainer { await model.grantAccess() }
                    case .denied: AccessDenied()
                    case .unavailable: UnavailableState()
                    case .granted: content
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Your numbers")
        }
        .task { await model.load() }
        .sheet(item: Binding(
            get: { session.map(SessionBox.init) },
            set: { if $0 == nil { session = nil } }
        )) { box in
            ReadingView(controller: box.controller) { summary in
                Task { await model.record(summary) }
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if model.weekly.isEmpty {
                    EmptyTrend()
                } else {
                    trend
                }

                readingCard
                hrvSection
                medicationsSection
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .refreshable { await model.load() }
    }

    // MARK: Trend

    private var trend: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeading(
                "Heart rate during your readings",
                detail: "Average beats per minute during each week's reading. Tap a point to read it."
            )
            WeeklyTrendChart(points: model.weekly, events: model.events, unit: "bpm")
                .frame(height: 290)
                .padding(.top, 8)

            if !model.events.isEmpty {
                MedicationLegend(events: model.events)
                    .padding(.top, 4)
                Text("Vertical lines mark a change to your medication. This shows what your numbers did around that change; it doesn't say why.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Reading

    private var readingCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeading(
                "Take a reading",
                detail: "About \(Config.readingDurationText) with your AirPods in, then two questions."
            )

            Button("Start a reading") { session = readingSession() }
                .buttonStyle(SolidButton())

            if let next = model.nextReminder {
                Text("Next reminder \(next.formatted(.dateTime.hour().minute())).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: HRV

    private var hrvSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeading("Heart rate variability", detail: "Recorded by Apple Watch. AirPods can't measure it.")

            if model.hrv.isEmpty {
                Text("No readings yet. This fills in on weeks you wear an Apple Watch.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 90, alignment: .leading)
            } else {
                WeeklyTrendChart(points: model.hrv, events: model.events, unit: "ms", showsEvents: false)
                    .frame(height: 140)
            }
        }
    }

    // MARK: Medications

    @ViewBuilder
    private var medicationsSection: some View {
        if !model.medications.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                SectionHeading("Medication", detail: "From your care plan.")
                ForEach(model.medications) { medication in
                    HStack {
                        Text(medication.name)
                        Spacer()
                        Text(medication.dose)
                            .foregroundStyle(.secondary)
                    }
                    .font(.subheadline)
                }
            }
        }
    }
}

/// `sheet(item:)` needs Identifiable; the controller is a plain protocol.
private struct SessionBox: Identifiable {
    let controller: any ReadingSessionController
    let id = UUID()
    init(_ controller: any ReadingSessionController) { self.controller = controller }
}

// MARK: - Pieces

struct SectionHeading: View {
    let title: String
    let detail: String?

    init(_ title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title3.weight(.semibold))
            if let detail {
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

/// The first screen most people see. An invitation, not an apology.
struct EmptyTrend: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeading("Heart rate during your readings")
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(.quaternary, style: StrokeStyle(lineWidth: 1, dash: [6, 5]))
                .frame(height: 180)
                .overlay {
                    Text("Your first reading starts this line.\nIt takes about eight weeks\nbefore a trend means anything.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
        }
    }
}

/// Explained before the system prompt, never cold on launch.
struct AccessExplainer: View {
    let grant: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer()
            Text("Loop needs two things from Health")
                .font(.title.weight(.semibold))

            VStack(alignment: .leading, spacing: 18) {
                Bullet("Read your heart rate", "Only what your AirPods record during a Loop reading.")
                Bullet("Read heart rate variability", "If your Apple Watch writes it. Optional.")
                Bullet("Save each reading as a session", "The only way to turn the AirPods sensor on. Loop never writes a measurement of its own.")
            }

            Text("Nothing else is read. You can change this any time in Settings › Health › Data Access.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Spacer()

            Button("Continue") { Task { await grant() } }
                .buttonStyle(SolidButton())
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private func Bullet(_ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(.primary).frame(width: 5, height: 5).padding(.top, 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

struct AccessDenied: View {
    var body: some View {
        MessageState(
            title: "Health access is off",
            detail: "Loop can't read your readings without it. Turn it on in Settings › Health › Data Access › Loop."
        )
    }
}

struct UnavailableState: View {
    var body: some View {
        MessageState(
            title: "Health isn't available here",
            detail: "This device doesn't store health data, so readings can't be recorded."
        )
    }
}

struct MessageState: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 10) {
            Text(title).font(.title3.weight(.semibold))
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 40)
    }
}

#Preview("With data") {
    HealthView(model: HealthModel(health: MockHealthProvider()), readingSession: { MockReadingSession() })
}

#Preview("Empty") {
    HealthView(model: HealthModel(health: EmptyHealthProvider()), readingSession: { MockReadingSession() })
}
