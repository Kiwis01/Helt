/**
 * Log de loop-voice.
 *
 * Un evento = un registro estructurado `{ ts, level, callId, event, ...campos }`.
 * Ese registro se emite de dos formas, elegidas con `LOG_FORMAT`:
 *
 *   pretty (default)  18:22:11 INFO  call-8f2a redflag.evaluated triggered=false 3ms
 *   json              {"ts":"...","level":"info","callId":"call-8f2a",...}
 *
 * `pretty` es para el escenario: durante el demo alguien mira esta terminal y
 * tiene que poder leer de un vistazo que regla disparo. `json` es para cuando
 * queremos pasar la corrida por `jq` despues.
 *
 * Los ultimos 200 registros quedan en un anillo en memoria y se sirven en
 * `/api/v1/status`: si algo se rompe en el escenario no hay tiempo de buscar en
 * el scrollback de la terminal.
 *
 * =============================================================================
 *  DOS COSAS QUE ESTE ARCHIVO NUNCA IMPRIME
 * =============================================================================
 *  1. Credenciales. Cualquier campo cuya clave suene a secreto sale como
 *     `[REDACTADO]`, aunque quien loguea se haya equivocado al pasarlo.
 *  2. El transcript completo del paciente. Para eso esta `preview()`: devuelve
 *     longitud y los primeros 40 caracteres. El texto entero vive en la sesion
 *     y sale del proceso una sola vez, ya redactado, dentro del episodio.
 */

import { config } from './config.js';

// -----------------------------------------------------------------------------
// Niveles
// -----------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/**
 * El nivel se resuelve en CADA evento, no una vez al importar.
 *
 * Cuesta una busqueda en un objeto y permite bajar el ruido a mitad de una
 * sesion (`process.env.LOG_LEVEL = 'error'`) sin reiniciar el proceso. Lo usan
 * la suite de tests y el smoke, que no quieren la traza completa de una llamada
 * mezclada con sus asserts.
 */
function minLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? config.logLevel).trim().toLowerCase();
  return LEVEL_ORDER[raw as LogLevel] ?? LEVEL_ORDER.info;
}

/** `pretty` para el escenario, `json` para postmortem con jq. */
function format(): 'json' | 'pretty' {
  return (process.env.LOG_FORMAT ?? 'pretty').trim().toLowerCase() === 'json' ? 'json' : 'pretty';
}

// -----------------------------------------------------------------------------
// Anillo en memoria
// -----------------------------------------------------------------------------

export interface LogRecord {
  ts: string;
  level: LogLevel;
  callId: string | null;
  event: string;
  [key: string]: unknown;
}

const RING_CAPACITY = 200;
const ring: LogRecord[] = [];

/** Los ultimos registros, del mas antiguo al mas reciente. Para el runbook. */
export function recentLogs(limit = 50): LogRecord[] {
  const take = Math.min(Math.max(1, Math.floor(limit)), ring.length);
  return ring.slice(ring.length - take);
}

/** Solo para tests. */
export function resetLogRing(): void {
  ring.length = 0;
}

// -----------------------------------------------------------------------------
// Higiene
// -----------------------------------------------------------------------------

/**
 * Claves que jamas se imprimen con su valor. Es una red de seguridad: ningun
 * sitio del codigo deberia pasar una credencial al logger, pero si algun dia
 * alguien loguea un objeto de configuracion entero, aqui se corta.
 */
const SECRET_KEY_RE = /(key|secret|token|password|passwd|authorization|credential|apikey)/i;

const PREVIEW_CHARS = 40;

/**
 * Vista segura de un texto del paciente: longitud completa y los primeros 40
 * caracteres. Nunca se loguea el transcript entero.
 */
export function preview(text: string): { chars: number; head: string } {
  const value = typeof text === 'string' ? text : '';
  const head = value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
  return { chars: value.length, head };
}

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTADO]' : value;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Formato legible
// -----------------------------------------------------------------------------

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.includes(' ') ? `"${value}"` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[no-serializable]';
  }
}

const LEVEL_LABEL: Readonly<Record<LogLevel, string>> = Object.freeze({
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
});

function formatPretty(record: LogRecord): string {
  const clock = record.ts.slice(11, 19); // HH:MM:SS
  const scope = record.callId ?? '-';
  const extras = Object.entries(record)
    .filter(([key]) => key !== 'ts' && key !== 'level' && key !== 'callId' && key !== 'event')
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  return `${clock} ${LEVEL_LABEL[record.level]} ${scope} ${record.event}${extras ? ` ${extras}` : ''}`;
}

// -----------------------------------------------------------------------------
// Emision
// -----------------------------------------------------------------------------

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const clean = scrub(fields);
  const callIdRaw = clean['callId'];
  delete clean['callId'];

  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    callId: typeof callIdRaw === 'string' && callIdRaw !== '' ? callIdRaw : null,
    event,
    ...clean,
  };

  ring.push(record);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);

  if (LEVEL_ORDER[level] < minLevel()) return;

  const line = format() === 'json' ? JSON.stringify(record) : formatPretty(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * El logger del servicio.
 *
 * Uso: `log.info('turn.patient', { callId, ...preview(text) })`.
 * El primer argumento es SIEMPRE un nombre de evento estable (con punto), no
 * una frase: asi se puede filtrar y contar despues.
 */
export const log = {
  debug: (event: string, fields?: Record<string, unknown>): void => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>): void => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>): void => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>): void => emit('error', event, fields),
};

/** Mensaje legible de cualquier cosa que se haya lanzado. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
