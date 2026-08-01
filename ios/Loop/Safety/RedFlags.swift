import Foundation

nonisolated enum EmergencyAction: Equatable, Sendable {
    case call911
    case call988
}

nonisolated struct RedFlag: Equatable, Sendable {
    let id: String
    let action: EmergencyAction
    /// Plain language, shown to the person. No jargon, no diagnosis.
    let reason: String
}

/// Deterministic emergency screening. A pure function over text: no network,
/// no model, no state. It runs on every turn the person speaks, before the
/// agent's reply is played, and nothing the model produces can suppress it.
///
/// English and Spanish, because the demo may be in either.
nonisolated enum RedFlags {

    nonisolated static func check(_ text: String) -> RedFlag? {
        let haystack = normalise(text)
        return rules.first { rule in
            rule.groups.allSatisfy { group in
                group.contains { haystack.contains(" \($0) ") }
            }
        }
        .map { RedFlag(id: $0.id, action: $0.action, reason: $0.reason) }
    }

    // MARK: - Rules

    private struct Rule: Sendable {
        let id: String
        let action: EmergencyAction
        let reason: String
        /// Every group must match. A group matches if any one of its phrases appears.
        let groups: [[String]]
    }

    private nonisolated static let rules: [Rule] = [
        Rule(
            id: "RF-01-CHEST-PAIN-RADIATING",
            action: .call911,
            reason: "You mentioned chest pain spreading to your arm or jaw.",
            groups: [
                ["chest pain", "chest hurts", "pain in my chest", "chest pressure",
                 "pressure in my chest", "crushing", "tightness in my chest",
                 "dolor de pecho", "me duele el pecho", "presion en el pecho",
                 "opresion en el pecho", "dolor en el pecho"],
                ["radiating", "radiates", "spreading", "spreads", "shooting down",
                 "down my arm", "into my arm", "to my arm", "my left arm", "my jaw",
                 "into my jaw", "to my jaw", "my shoulder blade",
                 "se irradia", "irradia", "al brazo", "el brazo izquierdo",
                 "la mandibula", "a la mandibula", "la quijada"],
            ]
        ),
        Rule(
            id: "RF-02-SYNCOPE",
            action: .call911,
            reason: "You mentioned losing consciousness.",
            // Actually fainting only. Feeling faint is ordinary in a panic
            // episode and must not escalate — see the negative tests.
            groups: [[
                "fainted", "passed out", "blacked out", "lost consciousness",
                "knocked out cold",
                "me desmaye", "me desmaya", "perdi el conocimiento",
                "perdi la conciencia", "me quede inconsciente",
            ]]
        ),
        Rule(
            id: "RF-03-UNILATERAL-WEAKNESS",
            action: .call911,
            reason: "You mentioned weakness or numbness on one side of your body.",
            groups: [
                ["one side", "left side", "right side", "left arm", "right arm",
                 "left leg", "right leg", "one arm", "one leg",
                 "un lado", "lado izquierdo", "lado derecho", "brazo izquierdo",
                 "brazo derecho", "pierna izquierda", "pierna derecha"],
                ["numb", "numbness", "weak", "weakness", "cant move", "can t move",
                 "wont move", "paralysed", "paralyzed", "dead weight",
                 "entumecido", "entumecida", "adormecido", "dormido", "debil",
                 "debilidad", "no puedo mover", "no lo puedo mover", "paralizado"],
            ]
        ),
        Rule(
            id: "RF-04-SPEECH-FACIAL",
            action: .call911,
            reason: "You mentioned slurred speech or your face drooping.",
            groups: [[
                "slurred", "slurring", "words are coming out wrong",
                "face is drooping", "face drooping", "drooping", "half my face",
                "one side of my face",
                "se me traba la lengua", "arrastro las palabras", "hablo arrastrado",
                "se me cayo la cara", "cara caida", "media cara",
            ]]
        ),
        Rule(
            id: "RF-05-THUNDERCLAP-HEADACHE",
            action: .call911,
            reason: "You described a sudden, severe headache.",
            groups: [[
                "worst headache of my life", "worst headache i have ever had",
                "worst headache ever", "thunderclap",
                "peor dolor de cabeza de mi vida", "el peor dolor de cabeza",
                "peor dolor de cabeza que he tenido",
            ]]
        ),
        Rule(
            id: "RF-06-DYSPNEA-AT-REST",
            action: .call911,
            reason: "You described serious trouble breathing.",
            // Deliberately narrow. "I can't breathe" and "me falta el aire" are
            // the defining sentences of a panic attack; escalating on them would
            // route every episode to 911 and make the product useless. These
            // phrases describe breathing trouble that panic does not explain.
            // ponytail: narrower than the shared brief's RF-06 — needs a
            // clinician's sign-off before this ships to anyone real.
            groups: [[
                "stopped breathing", "not breathing", "gasping for air", "gasping",
                "choking", "turning blue", "lips are blue", "lips are turning blue",
                "cant get any air", "can t get any air",
                "deje de respirar", "no estoy respirando", "me estoy ahogando",
                "labios morados", "me estoy poniendo morado", "boqueando",
            ]]
        ),
        Rule(
            id: "RF-07-SELF-HARM",
            action: .call988,
            reason: "You mentioned wanting to hurt yourself.",
            groups: [[
                "kill myself", "killing myself", "end my life", "end it all",
                "want to die", "wanna die", "suicide", "suicidal",
                "hurt myself", "harm myself", "not be here anymore",
                "matarme", "me quiero morir", "quiero morirme", "quitarme la vida",
                "suicidarme", "suicidio", "hacerme dano", "lastimarme",
                "no quiero vivir", "no quiero seguir viviendo",
            ]]
        ),
    ]

    // MARK: - Normalisation

    /// Lowercased, unaccented, punctuation flattened to spaces, and padded so a
    /// phrase search behaves like a word-boundary match — " arm " does not match
    /// "alarm".
    private nonisolated static func normalise(_ text: String) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
        let flattened = folded.map { $0.isLetter || $0.isNumber ? $0 : " " }
        let collapsed = String(flattened).split(separator: " ").joined(separator: " ")
        return " \(collapsed) "
    }
}
