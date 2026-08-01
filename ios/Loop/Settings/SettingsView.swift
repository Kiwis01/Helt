import SwiftUI

struct SettingsView: View {
    @Environment(MedplumAuth.self) private var auth
    @State private var times: [ReminderTime] = []
    @State private var notificationsDenied = false
    @State private var pendingWrites = 0
    @AppStorage(DemoSettings.redFlagScriptKey) private var useRedFlagScript = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if auth.isSignedIn {
                        LabeledContent("Signed in as", value: auth.displayName ?? "—")
                        if let id = auth.patientID {
                            LabeledContent("Patient") {
                                Text(id.prefix(8) + "…").font(.footnote.monospaced())
                            }
                        }
                        Button("Sign out", role: .destructive) { auth.signOut() }
                    } else {
                        Button("Sign in to Medplum") { Task { await auth.signIn() } }
                    }
                    if pendingWrites > 0 {
                        LabeledContent("Waiting to sync", value: "\(pendingWrites)")
                    }
                } header: {
                    Text("Record")
                } footer: {
                    if let error = auth.error {
                        Text(error)
                    } else {
                        Text("Your readings, questionnaires and episodes are written to your own record in Medplum.")
                    }
                }

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
                        Text("Notifications are off for HELT. Turn them on in Settings › Notifications › HELT.")
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
                    Text("HELT saves each reading as a workout because that is the only way to start the AirPods sensor. It never writes a health measurement. Change any of this in Settings › Health › Data Access › HELT.")
                }

                Section {
                    EmergencyDisclosure()
                        .multilineTextAlignment(.leading)
                        .listRowBackground(Color.clear)
                }

                Section {
                    LabeledContent("Clinical data",
                                   value: auth.isSignedIn ? "Medplum" : "Mock (signed out)")
                    LabeledContent("Record", value: Config.medplumBaseURL.host() ?? "—")
                    LabeledContent("Voice", value: Config.canUseLiveVoice ? "Deepgram" : "Scripted")
                } header: {
                    Text("Connection")
                } footer: {
                    Text("Readings, questionnaires and medication requests are written to your own Medplum record. The Deepgram key is currently built into the app — it should move behind a server before this ships to anyone.")
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
            .task {
                times = Reminders.times
                pendingWrites = WriteQueue().count
            }
        }
    }
}

#Preview { SettingsView() }
