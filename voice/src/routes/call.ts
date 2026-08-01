/**
 * La llamada: WebSocket con el navegador + inyeccion de turnos por HTTP.
 *
 *   GET  /api/v1/call/stream    WebSocket. Una conexion = una llamada.
 *   GET  /api/v1/call/socket    el mismo handler, otro nombre (ver abajo).
 *   POST /api/v1/call/simulate  mete un turno de paciente sin audio.
 *   GET  /api/v1/calls          las llamadas vivas, para el runbook.
 *
 * =============================================================================
 *  POR QUE DOS RUTAS PARA EL MISMO SOCKET
 * =============================================================================
 * `shared/constants.ts` congelo `API_PATHS.voice.callSocket = '/api/v1/call/socket'`
 * y el cliente del navegador prefiere `/api/v1/call/stream`. `shared/` es de
 * solo lectura para loop-voice, asi que en vez de romper el contrato de nadie o
 * pedir un PR a las 3 de la mañana, se montan las dos. Cuestan una linea y
 * eliminan una clase entera de fallo en el escenario.
 *
 * =============================================================================
 *  POR QUE EL STT VIVE AQUI Y NO EN EL NAVEGADOR
 * =============================================================================
 * El navegador manda PCM crudo y este proceso lo reenvia a Deepgram. Si el STT
 * corriera en el cliente, un navegador manipulado (o simplemente roto) podria
 * mandar el texto que quisiera —o no mandarlo— y el motor de red-flags dejaria
 * de ser una garantia para pasar a ser una sugerencia. Ademas la API key nunca
 * sale del servidor. Es la misma razon por la que `{"type":"text"}` entra por
 * `runPatientTurn` y no por un atajo: no puede existir un camino hacia el agente
 * que no pase por el motor de seguridad.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';

import { createSttRelay, type SttRelayWithFinalize } from '../audio/stt.js';
import { config } from '../config.js';
import { describeError, log, preview } from '../logger.js';
import {
  currentCall,
  endCall,
  getActiveCall,
  startCall,
} from '../orchestrator/callOrchestrator.js';
import { runPatientTurn, type ActiveCall, type CallSink } from '../orchestrator/turnPipeline.js';
import { sessionStore } from '../session/sessionStore.js';

export const WS_PATH_PRIMARY = '/api/v1/call/stream';
export const WS_PATH_ALIAS = '/api/v1/call/socket';
export const SIMULATE_PATH = '/api/v1/call/simulate';

// =============================================================================
// Sink hacia el navegador
// =============================================================================

/**
 * Traduce los eventos del pipeline a los mensajes JSON del protocolo del
 * Agente G. Todos los frames hacia el cliente son de TEXTO; el audio viaja en
 * base64 dentro de `{"type":"audio"}`.
 */
function createSocketSink(socket: WebSocket): CallSink {
  const send = (payload: Record<string, unknown>): void => {
    // readyState 1 = OPEN. Escribir en un socket cerrado no es un error del
    // servicio: el paciente colgo y la llamada sigue cerrandose por su cuenta.
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(payload));
  };

  return {
    transcript: (speaker, text, final) => send({ type: 'transcript', speaker, text, final }),

    audio: (result, seq) => {
      if (result.audio.length === 0) return; // provider 'none': turno mudo
      send({
        type: 'audio',
        mime: result.contentType,
        data: result.audio.toString('base64'),
        seq,
      });
    },

    state: (state) => send({ type: 'state', state }),

    escalation: (payload) =>
      send({
        type: 'escalation',
        rule: payload.rule,
        action: payload.action,
        script: payload.script,
        evidence: payload.evidence,
      }),

    coverage: (payload) =>
      send({
        type: 'coverage',
        status: payload.status,
        voiceSummary: payload.voiceSummary,
        copayCents: payload.copayCents,
        payerName: payload.payerName,
      }),

    biometrics: (payload) =>
      send({
        type: 'biometrics',
        heartRate: payload.heartRate,
        hrv: payload.hrv,
        respiratoryRate: payload.respiratoryRate,
      }),

    ready: (payload) => send({ type: 'ready', ...payload }),

    ended: (payload) =>
      send({
        type: 'ended',
        outcome: payload.outcome,
        encounterId: payload.encounterId,
        medplumUrl: payload.medplumUrl,
      }),

    error: (message, fatal) => send({ type: 'error', message, fatal }),
  };
}

// =============================================================================
// Mensajes del cliente
// =============================================================================

/**
 * Solo se valida `type`. El resto de campos se leen a mano y con tolerancia:
 * la regla del protocolo es que un `type` desconocido se IGNORA sin cerrar el
 * socket, para poder añadir mensajes sin romper a nadie.
 */
const clientMessageSchema = z.object({ type: z.string() }).passthrough();

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// =============================================================================
// El handler del socket
// =============================================================================

function handleSocket(socket: WebSocket, req: FastifyRequest): void {
  const sink = createSocketSink(socket);
  let call: ActiveCall | null = null;
  let relay: SttRelayWithFinalize | null = null;
  let starting = false;
  let closed = false;

  log.info('ws.connected', { path: req.url });

  /** Un turno del paciente, venga de la voz o del teclado. MISMO camino. */
  const feedTurn = (text: string, source: 'stt' | 'text'): void => {
    const active = call;
    if (active === null || active.ended) return;
    log.debug('turn.received', { callId: active.callId, source, ...preview(text) });
    // Sin `await`: un turno largo (la respiracion de caja dura 82 segundos) no
    // puede bloquear la lectura del socket, porque justo por ahi puede llegar el
    // turno que dispara una red-flag y corta esa misma intervencion.
    void runPatientTurn(active, text).catch((err) => {
      log.error('turn.failed', { callId: active.callId, message: describeError(err) });
      sink.error('No pude procesar ese turno, pero sigo contigo.', false);
    });
  };

  const openStt = (): void => {
    if (relay !== null) return;
    relay = createSttRelay({
      onPartial: (text) => sink.transcript('patient', text, false),
      onFinal: (text) => feedTurn(text, 'stt'),
      onError: (err) => {
        // Un fallo de STT NO es fatal: queda el respaldo por texto.
        log.warn('stt.error', { callId: call?.callId ?? null, message: err.message });
        sink.error('Se me cortó el audio un momento. Puedes escribirme si prefieres.', false);
      },
    });
    if (!relay.ready) {
      log.warn('stt.not-ready', {
        callId: call?.callId ?? null,
        note: 'sin DEEPGRAM_API_KEY o handshake en curso; el modo texto funciona igual',
      });
    }
  };

  const handleStart = async (payload: Record<string, unknown>): Promise<void> => {
    if (call !== null || starting) return;
    starting = true;
    try {
      const patientId = readString(payload, 'patientId') ?? config.patientId;
      const profile = readString(payload, 'profile') ?? undefined;
      call = await startCall(patientId, { sink, profile });
      openStt();
    } catch (err) {
      log.error('call.start-failed', { message: describeError(err) });
      sink.error('No pude iniciar la llamada.', true);
    } finally {
      starting = false;
    }
  };

  const finish = async (reason: string): Promise<void> => {
    const active = call;
    call = null;
    relay?.close();
    relay = null;
    if (active !== null && !active.ended) await endCall(active.callId, reason);
  };

  socket.on('message', (data: RawData, isBinary: boolean) => {
    // --- audio crudo del microfono ------------------------------------------
    if (isBinary) {
      if (relay === null) openStt();
      const chunk = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      relay?.pushAudio(chunk);
      return;
    }

    // --- mensajes de control -------------------------------------------------
    let payload: Record<string, unknown>;
    try {
      const parsed = clientMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) return; // basura: se ignora, el socket sigue vivo
      payload = parsed.data as Record<string, unknown>;
    } catch {
      log.debug('ws.bad-json', { callId: call?.callId ?? null });
      return;
    }

    const type = String(payload['type']);

    switch (type) {
      case 'start':
        void handleStart(payload);
        return;

      case 'speech-start':
        // Informativo. El primer frame binario ya implica inicio de habla.
        log.debug('ws.speech-start', { callId: call?.callId ?? null });
        return;

      case 'stop':
        // Cierra el turno YA en Deepgram, sin esperar al silencio.
        relay?.finalize();
        return;

      case 'text': {
        const text = readString(payload, 'text');
        if (text === null) return;
        // Sin eco aqui: `runPatientTurn` emite el turno del paciente como
        // primer paso, igual que con la voz. Ecoarlo tambien desde la ruta
        // mandaba el mismo `transcript` dos veces (el cliente lo deduplica,
        // pero mandar duplicados a proposito es pedirle perdon al cliente por
        // algo que podemos no hacer).
        feedTurn(text, 'text');
        return;
      }

      case 'end':
        void finish('el paciente colgo');
        return;

      case 'ping':
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'pong', at: payload['at'] ?? Date.now() }));
        }
        return;

      default:
        // REGLA DEL PROTOCOLO: un `type` desconocido no cierra el socket.
        log.debug('ws.unknown-type', { callId: call?.callId ?? null, messageType: type });
        return;
    }
  });

  socket.on('close', () => {
    if (closed) return;
    closed = true;
    log.info('ws.closed', { callId: call?.callId ?? null });
    // El socket puede morir sin `end` (pestaña cerrada, wifi del hackathon).
    // El episodio se escribe igual: es el unico registro duradero de la llamada.
    void finish('socket cerrado');
  });

  socket.on('error', (err: Error) => {
    log.warn('ws.error', { callId: call?.callId ?? null, message: err.message });
  });
}

// =============================================================================
// POST /api/v1/call/simulate
// =============================================================================

const simulateBodySchema = z.object({
  text: z.string().min(1),
  patientId: z.string().optional(),
  profile: z.string().optional(),
  /** Reusar la llamada viva en vez de crear una. Default true. */
  reuse: z.boolean().optional(),
});

/**
 * Mete un turno de paciente en el pipeline sin tocar el microfono.
 *
 * Es como se ensaya el camino de red-flag: no hace falta gritarle un sintoma
 * cardiaco a una laptop en una sala llena de gente para comprobar que la
 * escalacion funciona. Corre EXACTAMENTE el mismo `runPatientTurn` que la voz;
 * si esto escala, la llamada real escala.
 *
 * Si no hay llamada viva se crea una sin saludo: el turno inyectado es lo que
 * queremos observar, no la frase de apertura.
 */
async function handleSimulate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = simulateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.code(400).send({ error: 'body-invalido', hint: '{ "text": "me duele el pecho" }' });
    return;
  }

  const body = parsed.data;
  const reuse = body.reuse !== false;
  let call = reuse ? currentCall() : null;
  let created = false;

  if (call === null) {
    call = await startCall(body.patientId ?? config.patientId, {
      profile: body.profile,
      greet: false,
      ticks: false,
    });
    created = true;
  }

  const result = await runPatientTurn(call, body.text);

  reply.send({
    ok: true,
    callId: call.callId,
    createdCall: created,
    result,
    session: getActiveCall(call.callId)?.session.snapshot() ?? null,
  });
}

// =============================================================================
// GET /api/v1/calls
// =============================================================================

function handleCalls(_req: FastifyRequest, reply: FastifyReply): void {
  reply.send({
    active: sessionStore.active().map((session) => session.snapshot()),
    retained: sessionStore.size,
  });
}

// =============================================================================

export function registerCallRoutes(app: FastifyInstance): void {
  app.get(WS_PATH_PRIMARY, { websocket: true }, handleSocket);
  app.get(WS_PATH_ALIAS, { websocket: true }, handleSocket);
  app.post(SIMULATE_PATH, handleSimulate);
  app.get('/api/v1/calls', handleCalls);
}
