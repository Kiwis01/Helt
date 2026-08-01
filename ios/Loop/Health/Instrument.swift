import Foundation

/// A scored clinical questionnaire. GAD-7 is the first, not the only one —
/// adding an instrument is adding data here plus a `Questionnaire` in Medplum,
/// not writing a new screen.
///
/// Scoring lives in code, never in a prompt. The agent decides *whether* to
/// administer an instrument; it never grades one.
nonisolated struct Instrument: Identifiable, Sendable {
    /// Canonical URL, matching the Questionnaire in Medplum.
    let id: String
    /// What the model refers to it by, e.g. "GAD-7".
    let key: String
    let title: String
    let panelCode: String
    let totalScoreCode: String
    /// The recall period the items are asked over.
    let recall: String
    let items: [Item]
    let options: [Option]
    let bands: [Band]
    /// Items where any non-zero answer is a safety event rather than a score —
    /// PHQ-9 item 9 is suicidal ideation. Handled before the score is reported.
    let escalatingItems: [Int]
    let escalation: RedFlag?

    struct Item: Identifiable, Sendable {
        let id: Int
        let loinc: String
        let text: String
    }

    struct Option: Hashable, Sendable {
        let value: Int
        let loinc: String
        let text: String
    }

    struct Band: Sendable {
        let upTo: Int
        let label: String
    }

    var maximumScore: Int { items.count * (options.map(\.value).max() ?? 0) }

    // MARK: - Scoring

    /// Sum of every item. `nil` unless all are answered and in range — a partial
    /// questionnaire is not a score and must never be recorded as one.
    func score(_ answers: [Answer]) -> Int? {
        let byItem = Dictionary(answers.map { ($0.itemID, $0.value) }, uniquingKeysWith: { _, last in last })
        let valid = Set(options.map(\.value))
        guard items.allSatisfy({ byItem[$0.id] != nil }),
              byItem.values.allSatisfy({ valid.contains($0) })
        else { return nil }
        return items.compactMap { byItem[$0.id] }.reduce(0, +)
    }

    func severity(for score: Int) -> String? {
        bands.first { score <= $0.upTo }?.label
    }

    /// Descriptive, never diagnostic: reports a number and a band.
    func summary(for score: Int) -> String {
        guard let severity = severity(for: score)?.lowercased() else {
            return "You scored \(score) out of \(maximumScore)."
        }
        return "You scored \(score) out of \(maximumScore). That falls in the \(severity) range."
    }

    /// Checked before scoring. A safety item outranks the questionnaire.
    func safetyEvent(in answers: [Answer]) -> RedFlag? {
        guard let escalation else { return nil }
        let triggered = answers.contains { escalatingItems.contains($0.itemID) && $0.value > 0 }
        return triggered ? escalation : nil
    }

    func option(for value: Int) -> Option? { options.first { $0.value == value } }
}

nonisolated struct Answer: Identifiable, Codable, Hashable, Sendable {
    var id: Int { itemID }
    let itemID: Int
    let value: Int
}

// MARK: - Catalogue

nonisolated enum Instruments {
    static let all: [Instrument] = [gad7, phq9]

    /// Tolerant lookup — the model may say "GAD7", "gad-7" or the full title.
    static func named(_ raw: String) -> Instrument? {
        let needle = raw.lowercased().filter(\.isLetterOrNumber)
        return all.first {
            let key = $0.key.lowercased().filter(\.isLetterOrNumber)
            return key == needle || $0.title.lowercased().contains(raw.lowercased())
        }
    }

    /// Standard 0–3 frequency scale shared by GAD-7 and PHQ-9.
    private static let frequencyOptions: [Instrument.Option] = [
        .init(value: 0, loinc: "LA6568-5", text: "Not at all"),
        .init(value: 1, loinc: "LA6569-3", text: "Several days"),
        .init(value: 2, loinc: "LA6570-1", text: "More than half the days"),
        .init(value: 3, loinc: "LA6571-9", text: "Nearly every day"),
    ]

    static let gad7 = Instrument(
        id: "http://loinc.org/q/69737-5",
        key: "GAD-7",
        title: "Generalized Anxiety Disorder 7-item (GAD-7)",
        panelCode: "69737-5",
        totalScoreCode: "70274-6",
        recall: "Over the last two weeks, how often have you been bothered by…",
        items: [
            .init(id: 1, loinc: "69725-0", text: "Feeling nervous, anxious, or on edge"),
            .init(id: 2, loinc: "68509-9", text: "Not being able to stop or control worrying"),
            .init(id: 3, loinc: "69733-4", text: "Worrying too much about different things"),
            .init(id: 4, loinc: "69734-2", text: "Trouble relaxing"),
            .init(id: 5, loinc: "69735-9", text: "Being so restless that it's hard to sit still"),
            .init(id: 6, loinc: "69689-8", text: "Becoming easily annoyed or irritable"),
            .init(id: 7, loinc: "69736-7", text: "Feeling afraid, as if something awful might happen"),
        ],
        options: frequencyOptions,
        bands: [.init(upTo: 4, label: "Minimal"), .init(upTo: 9, label: "Mild"),
                .init(upTo: 14, label: "Moderate"), .init(upTo: 21, label: "Severe")],
        escalatingItems: [],
        escalation: nil
    )

    /// PHQ-9 item 9 asks about thoughts of being better off dead. Any non-zero
    /// answer routes to the same 988 path as a spoken red flag — it is a safety
    /// event, not a contribution to a total.
    static let phq9 = Instrument(
        id: "http://loinc.org/q/44249-1",
        key: "PHQ-9",
        title: "Patient Health Questionnaire 9-item (PHQ-9)",
        panelCode: "44249-1",
        totalScoreCode: "44261-6",
        recall: "Over the last two weeks, how often have you been bothered by…",
        items: [
            .init(id: 1, loinc: "44250-9", text: "Little interest or pleasure in doing things"),
            .init(id: 2, loinc: "44255-8", text: "Feeling down, depressed, or hopeless"),
            .init(id: 3, loinc: "44259-0", text: "Trouble falling or staying asleep, or sleeping too much"),
            .init(id: 4, loinc: "44254-1", text: "Feeling tired or having little energy"),
            .init(id: 5, loinc: "44251-7", text: "Poor appetite or overeating"),
            .init(id: 6, loinc: "44258-2", text: "Feeling bad about yourself, or that you're a failure"),
            .init(id: 7, loinc: "44252-5", text: "Trouble concentrating on things"),
            .init(id: 8, loinc: "44253-3", text: "Moving or speaking slowly, or being restless"),
            .init(id: 9, loinc: "44260-8", text: "Thoughts that you would be better off dead, or of hurting yourself"),
        ],
        options: frequencyOptions,
        bands: [.init(upTo: 4, label: "Minimal"), .init(upTo: 9, label: "Mild"),
                .init(upTo: 14, label: "Moderate"), .init(upTo: 19, label: "Moderately severe"),
                .init(upTo: 27, label: "Severe")],
        escalatingItems: [9],
        escalation: RedFlag(
            id: "RF-07-SELF-HARM",
            action: .call988,
            reason: "You said you've had thoughts of hurting yourself."
        )
    )
}

nonisolated extension Character {
    var isLetterOrNumber: Bool { isLetter || isNumber }
}
