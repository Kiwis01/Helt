import SwiftUI

@main
struct LoopApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                Tab("Talk", systemImage: "waveform") {
                    TalkView()
                }
                Tab("Analytics", systemImage: "chart.xyaxis.line") {
                    HealthView(
                        model: HealthModel(health: Self.healthProvider),
                        readingSession: Self.readingSession
                    )
                }
                Tab("Settings", systemImage: "gearshape") {
                    SettingsView()
                }
            }
            // Liquid Glass tab bar is the iOS 26 default; this lets it shrink
            // out of the way while reading the trend.
            .tabBarMinimizeBehavior(.onScrollDown)
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
