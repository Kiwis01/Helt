# Loop — iOS

A companion app for people managing anxiety. Two things: talk to a voice agent
that knows your clinical history, and track heart rate over weeks to see whether
treatment is actually changing anything.

iOS 26, SwiftUI, Swift Charts, no third-party dependencies.

## Running it

```sh
open Loop.xcodeproj      # or: xcodebuild -scheme Loop -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Builds and runs in the Simulator with mocks. No backend needed.

For live voice, `Secrets.xcconfig` at the repo root needs a Deepgram key:

```
DEEPGRAM_API_KEY = <key>
```

It is gitignored and injected via Info.plist at build time. Without it the app
falls back to a canned conversation, so it always demos.

## What's real and what isn't

| | State |
|---|---|
| Voice conversation | **Real.** Deepgram Voice Agent over WebSocket. Settings payload verified against the live API. |
| Mic capture / playback | **Written, unverified.** `AVAudioEngine` at 24kHz linear16. Needs a device — the Simulator has no real audio session. |
| Red-flag screening | **Real.** Pure function, 41 tests. |
| Weekly trend + medication overlay | Real HealthKit code, mock data. `HealthProvider` protocol picks. |
| Weekly reading | Real `HKWorkoutSession` code, mock timer in the Simulator. |
| Clinical data (medications, events) | **Mocked.** `MockClinicalDataService`. |
| Health sync | **Mocked.** `MockHealthSyncService` returns a fake id. |
| Weekly reminder | Real `UNCalendarNotificationTrigger`. |

The Simulator forces mocks (`Config.useMocks`) because `HKWorkoutSession` does
not run there and there are no AirPods.

## Backend contract

The app holds no clinical credentials. Everything goes through one host
(`Config.backendBaseURL`). Three protocols in `Backend/Contracts.swift`, each
with a mock that returns plausible data:

```swift
protocol ConversationService {
    func connect() async throws -> AsyncThrowingStream<ConversationEvent, Error>
    func send(audio: Data) async throws
    func interrupt() async          // barge-in and red-flag stop
    func disconnect() async
}

protocol HealthSyncService {
    func post(reading: ReadingSummary, weekly: [WeeklyPoint]) async throws -> String
}

protocol ClinicalDataService {
    func medications() async throws -> [Medication]
    func medicationEvents() async throws -> [MedicationEvent]   // the chart overlay
}
```

`ConversationEvent` is `.transcript(Turn)`, `.agentAudio(Data)`,
`.agentSpeechEnded`, `.closed`. Swapping Deepgram for a backend-proxied
transport means writing one more `ConversationService`; nothing else moves.

**The Deepgram key is the exception, and it's temporary.** It ships inside the
app, so anyone with the `.ipa` can extract it. The fix is the backend minting a
short-lived Deepgram token per call — only `Config.deepgramKey` changes.
Do this before TestFlight.

## What the AirPods API turned out to be

The design question was whether a third-party app can make AirPods Pro 3 start
measuring, or whether the user has to start a workout in the Fitness app.

**The app can start it.** On iOS 26 `HKLiveWorkoutBuilder` and
`HKLiveWorkoutDataSource` became available on iPhone (they were watchOS-only).
The app creates an `HKWorkoutSession`, calls `prepare()` with a countdown so the
sensor spins up, then `startActivity()` and `beginCollection()`. HealthKit routes
AirPods heart rate into the Health store on its own; there is no AirPods API.

Three constraints fell out of that, and two of them changed the product:

**The sensor only runs inside a workout session.** No passive sampling, no
on-demand read, nothing in the background. So the weekly check-in *is* the
session — five still minutes with a `.mindAndBody` workout open.

**`restingHeartRate` is unobtainable.** It is system-generated from all-day
sedentary samples and only Apple Watch feeds it. Apps cannot write it. So the
trend charts *average heart rate during the weekly reading* instead. For a
medication question this is arguably better: same posture, same duration, same
time each week, one source — a controlled measurement rather than a passive
estimate. `HKStatisticsCollectionQuery` still does the aggregation, predicated
to the app's own workouts so a Watch-recorded run never pollutes it.

**HRV is impossible from AirPods.** `heartRateVariabilitySDNN` is Watch-derived,
and we can't compute it ourselves — HealthKit gives BPM samples, not beat-to-beat
intervals (`HKHeartbeatSeriesSample` is also Watch-only). It lives in its own
clearly-labelled section that fills in only if a Watch is present.

**One deviation from spec:** the app requests *share* access to `workoutType`.
Read-only was the instruction, but a workout session must save a workout, and
that session is the only way to power the sensor. No health measurement is ever
written. The permission explainer says this in plain words.

## Safety layer

`Safety/RedFlags.swift` is a pure function — no network, no model, no state —
over seven rules, English and Spanish, with the shared brief's rule IDs. It runs
on every user turn in `CallModel.handle` *before* anything else touches that
turn. On a hit: playback stops, the event stream is abandoned, and
`EmergencyView` takes the screen. The model cannot suppress it; the red-flag mock
script has a scripted agent reply queued behind the trigger that provably never
reaches the transcript (`redFlagStopsTheAgentBeforeItCanReply`).

Matching is co-occurrence where it matters. RF-01 needs a chest symptom **and**
radiation, so "my chest feels tight" stays quiet and "spreading down my left arm"
fires. Phrases are matched on word boundaries — "number" must not trip "numb".

**RF-06 (breathing) is deliberately narrower than the shared brief, and needs a
clinician's sign-off.** The brief would fire on "I can't breathe." That is the
defining sentence of a panic attack; escalating on it sends every call to 911 and
makes the product useless. RF-06 only fires on things panic does not explain —
gasping, choking, stopped breathing, blue lips. Sixteen of the 41 tests are
negatives guarding exactly this: "I can't breathe", "I feel like I'm going to
faint", "me falta el aire" must all stay silent. That is a clinical judgement
made by an engineer. Review it.

RF-08/09 from the brief (biometric envelope) are not implemented: the app has no
live heart rate during a conversation, because the sensor only runs in a workout
session. Those belong in the backend.

Two other behaviours are enforced structurally rather than by discipline:

- **No live heart rate during a reading.** `ReadingSessionController` has no
  property that exposes a BPM. Body-checking maintains panic disorder, so the
  number goes into the weekly aggregate and is only seen later in the trend.
- **No diagnosis.** UI copy says what the data shows and what the care plan says.
  The agent prompt in `Config.agentPrompt` states it too, but the copy does not
  depend on the model complying.

## Demo

Settings › Demo › **Red-flag conversation** swaps the canned script for one where
someone describes radiating chest pain, so the safety stop can be shown on stage.
It takes priority over live voice, so the demo is repeatable and never depends on
the network.

## Tests

```sh
xcodebuild -scheme Loop -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

56 tests. The ones that matter: red-flag positives and negatives, barge-in
actually calling `interrupt()`, and the agent being silenced before it can reply
to a red flag.

## What I'd build next

1. **Move the Deepgram key behind the backend.** Ephemeral token per call.
2. **Test the audio path on a device.** Capture, playback, and echo cancellation
   are unverified. Expect to tune `VoiceAudio.scale` — the orb's level curve is
   fixed with no AGC and may read flat on real hardware.
3. **Wire the real backend.** Flip `Config.useMocks`; write the HTTP
   implementations of the three protocols.
4. **Episode write-back.** A conversation should produce a record the way a
   reading does — currently it produces nothing.
5. **Interim transcripts.** `CallModel` already replaces partial turns in place,
   but Deepgram is configured for finals only, so the transcript appears in
   whole sentences rather than streaming in.
6. **Clinician review of RF-06**, and Spanish negative cases from someone who
   speaks it natively.
