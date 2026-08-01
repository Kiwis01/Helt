import SwiftUI

struct SettingsView: View {
    @State private var times: [ReminderTime] = []
    @State private var notificationsDenied = false
    @AppStorage(DemoSettings.redFlagScriptKey) private var useRedFlagScript = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach($times) { $time in
                        DatePicker(
                            "Reminder",
                            selection: Binding(
                                get: { time.asDate },
                                set: { newDate in
                                    var updated = ReminderTime.from(newDate)
                                    updated.id = time.id
                                    time = updated
                                    Task { await Reminders.update(updated) }
                                }
                            ),
                            displayedComponents: .hourAndMinute
                        )
                    }
                    .onDelete { offsets in
                        let removed = offsets.map { times[$0] }
                        times.remove(atOffsets: offsets)
                        Task { for time in removed { await Reminders.remove(time) } }
                    }

                    Button("Add a reminder") {
                        Task {
                            let new = ReminderTime.from(.now)
                            if await Reminders.add(new) {
                                times = Reminders.times
                            } else {
                                notificationsDenied = true
                            }
                        }
                    }
                } header: {
                    Text("Reminders")
                } footer: {
                    if notificationsDenied {
                        Text("Notifications are off for Loop. Turn them on in Settings › Notifications › Loop.")
                    } else if times.isEmpty {
                        Text("No reminders. Add one and it repeats every day at that time.")
                    } else {
                        Text("Each repeats every day. A reading takes about \(Config.readingDurationText) and ends with two questions. Swipe to delete.")
                    }
                }

                Section {
                    LabeledContent("Heart rate", value: "Read")
                    LabeledContent("Heart rate variability", value: "Read")
                    LabeledContent("Workouts", value: "Read and save")
                } header: {
                    Text("Health data")
                } footer: {
                    Text("Loop saves each reading as a workout because that is the only way to start the AirPods sensor. It never writes a health measurement. Change any of this in Settings › Health › Data Access › Loop.")
                }

                Section {
                    EmergencyDisclosure()
                        .multilineTextAlignment(.leading)
                        .listRowBackground(Color.clear)
                }

                Section {
                    LabeledContent("Clinical data", value: Config.useMocks ? "Mock" : Config.backendBaseURL.absoluteString)
                    LabeledContent("Voice", value: Config.canUseLiveVoice ? "Deepgram" : "Scripted")
                } header: {
                    Text("Connection")
                } footer: {
                    Text("Clinical data goes through the backend. The Deepgram key is currently built into the app — it should move behind the backend before this ships to anyone.")
                }

                Section {
                    Toggle("Red-flag conversation", isOn: $useRedFlagScript)
                } header: {
                    Text("Demo")
                } footer: {
                    Text("Runs the scripted call where someone describes chest pain spreading to their arm, so the safety stop can be shown.")
                }
            }
            .navigationTitle("Settings")
            .toolbar { EditButton() }
            .task { times = Reminders.times }
        }
    }
}

#Preview { SettingsView() }
