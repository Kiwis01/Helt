import Foundation

/// Decides whether a call is live or scripted. One place, so the choice is
/// obvious and reversible.
enum CallFactory {
    static func make() -> CallModel {
        // The demo script wins when it's switched on, and the canned script is
        // the fallback whenever there is no key — the app always demos.
        guard Config.canUseLiveVoice, !DemoSettings.usesRedFlagScript else {
            return CallModel(service: MockConversationService(
                script: DemoSettings.usesRedFlagScript ? .redFlag : .ordinary
            ))
        }

        let audio = VoiceAudio()
        return CallModel(service: DeepgramConversationService(audio: audio), audio: audio)
    }
}
