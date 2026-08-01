import Foundation
import Observation

enum CallState: Equatable {
    case connecting
    case listening
    case thinking
    case speaking
    case escalated
    case ended
    case failed(String)

    /// The word shown when Reduce Motion is on and the orb can't move.
    var label: String {
        switch self {
        case .connecting: "Connecting"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .escalated: "Stopped"
        case .ended: "Ended"
        case .failed: "Couldn't connect"
        }
    }
}

@MainActor
@Observable
final class CallModel {
    private(set) var state: CallState = .connecting
    private(set) var transcript: [Turn] = []
    /// Non-nil once a red flag has fired. The call is over at that point.
    private(set) var escalation: RedFlag?
    /// 0–1, drives the orb.
    private(set) var level: Double = 0
    var isMuted = false {
        didSet {
            audio?.isMuted = isMuted
            if isMuted { level = 0 }
        }
    }

    private let service: any ConversationService
    /// Present for a live call; nil when the canned script is driving.
    private let audio: VoiceAudio?
    private var consumer: Task<Void, Never>?
    private var levels: Task<Void, Never>?

    init(service: any ConversationService, audio: VoiceAudio? = nil) {
        self.service = service
        self.audio = audio
    }

    func start() {
        guard consumer == nil else { return }
        consumer = Task { [self] in
            do {
                let events = try await service.connect()
                startLevelUpdates()
                for try await event in events {
                    await handle(event)
                    // A red flag ends the call. Nothing further is consumed,
                    // so no queued agent reply can reach the speaker.
                    if escalation != nil { break }
                }
            } catch {
                state = .failed(error.localizedDescription)
            }
        }
    }

    func end() async {
        consumer?.cancel()
        levels?.cancel()
        consumer = nil
        levels = nil
        level = 0
        await service.disconnect()
        state = .ended
    }

    // MARK: - Events

    private func handle(_ event: ConversationEvent) async {
        switch event {
        case .transcript(let turn):
            append(turn)

            // Deterministic screening, before anything else happens to this
            // turn. Not a prompt instruction — code the model cannot reach.
            if turn.speaker == .you, let flag = RedFlags.check(turn.text) {
                await escalate(flag)
                return
            }

            switch turn.speaker {
            case .you:
                // Barge-in: the agent is talking and the user starts anyway.
                // Playback stops before anything else, every time.
                if state == .speaking { await service.interrupt() }
                state = turn.isFinal ? .thinking : .listening
            case .agent:
                state = .speaking
            }

        case .agentSpeechEnded:
            if state == .speaking { state = .listening }

        case .agentAudio:
            break // real playback lands with the audio engine

        case .closed:
            levels?.cancel()
            level = 0
            state = .ended
        }
    }

    /// Stop everything, in this order: silence the agent, then cut the stream.
    private func escalate(_ flag: RedFlag) async {
        levels?.cancel()
        levels = nil
        level = 0
        await service.interrupt()
        escalation = flag
        state = .escalated
        await service.disconnect()
    }

    /// Interim results replace the partial turn they refine rather than piling up.
    private func append(_ turn: Turn) {
        if let last = transcript.last, !last.isFinal, last.speaker == turn.speaker {
            transcript[transcript.count - 1] = turn
        } else {
            transcript.append(turn)
        }
    }

    // MARK: - Level

    /// Real RMS from the audio engine when there is one. Without it — the
    /// canned script — a smoothed random walk stands in so the orb still moves.
    private func startLevelUpdates() {
        levels = Task { [self] in
            var target = 0.0
            while !Task.isCancelled {
                let active = (state == .speaking) || (state == .listening && !isMuted)
                if let audio {
                    target = state == .speaking ? audio.outputLevel : (isMuted ? 0 : audio.inputLevel)
                } else {
                    target = active ? Double.random(in: 0.15...1) : 0
                }
                level += (target - level) * 0.4
                try? await Task.sleep(for: .milliseconds(70))
            }
        }
    }
}
