/**
 * `CallSession` — el estado de UNA llamada.
 *
 * Es el unico sitio donde vive lo que paso durante la llamada: turnos,
 * intervenciones del care plan, coverage checks, extremos de biometria y la
 * escalacion (si la hubo). Al colgar produce el `EpisodeWriteback` del
 * Contrato 2.
 *
 * Decisiones:
 *   - El transcript se guarda EN CRUDO. El agente necesita el original para
 *     conversar; la redaccion de PII se aplica al SALIR del proceso
 *     (`buildEpisode`, `snapshot`). Redactar en la entrada seria irreversible y
 *     degradaria la conversacion.
 *   - Nada de `Math.random`: el `callId` sale de `crypto.randomUUID` mas un
 *     contador de proceso, asi que no hay colisiones dentro de una ejecucion.
 *   - El reloj es inyectable (`opts.now`) para que los tests sean deterministas.
 *   - `setState` NUNCA lanza: una transicion invalida se rechaza y se cuenta.
 *     La llamada del paciente no se cae por una maquina de estados.
 */

import { randomUUID } from 'node:crypto';

import { redactTurns } from '../redaction/pii.js';
import {
  type BiometricsSnapshot,
  type CallState,
  type CoverageCheckEcho,
  type CoverageCheckResponse,
  type CoverageStatus,
  type EpisodeOutcome,
  type EpisodeWriteback,
  type EscalationAction,
  type EscalationInfo,
  type InterventionAttempt,
  type PatientContext,
  type TranscriptTurn,
} from '../types.js';
import { buildEpisode as buildEpisodePayload, inferOutcome, toIsoUtc } from './episodeBuilder.js';

// -----------------------------------------------------------------------------
// Identificadores de llamada
// -----------------------------------------------------------------------------

const ID_SPACE = 0x10000; // 4 digitos hex

/**
 * Base aleatoria del proceso, derivada de `crypto.randomUUID()`. Sumandole un
 * contador monotono obtenemos IDs cortos ("call-8f2a", como en el contrato),
 * impredecibles entre ejecuciones y sin colisiones dentro de una misma.
 */
const idBase = Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 4), 16);
let idCounter = 0;

/** Siguiente `callId`. Formato: `call-` + 4 hex. */
export function nextCallId(): string {
  const value = (idBase + idCounter++) % ID_SPACE;
  return `call-${value.toString(16).padStart(4, '0')}`;
}

// -----------------------------------------------------------------------------
// Maquina de estados
// -----------------------------------------------------------------------------

/**
 * Transiciones permitidas.
 *
 *   idle -> greeting -> listening <-> thinking -> speaking -> listening
 *                           |                                    |
 *                           +-> intervention / coverage ----------+
 *                           +-> escalated -> ended
 *
 * `escalated` es TERMINAL salvo hacia `ended`: cuando una red-flag dispara, la
 * llamada solo puede acabar. `ended` no tiene salida.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<CallState, readonly CallState[]>> = Object.freeze({
  idle: ['greeting', 'listening', 'escalated', 'ended'],
  greeting: ['listening', 'thinking', 'speaking', 'escalated', 'ended'],
  listening: ['thinking', 'speaking', 'intervention', 'coverage', 'escalated', 'ended'],
  thinking: ['speaking', 'listening', 'intervention', 'coverage', 'escalated', 'ended'],
  speaking: ['listening', 'thinking', 'intervention', 'coverage', 'escalated', 'ended'],
  intervention: ['listening', 'thinking', 'speaking', 'coverage', 'escalated', 'ended'],
  coverage: ['listening', 'thinking', 'speaking', 'intervention', 'escalated', 'ended'],
  escalated: ['ended'],
  ended: [],
});

const ESCALATION_ACTIONS: readonly EscalationAction[] = ['advise-911', 'advise-988', 'connect-human'];
const COVERAGE_STATUSES: readonly CoverageStatus[] = ['covered', 'not-covered', 'needs-auth', 'unknown'];

/**
 * Normaliza la accion de escalacion. El motor de red-flags emite
 * `advise-911`; el ejemplo SSE del brief escribe `advised-911`. Se aceptan
 * ambas formas y se guarda siempre la del contrato.
 */
function normalizeAction(raw: string | null | undefined): EscalationAction | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace('advised-', 'advise-');
  return (ESCALATION_ACTIONS as readonly string[]).includes(value) ? (value as EscalationAction) : null;
}

// -----------------------------------------------------------------------------
// Opciones y snapshot
// -----------------------------------------------------------------------------

export interface CallSessionOptions {
  /** ID explicito (tests, reanudacion). Si falta se genera. */
  callId?: string;
  /** Instante de creacion. Si falta se toma de `now()`. */
  startedAt?: string | Date;
  /** Reloj inyectable. Default: `() => new Date()`. */
  now?: () => Date;
}

/** Objeto plano y serializable: debug, `/api/v1/calls/:id` y dashboard. */
export interface CallSessionSnapshot {
  callId: string;
  patientId: string;
  patientName: string;
  state: CallState;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  severitySelfReported: number | null;
  escalation: EscalationInfo;
  biometrics: BiometricsSnapshot;
  baseline: { heartRate: number | null; hrv: number | null; respiratoryRate: number | null };
  turnCount: number;
  interventions: InterventionAttempt[];
  coverageChecks: CoverageCheckEcho[];
  /** Transcript REDACTADO: el snapshot sale del proceso, el crudo no. */
  transcript: { redacted: true; turns: TranscriptTurn[] };
  /** Cuantas transiciones invalidas se rechazaron. Util para depurar el flujo. */
  rejectedTransitions: number;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// -----------------------------------------------------------------------------
// La clase
// -----------------------------------------------------------------------------

export class CallSession {
  readonly callId: string;
  readonly patientId: string;
  readonly ctx: PatientContext;
  readonly startedAt: string;

  private readonly clock: () => Date;

  private endedAtValue: string | null = null;
  private stateValue: CallState = 'idle';
  private rejectedTransitionsValue = 0;

  private readonly turnsValue: TranscriptTurn[] = [];
  private readonly interventionsValue: InterventionAttempt[] = [];
  private readonly coverageChecksValue: CoverageCheckEcho[] = [];

  private readonly biometricsValue: BiometricsSnapshot;
  private escalationValue: EscalationInfo = {
    triggered: false,
    rule: null,
    triggeredAt: null,
    action: null,
  };
  private severityValue: number | null = null;

  constructor(patientId: string, ctx: PatientContext, opts: CallSessionOptions = {}) {
    this.clock = opts.now ?? (() => new Date());
    this.callId = opts.callId ?? nextCallId();
    this.patientId = patientId;
    this.ctx = ctx;
    this.startedAt = toIsoUtc(opts.startedAt ?? this.clock());

    // Los extremos arrancan con lo que ya sabemos del contexto precargado: si
    // la llamada se corta antes del primer tick, el episodio sigue llevando la
    // biometria que motivo la llamada.
    const current = ctx?.current;
    this.biometricsValue = {
      peakHeartRate: finiteOrNull(current?.heartRate?.max) ?? finiteOrNull(current?.heartRate?.latest),
      minHrv: finiteOrNull(current?.hrv?.min) ?? finiteOrNull(current?.hrv?.latest),
      peakRespiratoryRate:
        finiteOrNull(current?.respiratoryRate?.max) ?? finiteOrNull(current?.respiratoryRate?.latest),
    };
  }

  // --- lecturas ---------------------------------------------------------------

  get endedAt(): string | null {
    return this.endedAtValue;
  }

  get state(): CallState {
    return this.stateValue;
  }

  get turns(): readonly TranscriptTurn[] {
    return this.turnsValue;
  }

  get interventions(): readonly InterventionAttempt[] {
    return this.interventionsValue;
  }

  get coverageChecks(): readonly CoverageCheckEcho[] {
    return this.coverageChecksValue;
  }

  get biometrics(): BiometricsSnapshot {
    return { ...this.biometricsValue };
  }

  get escalation(): EscalationInfo {
    return { ...this.escalationValue };
  }

  get severitySelfReported(): number | null {
    return this.severityValue;
  }

  get rejectedTransitions(): number {
    return this.rejectedTransitionsValue;
  }

  getState(): CallState {
    return this.stateValue;
  }

  /** Marca de tiempo actual del reloj de la sesion, en ISO UTC. */
  private nowIso(): string {
    return toIsoUtc(this.clock());
  }

  /** Duracion de la llamada en segundos. Si sigue viva, hasta ahora mismo. */
  durationSeconds(): number {
    const start = Date.parse(this.startedAt);
    const end = this.endedAtValue !== null ? Date.parse(this.endedAtValue) : this.clock().getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    return Math.max(0, Math.round((end - start) / 1000));
  }

  // --- mutaciones -------------------------------------------------------------

  /**
   * Cambia de estado si la transicion es valida. Devuelve si se aplico.
   * Nunca lanza: un flujo inesperado no puede tumbar la llamada.
   */
  setState(next: CallState): boolean {
    if (next === this.stateValue) return true;
    const allowed = ALLOWED_TRANSITIONS[this.stateValue] ?? [];
    if (!allowed.includes(next)) {
      this.rejectedTransitionsValue += 1;
      return false;
    }
    this.stateValue = next;
    if (next === 'ended' && this.endedAtValue === null) this.endedAtValue = this.nowIso();
    return true;
  }

  /** Anade un turno al transcript. El texto se guarda TAL CUAL (sin redactar). */
  addTurn(speaker: 'patient' | 'agent', text: string): void {
    const clean = typeof text === 'string' ? text.trim() : '';
    if (clean.length === 0) return;
    this.turnsValue.push({ speaker, at: this.nowIso(), text: clean });
  }

  /**
   * Registra un intento de actividad del care plan.
   *
   * Si ya hay un intento ABIERTO de la misma actividad se ACTUALIZA (se
   * conserva su `startedAt` original) en lugar de duplicarlo. Asi el flujo
   * normal — `recordIntervention(id, false, null)` al empezar y
   * `recordIntervention(id, true, 6)` al terminar — produce UN solo intento con
   * la hora real de inicio.
   */
  recordIntervention(activityId: string, completed: boolean, relief: number | null): void {
    const open = [...this.interventionsValue]
      .reverse()
      .find((attempt) => attempt.carePlanActivityId === activityId && !attempt.completed);

    const normalizedRelief = relief !== null && Number.isFinite(relief) ? Math.min(10, Math.max(0, Math.round(relief))) : null;

    if (open !== undefined) {
      open.completed = completed;
      if (normalizedRelief !== null) open.patientReportedRelief = normalizedRelief;
      return;
    }

    this.interventionsValue.push({
      carePlanActivityId: activityId,
      startedAt: this.nowIso(),
      completed,
      patientReportedRelief: normalizedRelief,
    });
  }

  /** Registra el eco de un coverage check (Contrato 3 -> Contrato 2). */
  recordCoverage(check: CoverageCheckResponse, serviceType: string): void {
    const status = (COVERAGE_STATUSES as readonly string[]).includes(check?.status)
      ? (check.status as CoverageStatus)
      : 'unknown';
    this.coverageChecksValue.push({
      checkId: typeof check?.checkId === 'string' && check.checkId.length > 0 ? check.checkId : 'cov-unknown',
      serviceType,
      result: status,
      copayCents: finiteOrNull(check?.copayCents),
    });
  }

  /** Actualiza los extremos de biometria. Maximo de HR/RR, MINIMO de HRV. */
  recordBiometricTick(hr: number, hrv: number, rr: number): void {
    const heartRate = finiteOrNull(hr);
    if (heartRate !== null) {
      this.biometricsValue.peakHeartRate =
        this.biometricsValue.peakHeartRate === null
          ? heartRate
          : Math.max(this.biometricsValue.peakHeartRate, heartRate);
    }

    const hrvValue = finiteOrNull(hrv);
    if (hrvValue !== null) {
      this.biometricsValue.minHrv =
        this.biometricsValue.minHrv === null ? hrvValue : Math.min(this.biometricsValue.minHrv, hrvValue);
    }

    const respiratory = finiteOrNull(rr);
    if (respiratory !== null) {
      this.biometricsValue.peakRespiratoryRate =
        this.biometricsValue.peakRespiratoryRate === null
          ? respiratory
          : Math.max(this.biometricsValue.peakRespiratoryRate, respiratory);
    }
  }

  /**
   * Registra la escalacion determinista del motor de red-flags.
   * GANA LA PRIMERA: es la que corto la llamada y la que se audita.
   * Fuerza el estado a `escalated` (la seguridad no negocia con la maquina de
   * estados), salvo que la llamada ya estuviera terminada.
   */
  setEscalation(rule: string, action: string): void {
    if (!this.escalationValue.triggered) {
      this.escalationValue = {
        triggered: true,
        rule: typeof rule === 'string' && rule.length > 0 ? rule : null,
        triggeredAt: this.nowIso(),
        action: normalizeAction(action),
      };
    }
    if (this.stateValue !== 'ended') this.stateValue = 'escalated';
  }

  /** Severidad auto-reportada por el paciente (0-10). */
  setSeverity(v: number): void {
    this.severityValue = Number.isFinite(v) ? Math.min(10, Math.max(0, Math.round(v))) : null;
  }

  /** Cierra la llamada. Idempotente. */
  end(): void {
    if (this.endedAtValue === null) this.endedAtValue = this.nowIso();
    this.stateValue = 'ended';
  }

  // --- salidas ----------------------------------------------------------------

  /** Outcome deducido del estado actual, sin construir el episodio. */
  inferOutcome(): EpisodeOutcome {
    return inferOutcome(this);
  }

  /**
   * Episodio listo para `POST :3001/api/v1/episodes`, ya redactado y validado
   * contra `episodeWritebackSchema`.
   */
  buildEpisode(outcome: EpisodeOutcome): EpisodeWriteback {
    return buildEpisodePayload(this, outcome, { now: this.clock });
  }

  /** Vista plana y serializable. El transcript va REDACTADO. */
  snapshot(): CallSessionSnapshot {
    const baseline = this.ctx?.baseline;
    return {
      callId: this.callId,
      patientId: this.patientId,
      patientName: this.ctx?.displayName ?? '',
      state: this.stateValue,
      startedAt: this.startedAt,
      endedAt: this.endedAtValue,
      durationSeconds: this.durationSeconds(),
      severitySelfReported: this.severityValue,
      escalation: { ...this.escalationValue },
      biometrics: { ...this.biometricsValue },
      baseline: {
        heartRate: finiteOrNull(baseline?.heartRate?.mean),
        hrv: finiteOrNull(baseline?.hrv?.mean),
        respiratoryRate: finiteOrNull(baseline?.respiratoryRate?.mean),
      },
      turnCount: this.turnsValue.length,
      interventions: this.interventionsValue.map((attempt) => ({ ...attempt })),
      coverageChecks: this.coverageChecksValue.map((check) => ({ ...check })),
      transcript: { redacted: true, turns: redactTurns(this.turnsValue) },
      rejectedTransitions: this.rejectedTransitionsValue,
    };
  }
}
