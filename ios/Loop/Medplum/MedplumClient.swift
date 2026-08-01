import Foundation

/// Writes FHIR resources straight to Medplum. There is no proxy backend —
/// Medplum *is* the backend, and the app authenticates as the patient.
@MainActor
final class MedplumClient {
    private let auth: MedplumAuth
    private let queue: WriteQueue

    init(auth: MedplumAuth, queue: WriteQueue = WriteQueue()) {
        self.auth = auth
        self.queue = queue
    }

    var patientID: String? { auth.patientID }

    /// Creates a resource, queueing it for retry if the write can't go through.
    /// Nothing the app records is allowed to be lost to a bad network.
    @discardableResult
    func create<T: Encodable & Sendable>(_ resource: T, type: String) async -> String? {
        let body: Data
        do {
            body = try JSONEncoder().encode(resource)
        } catch {
            return nil
        }

        let outcome = await post(type: type, body: body)
        switch outcome {
        case .created(let id): return id
        case .rejected: return nil          // malformed; retrying can't help
        case .retriable: queue.enqueue(.init(type: type, body: body)); return nil
        }
    }

    /// Retries anything stranded by an earlier failure. Safe to call often.
    func flush() async {
        for pending in queue.pending() {
            switch await post(type: pending.type, body: pending.body) {
            case .created, .rejected: queue.remove(pending.id)
            case .retriable: return          // still offline; stop and try later
            }
        }
    }

    private enum Outcome {
        case created(String?)
        /// 4xx — Medplum will never accept this. Dropping it beats clogging the queue.
        case rejected
        /// Network failure or 5xx. Worth trying again.
        case retriable
    }

    private func post(type: String, body: Data) async -> Outcome {
        guard let token = await auth.token() else { return .retriable }
        var request = URLRequest(url: Config.medplumBaseURL.appending(path: "fhir/R4/\(type)"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/fhir+json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 15

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let status = (response as? HTTPURLResponse)?.statusCode
        else { return .retriable }

        if (200..<300).contains(status) {
            let id = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? String
            return .created(id)
        }
        // 401 is worth retrying — the token may just have expired mid-flight.
        return (400..<500).contains(status) && status != 401 ? .rejected : .retriable
    }
}

/// Failed writes, persisted so they survive the app being killed.
@MainActor
final class WriteQueue {
    struct Pending: Codable, Identifiable, Sendable {
        var id = UUID()
        let type: String
        let body: Data
        var queuedAt = Date()
    }

    private let key = "medplum.writeQueue"

    func enqueue(_ pending: Pending) {
        var all = pending_()
        all.append(pending)
        save(all)
    }

    func pending() -> [Pending] { pending_() }

    func remove(_ id: UUID) {
        save(pending_().filter { $0.id != id })
    }

    var count: Int { pending_().count }

    private func pending_() -> [Pending] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let decoded = try? JSONDecoder().decode([Pending].self, from: data)
        else { return [] }
        return decoded
    }

    private func save(_ all: [Pending]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(all), forKey: key)
    }
}
