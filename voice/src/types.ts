/**
 * Tipos de loop-voice.
 *
 * 1. Re-exporta TODO lo de `shared/contracts.ts` para que ningun modulo de
 *    voice/ tenga que escribir la ruta relativa a shared.
 * 2. Anade los tipos internos del servicio de voz.
 *
 * Las interfaces de la seccion "internas" estan CONGELADAS: otros modulos
 * dependen de ellas literalmente. No se cambian sin avisar.
 */

// -----------------------------------------------------------------------------
// 1. Contratos compartidos (adaptador)
//
//    `shared/contracts.ts` es la fuente unica de verdad y esta CONGELADO: lo
//    escribio Carlos en estilo zod-first (`export const X` es el esquema y
//    `export type X` su `z.infer`). loop-voice se nombro antes de que existiera
//    ese archivo, asi que esta seccion traduce sus nombres a los del contrato.
//
//    Las FORMAS DE CABLE son identicas — solo cambian los identificadores.
//    Ningun otro modulo de voice/ tiene que enterarse: siguen importando de aqui.
// -----------------------------------------------------------------------------

import {
  BaselineMetric as BaselineMetricSchema,
  CoverageCheckRequest as CoverageCheckRequestSchema,
  CoverageCheckResponse as CoverageCheckResponseSchema,
  CurrentMetric as CurrentMetricSchema,
  DemoSpikeRequest as DemoSpikeRequestSchema,
  EpisodeWriteRequest as EpisodeWriteRequestSchema,
  LiveEventName as LiveEventNameSchema,
  ObservationSeries as ObservationSeriesSchema,
  OutcomesSummary as OutcomesSummarySchema,
  PatientContext as PatientContextSchema,
} from '../../shared/contracts.js';

import type {
  CurrentMetric as SharedCurrentMetric,
  PatientContext as SharedPatientContext,
  SafetyEnvelope,
} from '../../shared/contracts.js';

// --- Contrato 1: nombres que coinciden tal cual ------------------------------
export type {
  BaselineMetric,
  CostItem,
  CarePlanActivityType,
  CarePlanActivity,
  CarePlan,
  RecentEpisode,
  SafetyEnvelope,
  // Contrato 2
  EscalationAction,
  InterventionAttempt,
  BiometricsSnapshot,
  TranscriptTurn,
  // Contrato 3
  CoverageStatus,
  Deductible,
  CoverageCheckRequest,
  CoverageCheckResponse,
  // Contrato 4
  InterventionOutcome,
  OutcomesSummary,
  ObservationPoint,
  ObservationSeries,
  // Contrato 6
  DemoProfile,
  DemoSpikeRequest,
} from '../../shared/contracts.js';

// --- Contratos 1-5: nombres que el contrato bautizo distinto -----------------
export type {
  Trend as MetricTrend,
  MetricDelta as Delta,
  PatientCondition as ConditionRef,
  PatientMedication as MedicationRef,
  // Contrato 2
  EpisodeResolution as EpisodeOutcome,
  EpisodeEscalation as EscalationInfo,
  Transcript as TranscriptBlock,
  EpisodeCoverageCheck as CoverageCheckEcho,
  EpisodeWriteRequest as EpisodeWriteback,
  EpisodeWriteResponse as EpisodeWritebackResponse,
  // Contrato 4
  WeeklyEpisodeCount as EpisodeWeekCount,
  // Contrato 5
  LiveEventName as LiveEventType,
} from '../../shared/contracts.js';

import type { LiveEventName as LiveEventType } from '../../shared/contracts.js';

// --- Contenedores que el contrato declara en linea ---------------------------
// Carlos los escribio como `z.object({...})` anonimos dentro de PatientContext;
// loop-voice los necesita con nombre porque los pasa entre modulos.
export type Baseline = SharedPatientContext['baseline'];
export type Deltas = SharedPatientContext['deltas'];

/**
 * El contrato usa UN solo `CurrentMetric` con `max` y `min` ambos opcionales,
 * porque cubre metricas que suben y que bajan con la misma forma.
 *
 * loop-voice necesita la garantia estrecha: las reglas RF-01/RF-03 leen
 * `heartRate.max` y `hrv.min` sin comprobar null. Los fixtures y loop-core
 * siempre mandan el campo que corresponde a la direccion de la metrica, asi que
 * aqui se re-estrecha a nivel de tipo (sin coste en runtime).
 */
export type CurrentMetricRising = SharedCurrentMetric & { max: number };
export type CurrentMetricFalling = SharedCurrentMetric & { min: number };

/** Igual que la del contrato, pero con las direcciones ya estrechadas. */
export interface CurrentBiometrics {
  windowMinutes: number;
  heartRate: CurrentMetricRising;
  hrv: CurrentMetricFalling;
  respiratoryRate: CurrentMetricRising;
  /** OPCIONAL: el wearable del demo no publica SpO2. RF-08 debe saltarse la
   *  comprobacion cuando el campo no viene. */
  spo2?: CurrentMetricFalling;
  lastSampleAt: string;
}

// --- Esquemas zod, con los nombres que usa voice/ ----------------------------
// En el contrato el esquema y el tipo comparten identificador; voice/ los
// nombraba `xxxSchema`, asi que se re-exportan con ese alias.
export const baselineMetricSchema = BaselineMetricSchema;
export const currentMetricSchema = CurrentMetricSchema;
export const patientContextSchema = PatientContextSchema;
export const episodeWritebackSchema = EpisodeWriteRequestSchema;
export const coverageCheckRequestSchema = CoverageCheckRequestSchema;
export const coverageCheckResponseSchema = CoverageCheckResponseSchema;
export const outcomesSummarySchema = OutcomesSummarySchema;
export const observationSeriesSchema = ObservationSeriesSchema;
export const demoSpikeRequestSchema = DemoSpikeRequestSchema;
export const liveEventTypeSchema = LiveEventNameSchema;

/**
 * `PatientContext` tal y como lo consume voice/: el del contrato, pero con la
 * biometria ya estrechada a las direcciones de cada metrica.
 */
export type PatientContext = Omit<SharedPatientContext, 'current'> & {
  current: CurrentBiometrics;
};

/**
 * Parsers del contrato. Validan con el esquema compartido y devuelven el tipo
 * de voice/. El cast de `current` es el unico punto donde se afirma el
 * estrechamiento descrito arriba: si loop-core mandara una metrica que sube sin
 * `max`, el esquema la aceptaria y aqui se colaria. Es deliberado y esta
 * acotado a este archivo — si algun dia deja de cumplirse, se arregla aqui.
 */
export function parsePatientContext(raw: unknown): PatientContext {
  return PatientContextSchema.parse(raw) as PatientContext;
}

export function parseEpisodeWriteback(raw: unknown) {
  return EpisodeWriteRequestSchema.parse(raw);
}

export function parseCoverageCheckResponse(raw: unknown) {
  return CoverageCheckResponseSchema.parse(raw);
}

// -----------------------------------------------------------------------------
// 2. Motor de red-flags — voice/src/safety/  (Agente A)
//    LA PIEZA MAS IMPORTANTE DEL REPO. Determinista, pura, sin I/O.
// -----------------------------------------------------------------------------

/** Entrada del motor. `biometrics` puede ser null si aun no hay lectura. */
export interface RedFlagInput {
  transcriptText: string;
  biometrics: CurrentBiometrics | null;
  safetyEnvelope: SafetyEnvelope;
}

/**
 * Salida del motor.
 *
 * Si `triggered === true`:
 *   - el LLM NO se invoca para ese turno
 *   - se locuta `script` TAL CUAL (hardcodeado, nunca generado)
 *   - la llamada termina
 *   - se emite `safety.escalation` con `ruleId`
 */
export interface RedFlagResult {
  triggered: boolean;
  /** ID exacto de la regla, p.ej. "RF-01-CHEST-PAIN-RADIATING". */
  ruleId: string | null;
  action: 'advise-911' | 'advise-988' | 'connect-human' | null;
  /** Guion hardcodeado, nunca generado por un LLM. */
  script: string | null;
  /** Que texto o valor exacto disparo la regla. Los jueces lo van a pedir. */
  matchedEvidence: string | null;
  severity: 'none' | 'urgent' | 'critical';
}

/**
 * Definicion de una regla. `match` es pura: no hace I/O, no llama a red, no
 * usa reloj ni aleatoriedad. Devuelve la evidencia encontrada o null.
 */
export interface RedFlagRule {
  id: string;
  description: string;
  action: 'advise-911' | 'advise-988' | 'connect-human';
  severity: 'urgent' | 'critical';
  /** Prioridad de evaluacion: numero MAS ALTO = se evalua primero. */
  priority: number;
  script: string;
  match(input: RedFlagInput): string | null;
}

// -----------------------------------------------------------------------------
// 3. Capa LLM — voice/src/agent/  (Agente D)
// -----------------------------------------------------------------------------

export interface AgentTurnRequest {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

/**
 * Proveedor de LLM detras de una interfaz, para poder cambiar Bedrock por otra
 * cosa sin tocar el orquestador. Implementacion primaria: AWS Bedrock Converse
 * (streaming), modelo leido de `AGENT_MODEL_ID`.
 */
export interface LlmProvider {
  name: string;
  /** Deltas de texto conforme llegan. Nunca el texto completo de golpe. */
  streamReply(req: AgentTurnRequest, signal?: AbortSignal): AsyncIterable<string>;
}

// -----------------------------------------------------------------------------
// 4. Audio — voice/src/audio/  (Agente E)
// -----------------------------------------------------------------------------

export interface TtsResult {
  audio: Buffer;
  contentType: string;
  provider: 'deepgram' | 'polly' | 'none';
  latencyMs: number;
}

/**
 * Relay de STT hacia Deepgram Listen (WebSocket, nova-3, language=multi).
 * Vive en el SERVIDOR: el browser manda PCM crudo y este relay lo reenvia.
 */
export interface SttRelay {
  pushAudio(chunk: Buffer): void;
  close(): void;
  readonly ready: boolean;
}

export interface SttHandlers {
  onPartial(text: string): void;
  /** Turno cerrado del paciente. Es lo que entra al motor de red-flags. */
  onFinal(text: string): void;
  onError(err: Error): void;
}

// -----------------------------------------------------------------------------
// 5. Stream en vivo — voice/src/live/  (Agente C)
// -----------------------------------------------------------------------------

export interface LiveEvent {
  type: LiveEventType;
  data: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// 6. Estado de la llamada — voice/src/session/  (Agente F)
// -----------------------------------------------------------------------------

/**
 * Estados por los que pasa una llamada.
 *
 *   idle -> greeting -> listening <-> thinking -> speaking -> listening
 *                          |                                     |
 *                          +-> intervention -> listening         |
 *                          +-> escalated -> ended <--------------+
 *
 * `escalated` es terminal: desde ahi solo se va a `ended`.
 */
export type CallState =
  | 'idle'
  | 'greeting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'intervention'
  | 'coverage'
  | 'escalated'
  | 'ended';

/** Snapshot que el orquestador pasa entre modulos durante un turno. */
export interface TurnContext {
  callId: string;
  patientContext: PatientContext;
  state: CallState;
}
