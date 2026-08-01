/**
 * Tests de `map271`.
 *
 * La mitad de estos tests son payloads rotos a propósito. Es lo normal con EDI:
 * el 271 real casi nunca es el 271 de la documentación. Lo que se comprueba no
 * es solo que el caso feliz mapee bien, sino que ningún payload —por raro que
 * sea— consiga hacer que el módulo lance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dollarsToCents, map271, toCoinsurancePercent } from './map271.js';

/* ------------------------------------------------------------------ */
/* Payloads de ejemplo                                                 */
/* ------------------------------------------------------------------ */

/** 271 completo, el caso feliz: telesalud salud mental (EB03 = "A4"). */
const full271 = {
  meta: { traceId: '8f2a41' },
  controlNumber: '000000042',
  payer: { name: 'Test Payer Inc', payorIdentification: '00123' },
  planInformation: { groupNumber: 'GRP-1', groupDescription: 'Loop Demo Group' },
  planStatus: [{ statusCode: '1', status: 'Active Coverage', serviceTypeCodes: ['30'] }],
  benefitsInformation: [
    {
      code: '1',
      name: 'Active Coverage',
      serviceTypeCodes: ['30'],
      planCoverage: 'PPO Silver',
      inPlanNetworkIndicatorCode: 'Y',
    },
    {
      code: 'B',
      name: 'Co-Payment',
      serviceTypeCodes: ['A4'],
      coverageLevelCode: 'IND',
      timeQualifierCode: '27',
      timeQualifier: 'Visit',
      benefitAmount: '25',
      inPlanNetworkIndicatorCode: 'Y',
      authOrCertIndicator: 'N',
      planCoverage: 'PPO Silver',
    },
    {
      code: 'A',
      name: 'Co-Insurance',
      serviceTypeCodes: ['A4'],
      coverageLevelCode: 'IND',
      benefitPercent: '0',
      inPlanNetworkIndicatorCode: 'Y',
    },
    {
      code: 'C',
      name: 'Deductible',
      serviceTypeCodes: ['30'],
      coverageLevelCode: 'IND',
      timeQualifierCode: '23',
      timeQualifier: 'Calendar Year',
      benefitAmount: '1500',
      inPlanNetworkIndicatorCode: 'Y',
    },
    {
      code: 'C',
      name: 'Deductible',
      serviceTypeCodes: ['30'],
      coverageLevelCode: 'IND',
      timeQualifierCode: '29',
      timeQualifier: 'Remaining',
      benefitAmount: '80',
      inPlanNetworkIndicatorCode: 'Y',
    },
  ],
};

const OPTS = { x12ServiceTypeCode: 'A4', fallbackPayerName: 'Test Payer Inc' };

/* ------------------------------------------------------------------ */
/* Caso feliz                                                          */
/* ------------------------------------------------------------------ */

test('271 completo → covered con copago, coaseguro y deducible', () => {
  const result = map271(full271, OPTS);

  assert.equal(result.status, 'covered');
  assert.equal(result.payerName, 'Test Payer Inc');
  assert.equal(result.planName, 'PPO Silver');
  assert.equal(result.copayCents, 2500);
  assert.equal(result.coinsurancePercent, 0);
  assert.deepEqual(result.deductible, {
    individualCents: 150_000,
    metCents: 142_000,
    remainingCents: 8_000,
  });
  assert.equal(result.priorAuthRequired, false);
  assert.equal(result.raw271Id, 'stedi-271-8f2a41');
});

test('sin meta.traceId cae a controlNumber para el raw271Id', () => {
  const { meta: _meta, ...withoutMeta } = full271;
  assert.equal(map271(withoutMeta, OPTS).raw271Id, 'stedi-271-000000042');
});

/* ------------------------------------------------------------------ */
/* Degradación limpia — 271 parciales e incompletos                    */
/* ------------------------------------------------------------------ */

test('271 parcial (solo pagador) → unknown con todo en null, sin lanzar', () => {
  const partial = { payer: { name: 'Parcial Health' } };
  const result = map271(partial, OPTS);

  assert.equal(result.status, 'unknown');
  assert.equal(result.payerName, 'Parcial Health');
  assert.equal(result.planName, null);
  assert.equal(result.copayCents, null);
  assert.equal(result.coinsurancePercent, null);
  assert.equal(result.deductible, null);
  assert.equal(result.priorAuthRequired, null);
});

test('271 con beneficios pero sin montos → covered sin cifras inventadas', () => {
  const noAmounts = {
    meta: { traceId: 'abc' },
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '1' }],
    benefitsInformation: [{ code: 'B', serviceTypeCodes: ['A4'] }],
  };
  const result = map271(noAmounts, OPTS);

  assert.equal(result.status, 'covered');
  assert.equal(result.copayCents, null);
  assert.equal(result.deductible, null);
});

test('deducible con solo el restante → null, porque el contrato pide los tres montos', () => {
  const onlyRemaining = {
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '1' }],
    benefitsInformation: [
      {
        code: 'C',
        serviceTypeCodes: ['30'],
        coverageLevelCode: 'IND',
        timeQualifierCode: '29',
        timeQualifier: 'Remaining',
        benefitAmount: '80',
      },
    ],
  };
  const result = map271(onlyRemaining, OPTS);

  assert.equal(result.status, 'covered');
  assert.equal(result.deductible, null, 'mejor un hueco honesto que dos montos inventados');
});

test('deducible incoherente (restante > total) se descarta', () => {
  const incoherent = {
    payer: { name: 'X' },
    planStatus: [{ statusCode: '1' }],
    benefitsInformation: [
      { code: 'C', timeQualifierCode: '23', benefitAmount: '100', coverageLevelCode: 'IND' },
      { code: 'C', timeQualifierCode: '29', benefitAmount: '900', coverageLevelCode: 'IND' },
    ],
  };
  assert.equal(map271(incoherent, OPTS).deductible, null);
});

test('tipos equivocados en cada campo no hacen lanzar al mapper', () => {
  const junk = {
    meta: 'no soy un objeto',
    payer: ['tampoco'],
    planStatus: 'ni yo',
    planInformation: 42,
    benefitsInformation: [null, 'texto', 7, { code: 12345 }, {}],
    errors: 'esto debería ser un array',
  };
  const result = map271(junk, OPTS);

  assert.equal(result.status, 'unknown');
  assert.equal(result.payerName, 'Test Payer Inc'); // el fallback
  assert.equal(result.copayCents, null);
});

test('entradas absurdas devuelven unknown en vez de reventar', () => {
  for (const input of [null, undefined, 0, '', 'un string', [], [1, 2, 3], true, NaN]) {
    const result = map271(input, OPTS);
    assert.equal(result.status, 'unknown', `entrada: ${JSON.stringify(input)}`);
    assert.equal(result.copayCents, null);
    assert.equal(result.deductible, null);
  }
});

test('sin pagador en el 271 se usa el fallback, y sin fallback "Unknown"', () => {
  assert.equal(map271({}, OPTS).payerName, 'Test Payer Inc');
  assert.equal(map271({}).payerName, 'Unknown');
});

/* ------------------------------------------------------------------ */
/* Estados                                                             */
/* ------------------------------------------------------------------ */

test('EB01="I" (Non-Covered) → not-covered', () => {
  const nonCovered = {
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '1' }],
    benefitsInformation: [{ code: 'I', name: 'Non-Covered', serviceTypeCodes: ['A4'] }],
  };
  assert.equal(map271(nonCovered, OPTS).status, 'not-covered');
});

test('póliza inactiva (EB01="6") sin señal de vigencia → not-covered', () => {
  const inactive = {
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '6', status: 'Inactive' }],
    benefitsInformation: [{ code: '6', serviceTypeCodes: ['30'] }],
  };
  assert.equal(map271(inactive, OPTS).status, 'not-covered');
});

test('authOrCertIndicator="Y" → needs-auth y priorAuthRequired=true', () => {
  const needsAuth = {
    meta: { traceId: '9d8e7f' },
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '1' }],
    benefitsInformation: [
      {
        code: 'B',
        serviceTypeCodes: ['A4'],
        benefitAmount: '40',
        authOrCertIndicator: 'Y',
        planCoverage: 'PPO Silver',
        inPlanNetworkIndicatorCode: 'Y',
      },
      { code: 'A', serviceTypeCodes: ['A4'], benefitPercent: '0.2' },
    ],
  };
  const result = map271(needsAuth, OPTS);

  assert.equal(result.status, 'needs-auth');
  assert.equal(result.priorAuthRequired, true);
  assert.equal(result.copayCents, 4000);
  assert.equal(result.coinsurancePercent, 20);
});

test('EB01="V" (Cannot Process) → unknown aunque haya otros beneficios', () => {
  const cannotProcess = {
    payer: { name: 'Test Payer Inc' },
    benefitsInformation: [
      { code: 'V', name: 'Cannot Process' },
      { code: 'B', serviceTypeCodes: ['A4'], benefitAmount: '25' },
    ],
  };
  const result = map271(cannotProcess, OPTS);
  assert.equal(result.status, 'unknown');
  assert.equal(result.copayCents, null);
});

test('solo errores y ningún beneficio → unknown', () => {
  const errored = {
    meta: { traceId: 'err-1' },
    errors: [{ code: '42', description: 'Unable to respond at current time' }],
  };
  const result = map271(errored, OPTS);
  assert.equal(result.status, 'unknown');
  assert.equal(result.raw271Id, 'stedi-271-err-1');
});

test('errores del pagador con un beneficio suelto → unknown, sin copago', () => {
  // El pagador dijo "no sé quién es este miembro". Responder "cubierto, son 25
  // dólares" porque venía un EB01="B" en la misma respuesta es exactamente el
  // copago inventado que este servicio existe para no decir.
  const erroredWithBenefit = {
    meta: { traceId: 'err-2' },
    payer: { name: 'Test Payer Inc' },
    errors: [{ code: '72', description: 'Invalid/Missing Subscriber/Insured ID' }],
    benefitsInformation: [{ code: 'B', serviceTypeCodes: ['A4'], benefitAmount: '25' }],
  };
  const result = map271(erroredWithBenefit, OPTS);

  assert.equal(result.status, 'unknown');
  assert.equal(result.copayCents, null);
  assert.equal(result.deductible, null);
  assert.equal(result.coinsurancePercent, null);
  assert.equal(result.payerName, 'Test Payer Inc');
  assert.equal(result.raw271Id, 'stedi-271-err-2', 'la identidad del 271 sí se conserva');
});

test('errores del pagador tampoco permiten afirmar "not-covered"', () => {
  const erroredNonCovered = {
    payer: { name: 'Test Payer Inc' },
    errors: [{ code: '72', description: 'Invalid/Missing Subscriber/Insured ID' }],
    benefitsInformation: [{ code: 'I', name: 'Non-Covered', serviceTypeCodes: ['A4'] }],
  };
  assert.equal(map271(erroredNonCovered, OPTS).status, 'unknown');
});

test('con vigencia explícita (planStatus "1") los errores no tumban el resultado', () => {
  // Aquí sí hay una afirmación del pagador sobre la que apoyarse: dijo que la
  // póliza está activa. Los errores suelen ser de segmentos que no pedimos.
  const erroredButActive = {
    meta: { traceId: 'err-3' },
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '1', status: 'Active Coverage' }],
    errors: [{ code: '15', description: 'Required application data missing' }],
    benefitsInformation: [{ code: 'B', serviceTypeCodes: ['A4'], benefitAmount: '25' }],
  };
  const result = map271(erroredButActive, OPTS);

  assert.equal(result.status, 'covered');
  assert.equal(result.copayCents, 2500);
});

/* ------------------------------------------------------------------ */
/* Selección de beneficios                                             */
/* ------------------------------------------------------------------ */

test('si el service type pedido no aparece, cae al genérico "30"', () => {
  const genericOnly = {
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '1' }],
    benefitsInformation: [{ code: 'B', serviceTypeCodes: ['30'], benefitAmount: '15' }],
  };
  assert.equal(map271(genericOnly, { x12ServiceTypeCode: 'A4' }).copayCents, 1500);
});

test('el copago in-network gana al out-of-network', () => {
  const bothNetworks = {
    payer: { name: 'Test Payer Inc' },
    planStatus: [{ statusCode: '1' }],
    benefitsInformation: [
      { code: 'B', serviceTypeCodes: ['A4'], benefitAmount: '90', inPlanNetworkIndicatorCode: 'N' },
      { code: 'B', serviceTypeCodes: ['A4'], benefitAmount: '25', inPlanNetworkIndicatorCode: 'Y' },
    ],
  };
  assert.equal(map271(bothNetworks, OPTS).copayCents, 2500);
});

/* ------------------------------------------------------------------ */
/* Conversiones                                                        */
/* ------------------------------------------------------------------ */

test('dollarsToCents aguanta símbolos, comas y decimales', () => {
  assert.equal(dollarsToCents('25'), 2500);
  assert.equal(dollarsToCents('25.50'), 2550);
  assert.equal(dollarsToCents('$1,234.50'), 123_450);
  assert.equal(dollarsToCents(40), 4000);
  assert.equal(dollarsToCents(''), null);
  assert.equal(dollarsToCents('   '), null);
  assert.equal(dollarsToCents('no soy un monto'), null);
  assert.equal(dollarsToCents(null), null);
  assert.equal(dollarsToCents(undefined), null);
  assert.equal(dollarsToCents('-5'), null);
});

test('toCoinsurancePercent entiende fracción y puntos porcentuales', () => {
  assert.equal(toCoinsurancePercent('0.2'), 20);
  assert.equal(toCoinsurancePercent('0'), 0);
  assert.equal(toCoinsurancePercent('20'), 20);
  assert.equal(toCoinsurancePercent('1'), 100);
  assert.equal(toCoinsurancePercent('0.125'), 12.5);
  assert.equal(toCoinsurancePercent('999'), null);
  assert.equal(toCoinsurancePercent('abc'), null);
  assert.equal(toCoinsurancePercent(undefined), null);
});
