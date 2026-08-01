/**
 * =============================================================================
 *  ARCHIVO PROVISIONAL — escrito por Lewis (loop-voice), NO por Kiwis.
 *  Mismo criterio que `shared/contracts.ts`: cuando Kiwis publique el suyo,
 *  se hace diff y gana el de Kiwis.
 *
 *  Constantes compartidas por los tres servicios de Loop.
 *  Aqui NO van secretos. Nunca. Los secretos viven en el `.env` de la raiz.
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// Puertos (seccion 3 de los briefs)
// -----------------------------------------------------------------------------

export const PORTS = {
  /** loop-dashboard (Carlos) */
  dashboard: 3000,
  /** loop-core (Kiwis) — FHIR + Medplum */
  core: 3001,
  /** loop-voice (Lewis) — agente de voz + motor de seguridad */
  voice: 3002,
  /** loop-coverage (Carlos) — Stedi */
  coverage: 3003,
} as const;

export const DEFAULT_CORE_URL = `http://localhost:${PORTS.core}`;
export const DEFAULT_VOICE_URL = `http://localhost:${PORTS.voice}`;
export const DEFAULT_COVERAGE_URL = `http://localhost:${PORTS.coverage}`;
export const DEFAULT_DASHBOARD_URL = `http://localhost:${PORTS.dashboard}`;

// -----------------------------------------------------------------------------
// IDs fijos del demo
// -----------------------------------------------------------------------------

export const LOOP_PATIENT_ID = 'loop-demo-patient-001';
export const LOOP_PRACTITIONER_ID = 'loop-demo-clinician-001';
export const LOOP_CAREPLAN_ID = 'loop-demo-careplan-001';

// -----------------------------------------------------------------------------
// Codigos clinicos usados en el demo
// -----------------------------------------------------------------------------

/** LOINC — las cuatro metricas que publica el wearable. */
export const LOINC = {
  /** Heart rate */
  heartRate: '8867-4',
  /** Respiratory rate */
  respiratoryRate: '9279-1',
  /** Heart rate variability (SDNN) */
  hrv: '80404-7',
  /** Sleep duration */
  sleepHours: '93832-4',
} as const;

/** Sistemas de codificacion. */
export const CODE_SYSTEMS = {
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  cpt: 'http://www.ama-assn.org/go/cpt',
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
} as const;

/** SNOMED CT — Anxiety disorder. Condicion activa del paciente del demo. */
export const SNOMED_ANXIETY_DISORDER = '197480006';

/** CPT — Psicoterapia, 45 minutos. Es lo que se verifica en el coverage check. */
export const CPT_PSYCHOTHERAPY_45MIN = '90834';

/** Tipo de servicio que loop-voice manda a loop-coverage. */
export const SERVICE_TYPE_TELEHEALTH_MENTAL_HEALTH = 'telehealth-mental-health';

// -----------------------------------------------------------------------------
// Rutas de API (para no escribir strings sueltos en cada cliente)
// -----------------------------------------------------------------------------

export const API_PATHS = {
  core: {
    context: (patientId: string) => `/api/v1/context/${patientId}`,
    episodes: '/api/v1/episodes',
    summary: (patientId: string) => `/api/v1/patients/${patientId}/summary`,
    observations: (patientId: string) => `/api/v1/patients/${patientId}/observations`,
    episodesByPatient: (patientId: string) => `/api/v1/patients/${patientId}/episodes`,
    outcomes: (patientId: string) => `/api/v1/patients/${patientId}/outcomes`,
    demoSpike: '/api/v1/demo/spike',
    demoReset: '/api/v1/demo/reset',
  },
  coverage: {
    check: '/api/v1/coverage/check',
  },
  voice: {
    liveStream: '/api/v1/live/stream',
    callSocket: '/api/v1/call/socket',
    health: '/healthz',
  },
} as const;

// -----------------------------------------------------------------------------
// Perfiles de demo (Contrato 6)
// -----------------------------------------------------------------------------

export const DEMO_PROFILES = ['panic', 'cardiac-redflag', 'calm'] as const;

/** Nombres de los fixtures compartidos, para no escribirlos a mano. */
export const FIXTURES = {
  contextHappy: 'context.happy.json',
  contextRedflag: 'context.redflag.json',
  coverageCovered: 'coverage.covered.json',
  coverageUnknown: 'coverage.unknown.json',
  episodeSample: 'episode.sample.json',
  outcomesSample: 'outcomes.sample.json',
} as const;
