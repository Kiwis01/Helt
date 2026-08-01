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
// 1. Contratos compartidos (re-export)
// -----------------------------------------------------------------------------

export type {
  // Contrato 1
  MetricTrend,
  BaselineMetric,
  Baseline,
  CurrentMetricRising,
  CurrentMetricFalling,
  CurrentBiometrics,
  Delta,
  Deltas,
  ConditionRef,
  CostItem,
  CarePlanActivityType,
  CarePlanActivity,
  CarePlan,
  RecentEpisode,
  MedicationRef,
  SafetyEnvelope,
  PatientContext,
  // Contrato 2
  EpisodeOutcome,
  EscalationAction,
  EscalationInfo,
  InterventionAttempt,
  BiometricsSnapshot,
  TranscriptTurn,
  TranscriptBlock,
  CoverageCheckEcho,
  EpisodeWriteback,
  EpisodeWritebackResponse,
  // Contrato 3
  CoverageStatus,
  Deductible,
  CoverageCheckRequest,
  CoverageCheckResponse,
  // Contrato 4
  InterventionOutcome,
  EpisodeWeekCount,
  OutcomesSummary,
  ObservationPoint,
  ObservationSeries,
  // Contrato 5
  LiveEventType,
  // Contrato 6
  DemoProfile,
  DemoSpikeRequest,
} from '../../shared/contracts.js';

export {
  patientContextSchema,
  episodeWritebackSchema,
  coverageCheckResponseSchema,
  coverageCheckRequestSchema,
  outcomesSummarySchema,
  observationSeriesSchema,
  demoSpikeRequestSchema,
  liveEventTypeSchema,
  parsePatientContext,
  parseEpisodeWriteback,
  parseCoverageCheckResponse,
} from '../../shared/contracts.js';

import type {
  CurrentBiometrics,
  LiveEventType,
  PatientContext,
  SafetyEnvelope,
} from '../../shared/contracts.js';

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
