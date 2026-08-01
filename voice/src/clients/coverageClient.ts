/**
 * Cliente de **loop-coverage** (:3003, Carlos).
 *
 * Una sola operacion y una sola regla que la gobierna:
 *
 *   > **NUNCA se inventa un copago.**
 *
 * Todo fallo — timeout, 5xx, JSON roto, payload que no valida — sale por el
 * mismo sitio: una respuesta con `status: 'unknown'`, sin copago, sin
 * deducible, y con un `voiceSummary` honesto que el agente locuta LITERAL:
 * *"no pude verificar tu cobertura en este momento..."*.
 *
 * `voiceSummary` NUNCA pasa por el LLM. Menos latencia y cero riesgo de que el
 * modelo redondee un numero de dinero. Aqui tampoco se parsea un 271: eso es
 * trabajo de Carlos y de Stedi.
 */

import { config } from '../config.js';
import {
  coverageCheckRequestSchema,
  coverageCheckResponseSchema,
  type CoverageCheckRequest,
  type CoverageCheckResponse,
} from '../types.js';
import { fetchJson, readFixture } from './http.js';

const FIXTURE_COVERED = 'coverage.covered.json';
const FIXTURE_UNKNOWN = 'coverage.unknown.json';

const CHECK_PATH = '/api/v1/coverage/check';

/**
 * Verifica cobertura. **Nunca lanza.** Siempre devuelve una respuesta locutable.
 *
 * Con `USE_MOCKS=true` sirve `coverage.covered.json` (el camino feliz del demo).
 * Con `USE_MOCKS=false` llama a :3003 y degrada a 'unknown' ante cualquier
 * problema. El `latencyMs` devuelto es el medido aqui, no el que declare el
 * downstream: es el tiempo que el paciente realmente espero.
 */
export async function checkCoverage(req: CoverageCheckRequest): Promise<CoverageCheckResponse> {
  const startedAt = performance.now();

  // La peticion se valida por higiene, pero no se aborta por ello: si a :3003
  // no le gusta, respondera y nosotros degradaremos a 'unknown' igual.
  const reqCheck = coverageCheckRequestSchema.safeParse(req);
  if (!reqCheck.success) {
    console.warn(
      `[coverageClient] la peticion no valida (${reqCheck.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
        .join(' | ')}) — se intenta igualmente`,
    );
  }

  if (config.useMocks) {
    const covered = loadCoverage(FIXTURE_COVERED);
    if (covered) {
      console.info(
        `[coverageClient] USE_MOCKS — ${req.serviceType} → ${covered.status} (fixture ${FIXTURE_COVERED})`,
      );
      return { ...covered, checkedAt: nowIso(), latencyMs: elapsed(startedAt) };
    }
    return unknown(startedAt, `no se pudo leer el fixture ${FIXTURE_COVERED}`);
  }

  const result = await fetchJson<unknown>(`${config.coverageUrl}${CHECK_PATH}`, {
    method: 'POST',
    body: req,
    timeoutMs: config.timeouts.coverageMs,
    // Sin reintentos: una verificacion de elegibilidad es cara y hay un
    // paciente esperando en la linea. Si no salio a la primera, decimos la
    // verdad y seguimos con la conversacion.
    retries: 0,
    label: 'coverage/check',
  });

  if (!result.ok) {
    return unknown(startedAt, `:3003 no respondio bien (${result.error})`);
  }

  const parsed = coverageCheckResponseSchema.safeParse(result.data);
  if (!parsed.success) {
    return unknown(
      startedAt,
      `:3003 respondio 200 pero el payload no valida (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
        .join(' | ')})`,
    );
  }

  const response = parsed.data as CoverageCheckResponse;
  console.info(
    `[coverageClient] ${req.serviceType} → ${response.status} en ${result.latencyMs}ms ` +
      `(copago ${response.copayCents === null ? 'n/d' : `${response.copayCents}c`})`,
  );
  return { ...response, latencyMs: elapsed(startedAt) };
}

// -----------------------------------------------------------------------------
// Degradacion
// -----------------------------------------------------------------------------

/**
 * La respuesta honesta. Se construye desde `coverage.unknown.json` para que el
 * `voiceSummary` sea el mismo texto que revisamos con el equipo, y se fuerzan
 * los campos de dinero a null aunque el fixture cambie: de aqui no puede salir
 * una cifra inventada ni por accidente.
 */
function unknown(startedAt: number, reason: string): CoverageCheckResponse {
  console.warn(`[coverageClient] cobertura desconocida — ${reason}`);
  const base = loadCoverage(FIXTURE_UNKNOWN) ?? UNKNOWN_FALLBACK;
  return {
    ...base,
    status: 'unknown',
    copayCents: null,
    coinsurancePercent: null,
    deductible: null,
    voiceSummary: base.voiceSummary || UNKNOWN_FALLBACK.voiceSummary,
    checkedAt: nowIso(),
    latencyMs: elapsed(startedAt),
  };
}

function loadCoverage(fileName: string): CoverageCheckResponse | null {
  const raw = readFixture(fileName);
  if (raw === null) return null;
  const parsed = coverageCheckResponseSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[coverageClient] el fixture ${fileName} no valida contra el Contrato 3`);
    return null;
  }
  return parsed.data as CoverageCheckResponse;
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Ultimo recurso si `shared/fixtures/coverage.unknown.json` no esta.
 * Mismo texto que el fixture: es el que el agente locuta literal.
 */
const UNKNOWN_FALLBACK: CoverageCheckResponse = {
  checkId: 'cov-unknown-0000',
  checkedAt: '1970-01-01T00:00:00.000Z',
  status: 'unknown',
  // El Contrato 3 exige `payerName` como string. `'Unknown'` es literalmente lo
  // que trae `shared/fixtures/coverage.unknown.json`: si no sabemos la
  // aseguradora, se dice que no se sabe, no se pone una plausible.
  payerName: 'Unknown',
  planName: null,
  copayCents: null,
  coinsurancePercent: null,
  deductible: null,
  // null, no false: `false` afirmaria que NO hace falta autorizacion previa, y
  // eso es un dato que en este camino no tenemos.
  priorAuthRequired: null,
  raw271Id: null,
  voiceSummary:
    'No pude verificar tu cobertura en este momento. No quiero darte un número que no sea real, así que tu equipo de cuidado te lo puede confirmar cuando agendes.',
  latencyMs: 0,
};
