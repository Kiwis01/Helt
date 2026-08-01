/**
 * Ciclo de vida de una llamada.
 *
 *   startCall()  -> contexto precargado, sesion, saludo SIN LLM, ticks vivos
 *   runPatientTurn()  (en turnPipeline.ts, un turno cada vez)
 *   endCall()    -> outcome, episodio redactado, write-back, eventos de cierre
 *
 * Dos decisiones que hay que entender antes de tocar nada aqui:
 *
 * 1. **El saludo no pasa por el LLM.** `OPENING_DISCLOSURE` es un guion fijo
 *    (requisito del DoD: "no sustituyo la atencion de emergencia") y
 *    `buildOpeningLine(ctx)` es una funcion determinista que cita el ritmo
 *    cardiaco actual y el de referencia. Que un modelo redacte la primera frase
 *    costaria entre uno y tres segundos justo cuando alguien acaba de descolgar,
 *    y ademas dejaria al azar si los numeros se dicen o no. En el escenario, esa
 *    frase es la que demuestra que hay datos reales detras.
 *
 * 2. **`endCall` nunca deja de escribir el episodio.** Se llama desde el cierre
 *    normal, desde una escalacion, desde un socket que se murio y desde
 *    SIGINT/SIGTERM. Es idempotente y no lanza: `postEpisode` ya guarda el
 *    payload en disco si :3001 no contesta.
 */

import { buildOpeningLine, buildSystemPrompt } from '../agent/systemPrompt.js';
import { getPatientContext, postEpisode } from '../clients/coreClient.js';
import {
  emitBiometricsTick,
  emitCallEnded,
  emitCallStarted,
  emitEpisodeWritten,
} from '../live/bus.js';
import { describeError, log } from '../logger.js';
import { OPENING_DISCLOSURE } from '../safety/index.js';
import { sessionStore } from '../session/sessionStore.js';
import { config } from '../config.js';
import type { CurrentBiometrics, EpisodeOutcome, PatientContext } from '../types.js';
import {
  abortEverything,
  NOOP_SINK,
  safeSink,
  speakFixedLine,
  resolveStandaloneDeps,
  type ActiveCall,
  type CallSink,
  type PipelineDeps,
} from './turnPipeline.js';

// =============================================================================
// Registro de llamadas vivas
// =============================================================================

const calls = new Map<string, ActiveCall>();
const tickers = new Map<string, NodeJS.Timeout>();

export function getActiveCall(callId: string): ActiveCall | null {
  return calls.get(callId) ?? null;
}

/** La llamada viva mas reciente. El caso normal del demo: hay una sola. */
export function currentCall(): ActiveCall | null {
  let last: ActiveCall | null = null;
  for (const call of calls.values()) if (!call.ended) last = call;
  return last;
}

export function activeCallCount(): number {
  let count = 0;
  for (const call of calls.values()) if (!call.ended) count += 1;
  return count;
}

// =============================================================================
// Ticks de biometria
// =============================================================================

/** Cada cuanto se emite `biometrics.tick`. Es lo que Carlos pinta en vivo. */
export const TICK_MS = 3000;

/** Cuantos ticks tarda la curva en llegar al pico de la ventana observada. */
const RISE_TICKS = 8;

/** Constante de la bajada tras la intervencion (fraccion recuperada por tick). */
const RECOVERY_RATE = 0.12;

interface CurveState {
  tick: number;
  /** Tick en el que empezo la recuperacion, o null si sigue subiendo. */
  recoveryStartTick: number | null;
  recoveryFrom: { hr: number; hrv: number; rr: number } | null;
}

/**
 * Curva de biometria del episodio. **Deterministica: ni un `Math.random`.**
 *
 * Sube desde la lectura actual hacia el pico de la ventana mientras el episodio
 * esta activo, y baja hacia el baseline en cuanto se completa una intervencion.
 * La ondulacion es un seno del numero de tick, no ruido aleatorio: dos ensayos
 * con la misma secuencia de acciones producen exactamente la misma grafica, que
 * es lo que uno quiere antes de subirse a un escenario.
 *
 * Funcion pura, exportada para poder graficarla en un test.
 */
export function biometricCurve(
  ctx: PatientContext,
  state: CurveState,
): { heartRate: number; hrv: number; respiratoryRate: number } {
  const cur = ctx.current;
  const base = ctx.baseline;

  const wobble = Math.sin(state.tick / 2);

  if (state.recoveryStartTick === null || state.recoveryFrom === null) {
    const progress = Math.min(1, state.tick / RISE_TICKS);
    const hr = cur.heartRate.latest + (cur.heartRate.max - cur.heartRate.latest) * progress;
    const hrv = cur.hrv.latest + (cur.hrv.min - cur.hrv.latest) * progress;
    const rr =
      cur.respiratoryRate.latest +
      (cur.respiratoryRate.max - cur.respiratoryRate.latest) * progress;
    return {
      heartRate: Math.round(hr + wobble * 2),
      hrv: Math.max(1, Math.round(hrv + wobble)),
      respiratoryRate: Math.max(1, Math.round(rr + wobble * 0.5)),
    };
  }

  // Recuperacion: acercamiento exponencial al baseline, sin llegar a tocarlo
  // (nadie vuelve a su promedio de reposo dos minutos despues de un episodio).
  const elapsed = state.tick - state.recoveryStartTick;
  const decay = 1 - Math.pow(1 - RECOVERY_RATE, Math.max(0, elapsed));
  const from = state.recoveryFrom;
  const hrTarget = base.heartRate.mean * 1.08;
  const hrvTarget = base.hrv.mean * 0.9;
  const rrTarget = base.respiratoryRate.mean * 1.05;

  return {
    heartRate: Math.round(from.hr + (hrTarget - from.hr) * decay + wobble * 1.5),
    hrv: Math.max(1, Math.round(from.hrv + (hrvTarget - from.hrv) * decay + wobble)),
    respiratoryRate: Math.max(
      1,
      Math.round(from.rr + (rrTarget - from.rr) * decay + wobble * 0.5),
    ),
  };
}

/**
 * Actualiza la biometria VIVA de la llamada.
 *
 * Es la que ve el motor de red-flags: se guarda tambien como `max`/`min` de la
 * ventana, porque `checkEnvelope` mira el extremo ademas del ultimo valor. Un
 * paciente que estuvo a 171 hace un minuto ya se salio del envelope aunque
 * ahora marque 140.
 */
function applyTick(
  call: ActiveCall,
  reading: { heartRate: number; hrv: number; respiratoryRate: number },
): void {
  const bio = call.biometrics;
  call.biometrics = {
    ...bio,
    heartRate: {
      ...bio.heartRate,
      latest: reading.heartRate,
      max: Math.max(bio.heartRate.max, reading.heartRate),
    },
    hrv: { ...bio.hrv, latest: reading.hrv, min: Math.min(bio.hrv.min, reading.hrv) },
    respiratoryRate: {
      ...bio.respiratoryRate,
      latest: reading.respiratoryRate,
      max: Math.max(bio.respiratoryRate.max, reading.respiratoryRate),
    },
    lastSampleAt: new Date().toISOString(),
  };

  call.session.recordBiometricTick(reading.heartRate, reading.hrv, reading.respiratoryRate);
  emitBiometricsTick({
    callId: call.callId,
    heartRate: reading.heartRate,
    hrv: reading.hrv,
    respiratoryRate: reading.respiratoryRate,
  });
  call.sink.biometrics({
    heartRate: reading.heartRate,
    hrv: reading.hrv,
    respiratoryRate: reading.respiratoryRate,
  });
}

function startTicker(call: ActiveCall): void {
  const state: CurveState = { tick: 0, recoveryStartTick: null, recoveryFrom: null };

  const timer = setInterval(() => {
    if (call.ended) return;

    // La bajada arranca en cuanto hay una intervencion completada. Es la
    // historia que cuenta el grafico del dashboard: sube, respira, baja.
    if (state.recoveryStartTick === null && call.session.interventions.some((i) => i.completed)) {
      state.recoveryStartTick = state.tick;
      state.recoveryFrom = {
        hr: call.biometrics.heartRate.latest,
        hrv: call.biometrics.hrv.latest,
        rr: call.biometrics.respiratoryRate.latest,
      };
    }

    state.tick += 1;
    try {
      applyTick(call, biometricCurve(call.ctx, state));
    } catch (err) {
      log.warn('biometrics.tick-failed', { callId: call.callId, message: describeError(err) });
    }
  }, TICK_MS);

  // No mantiene el proceso vivo por si solo: si la llamada se quedo colgada, el
  // servidor puede cerrarse igual.
  timer.unref();
  tickers.set(call.callId, timer);
}

function stopTicker(callId: string): void {
  const timer = tickers.get(callId);
  if (timer !== undefined) {
    clearInterval(timer);
    tickers.delete(callId);
  }
}

// =============================================================================
// startCall
// =============================================================================

export interface StartCallOptions {
  /** Hacia donde habla el agente. Default: sumidero mudo. */
  sink?: CallSink;
  /** Perfil del contexto: 'cardiac-redflag' sirve el fixture con HR 163. */
  profile?: string;
  /** Dependencias inyectadas para esta llamada (tests, smoke, ensayos). */
  deps?: Partial<PipelineDeps>;
  /** Locutar disclosure + frase de apertura. Default true. */
  greet?: boolean;
  /** Emitir `biometrics.tick` cada 3s. Default true. */
  ticks?: boolean;
}

/**
 * Arranca una llamada.
 *
 * El contexto ya viene precargado por `warmContext()` al arrancar el servidor,
 * asi que esta llamada a `getPatientContext` es un acierto de cache o una
 * lectura de fixture: coste ~0ms. Esa es la primera de las tres palancas de
 * latencia del brief (las otras dos son el troceo por frases y la frase puente).
 */
export async function startCall(
  patientId: string = config.patientId,
  options: StartCallOptions = {},
): Promise<ActiveCall> {
  const sink = safeSink(options.sink ?? NOOP_SINK);
  const ctx = await getPatientContext(patientId, { profile: options.profile });
  const session = sessionStore.create(patientId, ctx);

  const firstGuided = [...ctx.carePlan.activities]
    .sort((a, b) => a.order - b.order)
    .find((activity) => activity.type === 'breathing' || activity.type === 'grounding');

  const call: ActiveCall = {
    callId: session.callId,
    patientId,
    session,
    ctx,
    systemPrompt: buildSystemPrompt(ctx),
    sink,
    hooks: {
      endCall: async (outcome, reason) => {
        await endCall(session.callId, reason, outcome);
      },
    },
    deps: options.deps ?? {},
    history: [],
    // Copia profunda de la biometria: los ticks la mutan y el contexto original
    // se sigue usando para el prompt y para el baseline.
    biometrics: structuredClone(ctx.current) as CurrentBiometrics,
    llmAbort: null,
    interventionStop: null,
    audioSeq: 0,
    pendingActivityId: null,
    awaitingRelief: null,
    awaitingSeverity: false,
    coverageDone: new Set<string>(),
    lastCoverageSummary: null,
    interventionsRun: new Set<string>(),
    ended: false,
  };

  calls.set(call.callId, call);

  emitCallStarted({ callId: call.callId, patientId });
  log.info('call.started', {
    callId: call.callId,
    patientId,
    profile: options.profile ?? 'happy',
    useMocks: config.useMocks,
    hr: ctx.current.heartRate.latest,
    hrBaseline: ctx.baseline.heartRate.mean,
  });

  sink.ready({
    callId: call.callId,
    patientId,
    displayName: ctx.displayName,
    age: ctx.age,
    biometrics: {
      heartRate: ctx.current.heartRate.latest,
      hrv: ctx.current.hrv.latest,
      respiratoryRate: ctx.current.respiratoryRate.latest,
    },
    baseline: {
      heartRate: ctx.baseline.heartRate.mean,
      hrv: ctx.baseline.hrv.mean,
      respiratoryRate: ctx.baseline.respiratoryRate.mean,
    },
    useMocks: config.useMocks,
  });

  if (options.ticks !== false) startTicker(call);

  if (options.greet !== false) {
    const deps = resolveStandaloneDeps({ ...call.deps });
    session.setState('greeting');
    sink.state('greeting');

    // Disclosure primero, siempre. Es lo unico que se dice antes de escuchar.
    await speakFixedLine(call, OPENING_DISCLOSURE, deps);
    // Y la frase que cita los numeros medidos. `includeDisclosure: false` para
    // no repetir lo que se acaba de decir con mas detalle.
    await speakFixedLine(call, buildOpeningLine(ctx, { includeDisclosure: false }), deps);

    // El saludo termina proponiendo la primera actividad del care plan: el "si"
    // del paciente en el turno siguiente arranca la intervencion.
    call.pendingActivityId = firstGuided?.id ?? null;

    session.setState('listening');
    sink.state('listening');
  }

  return call;
}

// =============================================================================
// endCall
// =============================================================================

export interface EndCallResult {
  callId: string;
  outcome: EpisodeOutcome;
  encounterId: string | null;
  medplumUrl: string | null;
  durationSeconds: number;
}

/**
 * Cierra la llamada y escribe el episodio. **Idempotente y no lanza.**
 *
 * `outcomeOverride` lo usa el camino de escalacion, que ya sabe como acabo esto
 * (`escalated-emergency` / `escalated-human`); el resto de caminos deja que
 * `inferOutcome()` lo deduzca del estado de la sesion.
 */
export async function endCall(
  callId: string,
  reason: string,
  outcomeOverride: EpisodeOutcome | null = null,
): Promise<EndCallResult | null> {
  const call = calls.get(callId);
  if (call === undefined || call.ended) return null;
  call.ended = true;

  abortEverything(call);
  stopTicker(callId);

  const session = call.session;
  const outcome = outcomeOverride ?? session.inferOutcome();
  session.end();

  const durationSeconds = session.durationSeconds();
  emitCallEnded({ callId, outcome, durationSeconds });
  log.info('call.ended', { callId, outcome, reason, durationSeconds, turns: session.turns.length });

  let encounterId: string | null = null;
  let medplumUrl: string | null = null;

  try {
    const episode = session.buildEpisode(outcome);
    const written = await postEpisode(episode);
    if (written !== null) {
      encounterId = written.encounterId;
      medplumUrl = written.medplumUrl;
      emitEpisodeWritten({ callId, encounterId });
      log.info('episode.written', { callId, encounterId });
    } else {
      log.warn('episode.not-written', { callId, note: 'guardado en .episodes-pending/' });
    }
  } catch (err) {
    // Ni construyendo el episodio ni escribiendolo puede caerse el cierre: el
    // navegador tiene que recibir su `ended` igual.
    log.error('episode.failed', { callId, message: describeError(err) });
  }

  call.sink.ended({ outcome, encounterId, medplumUrl });
  call.sink.state('ended');
  calls.delete(callId);

  return { callId, outcome, encounterId, medplumUrl, durationSeconds };
}

/**
 * Cierra TODAS las llamadas vivas escribiendo su episodio.
 * Lo llama el apagado limpio en SIGINT/SIGTERM.
 */
export async function endAllCalls(reason: string): Promise<EndCallResult[]> {
  const results: EndCallResult[] = [];
  for (const callId of [...calls.keys()]) {
    const ended = await endCall(callId, reason);
    if (ended !== null) results.push(ended);
  }
  return results;
}

/** Solo para tests: vacia el registro sin escribir episodios. */
export function resetOrchestratorForTests(): void {
  for (const callId of [...tickers.keys()]) stopTicker(callId);
  calls.clear();
}
