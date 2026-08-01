/**
 * STT: relay hacia Deepgram Listen (WebSocket, nova-3, language=multi).
 *
 * POR QUE VIVE EN EL SERVIDOR Y NO EN EL BROWSER
 * ----------------------------------------------
 * El browser abre un WS contra :3002 y manda PCM crudo (linear16, 16 kHz, mono).
 * Este relay lo reenvia a Deepgram. Dos razones, ambas de seguridad:
 *   1. El motor de red-flags DEBE ver el transcript en el servidor. Si el STT
 *      corriera en el browser, un cliente manipulado podria saltarse la
 *      evaluacion de seguridad simplemente no mandando el texto.
 *   2. `DEEPGRAM_API_KEY` nunca sale al browser.
 *
 * ACUMULACION DE TURNO
 * --------------------
 * Deepgram entrega varios `is_final` sueltos dentro de una misma frase. El
 * motor de red-flags necesita la frase ENTERA para matchear
 * "dolor de pecho **que se va al brazo**": si se le entrega "me duele el pecho"
 * y "y se me va al brazo" por separado, RF-01 no dispara. Por eso los finales
 * parciales se acumulan y solo se entrega `onFinal` con el turno completo,
 * cerrado por `speech_final` o por `UtteranceEnd`.
 */

import WebSocket from 'ws';

import { config } from '../config.js';
import type { SttHandlers, SttRelay } from '../types.js';

// -----------------------------------------------------------------------------
// Constantes del formato de audio (el cliente del browser debe usar las mismas)
// -----------------------------------------------------------------------------

/** PCM 16 bit little-endian. */
export const STT_ENCODING = 'linear16';
/** 16 kHz mono: suficiente para voz y un tercio del ancho de banda de 48 kHz. */
export const STT_SAMPLE_RATE = 16_000;
export const STT_CHANNELS = 1;

/** Redaccion de PII en el propio Deepgram: el texto crudo nunca toca disco. */
const DEFAULT_REDACT = 'pii';

/** Ping de keepalive: Deepgram cierra por inactividad a los ~10s. */
const KEEPALIVE_MS = 8_000;

/** Tope del buffer previo a la apertura del socket (~30s de audio a 16 kHz). */
const MAX_PENDING_BYTES = 1_000_000;

/** Margen para que Deepgram procese el `CloseStream` antes de cerrar el socket. */
const CLOSE_GRACE_MS = 500;

// -----------------------------------------------------------------------------
// Parser de mensajes de Deepgram — PURO, testeable en aislamiento
// -----------------------------------------------------------------------------

export type DeepgramMessageKind =
  | 'partial'
  | 'final'
  | 'utterance-end'
  | 'speech-started'
  | 'metadata'
  | 'error'
  | 'ignore';

export interface DeepgramMessage {
  kind: DeepgramMessageKind;
  /** Transcript del mensaje, ya trimmeado. Cadena vacia si no aplica. */
  text: string;
  /** Solo relevante con `kind === 'final'`: Deepgram considera cerrado el turno. */
  speechFinal: boolean;
  /** Descripcion cuando `kind === 'error'`. */
  detail: string | null;
}

const IGNORED: DeepgramMessage = Object.freeze({
  kind: 'ignore',
  text: '',
  speechFinal: false,
  detail: null,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractTranscript(message: Record<string, unknown>): string {
  const channel = asRecord(message.channel);
  if (!channel) return '';
  const alternatives = channel.alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return '';
  const best = asRecord(alternatives[0]);
  const transcript = best?.transcript;
  return typeof transcript === 'string' ? transcript.trim() : '';
}

/**
 * Traduce un frame de Deepgram Listen a la forma minima que le importa al
 * relay. Funcion PURA: acepta el JSON crudo (string, Buffer u objeto ya
 * parseado) y nunca lanza — cualquier basura cae en `kind: 'ignore'`.
 */
export function parseDeepgramMessage(raw: string | Buffer | unknown): DeepgramMessage {
  let payload: unknown = raw;

  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (text !== null) {
    try {
      payload = JSON.parse(text);
    } catch {
      return IGNORED;
    }
  }

  const message = asRecord(payload);
  if (!message) return IGNORED;

  const type = typeof message.type === 'string' ? message.type : '';

  // Algunos despliegues de Listen omiten `type` en los frames de resultados.
  const looksLikeResults = type === 'Results' || (type === '' && asRecord(message.channel) !== null);

  if (looksLikeResults) {
    const isFinal = message.is_final === true;
    return {
      kind: isFinal ? 'final' : 'partial',
      text: extractTranscript(message),
      speechFinal: message.speech_final === true,
      detail: null,
    };
  }

  switch (type) {
    case 'UtteranceEnd':
      return { kind: 'utterance-end', text: '', speechFinal: true, detail: null };
    case 'SpeechStarted':
      return { kind: 'speech-started', text: '', speechFinal: false, detail: null };
    case 'Metadata':
      return { kind: 'metadata', text: '', speechFinal: false, detail: null };
    case 'Error': {
      const description = message.description ?? message.message ?? message.error;
      return {
        kind: 'error',
        text: '',
        speechFinal: false,
        detail: typeof description === 'string' ? description : 'error de Deepgram',
      };
    }
    default:
      return IGNORED;
  }
}

// -----------------------------------------------------------------------------
// Ensamblador de turnos — sin red, testeable en aislamiento
// -----------------------------------------------------------------------------

export interface TurnAssembler {
  accept(message: DeepgramMessage): void;
  /** Cierra el turno con lo acumulado (si hay algo) y lo entrega en `onFinal`. */
  flush(): void;
  /** Texto acumulado del turno en curso. Solo lectura, util para diagnostico. */
  readonly pending: string;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Junta los `is_final` sueltos de Deepgram en un turno completo del paciente.
 * El turno se cierra con `speech_final` o, si Deepgram no lo manda, con
 * `UtteranceEnd`.
 */
export function createTurnAssembler(handlers: SttHandlers): TurnAssembler {
  let segments: string[] = [];

  function pendingText(): string {
    return normalize(segments.join(' '));
  }

  function flush(): void {
    const turn = pendingText();
    segments = [];
    if (turn) handlers.onFinal(turn);
  }

  return {
    get pending(): string {
      return pendingText();
    },
    flush,
    accept(message: DeepgramMessage): void {
      switch (message.kind) {
        case 'partial': {
          if (!message.text) return;
          // Se entrega el turno en curso COMPLETO, no solo el fragmento nuevo:
          // el dashboard pinta una linea que crece, no fragmentos sueltos.
          handlers.onPartial(normalize([...segments, message.text].join(' ')));
          return;
        }
        case 'final': {
          if (message.text) segments.push(message.text);
          if (message.speechFinal) flush();
          return;
        }
        case 'utterance-end':
          flush();
          return;
        case 'error':
          handlers.onError(new Error(message.detail ?? 'deepgram-stt: error sin descripcion'));
          return;
        default:
          return;
      }
    },
  };
}

// -----------------------------------------------------------------------------
// URL de conexion — pura
// -----------------------------------------------------------------------------

export interface ListenUrlOptions {
  model?: string;
  language?: string;
  /** `null` desactiva la redaccion (solo para el reintento de compatibilidad). */
  redact?: string | null;
}

/** Construye la URL de Deepgram Listen con los parametros del brief. */
export function buildListenUrl(opts: ListenUrlOptions = {}): string {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  const query = url.searchParams;

  query.set('model', opts.model ?? config.deepgram.sttModel);
  query.set('language', opts.language ?? config.deepgram.sttLanguage);
  query.set('encoding', STT_ENCODING);
  query.set('sample_rate', String(STT_SAMPLE_RATE));
  query.set('channels', String(STT_CHANNELS));
  query.set('smart_format', 'true');
  // `interim_results` es requisito de `utterance_end_ms`, ademas de alimentar
  // el transcript en vivo del dashboard.
  query.set('interim_results', 'true');
  query.set('endpointing', '300');
  query.set('utterance_end_ms', '1000');
  query.set('punctuate', 'true');

  const redact = opts.redact === undefined ? DEFAULT_REDACT : opts.redact;
  if (redact) query.set('redact', redact);

  return url.toString();
}

// -----------------------------------------------------------------------------
// Relay
// -----------------------------------------------------------------------------

/**
 * `SttRelay` mas el cierre explicito de turno.
 *
 * `finalize()` es aditivo sobre la interfaz congelada: el protocolo del cliente
 * manda `{"type":"stop"}` al soltar el push-to-talk y el servidor tiene que
 * cerrar el turno YA. Esperar al endpointing por silencio no sirve en el
 * escenario, donde hay ruido de fondo y el VAD puede tardar segundos — segundos
 * en los que el motor de red-flags todavia no ha visto la frase.
 */
export interface SttRelayWithFinalize extends SttRelay {
  /** Manda `Finalize` a Deepgram: cierra el turno en curso sin esperar silencio. */
  finalize(): void;
}

/**
 * Relay inerte: sin `DEEPGRAM_API_KEY` no hay voz, pero el servidor tiene que
 * arrancar igual y aceptar texto escrito. El motor de red-flags no depende de
 * ninguna credencial, y ese es el entregable irrenunciable del brief.
 */
function createInertRelay(): SttRelayWithFinalize {
  console.warn('[stt] WARN: falta DEEPGRAM_API_KEY — relay inerte, sin voz. Usa la entrada de texto.');
  return {
    pushAudio(): void {
      /* sin destino */
    },
    finalize(): void {
      /* nada que finalizar */
    },
    close(): void {
      /* nada que cerrar */
    },
    get ready(): boolean {
      return false;
    },
  };
}

/**
 * Abre el relay hacia Deepgram Listen.
 *
 * - `pushAudio` bufferea mientras el socket no esta abierto y vacia al abrir,
 *   asi que el cliente puede empezar a grabar sin esperar el handshake.
 * - `close` manda `CloseStream` y cierra limpio.
 * - Keepalive cada 8s.
 * - Nunca lanza: los fallos van por `handlers.onError`.
 */
export function createSttRelay(handlers: SttHandlers): SttRelayWithFinalize {
  const apiKey = config.deepgram.apiKey;
  if (!apiKey) return createInertRelay();

  const assembler = createTurnAssembler(handlers);

  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let socket: WebSocket | null = null;
  let keepAlive: NodeJS.Timeout | null = null;
  let closedByCaller = false;
  let everOpened = false;
  let retriedWithoutRedact = false;

  function stopKeepAlive(): void {
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  }

  function flushPending(ws: WebSocket): void {
    for (const chunk of pending) ws.send(chunk);
    pending.length = 0;
    pendingBytes = 0;
  }

  function connect(redact: string | null): void {
    const url = buildListenUrl({ redact });
    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    socket = ws;

    ws.on('open', () => {
      everOpened = true;
      console.info(
        `[stt] conectado a Deepgram model=${config.deepgram.sttModel} language=${config.deepgram.sttLanguage} redact=${redact ?? 'off'}`,
      );
      flushPending(ws);
      stopKeepAlive();
      keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, KEEPALIVE_MS);
      keepAlive.unref();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        assembler.accept(parseDeepgramMessage(Buffer.isBuffer(data) ? data : String(data)));
      } catch (err) {
        handlers.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on('error', (err: Error) => {
      console.warn(`[stt] error de socket: ${err.message}`);
      handlers.onError(err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      stopKeepAlive();
      if (closedByCaller) {
        console.info('[stt] socket cerrado (cierre solicitado)');
        return;
      }

      const detail = reason.length > 0 ? reason.toString('utf8') : 'sin detalle';

      // Compatibilidad: si el socket nunca llego a abrir y llevaba `redact`,
      // se reintenta una sola vez sin ese parametro. Preferimos un transcript
      // sin redaccion de Deepgram (la capa `redaction/` redacta igual antes de
      // persistir) a quedarnos sin voz en el escenario.
      if (!everOpened && redact !== null && !retriedWithoutRedact) {
        retriedWithoutRedact = true;
        console.warn(
          `[stt] Deepgram rechazo la conexion (code=${code} ${detail}); reintentando sin redact=${redact}`,
        );
        connect(null);
        return;
      }

      // Caida inesperada con audio a medias: se entrega el turno para que el
      // motor de red-flags lo vea. Perder la ultima frase es inaceptable.
      assembler.flush();
      console.warn(`[stt] socket cerrado inesperadamente code=${code} ${detail}`);
      handlers.onError(new Error(`deepgram-stt: socket cerrado (code=${code})`));
    });
  }

  connect(DEFAULT_REDACT);

  return {
    get ready(): boolean {
      return socket !== null && socket.readyState === WebSocket.OPEN;
    },

    pushAudio(chunk: Buffer): void {
      if (closedByCaller || chunk.length === 0) return;

      const ws = socket;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
        return;
      }

      // Todavia en handshake (o reintentando): se bufferea con tope para no
      // crecer sin limite si Deepgram nunca abre.
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes > MAX_PENDING_BYTES && pending.length > 0) {
        const dropped = pending.shift();
        pendingBytes -= dropped ? dropped.length : 0;
      }
    },

    /**
     * Cierra el turno en curso. Deepgram devuelve el `is_final` +
     * `speech_final` de lo que lleve acumulado, y el ensamblador entrega el
     * turno completo por `onFinal`. Si el socket aun no esta abierto no hay
     * nada que finalizar: el `utterance_end_ms` cerrara el turno igual.
     */
    finalize(): void {
      if (closedByCaller) return;
      const ws = socket;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Finalize' }));
      }
    },

    close(): void {
      if (closedByCaller) return;
      closedByCaller = true;
      stopKeepAlive();
      pending.length = 0;
      pendingBytes = 0;

      const ws = socket;
      if (!ws) return;

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        // Deepgram cierra el socket tras vaciar su buffer; si tarda, se fuerza.
        const timer = setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        }, CLOSE_GRACE_MS);
        timer.unref();
        return;
      }

      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    },
  };
}
