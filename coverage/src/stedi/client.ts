/**
 * El ÚNICO módulo que habla con Stedi.
 *
 * Todo lo que sabe cómo se pide un 270 y cómo llega un 271 vive aquí y en
 * `map271.ts`. El resto del servicio recibe un `Mapped271` y nunca ve un EDI.
 *
 * Dos garantías que este módulo debe cumplir siempre:
 *   1. Nunca lanza hacia arriba. Devuelve un resultado discriminado.
 *   2. Nunca tarda más de `TIMEOUTS_MS.stediUpstream` (2500ms), que es menos
 *      que lo que voice/ está dispuesto a esperar (3000ms).
 *
 * ─────────────────────────────────────────────────────────────────────
 * ASUNCIONES (no hay credenciales de Stedi en este entorno para verificarlas):
 *   - Endpoint: `POST {STEDI_BASE_URL}{STEDI_ELIGIBILITY_PATH}`.
 *   - Auth: header `Authorization` con la API key cruda, sin esquema.
 *   - Body: JSON con `controlNumber`, `tradingPartnerServiceId`, `provider`,
 *     `subscriber` y `encounter` (ver `buildEligibilityRequest`).
 *   - `dateOfBirth` en formato `YYYYMMDD`.
 *   - Respuesta: 200 con el 271 ya deserializado a JSON.
 * Cada una es una variable de entorno o una línea de este archivo. Ver la
 * sección "Qué verificar cuando llegue la API key de Stedi" del README.
 * ─────────────────────────────────────────────────────────────────────
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { AppConfig, StediConfig } from '../config.js';

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export type StediFailureReason =
  | 'not-configured'
  | 'timeout'
  | 'http-error'
  | 'network'
  | 'bad-json';

export type StediResult =
  | { ok: true; raw: unknown; latencyMs: number }
  | { ok: false; reason: StediFailureReason; detail: string; latencyMs: number };

export interface EligibilityInput {
  patientId: string;
  serviceType: string;
  cptCode: string;
  /** Código X12 de service type (EQ01), ej. "A4" para psiquiátrico. */
  x12ServiceTypeCode: string;
}

/* ------------------------------------------------------------------ */
/* Estado de salud del upstream                                        */
/* ------------------------------------------------------------------ */

/**
 * Resultado del último intento real. Alimenta `/healthz`, que es donde el
 * runbook del demo mira antes de salir al escenario.
 */
let lastRealAttempt: 'none' | 'ok' | 'failed' = 'none';

export function getStediUpstreamHealth(cfg: AppConfig): 'ok' | 'not-configured' | 'down' {
  if (!cfg.stediConfigured) return 'not-configured';
  return lastRealAttempt === 'failed' ? 'down' : 'ok';
}

/** Solo para tests y para el smoke: reinicia el estado observado del upstream. */
export function resetStediUpstreamHealth(): void {
  lastRealAttempt = 'none';
}

/* ------------------------------------------------------------------ */
/* Construcción del 270                                                */
/* ------------------------------------------------------------------ */

/**
 * Lo que el 270 no puede llevar en `null`. Sin payer no hay a quién preguntar, y
 * sin miembro no hay por quién: la petición sale, el pagador la rechaza y el
 * paciente escucha "no pude verificar" cuando en realidad nunca preguntamos.
 *
 * `loadConfig()` ya obliga a que estén antes de salir de modo mock; esto es la
 * segunda cerradura, porque `buildServer()` acepta configs inyectadas.
 */
function missingRequestFields(stedi: StediConfig): string[] {
  const missing: string[] = [];
  if (stedi.payerId === null) missing.push('payerId');
  if (stedi.memberId === null) missing.push('memberId');
  if (stedi.memberDob === null) missing.push('memberDob');
  return missing;
}

/** Number de control del 270: 9 dígitos. ASUNCIÓN sobre el formato exigido. */
function controlNumber(): string {
  return String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0');
}

/**
 * Cuerpo del 270. Función exportada y determinista salvo el `controlNumber`,
 * para poder inspeccionarla sin credenciales.
 */
export function buildEligibilityRequest(
  input: EligibilityInput,
  stedi: StediConfig,
): Record<string, unknown> {
  return {
    controlNumber: controlNumber(),
    tradingPartnerServiceId: stedi.payerId,
    provider: {
      organizationName: stedi.providerOrgName,
      npi: stedi.providerNpi,
    },
    subscriber: {
      memberId: stedi.memberId,
      firstName: stedi.memberFirstName,
      lastName: stedi.memberLastName,
      // Ya viene en `YYYYMMDD`: `config.ts` lo normaliza al arrancar.
      dateOfBirth: stedi.memberDob,
    },
    encounter: {
      serviceTypeCodes: [input.x12ServiceTypeCode],
      // El CPT concreto es lo que convierte "¿tengo salud mental?" en
      // "¿cuánto me cuesta ESTA sesión?". Es la diferencia entre una respuesta
      // genérica y una respuesta que le sirve al paciente.
      procedureCode: input.cptCode,
      productOrServiceIDQualifier: 'HC', // HCPCS/CPT
    },
  };
}

/* ------------------------------------------------------------------ */
/* Captura del 271 crudo                                               */
/* ------------------------------------------------------------------ */

/** `coverage/captures/` — desde `coverage/src/stedi/client.ts` son dos niveles. */
const CAPTURES_DIR = fileURLToPath(new URL('../../captures/', import.meta.url));

const safeFileName = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Guarda en disco lo que devolvió Stedi. Es la red de seguridad del demo: si
 * el sandbox se cae en el escenario, esta captura es el respaldo honesto.
 *
 * Nunca se persisten headers ni la API key. Y nunca propaga un error: no poder
 * escribir un archivo de depuración no puede tumbar una llamada de voz.
 */
export async function captureRaw(checkId: string, payload: unknown): Promise<string | null> {
  try {
    await mkdir(CAPTURES_DIR, { recursive: true });
    const path = `${CAPTURES_DIR}${safeFileName(checkId)}.json`;
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return path;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Llamada                                                             */
/* ------------------------------------------------------------------ */

function authHeader(stedi: StediConfig): string {
  const key = stedi.apiKey ?? '';
  return stedi.authScheme === null ? key : `${stedi.authScheme} ${key}`;
}

/**
 * Pide la elegibilidad a Stedi y captura la respuesta cruda.
 *
 * @param checkId  se usa como nombre del archivo de captura, para poder cruzar
 *                 un `checkId` del dashboard con su 271 en un segundo.
 */
export async function requestEligibility(
  input: EligibilityInput,
  checkId: string,
  cfg: AppConfig,
): Promise<StediResult> {
  const { stedi } = cfg;

  if (stedi.apiKey === null) {
    return { ok: false, reason: 'not-configured', detail: 'falta STEDI_API_KEY', latencyMs: 0 };
  }

  const missing = missingRequestFields(stedi);
  if (missing.length > 0) {
    // No se manda una petición que sabemos incompleta: gastaría el presupuesto
    // de latencia de la llamada de voz para acabar en el mismo "unknown".
    return {
      ok: false,
      reason: 'not-configured',
      detail: `el 270 iría incompleto, falta: ${missing.join(', ')}`,
      latencyMs: 0,
    };
  }

  const url = `${stedi.baseUrl}${stedi.eligibilityPath}`;
  const body = buildEligibilityRequest(input, stedi);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), stedi.timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: authHeader(stedi),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Math.round(performance.now() - startedAt);
    const text = await response.text();

    if (!response.ok) {
      lastRealAttempt = 'failed';
      await captureRaw(checkId, {
        checkId,
        at: new Date().toISOString(),
        url,
        request: body,
        ok: false,
        httpStatus: response.status,
        responseBody: text.slice(0, 20_000),
      });
      return {
        ok: false,
        reason: 'http-error',
        detail: `HTTP ${response.status}: ${text.slice(0, 300)}`,
        latencyMs,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      lastRealAttempt = 'failed';
      await captureRaw(checkId, {
        checkId,
        at: new Date().toISOString(),
        url,
        request: body,
        ok: false,
        parseError: true,
        responseBody: text.slice(0, 20_000),
      });
      return { ok: false, reason: 'bad-json', detail: 'la respuesta no es JSON', latencyMs };
    }

    lastRealAttempt = 'ok';
    await captureRaw(checkId, {
      checkId,
      at: new Date().toISOString(),
      url,
      request: body,
      ok: true,
      httpStatus: response.status,
      latencyMs,
      response: raw,
    });

    return { ok: true, raw, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    lastRealAttempt = 'failed';

    const aborted = controller.signal.aborted;
    const detail = error instanceof Error ? error.message : String(error);

    await captureRaw(checkId, {
      checkId,
      at: new Date().toISOString(),
      url,
      request: body,
      ok: false,
      aborted,
      error: detail,
      latencyMs,
    });

    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      detail: aborted ? `Stedi no respondió en ${stedi.timeoutMs}ms` : detail,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
