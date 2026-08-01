/**
 * Cliente de loop-coverage (:3003) — Contrato 3.
 *
 * Mismo contrato de capa que `core-client`: no lanza nunca y siempre devuelve
 * algo pintable con el origen marcado. Vive aparte porque apunta a otro
 * servicio, con otro presupuesto de latencia (`TIMEOUTS_MS.coverageCheck`, 3 s,
 * el mismo que respeta el agente de voz) y con un POST en vez de un GET.
 *
 * A diferencia de core-client, aquí el fallback NO es un adorno: si el sandbox
 * de Stedi no responde en el escenario, esto es lo que se ve. Por eso cae al
 * fixture `coverage.covered.json` marcado como fixture, y la tarjeta lo dice en
 * pantalla. Un copago inventado sin avisar sería el peor fallo posible de todo
 * el proyecto.
 */

import { CPT, TIMEOUTS_MS } from '@loop/shared/constants';
import { CoverageCheckResponse } from '@loop/shared/contracts';

import { config } from './config';
import type { DataResult, FallbackReason } from './core-client';
import { FIXTURE_COVERAGE } from './fixtures';

const CHECK_PATH = '/api/v1/coverage/check';

/**
 * Lo que el dashboard pregunta: la visita de telesalud de salud mental del care
 * plan (cp-act-3). Deliberadamente NO se pregunta por suplementos: los seguros
 * no los cubren y "no cubierto" no le sirve a nadie.
 */
export const DASHBOARD_SERVICE_TYPE = 'telehealth-mental-health';
export const DASHBOARD_CPT_CODE = CPT.psychotherapy45;

/** Texto en español para el pie de la tarjeta. */
export function describeCoverageReason(reason: FallbackReason): string {
  switch (reason) {
    case 'fixtures-mode':
      return 'modo respaldo activo';
    case 'timeout':
      return `loop-coverage no respondió en ${TIMEOUTS_MS.coverageCheck} ms`;
    case 'network':
      return 'loop-coverage no está disponible';
    case 'http-error':
      return 'loop-coverage devolvió un error';
    case 'invalid-schema':
      return 'la respuesta no cumple el Contrato 3';
    default:
      return 'respuesta en vivo';
  }
}

function fallback(reason: FallbackReason, detail: string | null = null): DataResult<CoverageCheckResponse> {
  return { data: FIXTURE_COVERAGE, source: 'fixture', reason, detail };
}

/** POST /api/v1/coverage/check */
export async function checkCoverage(
  callId: string | null = null,
  patientId: string = config.patientId,
): Promise<DataResult<CoverageCheckResponse>> {
  if (config.useFixtures) return fallback('fixtures-mode');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS_MS.coverageCheck);

  try {
    const response = await fetch(`${config.coverageUrl}${CHECK_PATH}`, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        patientId,
        serviceType: DASHBOARD_SERVICE_TYPE,
        cptCode: DASHBOARD_CPT_CODE,
        requestedBy: 'dashboard',
        callId,
      }),
    });

    if (!response.ok) return fallback('http-error', `HTTP ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fallback('invalid-schema', 'la respuesta no es JSON');
    }

    const parsed = CoverageCheckResponse.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join('.') || 'raíz';
      return fallback('invalid-schema', `${where}: ${issue?.message ?? 'forma inesperada'}`);
    }

    return { data: parsed.data, source: 'live', reason: null, detail: null };
  } catch (error) {
    const reason: FallbackReason = controller.signal.aborted ? 'timeout' : 'network';
    return fallback(reason, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
