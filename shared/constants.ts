/**
 * Loop — constantes compartidas.
 *
 * Fuente única de verdad para puertos, IDs de demo y códigos clínicos.
 * Este archivo es de SOLO LECTURA para core/, voice/, dashboard/ y coverage/.
 * Cambios: PR + aviso a los tres.
 *
 * Nota: aquí NO se lee process.env a propósito — este módulo se importa
 * también desde el bundle del navegador. Cada servicio lee su propio env.
 */

/* ------------------------------------------------------------------ */
/* Puertos                                                             */
/* ------------------------------------------------------------------ */

export const PORTS = {
  dashboard: 3000, // Carlos
  core: 3001, // Kiwis
  voice: 3002, // Lewis
  coverage: 3003, // Carlos
} as const;

export const DEFAULT_SERVICE_URLS = {
  dashboard: `http://localhost:${PORTS.dashboard}`,
  core: `http://localhost:${PORTS.core}`,
  voice: `http://localhost:${PORTS.voice}`,
  coverage: `http://localhost:${PORTS.coverage}`,
} as const;

/* ------------------------------------------------------------------ */
/* IDs fijos del demo                                                  */
/* ------------------------------------------------------------------ */

export const LOOP_PATIENT_ID = 'loop-demo-patient-001';
export const LOOP_PRACTITIONER_ID = 'loop-demo-clinician-001';
export const LOOP_CAREPLAN_ID = 'loop-demo-careplan-001';

/** Actividades del care plan. Referenciadas por voice/ y dashboard/. */
export const CARE_PLAN_ACTIVITY_IDS = {
  boxBreathing: 'cp-act-1',
  grounding: 'cp-act-2',
  messageCareTeam: 'cp-act-3',
} as const;

/* ------------------------------------------------------------------ */
/* Códigos clínicos                                                    */
/* ------------------------------------------------------------------ */

/** LOINC — métricas del wearable. Las usa core/ al sembrar Observations. */
export const LOINC = {
  heartRate: '8867-4',
  respiratoryRate: '9279-1',
  heartRateVariability: '80404-7',
  sleepDuration: '93832-4',
  oxygenSaturation: '59408-5',
} as const;

export const SNOMED = {
  anxietyDisorder: '197480006',
  panicAttack: '226300009',
} as const;

/** CPT — servicios que sí tienen respuesta real de elegibilidad. */
export const CPT = {
  /** Psychotherapy, 45 minutes. El objetivo del coverage check. */
  psychotherapy45: '90834',
  psychotherapy30: '90832',
  officeVisitEstablished: '99213',
} as const;

export const RXNORM = {
  sertraline50mg: '312938',
} as const;

/* ------------------------------------------------------------------ */
/* Sistemas de terminología                                            */
/* ------------------------------------------------------------------ */

export const SYSTEMS = {
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  cpt: 'http://www.ama-assn.org/go/cpt',
} as const;

/* ------------------------------------------------------------------ */
/* Presupuestos de latencia                                            */
/* ------------------------------------------------------------------ */

/**
 * Hay una llamada de voz en curso. Cada uno de estos timeouts existe para
 * que la conversación nunca se quede colgada esperando a un servicio.
 */
export const TIMEOUTS_MS = {
  /** voice/ → core/ para traer el contexto del paciente. */
  contextFetch: 2_000,
  /** voice/ → coverage/ a mitad de llamada. */
  coverageCheck: 3_000,
  /** coverage/ → Stedi. Debe ser menor que coverageCheck. */
  stediUpstream: 2_500,
  /** voice/ → core/ al escribir el episodio (no bloquea al paciente). */
  episodeWriteback: 5_000,
} as const;

/* ------------------------------------------------------------------ */
/* Tipos de servicio para el coverage check                            */
/* ------------------------------------------------------------------ */

/**
 * Apuntados a servicios con respuesta REAL de elegibilidad.
 * Deliberadamente no hay suplementos: los seguros no los cubren y la
 * respuesta ("not covered") no ayuda a nadie.
 */
export const COVERAGE_SERVICE_TYPES = [
  'telehealth-mental-health',
  'outpatient-mental-health',
  'prescription-drug',
] as const;

export type CoverageServiceType = (typeof COVERAGE_SERVICE_TYPES)[number];

/**
 * Mapeo a los service type codes de la X12 270 (EB01/EQ01).
 * `A4` = Psychiatric, `MH` = Mental Health, `88` = Pharmacy.
 */
export const X12_SERVICE_TYPE_CODES: Record<CoverageServiceType, string> = {
  'telehealth-mental-health': 'A4',
  'outpatient-mental-health': 'MH',
  'prescription-drug': '88',
};
