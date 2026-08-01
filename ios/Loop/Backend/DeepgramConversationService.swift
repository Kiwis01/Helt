import Foundation

/// Live conversation over Deepgram's Voice Agent API.
///
/// One websocket carries all three legs — speech to text, the model, text to
/// speech — so the app streams microphone PCM up and gets agent PCM plus
/// transcript events back.
///
/// The red-flag check still runs on this transcript in `CallModel`, before any
/// audio reaches the speaker. Nothing here can bypass it.
final class DeepgramConversationService: ConversationService {
    private let key: String
    private let audio: VoiceAudio
    private var socket: URLSessionWebSocketTask?
    private var continuation: AsyncThrowingStream<ConversationEvent, Error>.Continuation?

    /// Clinical context, fetched at connect time so turn one already knows who
    /// it's talking to without paying for a tool round trip.
    private let loadContext: @MainActor () async -> String?
    private var context: String?

    init(
        key: String = Config.deepgramKey,
        audio: VoiceAudio,
        context: @escaping @MainActor () async -> String? = { nil }
    ) {
        self.key = key
        self.audio = audio
        self.loadContext = context
    }

    private var prompt: String {
        guard let context else { return Config.agentPrompt }
        return Config.agentPrompt + "\n\nWhat you know about this person:\n" + context
    }

    // MARK: - ConversationService

    func connect() async throws -> AsyncThrowingStream<ConversationEvent, Error> {
        guard !key.isEmpty else { throw DeepgramError.missingKey }
        guard await VoiceAudio.requestPermission() else { throw VoiceAudioError.microphoneDenied }

        // The loader keeps its own deadline: a slow record must not hold up a
        // conversation someone may badly need. No context is a worse agent,
        // not a broken one.
        context = await loadContext()

        var request = URLRequest(url: URL(string: "wss://agent.deepgram.com/v1/agent/converse")!)
        request.setValue("Token \(key)", forHTTPHeaderField: "Authorization")

        let socket = URLSession.shared.webSocketTask(with: request)
        self.socket = socket
        socket.resume()

        try await send(settings)

        // Captures the socket, not self: this fires on the audio thread.
        audio.onCapture = { pcm in
            socket.send(.data(pcm)) { _ in }
        }
        try audio.start()

        return AsyncThrowingStream { continuation in
            self.continuation = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.disconnect() }
            }
            Task { await self.receiveLoop() }
        }
    }

    func send(audio pcm: Data) async throws {
        try await socket?.send(.data(pcm))
    }

    /// Barge-in: drop everything queued so the agent goes quiet now.
    ///
    /// Local only, deliberately. Deepgram handles barge-in server-side and
    /// there is no client message to cancel a turn — sending one it doesn't
    /// recognise earns an `Error` and ends the session, which is exactly the
    /// wrong outcome when someone has just said something urgent.
    func interrupt() async {
        audio.stopPlayback()
    }

    /// Hands a tool result back so the model can reason about it and reply.
    func answer(_ call: AgentTools.Call, with content: [String: Any]) async {
        try? await send(AgentTools.response(for: call, content: content))
    }

    func disconnect() async {
        audio.onCapture = nil
        audio.stop()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        continuation?.finish()
        continuation = nil
    }

    // MARK: - Receive

    private func receiveLoop() async {
        guard let socket else { return }
        while socket.state == .running {
            do {
                switch try await socket.receive() {
                case .data(let data):
                    // Binary frames are agent audio: raw linear16 at our rate.
                    audio.play(data)
                    continuation?.yield(.agentAudio(data))
                case .string(let text):
                    handle(text)
                @unknown default:
                    break
                }
            } catch {
                continuation?.yield(.closed)
                continuation?.finish()
                return
            }
        }
        continuation?.yield(.closed)
        continuation?.finish()
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONDecoder().decode(ServerMessage.self, from: data)
        else { return }

        switch message.type {
        case "ConversationText":
            guard let content = message.content, !content.isEmpty else { return }
            let speaker: Turn.Speaker = message.role == "user" ? .you : .agent
            continuation?.yield(.transcript(Turn(speaker: speaker, text: content, isFinal: true)))

        case "UserStartedSpeaking":
            // Deepgram heard the person talk over the agent. Cut playback here
            // too — waiting for the transcript would leave a stale sentence
            // playing for hundreds of milliseconds.
            audio.stopPlayback()

        case "AgentAudioDone":
            continuation?.yield(.agentSpeechEnded)

        case "FunctionCallRequest":
            guard let payload = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
            else { return }
            for call in AgentTools.calls(in: payload) {
                continuation?.yield(.toolCall(call))
            }

        case "Error":
            let detail = message.description ?? message.message ?? "Deepgram rejected the session."
            continuation?.finish(throwing: DeepgramError.server(detail))

        default:
            break
        }
    }

    // MARK: - Settings

    private var settings: [String: Any] {
        [
            "type": "Settings",
            "audio": [
                "input": ["encoding": "linear16", "sample_rate": Int(Config.voiceSampleRate)],
                "output": [
                    "encoding": "linear16",
                    "sample_rate": Int(Config.voiceSampleRate),
                    "container": "none",
                ],
            ],
            "agent": [
                "language": "en",
                "listen": ["provider": ["type": "deepgram", "model": "nova-3-medical"]],
                // Claude does the reasoning, routed through Deepgram on the one
                // socket — no Anthropic or Bedrock credential needed here.
                "think": [
                    "provider": ["type": "anthropic", "model": "claude-sonnet-4-5"],
                    "prompt": prompt,
                    "functions": AgentTools.definitions,
                ],
                "speak": ["provider": ["type": "deepgram", "model": "aura-2-thalia-en"]],
                "greeting": Config.agentGreeting,
            ],
        ]
    }

    private func send(_ payload: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: payload)
        try await socket?.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private struct ServerMessage: Decodable {
        let type: String
        let role: String?
        let content: String?
        let description: String?
        let message: String?
    }
}

enum DeepgramError: LocalizedError {
    case missingKey
    case server(String)

    var errorDescription: String? {
        switch self {
        case .missingKey: "No Deepgram key in this build."
        case .server(let detail): detail
        }
    }
}
