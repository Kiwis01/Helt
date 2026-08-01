/**
 * POST /api/v1/coverage/check — Contrato 3.
 *
 * Lo consumen dos clientes: el agente de voz (síncrono, a mitad de llamada) y
 * el bot de Medplum (asíncrono, post-encuentro).
 *
 * REGLA INNEGOCIABLE: esta ruta NUNCA devuelve 5xx por un fallo de upstream.
 * Hay una llamada de voz en curso; el agente no puede quedarse colgado ni
 * recibir un error. Si Stedi falla, tarda o devuelve algo impresentable, la
 * respuesta es 200 con `status: "unknown"`, todo en null y un `voiceSummary`
 * honesto. Nunca se inventa un copago.
 *
 * Un body malformado SÍ es 400: eso es un bug del cliente y tiene que salir a
 * la luz rápido, no esconderse tras un "unknown" plausible.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import {
  ApiError,
  CoverageCheckRequest,
  CoverageCheckResponse,
  X12_SERVICE_TYPE_CODES,
  type CoverageCheckResponse as CoverageCheckResponseType,
} from '@loop/shared';

import type { AppConfig } from '../config.js';
import { buildMockResponse, pickMockScenario } from '../mock.js';
import { map271 } from '../stedi/map271.js';
import { requestEligibility } from '../stedi/client.js';
import { buildVoiceSummary } from '../voice-summary.js';

export const COVERAGE_CHECK_PATH = '/api/v1/coverage/check';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const newCheckId = (): string => `cov-${randomUUID()}`;

/**
 * `serviceType` es un string libre en el contrato, así que se indexa el mapa de
 * `shared/constants.ts` de forma defensiva. Si llega uno desconocido se usa el
 * de salud mental, que es el único que este servicio persigue.
 */
function x12CodeFor(serviceType: string): string {
  const codes: Record<string, string | undefined> = X12_SERVICE_TYPE_CODES;
  return codes[serviceType] ?? X12_SERVICE_TYPE_CODES['telehealth-mental-health'];
}

/** La respuesta de degradación. Todo null salvo lo que sí sabemos con certeza. */
function unknownResponse(
  checkId: string,
  latencyMs: number,
  cfg: AppConfig,
  payerName = 'Unknown',
): CoverageCheckResponseType {
  return {
    checkId,
    checkedAt: new Date().toISOString(),
    status: 'unknown',
    payerName,
    planName: null,
    copayCents: null,
    coinsurancePercent: null,
    deductible: null,
    priorAuthRequired: null,
    raw271Id: null,
    voiceSummary: buildVoiceSummary(
      {
        status: 'unknown',
        copayCents: null,
        coinsurancePercent: null,
        deductible: null,
        priorAuthRequired: null,
        payerName,
      },
      cfg.lang,
    ),
    latencyMs,
  };
}

/* ------------------------------------------------------------------ */
/* Ruta                                                                */
/* ------------------------------------------------------------------ */

export function registerCoverageCheckRoute(app: FastifyInstance, cfg: AppConfig): void {
  app.post(COVERAGE_CHECK_PATH, async (request, reply) => {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);

    /* --- 1. Validación del body (el único caso de 400) --- */
    const parsedBody = CoverageCheckRequest.safeParse(request.body);
    if (!parsedBody.success) {
      const error: ApiError = {
        error: 'invalid_request',
        message: 'El body no cumple CoverageCheckRequest (ver shared/contracts.ts).',
        detail: parsedBody.error.flatten(),
      };
      request.log.warn({ issues: parsedBody.error.issues }, 'coverage check con body inválido');
      return reply.code(400).send(ApiError.parse(error));
    }

    const input = parsedBody.data;
    const checkId = newCheckId();

    /* --- 2. Resolución (mock o Stedi real) --- */
    let candidate: CoverageCheckResponseType;
    try {
      candidate = cfg.useMocks
        ? resolveFromMocks(checkId, input, cfg, elapsed)
        : await resolveFromStedi(checkId, input, cfg, elapsed);
    } catch (error) {
      // Cualquier excepción inesperada degrada. No hay 500 posible aquí.
      request.log.error({ err: error, checkId }, 'coverage check lanzó — degradando a unknown');
      candidate = unknownResponse(checkId, elapsed(), cfg);
    }

    /* --- 3. Validación de NUESTRA propia respuesta --- */
    // Si esto falla es un bug nuestro, no de Stedi. Se loguea fuerte y se
    // degrada: el agente de voz nunca debe recibir algo fuera de contrato.
    const validated = CoverageCheckResponse.safeParse(candidate);
    if (!validated.success) {
      request.log.error(
        { checkId, issues: validated.error.issues, candidate },
        'BUG EN loop-coverage: la respuesta generada NO cumple CoverageCheckResponse',
      );
      return reply.code(200).send(unknownResponse(checkId, elapsed(), cfg));
    }

    request.log.info(
      {
        checkId,
        status: validated.data.status,
        latencyMs: validated.data.latencyMs,
        mode: cfg.useMocks ? 'mock' : 'stedi',
        requestedBy: input.requestedBy,
        callId: input.callId ?? null,
      },
      'coverage check resuelto',
    );

    return reply.code(200).send(validated.data);
  });
}

/* ------------------------------------------------------------------ */
/* Resolución                                                          */
/* ------------------------------------------------------------------ */

function resolveFromMocks(
  checkId: string,
  input: { cptCode: string; serviceType: string },
  cfg: AppConfig,
  elapsed: () => number,
): CoverageCheckResponseType {
  const scenario = pickMockScenario(input, cfg.mockScenarioOverride);
  // `cfg.lang` va también aquí: la frase del mock se regenera con la misma
  // plantilla del modo real, no se copia del fixture.
  return buildMockResponse({ checkId, latencyMs: elapsed(), scenario, lang: cfg.lang });
}

async function resolveFromStedi(
  checkId: string,
  input: { patientId: string; cptCode: string; serviceType: string },
  cfg: AppConfig,
  elapsed: () => number,
): Promise<CoverageCheckResponseType> {
  const result = await requestEligibility(
    {
      patientId: input.patientId,
      serviceType: input.serviceType,
      cptCode: input.cptCode,
      x12ServiceTypeCode: x12CodeFor(input.serviceType),
    },
    checkId,
    cfg,
  );

  if (!result.ok) {
    // Timeout, 4xx/5xx de Stedi, red caída o JSON ilegible: todo acaba igual.
    // Un "no lo sé" honesto es infinitamente mejor que un copago inventado.
    return unknownResponse(checkId, elapsed(), cfg, cfg.stedi.payerName);
  }

  const facts = map271(result.raw, {
    x12ServiceTypeCode: x12CodeFor(input.serviceType),
    fallbackPayerName: cfg.stedi.payerName,
  });

  return {
    checkId,
    checkedAt: new Date().toISOString(),
    status: facts.status,
    payerName: facts.payerName,
    planName: facts.planName,
    copayCents: facts.copayCents,
    coinsurancePercent: facts.coinsurancePercent,
    deductible: facts.deductible,
    priorAuthRequired: facts.priorAuthRequired,
    raw271Id: facts.raw271Id,
    voiceSummary: buildVoiceSummary(facts, cfg.lang),
    latencyMs: elapsed(),
  };
}

/** Se exporta para que el manejador de errores global pueda degradar igual. */
export { unknownResponse, newCheckId };
