/**
 * Construccion del episodio (Contrato 2 — POST :3001/api/v1/episodes).
 *
 * Este modulo NO conoce la clase `CallSession`: trabaja contra la vista
 * estructural `EpisodeSessionView`. Asi la dependencia es de un solo sentido
 * (callSession.ts -> episodeBuilder.ts) y no hay ciclo de imports en ESM.
 *
 * Invariantes que este archivo garantiza:
 *   - `transcript.redacted` es SIEMPRE true y los turnos ya pasaron por el
 *     redactor de PII.
 *   - `escalation` lleva SIEMPRE sus 4 campos; null cuando no aplica, nunca
 *     omitidos.
 *   - Todas las fechas son ISO-8601 UTC terminadas en `Z`.
 *   - El payload se valida contra `episodeWritebackSchema` antes de devolverse.
 *     Si no valida es un bug de loop-voice, no del runtime, y se lanza.
 */

import { redactTurns } from '../redaction/pii.js';
import {
  episodeWritebackSchema,
  type BiometricsSnapshot,
  type CallState,
  type CoverageCheckEcho,
  type EpisodeOutcome,
  type EpisodeWriteback,
  type EscalationInfo,
  type InterventionAttempt,
  type TranscriptTurn,
} from '../types.js';

// -----------------------------------------------------------------------------
// Vista de la sesion que necesita el builder
// -----------------------------------------------------------------------------

/**
 * Lo minimo que el builder necesita leer de una llamada. `CallSession` la
 * cumple estructuralmente; los tests pueden pasar un objeto plano.
 */
export interface EpisodeSessionView {
  readonly callId: string;
  readonly patientId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly state: CallState;
  readonly turns: readonly TranscriptTurn[];
  readonly interventions: readonly InterventionAttempt[];
  readonly coverageChecks: readonly CoverageCheckEcho[];
  readonly biometrics: BiometricsSnapshot;
  readonly escalation: EscalationInfo;
  readonly severitySelfReported: number | null;
}

export interface BuildEpisodeOptions {
  /** Reloj inyectable. Solo se usa si la sesion aun no tiene `endedAt`. */
  now?: () => Date;
}

// -----------------------------------------------------------------------------
// Utilidades de tiempo
// -----------------------------------------------------------------------------

/**
 * Normaliza cualquier fecha a ISO-8601 UTC con `Z` y precision de segundos
 * (mismo formato que los fixtures compartidos). Si el valor no es parseable
 * devuelve `fallback`, y si tampoco hay fallback usa el instante actual: el
 * write-back nunca se queda sin fecha.
 */
export function toIsoUtc(value: string | number | Date | null | undefined, fallback?: string): string {
  const date = value instanceof Date ? value : value === null || value === undefined ? null : new Date(value);
  if (date !== null && !Number.isNaN(date.getTime())) return trimMillis(date);
  if (fallback !== undefined) return fallback;
  return trimMillis(new Date());
}

function trimMillis(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// -----------------------------------------------------------------------------
// Deduccion del outcome
// -----------------------------------------------------------------------------

/**
 * Un turno "util" del paciente. Filtra vacios y ruidos de STT ("eh", "mm"):
 * si la llamada entera fueron dos gruñidos, el episodio es `abandoned`.
 */
const MIN_USEFUL_TURN_CHARS = 3;

export function countUsefulPatientTurns(turns: readonly TranscriptTurn[]): number {
  return turns.filter((turn) => turn.speaker === 'patient' && turn.text.trim().length >= MIN_USEFUL_TURN_CHARS)
    .length;
}

/**
 * Deduce como termino el episodio. Determinista y en este orden exacto:
 *
 *   1. escalacion a 911                      -> escalated-emergency
 *   2. escalacion a 988 / humano             -> escalated-human
 *   3. alguna intervencion completada        -> resolved-with-intervention
 *   4. el paciente colgo sin turnos utiles   -> abandoned
 *   5. resto                                 -> self-resolved
 *
 * La escalacion gana SIEMPRE, aunque antes se hubiera completado una
 * intervencion: lo que importa clinicamente es como acabo la llamada.
 */
export function inferOutcome(session: EpisodeSessionView): EpisodeOutcome {
  if (session.escalation.triggered) {
    return session.escalation.action === 'advise-911' ? 'escalated-emergency' : 'escalated-human';
  }
  if (session.interventions.some((attempt) => attempt.completed)) return 'resolved-with-intervention';
  if (countUsefulPatientTurns(session.turns) === 0) return 'abandoned';
  return 'self-resolved';
}

// -----------------------------------------------------------------------------
// Construccion del payload
// -----------------------------------------------------------------------------

function normalizeSeverity(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(10, Math.max(0, Math.round(value)));
}

function normalizeMetric(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function normalizeEscalation(escalation: EscalationInfo, fallbackAt: string): EscalationInfo {
  // Los 4 campos SIEMPRE presentes. Nunca se omite ninguno.
  if (!escalation.triggered) {
    return { triggered: false, rule: null, triggeredAt: null, action: null };
  }
  return {
    triggered: true,
    rule: escalation.rule ?? null,
    triggeredAt: toIsoUtc(escalation.triggeredAt, fallbackAt),
    action: escalation.action ?? null,
  };
}

/**
 * Arma el `EpisodeWriteback` del Contrato 2.
 *
 * @param session  la llamada (o cualquier objeto que cumpla la vista).
 * @param outcome  si se omite, se deduce con `inferOutcome`.
 */
export function buildEpisode(
  session: EpisodeSessionView,
  outcome?: EpisodeOutcome,
  options: BuildEpisodeOptions = {},
): EpisodeWriteback {
  const now = options.now ?? (() => new Date());
  const startedAt = toIsoUtc(session.startedAt, trimMillis(now()));
  const endedAt = toIsoUtc(session.endedAt, trimMillis(now()));

  const payload: EpisodeWriteback = {
    patientId: session.patientId,
    callId: session.callId,
    startedAt,
    endedAt,
    outcome: outcome ?? inferOutcome(session),
    escalation: normalizeEscalation(session.escalation, endedAt),
    severitySelfReported: normalizeSeverity(session.severitySelfReported),
    interventionsAttempted: session.interventions.map((attempt) => ({
      carePlanActivityId: attempt.carePlanActivityId,
      startedAt: toIsoUtc(attempt.startedAt, startedAt),
      completed: attempt.completed === true,
      patientReportedRelief: normalizeSeverity(attempt.patientReportedRelief),
    })),
    biometricsSnapshot: {
      peakHeartRate: normalizeMetric(session.biometrics.peakHeartRate),
      minHrv: normalizeMetric(session.biometrics.minHrv),
      peakRespiratoryRate: normalizeMetric(session.biometrics.peakRespiratoryRate),
    },
    transcript: {
      // Nunca se persiste un transcript sin redactar. Este `true` es literal a
      // proposito: no hay camino de codigo que lo ponga en false.
      redacted: true,
      turns: redactTurns(session.turns).map((turn) => ({
        speaker: turn.speaker,
        at: toIsoUtc(turn.at, startedAt),
        text: turn.text,
      })),
    },
    coverageChecks: session.coverageChecks.map((check) => ({
      checkId: check.checkId,
      serviceType: check.serviceType,
      result: check.result,
      copayCents: normalizeMetric(check.copayCents),
    })),
  };

  const parsed = episodeWritebackSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join(' · ');
    throw new Error(
      `[episodeBuilder] el episodio de ${session.callId} no cumple episodeWritebackSchema. ` +
        `Esto es un bug de loop-voice, no del runtime downstream. Detalle: ${detail}`,
    );
  }

  return payload;
}
