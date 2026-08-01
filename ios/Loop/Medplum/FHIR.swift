import Foundation

/// The handful of FHIR shapes Loop actually writes. Hand-rolled rather than
/// pulling in a full FHIR model package for five resource types.
nonisolated enum FHIR {
    struct Coding: Codable, Hashable, Sendable {
        var system: String?
        var code: String?
        var display: String?
    }

    struct CodeableConcept: Codable, Hashable, Sendable {
        var coding: [Coding]?
        var text: String?

        static func loinc(_ code: String, _ display: String) -> CodeableConcept {
            CodeableConcept(coding: [Coding(system: "http://loinc.org", code: code, display: display)],
                            text: display)
        }
    }

    struct Reference: Codable, Hashable, Sendable {
        var reference: String
        var display: String?

        static func patient(_ id: String) -> Reference { Reference(reference: "Patient/\(id)") }
    }

    struct Quantity: Codable, Hashable, Sendable {
        var value: Double
        var unit: String?
        var system: String? = "http://unitsofmeasure.org"
        var code: String?
    }

    struct Period: Codable, Hashable, Sendable {
        var start: String?
        var end: String?
    }

    // MARK: - QuestionnaireResponse

    struct QuestionnaireResponse: Codable, Hashable, Sendable {
        var resourceType = "QuestionnaireResponse"
        var questionnaire: String
        var status: String = "completed"
        var subject: Reference
        var authored: String
        var author: Reference?
        var item: [Item]

        struct Item: Codable, Hashable, Sendable {
            var linkId: String
            var text: String?
            var answer: [Answer]
        }

        struct Answer: Codable, Hashable, Sendable {
            var valueCoding: Coding?
        }
    }

    // MARK: - Observation

    struct Observation: Codable, Hashable, Sendable {
        var resourceType = "Observation"
        var status: String = "final"
        var category: [CodeableConcept]?
        var code: CodeableConcept
        var subject: Reference
        var effectiveDateTime: String
        var valueQuantity: Quantity?
        var valueInteger: Int?
        var interpretation: [CodeableConcept]?
        var derivedFrom: [Reference]?

        static let surveyCategory = CodeableConcept(coding: [
            Coding(system: "http://terminology.hl7.org/CodeSystem/observation-category",
                   code: "survey", display: "Survey")
        ])

        static let vitalsCategory = CodeableConcept(coding: [
            Coding(system: "http://terminology.hl7.org/CodeSystem/observation-category",
                   code: "vital-signs", display: "Vital Signs")
        ])
    }
}

nonisolated extension Date {
    /// FHIR `instant` / `dateTime`.
    var fhir: String { ISO8601DateFormatter().string(from: self) }
}
