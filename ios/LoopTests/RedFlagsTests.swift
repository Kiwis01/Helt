import Foundation
import Testing
@testable import Loop

struct RedFlagsTests {

    // MARK: - Must escalate

    @Test(arguments: [
        ("my chest hurts and it's shooting down my arm", "RF-01-CHEST-PAIN-RADIATING"),
        ("there's pressure in my chest going up into my jaw", "RF-01-CHEST-PAIN-RADIATING"),
        ("me duele el pecho y se me va al brazo", "RF-01-CHEST-PAIN-RADIATING"),
        ("tengo dolor de pecho que se irradia a la mandibula", "RF-01-CHEST-PAIN-RADIATING"),

        ("I fainted in the kitchen", "RF-02-SYNCOPE"),
        ("I passed out for a few seconds", "RF-02-SYNCOPE"),
        ("me desmaye hace un momento", "RF-02-SYNCOPE"),
        ("creo que perdi el conocimiento", "RF-02-SYNCOPE"),

        ("my left arm has gone completely numb", "RF-03-UNILATERAL-WEAKNESS"),
        ("there's weakness down one side", "RF-03-UNILATERAL-WEAKNESS"),
        ("no puedo mover el brazo izquierdo", "RF-03-UNILATERAL-WEAKNESS"),
        ("tengo un lado del cuerpo entumecido", "RF-03-UNILATERAL-WEAKNESS"),

        ("my speech is slurred", "RF-04-SPEECH-FACIAL"),
        ("half my face feels wrong and I'm slurring", "RF-04-SPEECH-FACIAL"),
        ("se me traba la lengua", "RF-04-SPEECH-FACIAL"),

        ("this is the worst headache of my life", "RF-05-THUNDERCLAP-HEADACHE"),
        ("es el peor dolor de cabeza de mi vida", "RF-05-THUNDERCLAP-HEADACHE"),

        ("I'm gasping for air", "RF-06-DYSPNEA-AT-REST"),
        ("my lips are turning blue", "RF-06-DYSPNEA-AT-REST"),
        ("me estoy ahogando", "RF-06-DYSPNEA-AT-REST"),

        ("I want to kill myself", "RF-07-SELF-HARM"),
        ("I've been thinking about suicide", "RF-07-SELF-HARM"),
        ("quiero quitarme la vida", "RF-07-SELF-HARM"),
        ("no quiero vivir mas", "RF-07-SELF-HARM"),
    ])
    func escalates(phrase: String, expected: String) {
        let flag = RedFlags.check(phrase)
        #expect(flag?.id == expected, "\(phrase.debugDescription) should fire \(expected)")
    }

    // MARK: - Must NOT escalate

    /// These are ordinary sentences in a panic episode. Firing on any of them
    /// would route every call to 911 and make the product useless.
    @Test(arguments: [
        "my chest feels tight",
        "it's just in the middle, it happens when I panic",
        "my heart is racing and I can't slow it down",
        "I feel like I'm going to faint",
        "I feel faint and dizzy",
        "I can't breathe",
        "I can't catch my breath",
        "my hands are tingling on both sides",
        "I have a bit of a headache",
        "my arm feels a little tense",
        "I'm scared something is wrong with my heart",
        "siento el corazon acelerado",
        "me falta el aire",
        "me duele un poco la cabeza",
        "siento un poco de presion",
        "estoy muy nervioso",
    ])
    func doesNotEscalate(phrase: String) {
        #expect(RedFlags.check(phrase) == nil, "\(phrase.debugDescription) must not escalate")
    }

    // MARK: - Behaviour

    @Test func selfHarmRoutesTo988AndNot911() {
        #expect(RedFlags.check("I want to kill myself")?.action == .call988)
    }

    @Test func cardiacRoutesTo911() {
        #expect(RedFlags.check("chest pain radiating to my jaw")?.action == .call911)
    }

    /// Chest pain on its own is not enough — the mock conversation depends on
    /// "my chest feels tight" staying quiet so the agent can ask about spread.
    @Test func chestPainNeedsRadiationToFire() {
        #expect(RedFlags.check("my chest hurts") == nil)
        #expect(RedFlags.check("my chest hurts and it spreads to my jaw") != nil)
    }

    /// "number" contains "numb", which would otherwise pair with "one side"
    /// and fire a stroke alert on a sentence about a page number.
    @Test func matchingIsWordBoundaryNotSubstring() {
        #expect(RedFlags.check("one side of the page has a number on it") == nil)
        #expect(RedFlags.check("one side of my body has gone numb") != nil)
    }

    @Test func punctuationAndCasingDoNotMatter() {
        #expect(RedFlags.check("MY CHEST HURTS -- IT'S SPREADING TO MY JAW!!") != nil)
    }

    @Test func emptyAndInnocuousInputIsSafe() {
        #expect(RedFlags.check("") == nil)
        #expect(RedFlags.check("hello") == nil)
    }
}
