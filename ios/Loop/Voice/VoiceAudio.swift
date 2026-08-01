import AVFoundation
import Foundation

/// Microphone capture and agent playback for a conversation.
///
/// Not an actor: the capture tap runs on a realtime audio thread that must not
/// await anything. State touched from both that thread and the main one is
/// guarded by a lock instead.
nonisolated final class VoiceAudio: @unchecked Sendable {
    /// Called on the audio thread with 16-bit mono PCM at `Config.voiceSampleRate`.
    var onCapture: (@Sendable (Data) -> Void)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let lock = NSLock()

    private var _inputLevel = 0.0
    private var _outputLevel = 0.0
    private var _isMuted = false
    private var _scheduledFrames = 0

    /// 16-bit mono at the rate Deepgram is configured for, both directions.
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: Config.voiceSampleRate,
        channels: 1,
        interleaved: true
    )!

    /// What the player node actually renders.
    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: Config.voiceSampleRate,
        channels: 1,
        interleaved: false
    )!

    // MARK: - Levels

    var inputLevel: Double { lock.withLock { _inputLevel } }
    var outputLevel: Double { lock.withLock { _outputLevel } }

    var isMuted: Bool {
        get { lock.withLock { _isMuted } }
        set { lock.withLock { _isMuted = newValue } }
    }

    /// True while there is still agent audio queued to play.
    var isPlaying: Bool { lock.withLock { _scheduledFrames > 0 } }

    // MARK: - Lifecycle

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        // .voiceChat turns on the system's echo cancellation, which is what
        // stops the agent's own voice from being transcribed as the user's.
        try session.setCategory(.playAndRecord, mode: .voiceChat,
                                options: [.allowBluetoothHFP, .defaultToSpeaker])
        try session.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)

        guard let converter = AVAudioConverter(from: inputFormat, to: wireFormat) else {
            throw VoiceAudioError.unsupportedInputFormat
        }

        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            self?.handleCapture(buffer, using: converter)
        }

        engine.prepare()
        try engine.start()
        player.play()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        lock.withLock {
            _inputLevel = 0
            _outputLevel = 0
            _scheduledFrames = 0
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Capture

    private func handleCapture(_ buffer: AVAudioPCMBuffer, using converter: AVAudioConverter) {
        let ratio = wireFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let channel = out.int16ChannelData else { return }

        let frames = Int(out.frameLength)
        let samples = UnsafeBufferPointer(start: channel[0], count: frames)

        var sum = 0.0
        for sample in samples {
            let normalised = Double(sample) / 32768
            sum += normalised * normalised
        }
        let rms = (sum / Double(frames)).squareRoot()

        let muted = lock.withLock {
            _inputLevel = Self.scale(rms)
            return _isMuted
        }
        guard !muted else { return }

        onCapture?(Data(bytes: channel[0], count: frames * MemoryLayout<Int16>.size))
    }

    // MARK: - Playback

    /// Queues one chunk of agent audio. 16-bit mono PCM.
    func play(_ pcm: Data) {
        let frames = pcm.count / MemoryLayout<Int16>.size
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData
        else { return }

        buffer.frameLength = AVAudioFrameCount(frames)

        var peak = 0.0
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<frames {
                let value = Float(samples[index]) / 32768
                channel[0][index] = value
                peak = max(peak, Double(abs(value)))
            }
        }

        lock.withLock {
            _scheduledFrames += frames
            _outputLevel = Self.scale(peak)
        }

        player.scheduleBuffer(buffer) { [weak self] in
            guard let self else { return }
            lock.withLock {
                _scheduledFrames = max(0, _scheduledFrames - frames)
                if _scheduledFrames == 0 { _outputLevel = 0 }
            }
        }
    }

    /// Barge-in. Drops everything queued so the agent goes quiet immediately
    /// rather than finishing the sentence it started.
    func stopPlayback() {
        player.stop()
        lock.withLock {
            _scheduledFrames = 0
            _outputLevel = 0
        }
        player.play()
    }

    /// RMS is tiny for speech; this maps a usable range onto 0–1 so the orb
    /// actually moves. ponytail: fixed curve, no AGC — tune if it reads flat
    /// on the demo device.
    private static func scale(_ value: Double) -> Double {
        min(1, max(0, value * 6))
    }
}

enum VoiceAudioError: LocalizedError {
    case unsupportedInputFormat
    case microphoneDenied

    var errorDescription: String? {
        switch self {
        case .unsupportedInputFormat: "This device's microphone isn't usable for a call."
        case .microphoneDenied: "HELT needs microphone access. Turn it on in Settings › HELT."
        }
    }
}
