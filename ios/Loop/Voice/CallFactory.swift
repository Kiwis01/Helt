import Foundation

/// Decides whether a call is live or scripted, and gives the live agent the
/// clinical context it needs on turn one.
@MainActor
enum CallFactory {
    /// Synchronous on purpose. Building a call must never wait on the network —
    /// the conversation view appears immediately and shows "connecting" while
    /// the context load and websocket handshake happen behind it.
    static func make(auth: MedplumAuth) -> CallModel {
        // The demo script wins when it's switched on, and the canned script is
        // the fallback whenever there is no key — the app always demos.
        guard Config.canUseLiveVoice, !DemoSettings.usesRedFlagScript else {
            return CallModel(service: MockConversationService(
                script: DemoSettings.usesRedFlagScript ? .redFlag : .ordinary
            ))
        }

        let audio = VoiceAudio()
        // Preloaded rather than fetched by a tool: it's needed on the first turn,
        // and a round trip there would cost a second of an already ~1.5s reply.
        // Fetched at connect time, under a budget — see `PatientContext.build`.
        let service = DeepgramConversationService(audio: audio) {
            await PatientContext(auth: auth).build()
        }
        let model = CallModel(service: service, audio: audio)
        model.medicationHistory = { await MedicationHistory(auth: auth).all() }
        return model
    }
}
