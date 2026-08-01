/**
 * Modo mock: respuestas servidas desde `shared/fixtures/`.
 *
 * Es la palanca que hace trivial la integración con voice/ y con el bot de
 * Kiwis: sin API key de Stedi el servicio sigue respondiendo el shape exacto
 * del Contrato 3, así que nadie se bloquea.
 *
 * Los fixtures son de SOLO LECTURA (viven en `shared/`). Aquí se cargan, se
 * validan contra el contrato y se les refrescan los campos que no pueden venir
 * de un archivo: `checkId`, `checkedAt`, `latencyMs` y el `voiceSummary`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { CoverageCheckResponse } from '@loop/shared';

import { buildVoiceSummary, type VoiceLang } from './voice-summary.js';

export type MockScenario = 'covered' | 'needsauth' | 'unknown';

const FIXTURE_FILES: Record<MockScenario, string> = {
  covered: 'coverage.covered.json',
  needsauth: 'coverage.needsauth.json',
  unknown: 'coverage.unknown.json',
};

/* ------------------------------------------------------------------ */
/* Selección de escenario                                              */
/* ------------------------------------------------------------------ */

/**
 * Qué fixture devolver según lo que pidan.
 *
 * El demo pide CPT 90834 (psicoterapia 45 min) y tiene que salir "covered".
 * Los otros mapeos existen para poder enseñar más de un resultado sin tocar
 * código ni reiniciar nada: basta con cambiar el `cptCode` del curl.
 */
const SCENARIO_BY_CPT: Record<string, MockScenario> = {
  '90834': 'covered', // ← el camino del demo
  '90832': 'needsauth', // psicoterapia 30 min → fuerza needs-auth
  '99213': 'unknown', // visita de consultorio → fuerza el fallback honesto
};

const SCENARIO_BY_SERVICE_TYPE: Record<string, MockScenario> = {
  'telehealth-mental-health': 'covered',
  'outpatient-mental-health': 'covered',
  'prescription-drug': 'needsauth',
};

export function pickMockScenario(
  input: { cptCode: string; serviceType: string },
  override: MockScenario | null = null,
): MockScenario {
  if (override !== null) return override;
  return (
    SCENARIO_BY_CPT[input.cptCode] ?? SCENARIO_BY_SERVICE_TYPE[input.serviceType] ?? 'covered'
  );
}

/* ------------------------------------------------------------------ */
/* Carga de fixtures                                                   */
/* ------------------------------------------------------------------ */

const require = createRequire(import.meta.url);

/**
 * Los fixtures se resuelven por el mapa `exports` de `@loop/shared` para no
 * depender de la profundidad de carpetas. Si el workspace no estuviera
 * enlazado, se cae a la ruta relativa dentro del monorepo.
 */
function resolveFixturePath(fileName: string): string {
  try {
    return require.resolve(`@loop/shared/fixtures/${fileName}`);
  } catch {
    return fileURLToPath(new URL(`../../shared/fixtures/${fileName}`, import.meta.url));
  }
}

const cache = new Map<MockScenario, ReturnType<typeof CoverageCheckResponse.parse>>();

/** Carga y valida el fixture. Si no valida es un bug de `shared/`, no nuestro. */
export function loadFixture(scenario: MockScenario) {
  const cached = cache.get(scenario);
  if (cached !== undefined) return cached;

  const path = resolveFixturePath(FIXTURE_FILES[scenario]);
  const parsed = CoverageCheckResponse.parse(JSON.parse(readFileSync(path, 'utf8')));
  cache.set(scenario, parsed);
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Respuesta mock                                                      */
/* ------------------------------------------------------------------ */

export interface MockResponseInput {
  checkId: string;
  latencyMs: number;
  scenario: MockScenario;
  lang: VoiceLang;
}

/**
 * El fixture entero, salvo los campos que describen ESTA llamada. Si se
 * devolvieran los del archivo, el dashboard mostraría dos checks con el mismo
 * `checkId` y la demo se vería falsa.
 *
 * El `voiceSummary` se REGENERA con la misma plantilla del modo real en vez de
 * copiarse del archivo. Dos razones:
 *
 *   1. La frase del fixture nombra un servicio concreto ("Tu sesión de
 *      telesalud sí está cubierta") y el mock responde a cualquier petición, así
 *      que el agente acababa leyendo en voz alta un servicio que nadie pidió.
 *   2. El camino que se ensaya en el demo pasa a ser el mismo código que corre
 *      en producción. Antes mock y real no decían lo mismo con los mismos datos:
 *      el fixture `needsauth` trae copayCents 4000 y su frase no lo mencionaba.
 */
export function buildMockResponse(input: MockResponseInput) {
  const fixture = loadFixture(input.scenario);

  return {
    ...fixture,
    checkId: input.checkId,
    checkedAt: new Date().toISOString(),
    latencyMs: input.latencyMs,
    voiceSummary: buildVoiceSummary(
      {
        status: fixture.status,
        copayCents: fixture.copayCents,
        coinsurancePercent: fixture.coinsurancePercent,
        deductible: fixture.deductible,
        priorAuthRequired: fixture.priorAuthRequired,
        payerName: fixture.payerName,
      },
      input.lang,
    ),
  };
}
