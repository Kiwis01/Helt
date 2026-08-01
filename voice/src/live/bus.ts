/**
 * Bus de eventos en vivo — Contrato 5.
 *
 * loop-voice emite, el dashboard de Carlos (:3000) consume via SSE.
 * Es un EventEmitter tipado, en memoria, sin dependencias y sin I/O:
 * emitir NUNCA puede fallar ni bloquear el loop de la llamada.
 *
 * Tres garantias que el resto del servicio da por hechas:
 *
 *   1. `emit` sella cada evento con `at` (ISO-8601) si no viene ya.
 *   2. Un suscriptor que lanza NO rompe a los demas ni al emisor. Si un cliente
 *      SSE se muere a media escritura, la llamada del paciente sigue viva.
 *   3. `recent()` guarda los ultimos eventos en un buffer circular, para que un
 *      dashboard que se conecta tarde no vea una pantalla vacia. Ese es el
 *      riesgo explicito del brief de Carlos: el demo dura 3 minutos y no hay
 *      segunda oportunidad para reconectar.
 *
 * Los shapes de `data` de los helpers son LITERALMENTE los del Contrato 5.
 * Usa siempre un helper, nunca `liveBus.emit` a pelo, salvo para reproducir un
 * evento que ya trae su propio `at` (replay / tests).
 */

import type {
  CoverageStatus,
  EpisodeOutcome,
  LiveEvent,
  LiveEventType,
} from '../types.js';

export type { LiveEvent, LiveEventType };

// -----------------------------------------------------------------------------
// Estado del bus (modulo singleton)
// -----------------------------------------------------------------------------

/** Cuantos eventos se retienen para el replay de un cliente que llega tarde. */
export const BUFFER_CAPACITY = 200;

/** Limite por defecto de `recent()` y del endpoint `/api/v1/live/events`. */
export const DEFAULT_RECENT_LIMIT = 50;

/** Los 7 tipos del Contrato 5, en orden narrativo de una llamada. */
export const LIVE_EVENT_TYPES: readonly LiveEventType[] = Object.freeze([
  'call.started',
  'transcript.turn',
  'biometrics.tick',
  'safety.escalation',
  'coverage.check',
  'call.ended',
  'episode.written',
] as const);

type Listener = (event: LiveEvent) => void;

/** Cada `subscribe` mete un wrapper distinto: la misma fn puede suscribirse dos veces. */
const listeners = new Set<Listener>();

/** Buffer circular. El indice 0 es el mas antiguo. */
const buffer: LiveEvent[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

// -----------------------------------------------------------------------------
// El bus
// -----------------------------------------------------------------------------

/**
 * Interfaz CONGELADA. Otros modulos dependen de ella literalmente.
 * Lo auxiliar (reset, contadores) vive en funciones sueltas, fuera del objeto.
 */
export const liveBus: {
  emit(type: LiveEventType, data: Record<string, unknown>): void;
  subscribe(fn: (e: LiveEvent) => void): () => void;
  recent(limit?: number): LiveEvent[];
} = {
  emit(type, data) {
    // `at` se respeta si ya viene (replay de un episodio, tests deterministas);
    // si no, se sella aqui. El dashboard ordena por este campo.
    const incomingAt = data['at'];
    const at =
      typeof incomingAt === 'string' && incomingAt.trim() !== '' ? incomingAt : nowIso();

    // Congelado: `recent()` reparte referencias al mismo objeto a N clientes
    // SSE. Que ninguno pueda mutar lo que otro va a serializar.
    const event: LiveEvent = { type, data: { ...data, at } };
    Object.freeze(event.data);
    Object.freeze(event);

    buffer.push(event);
    if (buffer.length > BUFFER_CAPACITY) {
      buffer.splice(0, buffer.length - BUFFER_CAPACITY);
    }

    // Copia de la lista: un suscriptor puede darse de baja durante su propio
    // callback (justo lo que hace el handler SSE cuando el socket ya murio).
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        // Aislado a proposito: el bus nunca propaga el fallo de un consumidor.
        console.error(`[live] suscriptor fallo procesando "${type}":`, err);
      }
    }
  },

  subscribe(fn) {
    const wrapper: Listener = (event) => fn(event);
    listeners.add(wrapper);
    let active = true;
    return () => {
      if (!active) return; // idempotente: llamar dos veces no borra a otro
      active = false;
      listeners.delete(wrapper);
    };
  },

  recent(limit = DEFAULT_RECENT_LIMIT) {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const take = Math.min(Math.floor(limit), buffer.length);
    // Orden cronologico (antiguo -> reciente): el dashboard reproduce el hilo
    // de la conversacion tal como paso, no al reves.
    return buffer.slice(buffer.length - take);
  },
};

// -----------------------------------------------------------------------------
// Auxiliares (fuera de la interfaz congelada)
// -----------------------------------------------------------------------------

/** Cuantos suscriptores activos hay. Sirve para detectar fugas de clientes SSE. */
export function subscriberCount(): number {
  return listeners.size;
}

/** Cuantos eventos hay retenidos ahora mismo. */
export function bufferedCount(): number {
  return buffer.length;
}

/**
 * Vacia buffer y suscriptores. **Solo para tests.** En produccion el bus vive
 * lo que vive el proceso.
 */
export function resetLiveBus(): void {
  listeners.clear();
  buffer.length = 0;
}

// -----------------------------------------------------------------------------
// Helpers tipados — un shape por evento, identico al Contrato 5
// -----------------------------------------------------------------------------
//
// Cada helper construye el objeto campo a campo (nada de spread del argumento):
// asi es imposible que un campo de mas se cuele al stream del dashboard.
// El campo `at` NO se pasa: lo sella `liveBus.emit`.

/** `call.started` — arranca la llamada. Primer evento de toda sesion. */
export interface CallStartedData {
  callId: string;
  patientId: string;
}

export function emitCallStarted(input: CallStartedData): void {
  liveBus.emit('call.started', {
    callId: input.callId,
    patientId: input.patientId,
  });
}

/** `transcript.turn` — un turno cerrado, del paciente o del agente. */
export interface TranscriptTurnData {
  callId: string;
  speaker: 'patient' | 'agent';
  /** Texto YA redactado si va a persistirse. Aqui va tal cual se locuta. */
  text: string;
}

export function emitTranscriptTurn(input: TranscriptTurnData): void {
  liveBus.emit('transcript.turn', {
    callId: input.callId,
    speaker: input.speaker,
    text: input.text,
  });
}

/** `biometrics.tick` — lectura del wearable durante la llamada. */
export interface BiometricsTickData {
  callId: string;
  heartRate: number;
  hrv: number;
  respiratoryRate: number;
}

export function emitBiometricsTick(input: BiometricsTickData): void {
  liveBus.emit('biometrics.tick', {
    callId: input.callId,
    heartRate: input.heartRate,
    hrv: input.hrv,
    respiratoryRate: input.respiratoryRate,
  });
}

/**
 * `safety.escalation` — disparo el motor de red-flags.
 *
 * Es EL evento del demo: cuando esto sale por el stream, el LLM ya no vio el
 * turno y la llamada se esta cerrando. `rule` es el ID exacto de la regla
 * (p.ej. "RF-01-CHEST-PAIN-RADIATING") para que el juez lo lea en pantalla.
 *
 * `action` va como `string` a proposito: el motor devuelve `advise-911` /
 * `advise-988` / `connect-human`, pero el ejemplo del brief muestra tambien la
 * forma en pasado ("advised-911"). El dashboard solo lo pinta; no se rompe por
 * la variante, y no vale la pena bloquear a Carlos por un participio.
 */
export interface SafetyEscalationData {
  callId: string;
  rule: string;
  action: string;
}

export function emitSafetyEscalation(input: SafetyEscalationData): void {
  liveBus.emit('safety.escalation', {
    callId: input.callId,
    rule: input.rule,
    action: input.action,
  });
}

/** `coverage.check` — resultado de loop-coverage (:3003). `copayCents` puede ser null. */
export interface CoverageCheckData {
  callId: string;
  checkId: string;
  status: CoverageStatus;
  copayCents: number | null;
}

export function emitCoverageCheck(input: CoverageCheckData): void {
  liveBus.emit('coverage.check', {
    callId: input.callId,
    checkId: input.checkId,
    status: input.status,
    copayCents: input.copayCents,
  });
}

/** `call.ended` — la llamada se cerro, con su outcome del Contrato 2. */
export interface CallEndedData {
  callId: string;
  outcome: EpisodeOutcome;
  durationSeconds: number;
}

export function emitCallEnded(input: CallEndedData): void {
  liveBus.emit('call.ended', {
    callId: input.callId,
    outcome: input.outcome,
    durationSeconds: input.durationSeconds,
  });
}

/** `episode.written` — loop-core (:3001) confirmo el Encounter. Ultimo evento. */
export interface EpisodeWrittenData {
  callId: string;
  encounterId: string;
}

export function emitEpisodeWritten(input: EpisodeWrittenData): void {
  liveBus.emit('episode.written', {
    callId: input.callId,
    encounterId: input.encounterId,
  });
}
