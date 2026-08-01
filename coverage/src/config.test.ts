/**
 * Tests de `loadConfig`.
 *
 * La pregunta que responden: ¿cuándo sale este servicio a Stedi de verdad?
 * Salir a real con la petición incompleta acaba en "no pude verificar" delante
 * de los jueces, que es peor que un fixture honesto.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/* `config.ts` aplica el `.env` y construye la config del proceso al importarse.
 * Se desactiva ANTES del import (por eso es dinámico) para que el resultado de
 * los tests no dependa de si esta máquina tiene un `.env` con credenciales. */
process.env['COVERAGE_ENV_FILE'] = 'none';
const { loadConfig, normalizeDob } = await import('./config.js');

/** El mínimo que exige el 270. */
const FULL = {
  STEDI_API_KEY: 'clave-de-prueba',
  STEDI_TEST_PAYER_ID: 'PAYER-1',
  STEDI_TEST_MEMBER_ID: 'MEMBER-1',
  STEDI_TEST_MEMBER_DOB: '1992-03-14',
  COVERAGE_ENV_FILE: 'none',
};

test('sin nada configurado arranca en modo mock', () => {
  const cfg = loadConfig({ COVERAGE_ENV_FILE: 'none' });
  assert.equal(cfg.useMocks, true);
  assert.equal(cfg.stediConfigured, false);
  assert.ok(cfg.stediMissing.includes('STEDI_API_KEY'));
});

test('la API key sola NO basta para salir a modo real', () => {
  // Con `ops/.env.example` copiado tal cual, payer y miembro vienen vacíos: es
  // el estado más probable el día del demo.
  const cfg = loadConfig({ USE_MOCKS: 'false', STEDI_API_KEY: 'k', COVERAGE_ENV_FILE: 'none' });

  assert.equal(cfg.useMocks, true, 'mejor el fixture covered que un 270 lleno de nulls');
  assert.equal(cfg.stediConfigured, false);
  assert.deepEqual(cfg.stediMissing, [
    'STEDI_TEST_PAYER_ID',
    'STEDI_TEST_MEMBER_ID',
    'STEDI_TEST_MEMBER_DOB',
  ]);
});

test('con el mínimo viable sí sale a real', () => {
  const cfg = loadConfig({ ...FULL, USE_MOCKS: 'false' });

  assert.equal(cfg.useMocks, false);
  assert.equal(cfg.stediConfigured, true);
  assert.deepEqual(cfg.stediMissing, []);
  assert.equal(cfg.stedi.memberDob, '19920314', 'normalizada para el 270');
});

test('USE_MOCKS=true manda aunque Stedi esté completo', () => {
  const cfg = loadConfig({ ...FULL, USE_MOCKS: 'true' });
  assert.equal(cfg.useMocks, true);
  assert.equal(cfg.stediConfigured, true, 'la palanca no borra que Stedi sí está configurado');
});

test('cada variable que falte se nombra, para poder arreglarla sin adivinar', () => {
  for (const missing of ['STEDI_TEST_PAYER_ID', 'STEDI_TEST_MEMBER_ID'] as const) {
    const env: NodeJS.ProcessEnv = { ...FULL, USE_MOCKS: 'false' };
    delete env[missing];
    const cfg = loadConfig(env);

    assert.equal(cfg.useMocks, true, `falta ${missing}`);
    assert.deepEqual(cfg.stediMissing, [missing]);
  }
});

test('una fecha de nacimiento inservible cuenta como faltante y lo dice', () => {
  const cfg = loadConfig({ ...FULL, USE_MOCKS: 'false', STEDI_TEST_MEMBER_DOB: 'marzo del 92' });

  assert.equal(cfg.useMocks, true);
  assert.equal(cfg.stedi.memberDob, null);
  assert.equal(cfg.stediMissing.length, 1);
  assert.match(cfg.stediMissing[0] ?? '', /STEDI_TEST_MEMBER_DOB/);
  assert.match(cfg.stediMissing[0] ?? '', /marzo del 92/, 'el log tiene que decir qué había');
});

test('las claves vacías del .env.example son "no configurado", no "configurado con nada"', () => {
  const cfg = loadConfig({ ...FULL, STEDI_TEST_PAYER_ID: '   ', COVERAGE_ENV_FILE: 'none' });
  assert.equal(cfg.stedi.payerId, null);
  assert.equal(cfg.stediConfigured, false);
});

test('normalizeDob acepta el formato del .env y rechaza lo demás', () => {
  assert.equal(normalizeDob('1992-03-14'), '19920314');
  assert.equal(normalizeDob('19920314'), '19920314');
  assert.equal(normalizeDob('1992/03/14'), '19920314');
  assert.equal(normalizeDob('92-03-14'), null);
  assert.equal(normalizeDob(''), null);
  assert.equal(normalizeDob(null), null);
});
