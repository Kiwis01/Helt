import SwiftUI

@main
struct LoopApp: App {
    @State private var auth = MedplumAuth()

    var body: some Scene {
        WindowGroup {
            TabView {
                Tab("Talk", systemImage: "waveform") {
                    TalkView()
                }
                Tab("Analytics", systemImage: "chart.xyaxis.line") {
                    HealthView(
                        model: HealthModel(
                            health: Self.healthProvider,
                            // Real prescriptions once signed in; mock data only
                            // when there is no record to read.
                            clinical: auth.isSignedIn
                                ? MedplumClinicalDataService(auth: auth)
                                : MockClinicalDataService(),
                            heartRate: auth.isSignedIn
                                ? HeartRateSync(auth: auth, medplum: MedplumClient(auth: auth))
                                : nil,
                            checkIn: auth.isSignedIn
                                ? CheckInRecorder(medplum: MedplumClient(auth: auth))
                                : nil
                        ),
                        readingSession: Self.readingSession
                    )
                    .id(auth.isSignedIn)
                }
                Tab("Settings", systemImage: "gearshape") {
                    SettingsView()
                }
            }
            // Liquid Glass tab bar is the iOS 26 default; this lets it shrink
            // out of the way while reading the trend.
            .tabBarMinimizeBehavior(.onScrollDown)
            .environment(auth)
            .task {
                await auth.restore()
                // Anything stranded by a bad network last time goes now.
                await MedplumClient(auth: auth).flush()
            }
        }
    }

    /// The Simulator has no AirPods and cannot run a workout session, so mocks
    /// are not a fallback there — they are the only thing that works.
    private static var healthProvider: any HealthProvider {
        Config.useRealHealthKit ? LiveHealthProvider() : MockHealthProvider()
    }

    private static var readingSession: () -> any ReadingSessionController {
        Config.useRealHealthKit ? { LiveReadingSession() } : { MockReadingSession() }
    }
}
