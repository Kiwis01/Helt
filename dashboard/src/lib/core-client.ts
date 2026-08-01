/**
 * Cliente de loop-core (:3001) — Contratos 4 y 6.
 *
 * Contrato de esta capa, en una frase: **nunca lanza y nunca devuelve vacío.**
 *
 * Cada lectura hace fetch con timeout, valida la respuesta contra el esquema
 * zod de `@loop/shared` y, ante cualquier problema (red caída, timeout,
 * 500, JSON con otra forma), devuelve el fixture equivalente marcado con
 * `source: 'fixture'`. Quien consume esto no necesita try/catch ni estados de
 * error: siempre recibe datos pintables y el motivo por el que llegaron.
 *
 * Marcar el origen no es un detalle: si el dashboard puede caer a fixtures en
 * silencio, alguien acaba enseñando datos inventados creyendo que son reales.
 * Por eso `DataResult.source` sube hasta un badge visible en pantalla.
 */

import type { ZodType } from 'zod';

import { TIMEOUTS_MS } from '@loop/shared/constants';
import {
  DemoResetResponse,
  DemoSpikeResponse,
  EpisodeList,
  ObservationSeries,
  OutcomesSummary,
  PatientSummary,
  type DemoProfile,
  type ObservationMetric,
} from '@loop/shared/contracts';

import { config } from './config';
import {
  FIXTURE_EPISODES,
  FIXTURE_OBSERVATIONS,
  FIXTURE_OUTCOMES,
  FIXTURE_SUMMARY,
} from './fixtures';

/* ================================================================== */
/* Tipos del resultado                                                 */
/* ================================================================== */

export type DataSource = 'live' | 'fixture';

/** Por qué se acabó leyendo del fixture. `null` cuando la lectura fue en vivo. */
export type FallbackReason =
  | 'fixtures-mode'
  | 'timeout'
  | 'network'
  | 'http-error'
  | 'invalid-schema'
  | null;

export interface DataResult<T> {
  data: T;
  source: DataSource;
  reason: FallbackReason;
  /** Detalle técnico corto para el badge y la consola. Nunca se muestra solo. */
  detail: string | null;
}

/** Texto en español para el badge de origen y los mensajes inline. */
export function describeReason(reason: FallbackReason): string {
  switch (reason) {
    case 'fixtures-mode':
      return 'modo respaldo activo';
    case 'timeout':
      return `loop-core no respondió en ${TIMEOUTS_MS.contextFetch} ms`;
    case 'network':
      return 'loop-core no está disponible';
    case 'http-error':
      return 'loop-core devolvió un error';
    case 'invalid-schema':
      return 'la respuesta no cumple el contrato';
    default:
      return 'datos en vivo';
  }
}

/**
 * Origen agregado de varias lecturas. Basta con que una caiga a fixtures para
 * que la página entera deje de poder presumir de datos en vivo.
 */
export function aggregateSource(results: readonly DataResult<unknown>[]): DataResult<null> {
  const fallen = results.find((r) => r.source === 'fixture');
  if (!fallen) {
    return { data: null, source: 'live', reason: null, detail: null };
  }
  return { data: null, source: 'fixture', reason: fallen.reason, detail: fallen.detail };
}

/* ================================================================== */
/* Motor de peticiones                                                 */
/* ================================================================== */

const API_PREFIX = '/api/v1';

function url(path: string): string {
  return `${config.coreUrl}${API_PREFIX}${path}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallback<T>(data: T, reason: FallbackReason, detail: string | null = null): DataResult<T> {
  return { data, source: 'fixture', reason, detail };
}

/**
 * Petición + timeout + validación, con el fixture ya resuelto por el llamante.
 *
 * `fixtureData` se pasa por valor y no como getter perezoso justamente para
 * que esta función no tenga ninguna ruta capaz de lanzar: el peor caso
 * posible es devolver el objeto que ya se tenía en la mano.
 */
async function request<T>(
  path: string,
  schema: ZodType<T>,
  fixtureData: T,
  init?: RequestInit,
): Promise<DataResult<T>> {
  if (config.useFixtures) {
    return fallback(fixtureData, 'fixtures-mode');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS_MS.contextFetch);

  try {
    const response = await fetch(url(path), {
      ...init,
      signal: controller.signal,
      // El dashboard se proyecta en vivo: una respuesta cacheada durante el
      // demo es peor que una lenta.
      cache: 'no-store',
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });

    if (!response.ok) {
      return fallback(fixtureData, 'http-error', `HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fallback(fixtureData, 'invalid-schema', 'la respuesta no es JSON');
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join('.') || 'raíz';
      return fallback(fixtureData, 'invalid-schema', `${where}: ${issue?.message ?? 'forma inesperada'}`);
    }

    return { data: parsed.data, source: 'live', reason: null, detail: null };
  } catch (error) {
    // `AbortController` no distingue causas: si abortamos nosotros fue el
    // timeout, cualquier otra cosa es la red o el host caído.
    const reason: FallbackReason = controller.signal.aborted ? 'timeout' : 'network';
    return fallback(fixtureData, reason, messageOf(error));
  } finally {
    clearTimeout(timer);
  }
}

/* ================================================================== */
/* CONTRATO 4 — Lecturas del dashboard                                 */
/* ================================================================== */

/** GET /api/v1/patients/:id/summary */
export function fetchSummary(patientId: string = config.patientId): Promise<DataResult<PatientSummary>> {
  return request(`/patients/${encodeURIComponent(patientId)}/summary`, PatientSummary, FIXTURE_SUMMARY);
}

export interface ObservationQuery {
  metric: ObservationMetric;
  /** ISO-8601. Si se omiten, loop-core decide la ventana (30 días por defecto). */
  from?: string;
  to?: string;
  /** Tamaño del bucket de agregación, p. ej. `1h` o `15m`. */
  bucket?: string;
}

/** GET /api/v1/patients/:id/observations?metric=&from=&to=&bucket= */
export function fetchObservations(
  query: ObservationQuery,
  patientId: string = config.patientId,
): Promise<DataResult<ObservationSeries>> {
  const params = new URLSearchParams({ metric: query.metric });
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.bucket) params.set('bucket', query.bucket);

  return request(
    `/patients/${encodeURIComponent(patientId)}/observations?${params.toString()}`,
    ObservationSeries,
    FIXTURE_OBSERVATIONS[query.metric],
  );
}

/** GET /api/v1/patients/:id/episodes */
export function fetchEpisodes(patientId: string = config.patientId): Promise<DataResult<EpisodeList>> {
  return request(`/patients/${encodeURIComponent(patientId)}/episodes`, EpisodeList, FIXTURE_EPISODES);
}

/** GET /api/v1/patients/:id/outcomes — el gráfico que cierra el pitch. */
export function fetchOutcomes(patientId: string = config.patientId): Promise<DataResult<OutcomesSummary>> {
  return request(`/patients/${encodeURIComponent(patientId)}/outcomes`, OutcomesSummary, FIXTURE_OUTCOMES);
}

/* ================================================================== */
/* CONTRATO 6 — Control de demo                                        */
/* ================================================================== */

/**
 * No hay fixture para estos: son efectos, no lecturas. Cuando loop-core no
 * está, se devuelve una respuesta local con `ok: false` y un mensaje honesto
 * — "no se aplicó nada" — en vez de fingir que el spike ocurrió.
 *
 * El mensaje describe solo el EFECTO. La causa la pone `describeReason()`,
 * para que la UI las junte sin repetirse.
 */
function unavailableSpike(profile: DemoProfile): DemoSpikeResponse {
  return {
    ok: false,
    profile,
    appliedAt: new Date().toISOString(),
    message: 'No se aplicó ningún cambio en el paciente.',
  };
}

function unavailableReset(): DemoResetResponse {
  return {
    ok: false,
    resetAt: new Date().toISOString(),
    message: 'No se reinició el estado del demo.',
  };
}

/** POST /api/v1/demo/spike */
export function triggerDemoSpike(
  profile: DemoProfile,
  patientId: string = config.patientId,
): Promise<DataResult<DemoSpikeResponse>> {
  return request('/demo/spike', DemoSpikeResponse, unavailableSpike(profile), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patientId, profile }),
  });
}

/** POST /api/v1/demo/reset */
export function resetDemo(patientId: string = config.patientId): Promise<DataResult<DemoResetResponse>> {
  return request('/demo/reset', DemoResetResponse, unavailableReset(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patientId }),
  });
}
