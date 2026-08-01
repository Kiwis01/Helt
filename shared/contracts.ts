/**
 * Loop — contratos de integración entre las tres plataformas.
 *
 * ESTE ARCHIVO ES LA FUENTE ÚNICA DE VERDAD.
 * Congelado en T0. Cambios: mensaje al grupo → PR → los tres hacen pull.
 *
 *   Contrato 1  Patient Context    core(:3001)     → voice(:3002)
 *   Contrato 2  Episode write-back voice(:3002)    → core(:3001)
 *   Contrato 3  Coverage check     coverage(:3003) ← voice(:3002), core bot
 *   Contrato 4  Dashboard reads    core(:3001)     → dashboard(:3000)
 *   Contrato 5  Live event stream  voice(:3002)    → dashboard(:3000)
 *   Contrato 6  Demo control       core(:3001)     ← dashboard(:3000)
 *
 * Cada esquema zod es a la vez validador en runtime y tipo en compile time.
 * Los servicios DEBEN validar sus respuestas contra estos esquemas.
 */

import { z } from 'zod';

/* ================================================================== */
/* Primitivas                                                          */
/* ================================================================== */

/** ISO-8601. Acepta tanto `...Z` como offsets `...+02:00`. */
export const IsoDateTime = z.string().datetime({ offset: true });

export const Trend = z.enum(['rising', 'falling', 'stable']);
export type Trend = z.infer<typeof Trend>;

/** Estadística de una métrica sobre la ventana de baseline (30 días). */
export const BaselineMetric = z.object({
  mean: z.number(),
  sd: z.number(),
  unit: z.string(),
});
export type BaselineMetric = z.infer<typeof BaselineMetric>;

/** Estado de una métrica en la ventana reciente (por defecto 30 min). */
export const CurrentMetric = z.object({
  latest: z.number(),
  max: z.number().optional(),
  min: z.number().optional(),
  trend: Trend,
  unit: z.string(),
});
export type CurrentMetric = z.infer<typeof CurrentMetric>;

/** Cuánto se aleja el valor actual del baseline personal del paciente. */
export const MetricDelta = z.object({
  absolute: z.number(),
  /** Desviaciones estándar respecto al baseline. El número que hace sonar
   *  inteligente al agente de voz: "8 desviaciones por encima de tu normal". */
  sdFromBaseline: z.number(),
});
export type MetricDelta = z.infer<typeof MetricDelta>;

/* ================================================================== */
/* Envelope de seguridad                                               */
/* ================================================================== */

/**
 * Umbrales biométricos publicados por core/ y evaluados por voice/.
 *
 * Vive en el contexto (no hardcodeado en voice/) para que sea dato clínico
 * versionado en FHIR y no una constante escondida en el código del agente.
 *
 * voice/ DEBE evaluarlos de forma determinista ANTES de invocar al LLM.
 */
export const SafetyEnvelope = z.object({
  heartRateMax: z.number(),
  heartRateMin: z.number(),
  respiratoryRateMax: z.number(),
  spo2Min: z.number(),
  note: z.string(),
});
export type SafetyEnvelope = z.infer<typeof SafetyEnvelope>;

/* ================================================================== */
/* Care plan                                                           */
/* ================================================================== */

export const CarePlanActivityType = z.enum([
  'breathing',
  'grounding',
  'cognitive',
  'physical',
  'escalation-soft',
]);
export type CarePlanActivityType = z.infer<typeof CarePlanActivityType>;

/**
 * Un ítem del plan con costo asociado. Su presencia es lo que dispara el
 * coverage check desde la conversación.
 */
export const CostItem = z.object({
  serviceType: z.string(),
  cptCode: z.string(),
});
export type CostItem = z.infer<typeof CostItem>;

export const CarePlanActivity = z.object({
  id: z.string(),
  order: z.number().int(),
  type: CarePlanActivityType,
  title: z.string(),
  instruction: z.string(),
  durationMinutes: z.number().optional(),
  /** Texto que el agente lee tal cual para guiar la intervención. */
  voiceScript: z.string().optional(),
  costItem: CostItem.optional(),
});
export type CarePlanActivity = z.infer<typeof CarePlanActivity>;

export const CarePlan = z.object({
  id: z.string(),
  authoredBy: z.string(),
  lastUpdated: z.string(),
  activities: z.array(CarePlanActivity),
});
export type CarePlan = z.infer<typeof CarePlan>;

/* ================================================================== */
/* Historia clínica                                                    */
/* ================================================================== */

export const PatientCondition = z.object({
  code: z.string(),
  system: z.string(),
  display: z.string(),
  onsetDate: z.string(),
  clinicalStatus: z.enum(['active', 'remission', 'resolved']),
});
export type PatientCondition = z.infer<typeof PatientCondition>;

export const PatientMedication = z.object({
  display: z.string(),
  status: z.enum(['active', 'stopped', 'on-hold']),
  rxnorm: z.string(),
  coverageCheckable: z.boolean(),
});
export type PatientMedication = z.infer<typeof PatientMedication>;

export const EpisodeResolution = z.enum([
  'self-resolved',
  'resolved-with-intervention',
  'escalated-emergency',
  'escalated-human',
  'abandoned',
]);
export type EpisodeResolution = z.infer<typeof EpisodeResolution>;

/** Resumen de un episodio previo. Aparece en el contexto y en el dashboard. */
export const RecentEpisode = z.object({
  encounterId: z.string(),
  startedAt: IsoDateTime,
  durationMinutes: z.number(),
  peakHeartRate: z.number(),
  interventions: z.array(z.string()),
  resolution: EpisodeResolution,
  severitySelfReported: z.number().min(0).max(10).nullable(),
});
export type RecentEpisode = z.infer<typeof RecentEpisode>;

/* ================================================================== */
/* CONTRATO 1 — Patient Context                                        */
/* core(:3001) → voice(:3002)                                          */
/* GET /api/v1/context/:patientId?window=30m                           */
/* ================================================================== */

export const CurrentBiometrics = z.object({
  windowMinutes: z.number(),
  heartRate: CurrentMetric,
  hrv: CurrentMetric,
  respiratoryRate: CurrentMetric,
  spo2: CurrentMetric.optional(),
  lastSampleAt: IsoDateTime,
});
export type CurrentBiometrics = z.infer<typeof CurrentBiometrics>;

export const PatientContext = z.object({
  patientId: z.string(),
  displayName: z.string(),
  age: z.number().int(),
  generatedAt: IsoDateTime,
  baseline: z.object({
    heartRate: BaselineMetric,
    hrv: BaselineMetric,
    respiratoryRate: BaselineMetric,
    sleepHours: BaselineMetric,
  }),
  current: CurrentBiometrics,
  deltas: z.object({
    heartRate: MetricDelta,
    hrv: MetricDelta,
    respiratoryRate: MetricDelta.optional(),
  }),
  conditions: z.array(PatientCondition),
  carePlan: CarePlan,
  recentEpisodes: z.array(RecentEpisode),
  medications: z.array(PatientMedication),
  safetyEnvelope: SafetyEnvelope,
});
export type PatientContext = z.infer<typeof PatientContext>;

/* ================================================================== */
/* CONTRATO 2 — Episode write-back                                     */
/* voice(:3002) → core(:3001)                                          */
/* POST /api/v1/episodes                                               */
/* ================================================================== */

export const EscalationAction = z.enum([
  'advise-911',
  'advise-988',
  'connect-human',
]);
export type EscalationAction = z.infer<typeof EscalationAction>;

export const EpisodeEscalation = z.object({
  triggered: z.boolean(),
  /** ID de la regla determinista que disparó, ej. RF-01-CHEST-PAIN-RADIATING. */
  rule: z.string().nullable(),
  triggeredAt: IsoDateTime.nullable(),
  action: EscalationAction.nullable(),
});
export type EpisodeEscalation = z.infer<typeof EpisodeEscalation>;

export const InterventionAttempt = z.object({
  carePlanActivityId: z.string(),
  startedAt: IsoDateTime,
  completed: z.boolean(),
  /** 0–10 reportado por el paciente. Alimenta el gráfico de outcomes. */
  patientReportedRelief: z.number().min(0).max(10).nullable(),
});
export type InterventionAttempt = z.infer<typeof InterventionAttempt>;

export const BiometricsSnapshot = z.object({
  peakHeartRate: z.number(),
  minHrv: z.number(),
  peakRespiratoryRate: z.number(),
});
export type BiometricsSnapshot = z.infer<typeof BiometricsSnapshot>;

export const TranscriptTurn = z.object({
  speaker: z.enum(['patient', 'agent', 'system']),
  at: IsoDateTime,
  text: z.string(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurn>;

export const Transcript = z.object({
  /** Debe ser true antes de persistir. Deepgram hace la redacción de PII. */
  redacted: z.boolean(),
  turns: z.array(TranscriptTurn),
});
export type Transcript = z.infer<typeof Transcript>;

/** Resumen de un coverage check, embebido en el episodio. */
export const EpisodeCoverageCheck = z.object({
  checkId: z.string(),
  serviceType: z.string(),
  result: z.string(),
  copayCents: z.number().nullable(),
});
export type EpisodeCoverageCheck = z.infer<typeof EpisodeCoverageCheck>;

export const EpisodeWriteRequest = z.object({
  patientId: z.string(),
  callId: z.string(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  outcome: EpisodeResolution,
  escalation: EpisodeEscalation,
  severitySelfReported: z.number().min(0).max(10).nullable(),
  interventionsAttempted: z.array(InterventionAttempt),
  biometricsSnapshot: BiometricsSnapshot,
  transcript: Transcript,
  coverageChecks: z.array(EpisodeCoverageCheck),
});
export type EpisodeWriteRequest = z.infer<typeof EpisodeWriteRequest>;

export const EpisodeWriteResponse = z.object({
  encounterId: z.string(),
  medplumUrl: z.string(),
});
export type EpisodeWriteResponse = z.infer<typeof EpisodeWriteResponse>;

/* ================================================================== */
/* CONTRATO 3 — Coverage check                                         */
/* coverage(:3003) ← voice(:3002), core bot                            */
/* POST /api/v1/coverage/check                                         */
/* ================================================================== */

export const CoverageStatus = z.enum([
  'covered',
  'not-covered',
  'needs-auth',
  'unknown',
]);
export type CoverageStatus = z.infer<typeof CoverageStatus>;

export const CoverageCheckRequest = z.object({
  patientId: z.string(),
  serviceType: z.string(),
  cptCode: z.string(),
  requestedBy: z.enum(['voice-agent', 'medplum-bot', 'dashboard']),
  callId: z.string().nullable().optional(),
});
export type CoverageCheckRequest = z.infer<typeof CoverageCheckRequest>;

export const Deductible = z.object({
  individualCents: z.number(),
  metCents: z.number(),
  remainingCents: z.number(),
});
export type Deductible = z.infer<typeof Deductible>;

export const CoverageCheckResponse = z.object({
  checkId: z.string(),
  checkedAt: IsoDateTime,
  status: CoverageStatus,
  payerName: z.string(),
  planName: z.string().nullable(),
  copayCents: z.number().nullable(),
  coinsurancePercent: z.number().nullable(),
  deductible: Deductible.nullable(),
  priorAuthRequired: z.boolean().nullable(),
  raw271Id: z.string().nullable(),
  /**
   * CRÍTICO: voice/ lee este campo LITERAL, sin pasarlo por el LLM.
   * Generado por plantilla determinista en coverage/. Nunca por un modelo.
   * Si un dato no se conoce con certeza, la frase lo dice — no lo inventa.
   */
  voiceSummary: z.string(),
  latencyMs: z.number(),
});
export type CoverageCheckResponse = z.infer<typeof CoverageCheckResponse>;

/* ================================================================== */
/* CONTRATO 4 — Lecturas del dashboard                                 */
/* core(:3001) → dashboard(:3000)                                      */
/* ================================================================== */

/** GET /api/v1/patients/:id/summary */
export const PatientSummary = z.object({
  patientId: z.string(),
  displayName: z.string(),
  age: z.number().int(),
  gender: z.string().nullable(),
  conditions: z.array(PatientCondition),
  medications: z.array(PatientMedication),
  carePlanAuthor: z.string(),
  carePlanLastUpdated: z.string(),
  baseline: z.object({
    heartRate: BaselineMetric,
    hrv: BaselineMetric,
    respiratoryRate: BaselineMetric,
    sleepHours: BaselineMetric,
  }),
  episodeCount: z.number().int(),
  lastEpisodeAt: IsoDateTime.nullable(),
});
export type PatientSummary = z.infer<typeof PatientSummary>;

export const ObservationMetric = z.enum([
  'heartRate',
  'hrv',
  'respiratoryRate',
  'sleepHours',
]);
export type ObservationMetric = z.infer<typeof ObservationMetric>;

export const ObservationPoint = z.object({
  t: IsoDateTime,
  v: z.number(),
});
export type ObservationPoint = z.infer<typeof ObservationPoint>;

/** GET /api/v1/patients/:id/observations?metric=&from=&to=&bucket= */
export const ObservationSeries = z.object({
  metric: ObservationMetric,
  unit: z.string(),
  bucket: z.string(),
  baseline: BaselineMetric,
  points: z.array(ObservationPoint),
});
export type ObservationSeries = z.infer<typeof ObservationSeries>;

/** GET /api/v1/patients/:id/episodes */
export const EpisodeListItem = z.object({
  encounterId: z.string(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationMinutes: z.number(),
  outcome: EpisodeResolution,
  peakHeartRate: z.number(),
  minHrv: z.number().nullable(),
  severitySelfReported: z.number().min(0).max(10).nullable(),
  interventions: z.array(
    z.object({
      carePlanActivityId: z.string(),
      title: z.string(),
      completed: z.boolean(),
      patientReportedRelief: z.number().min(0).max(10).nullable(),
    }),
  ),
  escalation: EpisodeEscalation,
});
export type EpisodeListItem = z.infer<typeof EpisodeListItem>;

export const EpisodeList = z.object({
  patientId: z.string(),
  episodes: z.array(EpisodeListItem),
});
export type EpisodeList = z.infer<typeof EpisodeList>;

/**
 * GET /api/v1/patients/:id/outcomes
 *
 * El loop cerrado: intervención → resultado medido.
 * Es la última visualización que ven los jueces.
 */
export const InterventionOutcome = z.object({
  carePlanActivityId: z.string(),
  title: z.string(),
  timesAttempted: z.number().int(),
  avgEpisodeDurationMinutes: z.number(),
  avgReliefScore: z.number(),
});
export type InterventionOutcome = z.infer<typeof InterventionOutcome>;

export const WeeklyEpisodeCount = z.object({
  weekStart: z.string(),
  count: z.number().int(),
});
export type WeeklyEpisodeCount = z.infer<typeof WeeklyEpisodeCount>;

export const OutcomesSummary = z.object({
  byIntervention: z.array(InterventionOutcome),
  /** La línea de referencia: cuánto dura un episodio sin intervención. */
  baselineNoInterventionAvgDurationMinutes: z.number(),
  episodeCountByWeek: z.array(WeeklyEpisodeCount),
});
export type OutcomesSummary = z.infer<typeof OutcomesSummary>;

/* ================================================================== */
/* CONTRATO 5 — Live event stream (SSE)                                */
/* voice(:3002) → dashboard(:3000)                                     */
/* GET /api/v1/live/stream                                             */
/* ================================================================== */

export const LiveEventName = z.enum([
  'call.started',
  'transcript.turn',
  'biometrics.tick',
  'safety.escalation',
  'coverage.check',
  'call.ended',
  'episode.written',
]);
export type LiveEventName = z.infer<typeof LiveEventName>;

export const CallStartedEvent = z.object({
  callId: z.string(),
  patientId: z.string(),
  at: IsoDateTime,
});
export type CallStartedEvent = z.infer<typeof CallStartedEvent>;

export const TranscriptTurnEvent = z.object({
  callId: z.string(),
  speaker: z.enum(['patient', 'agent', 'system']),
  text: z.string(),
  at: IsoDateTime,
});
export type TranscriptTurnEvent = z.infer<typeof TranscriptTurnEvent>;

export const BiometricsTickEvent = z.object({
  callId: z.string(),
  heartRate: z.number(),
  hrv: z.number(),
  respiratoryRate: z.number(),
  at: IsoDateTime,
});
export type BiometricsTickEvent = z.infer<typeof BiometricsTickEvent>;

export const SafetyEscalationEvent = z.object({
  callId: z.string(),
  /** El dashboard muestra este ID. Los jueces quieren ver que fue una regla. */
  rule: z.string(),
  action: EscalationAction,
  at: IsoDateTime,
});
export type SafetyEscalationEvent = z.infer<typeof SafetyEscalationEvent>;

export const CoverageCheckEvent = z.object({
  callId: z.string(),
  checkId: z.string(),
  status: CoverageStatus,
  copayCents: z.number().nullable(),
  deductibleRemainingCents: z.number().nullable().optional(),
  payerName: z.string().optional(),
  voiceSummary: z.string().optional(),
  at: IsoDateTime,
});
export type CoverageCheckEvent = z.infer<typeof CoverageCheckEvent>;

export const CallEndedEvent = z.object({
  callId: z.string(),
  outcome: EpisodeResolution,
  durationSeconds: z.number(),
  at: IsoDateTime,
});
export type CallEndedEvent = z.infer<typeof CallEndedEvent>;

export const EpisodeWrittenEvent = z.object({
  callId: z.string(),
  encounterId: z.string(),
  at: IsoDateTime,
});
export type EpisodeWrittenEvent = z.infer<typeof EpisodeWrittenEvent>;

/** Unión discriminada de todos los eventos del stream. */
export const LiveEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('call.started'), data: CallStartedEvent }),
  z.object({ event: z.literal('transcript.turn'), data: TranscriptTurnEvent }),
  z.object({ event: z.literal('biometrics.tick'), data: BiometricsTickEvent }),
  z.object({ event: z.literal('safety.escalation'), data: SafetyEscalationEvent }),
  z.object({ event: z.literal('coverage.check'), data: CoverageCheckEvent }),
  z.object({ event: z.literal('call.ended'), data: CallEndedEvent }),
  z.object({ event: z.literal('episode.written'), data: EpisodeWrittenEvent }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/* ================================================================== */
/* CONTRATO 6 — Control de demo                                        */
/* core(:3001) ← dashboard(:3000)                                      */
/* ================================================================== */

export const DemoProfile = z.enum(['panic', 'cardiac-redflag', 'calm']);
export type DemoProfile = z.infer<typeof DemoProfile>;

export const DemoSpikeRequest = z.object({
  patientId: z.string(),
  profile: DemoProfile,
});
export type DemoSpikeRequest = z.infer<typeof DemoSpikeRequest>;

export const DemoSpikeResponse = z.object({
  ok: z.boolean(),
  profile: DemoProfile,
  appliedAt: IsoDateTime,
  message: z.string(),
});
export type DemoSpikeResponse = z.infer<typeof DemoSpikeResponse>;

export const DemoResetResponse = z.object({
  ok: z.boolean(),
  resetAt: IsoDateTime,
  message: z.string(),
});
export type DemoResetResponse = z.infer<typeof DemoResetResponse>;

/* ================================================================== */
/* Errores                                                             */
/* ================================================================== */

/**
 * Forma de error compartida. Cualquier servicio que devuelva !2xx usa esto.
 *
 * coverage/ es la excepción deliberada: NUNCA devuelve !2xx, porque hay una
 * llamada de voz en curso. Degrada a status="unknown" con HTTP 200.
 */
export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  detail: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/* ================================================================== */
/* Health                                                              */
/* ================================================================== */

export const HealthResponse = z.object({
  service: z.enum(['loop-core', 'loop-voice', 'loop-coverage', 'loop-dashboard']),
  ok: z.boolean(),
  useMocks: z.boolean(),
  uptimeSeconds: z.number(),
  version: z.string(),
  /** Estado de las dependencias upstream, si aplica. */
  upstream: z.record(z.string(), z.enum(['ok', 'degraded', 'down', 'not-configured'])).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
