/**
 * Plumbing compartida de los clientes HTTP de loop-voice.
 *
 * Dos responsabilidades, las dos al servicio de la misma regla:
 * **la llamada del paciente nunca se cae por un downstream**.
 *
 *   1. `fetchJson` — wrapper sobre el fetch nativo de Node 24 con timeout,
 *      presupuesto total y como mucho UN reintento. NUNCA lanza: devuelve un
 *      resultado que el cliente inspecciona y degrada.
 *   2. `readFixture` — lectura de `shared/fixtures/`. Es el ultimo recurso de
 *      los dos clientes cuando :3001 o :3003 no contestan, y tambien el camino
 *      normal cuando `USE_MOCKS=true`. Tampoco lanza nunca.
 *
 * Vive junto a los clientes (y no en un `utils/`) porque es exactamente su
 * plomeria: nadie mas fuera de `clients/` deberia usarla.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// fetchJson
// =============================================================================

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface FetchJsonOptions {
  method?: HttpMethod;
  /** Se serializa con JSON.stringify. `undefined` = sin cuerpo. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Timeout de CADA intento. Default 2000ms. */
  timeoutMs?: number;
  /**
   * Reintentos ADICIONALES. Se capa en {@link MAX_RETRIES} = 1: hay una llamada
   * de voz esperando y un tercer intento ya es peor que degradar.
   * Default: 1 en GET (idempotente), 0 en el resto (POST podria duplicar).
   */
  retries?: number;
  /**
   * Presupuesto TOTAL de la operacion (todos los intentos + el backoff).
   * Default: sin restriccion extra sobre `timeoutMs * (retries + 1)`.
   * El reintento se salta si ya no cabe en el presupuesto, y el timeout del
   * segundo intento se recorta a lo que queda.
   */
  budgetMs?: number;
  /** Etiqueta corta para los logs, p.ej. 'core/context'. */
  label?: string;
}

export interface FetchJsonResult<T = unknown> {
  ok: boolean;
  /** Codigo HTTP. **0** = no hubo respuesta (timeout o error de red). */
  status: number;
  data: T | null;
  /** Mensaje legible. `null` si `ok`. */
  error: string | null;
  latencyMs: number;
  /** Intentos consumidos (1 o 2). */
  attempts: number;
  timedOut: boolean;
}

/** Tope duro de reintentos. No se sube. */
export const MAX_RETRIES = 1;

/** Espera entre el intento fallido y el reintento. Corta a proposito. */
export const RETRY_BACKOFF_MS = 120;

const DEFAULT_TIMEOUT_MS = 2000;

/** Maximo de caracteres del cuerpo que se copian a `error`. */
const SNIPPET_MAX = 120;

interface Attempt<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  timedOut: boolean;
}

/**
 * GET/POST JSON que **nunca lanza**.
 *
 * Todos los modos de fallo (timeout, DNS, conexion rechazada, 5xx, 4xx, cuerpo
 * que no es JSON) salen por el mismo sitio: `ok: false` con `error` poblado.
 * El que llama decide como degradar; aqui no se decide nada de producto.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<FetchJsonResult<T>> {
  const method: HttpMethod = options.method ?? 'GET';
  const perAttemptTimeout = normalizeTimeout(options.timeoutMs);
  const retries = normalizeRetries(options.retries, method);
  const budgetMs = normalizeBudget(options.budgetMs, perAttemptTimeout, retries);
  const label = options.label ?? `${method} ${url}`;

  const startedAt = performance.now();
  const elapsed = (): number => performance.now() - startedAt;

  let attempts = 0;
  let last: Attempt<T> = {
    ok: false,
    status: 0,
    data: null,
    error: 'sin intentos',
    timedOut: false,
  };

  for (let index = 0; index <= retries; index += 1) {
    const remaining = budgetMs - elapsed();
    if (remaining <= 0) break;

    attempts += 1;
    last = await attemptOnce<T>(url, method, options, Math.min(perAttemptTimeout, remaining));

    if (last.ok || !isRetryable(last)) break;
    if (index >= retries) break;

    // Solo reintentamos si el backoff + otro intento con sentido caben.
    if (elapsed() + RETRY_BACKOFF_MS >= budgetMs) break;
    console.warn(
      `[http] ${label} fallo (${describe(last)}) — reintento ${index + 1}/${retries} en ${RETRY_BACKOFF_MS}ms`,
    );
    await sleep(RETRY_BACKOFF_MS);
  }

  return {
    ok: last.ok,
    status: last.status,
    data: last.data,
    error: last.error,
    latencyMs: Math.round(elapsed()),
    attempts,
    timedOut: last.timedOut,
  };
}

async function attemptOnce<T>(
  url: string,
  method: HttpMethod,
  options: FetchJsonOptions,
  timeoutMs: number,
): Promise<Attempt<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // El timer no debe mantener vivo el proceso si todo lo demas ya termino.
  timer.unref?.();

  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  }

  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();

    let data: T | null = null;
    let parseError: string | null = null;
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text) as T;
      } catch {
        parseError = `respuesta no es JSON valido: ${snippet(text)}`;
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        error: `HTTP ${response.status}${text.trim() === '' ? '' : ` — ${snippet(text)}`}`,
        timedOut: false,
      };
    }
    if (parseError !== null) {
      return { ok: false, status: response.status, data: null, error: parseError, timedOut: false };
    }
    return { ok: true, status: response.status, data, error: null, timedOut: false };
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: `timeout tras ${timeoutMs}ms`,
        timedOut: true,
      };
    }
    return { ok: false, status: 0, data: null, error: `error de red: ${message(err)}`, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Que vale la pena reintentar: lo transitorio.
 * Un 4xx no cambia de opinion en 120ms, y un 200 con JSON roto tampoco.
 */
function isRetryable(attempt: Attempt<unknown>): boolean {
  if (attempt.timedOut) return true;
  if (attempt.status === 0) return true; // error de red
  if (attempt.status === 429) return true;
  return attempt.status >= 500;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return value;
}

function normalizeRetries(value: number | undefined, method: HttpMethod): number {
  const base = value ?? (method === 'GET' ? 1 : 0);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return Math.min(Math.floor(base), MAX_RETRIES);
}

function normalizeBudget(value: number | undefined, timeoutMs: number, retries: number): number {
  const natural = timeoutMs * (retries + 1) + RETRY_BACKOFF_MS * retries;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return natural;
  return Math.min(value, natural);
}

function describe(attempt: Attempt<unknown>): string {
  return attempt.status === 0 ? (attempt.error ?? 'sin respuesta') : `HTTP ${attempt.status}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recorta el cuerpo para el log. No se vuelca entero a proposito: puede traer
 * datos del paciente y esto acaba en stdout.
 */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SNIPPET_MAX ? flat : `${flat.slice(0, SNIPPET_MAX)}…`;
}

/**
 * Backoff entre intentos.
 *
 * OJO: este timer **no** se hace `unref`. Si se desreferencia y no queda nada
 * mas en el event loop (el fetch ya fallo con ECONNREFUSED, que es justo el
 * caso que nos importa), Node da por terminado el proceso y la promesa del
 * reintento no se resuelve nunca. Costo real de mantenerlo referenciado: 120ms.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

// =============================================================================
// Fixtures compartidos
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/voice/src/clients

/** `shared/fixtures/`. Se resuelve desde el modulo, no desde el cwd. */
export const FIXTURES_DIR = resolve(here, '../../../shared/fixtures');

const fixtureCache = new Map<string, unknown | null>();

/**
 * Lee y parsea un fixture de `shared/fixtures/`. **Nunca lanza**: devuelve
 * `null` si no existe o no es JSON. El resultado se memoiza (los fixtures no
 * cambian en caliente) — quien lo consuma debe validarlo con zod, que ya
 * devuelve un objeto nuevo en cada parse.
 *
 * `shared/` es de SOLO LECTURA para loop-voice: aqui solo se lee.
 */
export function readFixture<T = unknown>(fileName: string): T | null {
  if (fixtureCache.has(fileName)) return fixtureCache.get(fileName) as T | null;

  let parsed: unknown | null = null;
  try {
    const path = resolve(FIXTURES_DIR, fileName);
    // Cinturon: el nombre siempre es una constante del modulo, pero que un
    // '../..' no pueda sacarnos de shared/fixtures.
    if (path !== FIXTURES_DIR && !path.startsWith(FIXTURES_DIR + sep)) {
      throw new Error(`ruta fuera de shared/fixtures: ${fileName}`);
    }
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    console.warn(`[http] no se pudo leer el fixture ${fileName}: ${message(err)}`);
    parsed = null;
  }

  fixtureCache.set(fileName, parsed);
  return parsed as T | null;
}

/** Solo para tests: vacia la memoizacion de fixtures. */
export function resetFixtureCacheForTests(): void {
  fixtureCache.clear();
}
