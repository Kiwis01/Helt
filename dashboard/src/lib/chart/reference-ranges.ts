/**
 * Rangos de referencia por analito.
 *
 * Marcar un valor fuera de rango es la señal de confianza número uno de una
 * pantalla clínica: es lo que separa "aquí hay una tabla de números" de "aquí
 * hay una herramienta que sabe qué está mal". Por eso cada rango lleva `source`
 * y la UI la muestra — un umbral sin procedencia es un umbral que el médico no
 * se puede permitir creer.
 *
 * NINGÚN valor de este archivo se inventa ni se genera. Son umbrales de guías
 * clínicas publicadas, citadas una por una. Si un analito no tiene rango
 * conocido aquí, el mapeador devuelve `null` y la UI lo pinta sin bandera, que
 * es honesto. Inventar un rango para que la tarjeta "se vea completa" sería
 * exactamente el fallo que hunde la credibilidad de la pantalla.
 *
 * `lowerIsWorse` invierte la lectura para las magnitudes donde bajar es
 * empeorar (FEV1). Sin esa marca, un FEV1 que sube de 68 a 82 se pintaría como
 * deterioro, que es justo lo contrario de lo que pasó.
 */

import type { ReferenceRange } from './types';

/** Clave: código LOINC. Es la única llave estable entre Medplum y esta tabla. */
export const REFERENCE_RANGES: Record<string, ReferenceRange> = {
  // Hemoglobina glucosilada. El objetivo <7 % es el de la ADA para adultos
  // no gestantes con diabetes; ≥9 % es "control muy deficiente" en la misma guía.
  '4548-4': {
    low: null,
    high: 7,
    criticalHigh: 9,
    criticalLow: null,
    source: 'ADA Standards of Care in Diabetes — objetivo <7 % en adultos con diabetes',
    lowerIsWorse: false,
  },

  // Colesterol LDL. Umbrales del ATP III / NCEP, aún los de uso corriente para
  // clasificar: <100 óptimo, ≥160 alto, ≥190 muy alto.
  '2089-1': {
    low: null,
    high: 100,
    criticalHigh: 190,
    criticalLow: null,
    source: 'NCEP ATP III — LDL óptimo <100 mg/dL, muy alto ≥190 mg/dL',
    lowerIsWorse: false,
  },

  // FEV1 como % del predicho. ≥80 % se considera normal; <50 % es obstrucción
  // grave. Aquí bajar es empeorar.
  '20150-9': {
    low: 80,
    high: null,
    criticalHigh: null,
    criticalLow: 50,
    source: 'ATS/ERS — FEV1 ≥80 % del predicho es normal; <50 % obstrucción grave',
    lowerIsWorse: true,
  },

  // Presión sistólica. Umbrales ACC/AHA 2017: <120 normal, ≥130 hipertensión
  // estadio 1, ≥180 crisis hipertensiva.
  '8480-6': {
    low: null,
    high: 130,
    criticalHigh: 180,
    criticalLow: null,
    source: 'ACC/AHA 2017 — sistólica <120 normal, ≥130 hipertensión, ≥180 crisis',
    lowerIsWorse: false,
  },

  // Presión diastólica, misma guía: <80 normal, ≥80 estadio 1, ≥120 crisis.
  '8462-4': {
    low: null,
    high: 80,
    criticalHigh: 120,
    criticalLow: null,
    source: 'ACC/AHA 2017 — diastólica <80 normal, ≥80 hipertensión, ≥120 crisis',
    lowerIsWorse: false,
  },

  // Frecuencia cardiaca en reposo del adulto.
  '8867-4': {
    low: 60,
    high: 100,
    criticalHigh: 130,
    criticalLow: 40,
    source: 'Frecuencia cardiaca en reposo del adulto, 60–100 lpm',
    lowerIsWorse: false,
  },

  // Peso corporal: NO lleva rango. Un peso "normal" depende de la talla, y sin
  // Observation de estatura no hay IMC que calcular. Dejarlo sin bandera es lo
  // correcto; inventar un umbral sería peor que no marcar nada.
};

/** Etiquetas en español por código LOINC, para no depender del display de FHIR. */
export const METRIC_LABELS: Record<string, string> = {
  '4548-4': 'Hemoglobina A1c',
  '2089-1': 'Colesterol LDL',
  '20150-9': 'FEV1',
  '8480-6': 'Presión sistólica',
  '8462-4': 'Presión diastólica',
  '8867-4': 'Frecuencia cardiaca',
  '29463-7': 'Peso',
  '85354-9': 'Presión arterial',
};

/**
 * Orden de importancia clínica para elegir la métrica titular del roster.
 * Cuanto más bajo el número, más manda. Lo que no esté aquí va al final.
 */
export const METRIC_PRIORITY: Record<string, number> = {
  '4548-4': 1,
  '2089-1': 2,
  '20150-9': 3,
  '8480-6': 4,
  '8462-4': 5,
  '8867-4': 6,
  '29463-7': 7,
};

export function referenceRangeFor(loinc: string | null): ReferenceRange | null {
  if (!loinc) return null;
  return REFERENCE_RANGES[loinc] ?? null;
}

export function labelFor(loinc: string | null, fallback: string): string {
  if (!loinc) return fallback;
  return METRIC_LABELS[loinc] ?? fallback;
}

export function priorityFor(loinc: string | null): number {
  if (!loinc) return 99;
  return METRIC_PRIORITY[loinc] ?? 99;
}
