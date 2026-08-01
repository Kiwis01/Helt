/**
 * =============================================================================
 *  ARCHIVO PROVISIONAL — escrito por Lewis (loop-voice), NO por Kiwis.
 * =============================================================================
 *
 *  Segun el reparto original, `shared/contracts.ts` lo publica Kiwis en T0.
 *  A la hora de arrancar loop-voice ese archivo todavia no existia, asi que
 *  este es una transcripcion literal de la SECCION 4 ("Contratos de
 *  integracion") del brief `plandevs/02-LEWIS-voice-safety.md`, que es
 *  identica en los tres briefs.
 *
 *  CUANDO KIWIS PUBLIQUE EL SUYO:
 *    1. `git diff` entre ambos archivos.
 *    2. Gana el de Kiwis (el es el owner del contrato).
 *    3. Se revisa que los tipos internos de voice/ (voice/src/types.ts) sigan
 *       compilando y se avisa en el grupo.
 *
 *  Convenciones de este archivo:
 *    - Los TIPOS estan declarados a mano y son la referencia exacta del brief.
 *    - Los ESQUEMAS zod son deliberadamente mas permisivos en los campos
 *      "string-union abiertos" (trend, activity.type, clinicalStatus) para que
 *      un valor inesperado de otro servicio NUNCA tire la llamada. Regla de oro
 *      de loop-voice: la llamada nunca se cae.
 *    - Todas las marcas de tiempo son ISO-8601 en UTC (string).
 *
 *  NADA en este archivo hace I/O. Es solo tipos + validacion.
 * =============================================================================
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Utilidades internas
// -----------------------------------------------------------------------------

/** Comprobacion en tiempo de compilacion: `A` debe ser asignable a `B`. */
type AssertExtends<A extends B, B> = A;

// =============================================================================
// CONTRATO 1 — Patient Context
// GET http://localhost:3001/api/v1/context/:patientId?window=30m
// sirve Kiwis -> consume Lewis
// =============================================================================

/** Tendencia de una metrica dentro de la ventana observada. */
export type MetricTrend = 'rising' | 'falling' | 'stable';

/** Estadistico de baseline de una metrica (media historica del wearable). */
export interface BaselineMetric {
  mean: number;
  sd: number;
  unit: string;
}

/** Baseline completo del paciente. */
export interface Baseline {
  heartRate: BaselineMetric;
  hrv: BaselineMetric;
  respiratoryRate: BaselineMetric;
  sleepHours: BaselineMetric;
}

/** Lectura actual de una metrica que sube cuando el paciente se activa. */
export interface CurrentMetricRising {
  latest: number;
  max: number;
  trend: MetricTrend;
  unit: string;
}

/** Lectura actual de una metrica que baja cuando el paciente se activa. */
export interface CurrentMetricFalling {
  latest: number;
  min: number;
  trend: MetricTrend;
  unit: string;
}

/**
 * Biometria de la ventana reciente. Es la entrada del motor de red-flags
 * junto con el `SafetyEnvelope`.
 *
 * `spo2` es OPCIONAL: el brief lo menciona en el safetyEnvelope (spo2Min) pero
 * el wearable del demo no lo publica. La regla RF-08 debe saltarse la
 * comprobacion de SpO2 cuando el campo no viene.
 */
export interface CurrentBiometrics {
  windowMinutes: number;
  heartRate: CurrentMetricRising;
  hrv: CurrentMetricFalling;
  respiratoryRate: CurrentMetricRising;
  spo2?: CurrentMetricFalling;
  lastSampleAt: string;
}

/** Diferencia de una metrica respecto a su baseline. */
export interface Delta {
  absolute: number;
  sdFromBaseline: number;
}

/** Deltas calculados por loop-core. Solo heartRate y hrv son obligatorios. */
export interface Deltas {
  heartRate: Delta;
  hrv: Delta;
  respiratoryRate?: Delta;
}

/** Condicion clinica activa del paciente (SNOMED). */
export interface ConditionRef {
  code: string;
  system: string;
  display: string;
  onsetDate: string;
  clinicalStatus: 'active' | 'recurrence' | 'remission' | 'resolved' | (string & {});
}

/** Item de costo asociado a una actividad del plan; dispara el coverage check. */
export interface CostItem {
  serviceType: string;
  cptCode: string;
}

/** Tipo de actividad del care plan. Union abierta a proposito. */
export type CarePlanActivityType = 'breathing' | 'grounding' | 'escalation-soft' | (string & {});

/**
 * Actividad del plan de cuidado escrita por el clinico.
 *
 * Convencion de `voiceScript` (acordada por loop-voice): las FASES locutables
 * van separadas por `\n`. El orquestador habla una linea, espera el timing
 * indicado y pasa a la siguiente. Un `voiceScript` de una sola linea se locuta
 * de corrido.
 */
export interface CarePlanActivity {
  id: string;
  order: number;
  type: CarePlanActivityType;
  title: string;
  instruction: string;
  durationMinutes?: number;
  voiceScript?: string;
  costItem?: CostItem;
}

/** Plan de cuidado del paciente. */
export interface CarePlan {
  id: string;
  authoredBy: string;
  lastUpdated: string;
  activities: CarePlanActivity[];
}

/** Episodio anterior resumido (para dar continuidad en la conversacion). */
export interface RecentEpisode {
  encounterId: string;
  startedAt: string;
  durationMinutes: number;
  peakHeartRate: number;
  interventions: string[];
  resolution: string;
  severitySelfReported: number | null;
}

/** Medicacion activa. loop-voice NUNCA recomienda ni ajusta medicacion. */
export interface MedicationRef {
  display: string;
  status: string;
  rxnorm: string;
  coverageCheckable: boolean;
}

/**
 * Limites biometricos duros. Salirse de aqui DEBE disparar escalacion
 * determinista ANTES de cualquier llamada al LLM (regla RF-08).
 */
export interface SafetyEnvelope {
  heartRateMax: number;
  heartRateMin: number;
  respiratoryRateMax: number;
  spo2Min: number;
  note?: string;
}

/** Contrato 1 completo. Es lo unico que loop-voice necesita para conversar. */
export interface PatientContext {
  patientId: string;
  displayName: string;
  age: number;
  generatedAt: string;
  baseline: Baseline;
  current: CurrentBiometrics;
  deltas: Deltas;
  conditions: ConditionRef[];
  carePlan: CarePlan;
  recentEpisodes: RecentEpisode[];
  medications: MedicationRef[];
  safetyEnvelope: SafetyEnvelope;
}

// --- esquemas zod -------------------------------------------------------------

export const baselineMetricSchema = z.object({
  mean: z.number(),
  sd: z.number(),
  unit: z.string(),
});

export const baselineSchema = z.object({
  heartRate: baselineMetricSchema,
  hrv: baselineMetricSchema,
  respiratoryRate: baselineMetricSchema,
  sleepHours: baselineMetricSchema,
});

const currentMetricRisingSchema = z.object({
  latest: z.number(),
  max: z.number(),
  // union abierta a proposito: un "steady" inesperado no debe tirar la llamada
  trend: z.string(),
  unit: z.string(),
});

const currentMetricFallingSchema = z.object({
  latest: z.number(),
  min: z.number(),
  trend: z.string(),
  unit: z.string(),
});

export const currentBiometricsSchema = z.object({
  windowMinutes: z.number(),
  heartRate: currentMetricRisingSchema,
  hrv: currentMetricFallingSchema,
  respiratoryRate: currentMetricRisingSchema,
  spo2: currentMetricFallingSchema.optional(),
  lastSampleAt: z.string(),
});

const deltaSchema = z.object({
  absolute: z.number(),
  sdFromBaseline: z.number(),
});

export const deltasSchema = z.object({
  heartRate: deltaSchema,
  hrv: deltaSchema,
  respiratoryRate: deltaSchema.optional(),
});

export const conditionRefSchema = z.object({
  code: z.string(),
  system: z.string(),
  display: z.string(),
  onsetDate: z.string(),
  clinicalStatus: z.string(),
});

export const costItemSchema = z.object({
  serviceType: z.string(),
  cptCode: z.string(),
});

export const carePlanActivitySchema = z.object({
  id: z.string(),
  order: z.number(),
  type: z.string(),
  title: z.string(),
  instruction: z.string(),
  durationMinutes: z.number().optional(),
  voiceScript: z.string().optional(),
  costItem: costItemSchema.optional(),
});

export const carePlanSchema = z.object({
  id: z.string(),
  authoredBy: z.string(),
  lastUpdated: z.string(),
  activities: z.array(carePlanActivitySchema),
});

export const recentEpisodeSchema = z.object({
  encounterId: z.string(),
  startedAt: z.string(),
  durationMinutes: z.number(),
  peakHeartRate: z.number(),
  interventions: z.array(z.string()),
  resolution: z.string(),
  severitySelfReported: z.number().nullable(),
});

export const medicationRefSchema = z.object({
  display: z.string(),
  status: z.string(),
  rxnorm: z.string(),
  coverageCheckable: z.boolean(),
});

export const safetyEnvelopeSchema = z.object({
  heartRateMax: z.number(),
  heartRateMin: z.number(),
  respiratoryRateMax: z.number(),
  spo2Min: z.number(),
  note: z.string().optional(),
});

export const patientContextSchema = z.object({
  patientId: z.string(),
  displayName: z.string(),
  age: z.number(),
  generatedAt: z.string(),
  baseline: baselineSchema,
  current: currentBiometricsSchema,
  deltas: deltasSchema,
  conditions: z.array(conditionRefSchema),
  carePlan: carePlanSchema,
  recentEpisodes: z.array(recentEpisodeSchema),
  medications: z.array(medicationRefSchema),
  safetyEnvelope: safetyEnvelopeSchema,
});

type _CheckPatientContext = AssertExtends<PatientContext, z.infer<typeof patientContextSchema>>;

/** Valida y devuelve un PatientContext. Lanza si el payload es invalido. */
export function parsePatientContext(raw: unknown): PatientContext {
  return patientContextSchema.parse(raw) as PatientContext;
}

// =============================================================================
// CONTRATO 2 — Episode write-back
// POST http://localhost:3001/api/v1/episodes
// llama Lewis -> sirve Kiwis
// =============================================================================

/** Como termino el episodio. Lo decide el orquestador de loop-voice. */
export type EpisodeOutcome =
  | 'resolved-with-intervention'
  | 'self-resolved'
  | 'escalated-emergency'
  | 'escalated-human'
  | 'abandoned';

/** Accion determinista tomada por el motor de red-flags. */
export type EscalationAction = 'advise-911' | 'advise-988' | 'connect-human';

/** Info de escalacion. `rule` es el ID exacto de la regla (p.ej. RF-01-...). */
export interface EscalationInfo {
  triggered: boolean;
  rule: string | null;
  triggeredAt: string | null;
  action: EscalationAction | null;
}

/** Intento de una actividad del care plan durante la llamada. */
export interface InterventionAttempt {
  carePlanActivityId: string;
  startedAt: string;
  completed: boolean;
  patientReportedRelief: number | null;
}

/**
 * Extremos biometricos observados durante la llamada.
 * Nullable: una llamada puede terminar antes de recibir un solo tick.
 */
export interface BiometricsSnapshot {
  peakHeartRate: number | null;
  minHrv: number | null;
  peakRespiratoryRate: number | null;
}

/** Un turno del transcript. */
export interface TranscriptTurn {
  speaker: 'patient' | 'agent';
  at: string;
  text: string;
}

/** Transcript completo. `redacted` DEBE ser true antes de persistir. */
export interface TranscriptBlock {
  redacted: boolean;
  turns: TranscriptTurn[];
}

/** Eco resumido de un coverage check hecho durante la llamada. */
export interface CoverageCheckEcho {
  checkId: string;
  serviceType: string;
  result: CoverageStatus;
  copayCents: number | null;
}

/** Contrato 2 completo. */
export interface EpisodeWriteback {
  patientId: string;
  callId: string;
  startedAt: string;
  endedAt: string;
  outcome: EpisodeOutcome;
  escalation: EscalationInfo;
  severitySelfReported: number | null;
  interventionsAttempted: InterventionAttempt[];
  biometricsSnapshot: BiometricsSnapshot;
  transcript: TranscriptBlock;
  coverageChecks: CoverageCheckEcho[];
}

/** Respuesta 201 de POST /api/v1/episodes. */
export interface EpisodeWritebackResponse {
  encounterId: string;
  medplumUrl: string;
}

// --- esquemas zod -------------------------------------------------------------

export const episodeOutcomeSchema = z.enum([
  'resolved-with-intervention',
  'self-resolved',
  'escalated-emergency',
  'escalated-human',
  'abandoned',
]);

export const escalationInfoSchema = z.object({
  triggered: z.boolean(),
  rule: z.string().nullable(),
  triggeredAt: z.string().nullable(),
  action: z.string().nullable(),
});

export const interventionAttemptSchema = z.object({
  carePlanActivityId: z.string(),
  startedAt: z.string(),
  completed: z.boolean(),
  patientReportedRelief: z.number().nullable(),
});

export const biometricsSnapshotSchema = z.object({
  peakHeartRate: z.number().nullable(),
  minHrv: z.number().nullable(),
  peakRespiratoryRate: z.number().nullable(),
});

export const transcriptTurnSchema = z.object({
  speaker: z.enum(['patient', 'agent']),
  at: z.string(),
  text: z.string(),
});

export const transcriptBlockSchema = z.object({
  redacted: z.boolean(),
  turns: z.array(transcriptTurnSchema),
});

export const coverageStatusSchema = z.enum(['covered', 'not-covered', 'needs-auth', 'unknown']);

export const coverageCheckEchoSchema = z.object({
  checkId: z.string(),
  serviceType: z.string(),
  result: coverageStatusSchema,
  copayCents: z.number().nullable(),
});

export const episodeWritebackSchema = z.object({
  patientId: z.string(),
  callId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  outcome: episodeOutcomeSchema,
  escalation: escalationInfoSchema,
  severitySelfReported: z.number().nullable(),
  interventionsAttempted: z.array(interventionAttemptSchema),
  biometricsSnapshot: biometricsSnapshotSchema,
  transcript: transcriptBlockSchema,
  coverageChecks: z.array(coverageCheckEchoSchema),
});

type _CheckEpisodeWriteback = AssertExtends<EpisodeWriteback, z.infer<typeof episodeWritebackSchema>>;

export const episodeWritebackResponseSchema = z.object({
  encounterId: z.string(),
  medplumUrl: z.string(),
});

/** Valida un EpisodeWriteback antes de mandarlo a loop-core. */
export function parseEpisodeWriteback(raw: unknown): EpisodeWriteback {
  return episodeWritebackSchema.parse(raw) as EpisodeWriteback;
}

// =============================================================================
// CONTRATO 3 — Coverage check
// POST http://localhost:3003/api/v1/coverage/check
// sirve Carlos -> consume Lewis (y el Bot de Kiwis)
// =============================================================================

/** Estado de cobertura devuelto por loop-coverage. */
export type CoverageStatus = 'covered' | 'not-covered' | 'needs-auth' | 'unknown';

/** Deducible del plan, en centavos. */
export interface Deductible {
  individualCents: number;
  metCents: number;
  remainingCents: number;
}

/** Peticion de verificacion de cobertura. */
export interface CoverageCheckRequest {
  patientId: string;
  serviceType: string;
  cptCode: string;
  requestedBy: 'voice-agent' | 'core-bot' | (string & {});
  callId: string;
}

/**
 * Respuesta de verificacion de cobertura.
 *
 * `voiceSummary` es el campo critico: loop-voice lo locuta LITERAL, sin pasarlo
 * por el LLM. Cero riesgo de que el modelo invente un copago.
 */
export interface CoverageCheckResponse {
  checkId: string;
  checkedAt: string;
  status: CoverageStatus;
  payerName: string | null;
  planName: string | null;
  copayCents: number | null;
  coinsurancePercent: number | null;
  deductible: Deductible | null;
  priorAuthRequired: boolean;
  raw271Id: string | null;
  voiceSummary: string;
  latencyMs: number;
}

// --- esquemas zod -------------------------------------------------------------

export const deductibleSchema = z.object({
  individualCents: z.number(),
  metCents: z.number(),
  remainingCents: z.number(),
});

export const coverageCheckRequestSchema = z.object({
  patientId: z.string(),
  serviceType: z.string(),
  cptCode: z.string(),
  requestedBy: z.string(),
  callId: z.string(),
});

export const coverageCheckResponseSchema = z.object({
  checkId: z.string(),
  checkedAt: z.string(),
  status: coverageStatusSchema,
  payerName: z.string().nullable(),
  planName: z.string().nullable(),
  copayCents: z.number().nullable(),
  coinsurancePercent: z.number().nullable(),
  deductible: deductibleSchema.nullable(),
  priorAuthRequired: z.boolean(),
  raw271Id: z.string().nullable(),
  voiceSummary: z.string(),
  latencyMs: z.number(),
});

type _CheckCoverageResponse = AssertExtends<
  CoverageCheckResponse,
  z.infer<typeof coverageCheckResponseSchema>
>;

/** Valida una CoverageCheckResponse. El cliente debe usar safeParse, no esto. */
export function parseCoverageCheckResponse(raw: unknown): CoverageCheckResponse {
  return coverageCheckResponseSchema.parse(raw) as CoverageCheckResponse;
}

// =============================================================================
// CONTRATO 4 — Lecturas del dashboard
// sirve Kiwis -> consume Carlos. loop-voice NO las consume, pero los tipos
// viven aqui porque el archivo es la fuente unica de verdad.
// =============================================================================

/** Fila del grafico estrella: que intervencion funciona mejor. */
export interface InterventionOutcome {
  carePlanActivityId: string;
  title: string;
  timesAttempted: number;
  avgEpisodeDurationMinutes: number;
  avgReliefScore: number;
}

/** Conteo de episodios por semana. */
export interface EpisodeWeekCount {
  weekStart: string;
  count: number;
}

/** GET /api/v1/patients/:id/outcomes */
export interface OutcomesSummary {
  byIntervention: InterventionOutcome[];
  baselineNoInterventionAvgDurationMinutes: number;
  episodeCountByWeek: EpisodeWeekCount[];
}

/** Punto de una serie temporal. */
export interface ObservationPoint {
  t: string;
  v: number;
}

/** GET /api/v1/patients/:id/observations?metric=heartRate&bucket=1h */
export interface ObservationSeries {
  metric: string;
  unit: string;
  points: ObservationPoint[];
}

export const interventionOutcomeSchema = z.object({
  carePlanActivityId: z.string(),
  title: z.string(),
  timesAttempted: z.number(),
  avgEpisodeDurationMinutes: z.number(),
  avgReliefScore: z.number(),
});

export const outcomesSummarySchema = z.object({
  byIntervention: z.array(interventionOutcomeSchema),
  baselineNoInterventionAvgDurationMinutes: z.number(),
  episodeCountByWeek: z.array(z.object({ weekStart: z.string(), count: z.number() })),
});

export const observationSeriesSchema = z.object({
  metric: z.string(),
  unit: z.string(),
  points: z.array(z.object({ t: z.string(), v: z.number() })),
});

// =============================================================================
// CONTRATO 5 — Live event stream (SSE)
// GET http://localhost:3002/api/v1/live/stream
// sirve Lewis -> consume Carlos
// =============================================================================

/** Los 7 tipos de evento del stream en vivo. */
export type LiveEventType =
  | 'call.started'
  | 'transcript.turn'
  | 'biometrics.tick'
  | 'safety.escalation'
  | 'coverage.check'
  | 'call.ended'
  | 'episode.written';

export const liveEventTypeSchema = z.enum([
  'call.started',
  'transcript.turn',
  'biometrics.tick',
  'safety.escalation',
  'coverage.check',
  'call.ended',
  'episode.written',
]);

// =============================================================================
// CONTRATO 6 — Control de demo
// POST /api/v1/demo/spike · POST /api/v1/demo/reset  (sirve Kiwis)
// =============================================================================

/** Perfil de biometria sintetica que fuerza el dashboard durante el demo. */
export type DemoProfile = 'panic' | 'cardiac-redflag' | 'calm';

export interface DemoSpikeRequest {
  patientId: string;
  profile: DemoProfile;
}

export const demoSpikeRequestSchema = z.object({
  patientId: z.string(),
  profile: z.enum(['panic', 'cardiac-redflag', 'calm']),
});

type _CheckDemoSpike = AssertExtends<DemoSpikeRequest, z.infer<typeof demoSpikeRequestSchema>>;
