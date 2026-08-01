/**
 * Stream SSE en vivo — Contrato 5. **Es la dependencia de Carlos.**
 *
 * Tres rutas, todas bajo `/api/v1/live`:
 *
 *   GET  /api/v1/live/stream       Server-Sent Events. Lo que consume el dashboard.
 *   GET  /api/v1/live/events       Los mismos eventos en JSON plano (debug / fallback).
 *   POST /api/v1/live/test-event   Inyecta un evento falso (checkpoint "SSE vivo", T+8h).
 *
 * Nada de esto toca el loop de la llamada: solo lee del `liveBus`.
 * Si el dashboard se cae, la llamada sigue. Si la llamada se cae, el dashboard
 * mantiene su conexion abierta y recibe el siguiente evento sin reconectar.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { liveEventTypeSchema, type LiveEventType } from '../types.js';
import {
  BUFFER_CAPACITY,
  DEFAULT_RECENT_LIMIT,
  LIVE_EVENT_TYPES,
  liveBus,
  type LiveEvent,
} from './bus.js';

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

export const STREAM_PATH = '/api/v1/live/stream';
export const EVENTS_PATH = '/api/v1/live/events';
export const TEST_EVENT_PATH = '/api/v1/live/test-event';

/**
 * Cada cuanto se manda el comentario `: ping`.
 *
 * Un stream SSE ocioso lo cierran los proxies (y algunos navegadores) a los
 * ~30-60s. Durante el demo puede haber medio minuto entre la conexion del
 * dashboard y el primer turno del paciente: sin heartbeat, esa conexion podria
 * estar muerta justo cuando llega `call.started`.
 */
export const HEARTBEAT_MS = 15_000;

// -----------------------------------------------------------------------------
// Serializacion SSE
// -----------------------------------------------------------------------------

/**
 * Convierte un evento del bus al formato de cable de SSE:
 *
 *     event: transcript.turn\n
 *     data: {"callId":"call-8f2a","speaker":"patient","text":"...","at":"..."}\n
 *     \n
 *
 * El JSON va SIEMPRE en una sola linea. Eso no es cosmetico: en SSE un salto de
 * linea dentro del payload termina el campo `data`, y el resto del texto se
 * interpreta como un campo nuevo (o basura). `JSON.stringify` ya escapa `\n`,
 * `\r`, comillas y tabuladores, asi que un turno del paciente con saltos de
 * linea o comillas viaja intacto.
 *
 * U+2028 / U+2029 no rompen a `EventSource` (solo CR y LF cuentan como fin de
 * linea), pero si rompen a cualquier consumidor que haga `eval`. Se escapan por
 * higiene: el coste es cero y no sabemos con que va a parsear Carlos.
 */
export function formatSseEvent(event: LiveEvent): string {
  return `event: ${event.type}\ndata: ${serializeData(event.data)}\n\n`;
}

function serializeData(data: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(data) ?? '{}';
  } catch {
    // Payload no serializable (referencia circular, BigInt...). Es un bug de
    // quien emitio, pero el stream del demo no se cae por eso.
    json = JSON.stringify({ error: 'payload-no-serializable' });
  }
  return json.replace(LINE_SEPARATOR_RE, '\\u2028').replace(PARAGRAPH_SEPARATOR_RE, '\\u2029');
}

/** U+2028 LINE SEPARATOR. Construido por codigo para que se vea en el diff. */
const LINE_SEPARATOR_RE = new RegExp(String.fromCharCode(0x2028), 'g');
/** U+2029 PARAGRAPH SEPARATOR. */
const PARAGRAPH_SEPARATOR_RE = new RegExp(String.fromCharCode(0x2029), 'g');

// -----------------------------------------------------------------------------
// GET /api/v1/live/stream
// -----------------------------------------------------------------------------

function handleStream(req: FastifyRequest, reply: FastifyReply): void {
  // Fastify deja de gestionar esta respuesta: la escribimos a mano y no termina
  // nunca (hasta que el cliente cuelgue). Sin `hijack()` Fastify esperaria un
  // `send()` que jamas llega.
  reply.hijack();

  const res = reply.raw;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // nginx y compania bufferean respuestas: esto lo desactiva. Sin ello el
    // dashboard veria los eventos a rafagas de 4KB en vez de en tiempo real.
    'X-Accel-Buffering': 'no',
    // CORS a mano. Al hacer `hijack()` las cabeceras que puso @fastify/cors con
    // `reply.header()` ya no se vuelcan (Fastify las aplica al enviar, y aqui
    // no enviamos). El dashboard vive en :3000 y este stream en :3002, asi que
    // sin esta linea el EventSource del navegador lo bloquea.
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  /** Idempotente: se llama desde 'close' del request, del socket y de un error. */
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const write = (chunk: string): void => {
    if (closed || res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    try {
      res.write(chunk);
    } catch {
      // Socket muerto a media escritura. Se limpia y se calla: un cliente SSE
      // caido no es un error del servicio de voz.
      cleanup();
    }
  };

  // 1. Comentario de apertura. Confirma al cliente que la conexion esta viva
  //    aunque todavia no haya pasado nada en la llamada.
  write(': connected\n\n');

  // 2. Replay del buffer. Un dashboard que conecta a mitad del demo se hidrata
  //    al instante en vez de mirar una pantalla vacia.
  for (const event of liveBus.recent()) {
    write(formatSseEvent(event));
  }

  // 3. Eventos nuevos.
  unsubscribe = liveBus.subscribe((event) => write(formatSseEvent(event)));

  // 4. Heartbeat contra proxies.
  heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref(); // no mantiene el proceso vivo por si solo

  // 5. Limpieza. Cero fugas: sin esto cada reconexion del dashboard dejaria un
  //    suscriptor y un intervalo huerfanos para el resto del proceso.
  req.raw.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// -----------------------------------------------------------------------------
// GET /api/v1/live/events?limit=50
// -----------------------------------------------------------------------------

/**
 * Mismo contenido que el stream, en JSON plano.
 *
 * Existe por dos motivos: depurar con `curl` sin quedarse colgado en un stream,
 * y tener un plan B si el `EventSource` falla en el escenario (el dashboard
 * puede hacer polling a esto cada segundo y el demo se ve igual).
 *
 * Nunca devuelve 400: un `limit` raro se clampea. Este endpoint no puede ser el
 * motivo de que el dashboard muestre un error en pantalla.
 */
function handleEvents(req: FastifyRequest, reply: FastifyReply): void {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const limit = parseLimit(query['limit']);
  const events = liveBus.recent(limit);

  reply.header('Cache-Control', 'no-cache').send({
    count: events.length,
    limit,
    /** Orden cronologico: antiguo -> reciente, igual que el replay del stream. */
    events,
  });
}

function parseLimit(raw: unknown): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(first);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECENT_LIMIT;
  return Math.min(Math.floor(parsed), BUFFER_CAPACITY);
}

// -----------------------------------------------------------------------------
// POST /api/v1/live/test-event
// -----------------------------------------------------------------------------

/**
 * Inyecta un evento falso en el bus. Es el checkpoint "SSE vivo" de T+8h:
 * **Carlos puede conectar y terminar su dashboard antes de que el loop de voz
 * exista.** No depende de Deepgram, ni de Bedrock, ni de :3001, ni de :3003.
 *
 * Body (todo opcional):
 *
 *   {
 *     "type": "transcript.turn",          // uno de los 7 del Contrato 5
 *     "data": { "callId": "...", ... }    // si falta, se genera un payload de
 *   }                                     // ejemplo valido para ese tipo
 *
 * Respuestas:
 *   202 -> { ok: true, emitted: { type, data } }   el evento ya salio al stream
 *   400 -> { error, validTypes }                   `type` no es uno de los 7
 *
 * Ejemplos:
 *
 *   # evento de ejemplo, sin pensar en el shape
 *   curl -X POST http://localhost:3002/api/v1/live/test-event \
 *        -H 'content-type: application/json' -d '{"type":"safety.escalation"}'
 *
 *   # evento con payload propio
 *   curl -X POST http://localhost:3002/api/v1/live/test-event \
 *        -H 'content-type: application/json' \
 *        -d '{"type":"transcript.turn","data":{"callId":"call-demo","speaker":"patient","text":"me cuesta respirar"}}'
 *
 * Nota: si `data` viene, se emite TAL CUAL (mas el `at` que sella el bus). No se
 * valida el shape a proposito, para poder probar como reacciona el dashboard a
 * un payload incompleto.
 */
const testEventBodySchema = z.object({
  type: liveEventTypeSchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

function handleTestEvent(req: FastifyRequest, reply: FastifyReply): void {
  const parsed = testEventBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    reply.code(400).send({
      error: 'body-invalido',
      hint: 'Body opcional: { "type": <uno de validTypes>, "data": { ... } }',
      validTypes: LIVE_EVENT_TYPES,
    });
    return;
  }

  const type: LiveEventType = parsed.data.type ?? 'transcript.turn';
  const data = parsed.data.data ?? sampleDataFor(type);

  liveBus.emit(type, data);

  // Se devuelve el evento tal como quedo en el bus (con su `at` sellado), para
  // que Carlos pueda comparar contra lo que le llego por el stream.
  const emitted = liveBus.recent(1)[0] ?? null;
  reply.code(202).send({ ok: true, emitted });
}

/**
 * Payload de ejemplo por tipo de evento. Numeros coherentes con el fixture del
 * demo (`shared/fixtures/context.happy.json`): baseline 68 bpm, episodio a 118.
 */
function sampleDataFor(type: LiveEventType): Record<string, unknown> {
  const callId = `call-test-${Math.random().toString(16).slice(2, 6)}`;

  switch (type) {
    case 'call.started':
      return { callId, patientId: 'loop-demo-patient-001' };
    case 'transcript.turn':
      return {
        callId,
        speaker: 'patient',
        text: 'Siento el corazon muy acelerado y me cuesta respirar.',
      };
    case 'biometrics.tick':
      return { callId, heartRate: 118, hrv: 21, respiratoryRate: 24 };
    case 'safety.escalation':
      return { callId, rule: 'RF-01-CHEST-PAIN-RADIATING', action: 'advise-911' };
    case 'coverage.check':
      return { callId, checkId: 'cov-1a2b', status: 'covered', copayCents: 2500 };
    case 'call.ended':
      return { callId, outcome: 'resolved-with-intervention', durationSeconds: 188 };
    case 'episode.written':
      return { callId, encounterId: 'enc-0042' };
  }
}

// -----------------------------------------------------------------------------
// Registro
// -----------------------------------------------------------------------------

/** Monta las tres rutas de `/api/v1/live` en la instancia de Fastify. */
export function registerSseRoutes(app: FastifyInstance): void {
  app.get(STREAM_PATH, handleStream);
  app.get(EVENTS_PATH, handleEvents);
  app.post(TEST_EVENT_PATH, handleTestEvent);
}
