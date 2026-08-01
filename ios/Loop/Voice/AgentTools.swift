import Foundation

/// What the agent is allowed to do, and what it gets told up front.
///
/// The split matters for latency: anything needed on turn one is *preloaded*
/// into the system prompt, because a tool round trip mid-conversation costs a
/// second on top of an already ~1.5s turn. Tools are for actions and for
/// lookups that are genuinely occasional.
nonisolated enum AgentTools {

    /// Declared to Deepgram inside `agent.think.functions`.
    static var definitions: [[String: Any]] {
        [[
            "name": "administer_questionnaire",
            "description": """
                Present a validated questionnaire in the app and wait for the person to \
                complete it. Returns the score and severity band. Offer this only when the \
                conversation suggests it would genuinely help — for example ongoing symptoms \
                over days or weeks — and never during an acute episode where someone is \
                struggling to talk. Available instruments: \
                \(Instruments.all.map(\.key).joined(separator: ", ")).
                """,
            "parameters": [
                "type": "object",
                "properties": [
                    "instrument": [
                        "type": "string",
                        "description": "Which questionnaire, e.g. \(Instruments.all.map(\.key).joined(separator: " or "))",
                    ],
                    "reason": [
                        "type": "string",
                        "description": "Briefly, what in the conversation prompted this",
                    ],
                ],
                "required": ["instrument"],
            ],
        ]]
    }

    /// A tool call the app has to act on.
    struct Call: Sendable, Equatable {
        let id: String
        let name: String
        let arguments: [String: String]

        var instrument: Instrument? {
            arguments["instrument"].flatMap { Instruments.named($0) }
        }
        var reason: String? { arguments["reason"] }
    }

    /// Decodes `FunctionCallRequest`. Deepgram sends `functions` as an array and
    /// `arguments` as a JSON *string*, not an object.
    static func calls(in payload: [String: Any]) -> [Call] {
        guard let functions = payload["functions"] as? [[String: Any]] else { return [] }
        return functions.compactMap { function in
            guard let id = function["id"] as? String,
                  let name = function["name"] as? String
            else { return nil }
            var arguments: [String: String] = [:]
            if let raw = function["arguments"] as? String,
               let data = raw.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                for (key, value) in parsed { arguments[key] = String(describing: value) }
            }
            return Call(id: id, name: name, arguments: arguments)
        }
    }

    /// The reply Deepgram expects. `content` is a JSON string.
    static func response(for call: Call, content: [String: Any]) -> [String: Any] {
        let json = (try? JSONSerialization.data(withJSONObject: content))
            .map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return ["type": "FunctionCallResponse", "id": call.id, "name": call.name, "content": json]
    }
}
