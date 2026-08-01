import Foundation

/// Single place the app points outward. Everything clinical — Medplum, care
/// plans, episodes — lives behind `backendBaseURL` and the app holds no key
/// for any of it. Deepgram is the one exception, and a temporary one: see
/// `deepgramKey`.
nonisolated enum Config {
    static let backendBaseURL = URL(string: "http://localhost:3001")!

    /// Clinical data — medications, care plan, episode history — comes from
    /// mocks until the backend exists. Nothing to do with HealthKit.
    static var useMocks: Bool {
        true // flip when the backend is up
    }

    /// HealthKit is real on any physical device. The Simulator has no AirPods
    /// and cannot run a workout session, so it is the only place that mocks.
    static var useRealHealthKit: Bool {
        #if targetEnvironment(simulator)
        false
        #else
        true
        #endif
    }

    /// How long a reading holds the sensor. Long enough for the PPG sensor to
    /// settle and give a stable average, short enough that people actually do
    /// it every week.
    static var readingSeconds: TimeInterval {
        #if targetEnvironment(simulator)
        return 20
        #else
        return 60
        #endif
    }

    /// Keeps the interface copy honest when `readingSeconds` changes.
    static var readingDurationText: String {
        let seconds = Int(readingSeconds)
        if seconds < 60 { return "\(seconds) seconds" }
        let minutes = seconds / 60
        return minutes == 1 ? "a minute" : "\(minutes) minutes"
    }

    /// Countdown before collection starts, so the sensor has time to come up.
    static let readingCountdownSeconds = 3

    /// Weeks shown in the trend.
    static let trendWeeks = 12

    
    
    

    // MARK: - Medplum

    /// Medplum is the backend. There is no proxy service — the app authenticates
    /// as the patient and writes FHIR directly.
    static let medplumBaseURL = URL(string: "https://api.medplum.com/")!

    /// Public client: authorization code + PKCE, no secret. Safe to ship.
    static let medplumClientID = "643cb471-dcf4-48b4-a57c-514ce17684b4"

    static let medplumRedirectScheme = "loop"
    static let medplumRedirectURI = "loop://auth-callback"

    // MARK: - Voice

    /// Injected at build time from `Secrets.xcconfig`, which is gitignored.
    ///
    /// This is a hackathon shortcut and it contradicts the thin-client rule:
    /// anyone with the .ipa can extract this. The real fix is for the backend
    /// to mint a short-lived Deepgram token per call and hand it to the app —
    /// at which point only `deepgramKey` changes, not the service.
    /// ponytail: shipping key. Swap for a backend-minted ephemeral token
    /// before this goes near TestFlight.
    static var deepgramKey: String {
        (Bundle.main.object(forInfoDictionaryKey: "DEEPGRAM_API_KEY") as? String) ?? ""
    }

    /// Falls back to the canned script when there's no key, so the app always
    /// demos rather than showing an error.
    static var canUseLiveVoice: Bool { !deepgramKey.isEmpty }

    static let voiceSampleRate = 24_000.0

    static let agentPrompt = """
        You are Loop, a companion for someone managing anxiety. You contextualise, \
        you never diagnose. Never tell someone what condition they have or what is \
        happening to them medically. Say what their data shows and what their care \
        plan says, and let them draw conclusions. Their clinician wrote the care \
        plan; you read it back. Keep replies to one or two sentences — they may be \
        mid-episode and cannot follow long answers. Cite concrete numbers when you \
        have them. Never recommend medication, supplements, or dosage changes. If \
        someone describes a medical emergency, tell them to hang up and call 911.
        """

    static let agentGreeting =
        "I'm here. Tell me what's going on."
}

/// Switches that exist only to make the demo repeatable on stage.
nonisolated enum DemoSettings {
    static let redFlagScriptKey = "demo.redFlagScript"

    static var usesRedFlagScript: Bool {
        UserDefaults.standard.bool(forKey: redFlagScriptKey)
    }
}
