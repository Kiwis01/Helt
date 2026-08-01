import Foundation
import UserNotifications

nonisolated struct ReminderTime: Identifiable, Codable, Hashable, Sendable {
    var id = UUID()
    var hour: Int
    var minute: Int

    var components: DateComponents { DateComponents(hour: hour, minute: minute) }

    /// The next time this fires, for display.
    var next: Date? {
        Calendar.current.nextDate(after: .now, matching: components, matchingPolicy: .nextTime)
    }

    static func from(_ date: Date) -> ReminderTime {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return ReminderTime(hour: parts.hour ?? 9, minute: parts.minute ?? 0)
    }

    /// For binding a `DatePicker`, which only speaks `Date`.
    var asDate: Date {
        Calendar.current.date(from: components) ?? .now
    }
}

/// Reading reminders. Each one repeats every day at the time the person chose.
nonisolated enum Reminders {
    private static let storageKey = "reminders.times"
    private static let identifierPrefix = "loop.reading-reminder."

    static var times: [ReminderTime] {
        get {
            guard let data = UserDefaults.standard.data(forKey: storageKey),
                  let decoded = try? JSONDecoder().decode([ReminderTime].self, from: data)
            else { return [] }
            return decoded.sorted { ($0.hour, $0.minute) < ($1.hour, $1.minute) }
        }
        set {
            let sorted = newValue.sorted { ($0.hour, $0.minute) < ($1.hour, $1.minute) }
            UserDefaults.standard.set(try? JSONEncoder().encode(sorted), forKey: storageKey)
        }
    }

    /// Soonest upcoming reminder across all of them.
    static var next: Date? {
        times.compactMap(\.next).min()
    }

    static func requestPermission() async -> Bool {
        let center = UNUserNotificationCenter.current()
        return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    /// Rewrites every scheduled notification to match `times`. Cheap enough to
    /// call on any change, and it can't drift out of sync with what's stored.
    static func reschedule() async {
        let center = UNUserNotificationCenter.current()
        let stale = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: stale)

        for time in times {
            let content = UNMutableNotificationContent()
            content.title = "Time for a reading"
            content.body = "About \(Config.readingDurationText), then two questions."
            content.sound = .default

            let request = UNNotificationRequest(
                identifier: identifierPrefix + time.id.uuidString,
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: time.components, repeats: true)
            )
            try? await center.add(request)
        }
    }

    @discardableResult
    static func add(_ time: ReminderTime) async -> Bool {
        guard await requestPermission() else { return false }
        times.append(time)
        await reschedule()
        return true
    }

    static func remove(_ time: ReminderTime) async {
        times.removeAll { $0.id == time.id }
        await reschedule()
    }

    static func update(_ time: ReminderTime) async {
        guard let index = times.firstIndex(where: { $0.id == time.id }) else { return }
        var updated = times
        updated[index] = time
        times = updated
        await reschedule()
    }
}
