/**
 * Tests del modo mock.
 *
 * El modo mock es el camino que se ensaya en el demo, así que tiene que decir
 * exactamente lo mismo que diría el modo real con esos mismos datos. Si diverge,
 * lo que se ensaya no es lo que se enseña.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMockResponse, loadFixture, pickMockScenario } from './mock.js';
import { buildVoiceSummary } from './voice-summary.js';

const SCENARIOS = ['covered', 'needsauth', 'unknown'] as const;

test('el voiceSummary se regenera con la plantilla, no se copia del fixture', () => {
  for (const scenario of SCENARIOS) {
    const fixture = loadFixture(scenario);
    const response = buildMockResponse({ checkId: 'cov-test', latencyMs: 7, scenario, lang: 'es' });

    assert.equal(
      response.voiceSummary,
      buildVoiceSummary(
        {
          status: fixture.status,
          copayCents: fixture.copayCents,
          coinsurancePercent: fixture.coinsurancePercent,
          deductible: fixture.deductible,
          priorAuthRequired: fixture.priorAuthRequired,
          payerName: fixture.payerName,
        },
        'es',
      ),
      `escenario ${scenario}`,
    );
  }
});

test('la frase del mock no nombra un servicio que nadie pidió', () => {
  // El fixture `covered` dice "Tu sesión de telesalud sí está cubierta", pero el
  // mock responde a cualquier petición: preguntando por farmacia, el agente
  // acababa leyendo en voz alta un servicio distinto del consultado.
  const scenario = pickMockScenario({ cptCode: '90834', serviceType: 'prescription-drug' });
  const response = buildMockResponse({ checkId: 'cov-test', latencyMs: 1, scenario, lang: 'es' });

  assert.match(loadFixture('covered').voiceSummary, /telesalud/, 'el fixture sí lo nombra');
  assert.ok(
    !/telesalud/i.test(response.voiceSummary),
    `la respuesta no debe nombrarlo → "${response.voiceSummary}"`,
  );
});

test('needs-auth en mock dice el copago que trae su propio JSON', () => {
  const response = buildMockResponse({
    checkId: 'cov-test',
    latencyMs: 1,
    scenario: 'needsauth',
    lang: 'es',
  });

  assert.equal(response.copayCents, 4000);
  assert.match(
    response.voiceSummary,
    /40 dólares/,
    'mock y real tienen que decir lo mismo con los mismos datos',
  );
});

test('el idioma del servicio manda sobre el del fixture', () => {
  const en = buildMockResponse({ checkId: 'cov-test', latencyMs: 1, scenario: 'covered', lang: 'en' });
  assert.match(en.voiceSummary, /covered by your plan/);
});

test('unknown en mock sigue sin mencionar ninguna cifra', () => {
  const response = buildMockResponse({
    checkId: 'cov-test',
    latencyMs: 1,
    scenario: 'unknown',
    lang: 'es',
  });
  assert.equal(response.copayCents, null);
  assert.ok(!/\d/.test(response.voiceSummary), response.voiceSummary);
});

test('checkId, checkedAt y latencyMs son de ESTA llamada, no del archivo', () => {
  const fixture = loadFixture('covered');
  const response = buildMockResponse({
    checkId: 'cov-nuevo',
    latencyMs: 42,
    scenario: 'covered',
    lang: 'es',
  });

  assert.equal(response.checkId, 'cov-nuevo');
  assert.equal(response.latencyMs, 42);
  assert.notEqual(response.checkedAt, fixture.checkedAt);
});
