/**
 * Tests de la carga del `.env`.
 *
 * Lo que se prueba aquí es que escribir `STEDI_API_KEY=...` en un archivo tenga
 * efecto de verdad. El fallo que estos tests impiden es silencioso: la clave
 * puesta, el servicio en modo mock y nadie enterándose hasta el escenario.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEnvFile, parseEnvFile } from './env-file.js';

/** Escribe un `.env` temporal y devuelve su ruta. Se limpia al terminar. */
function withEnvFile(contents: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'loop-coverage-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents, 'utf8');
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Parseo                                                              */
/* ------------------------------------------------------------------ */

test('parsea el formato que trae ops/.env.example', () => {
  const parsed = parseEnvFile(
    [
      '# Comentario de cabecera',
      '',
      'USE_MOCKS=true',
      'STEDI_API_KEY=',
      'STEDI_TEST_PAYER_NAME=Test Payer Inc',
      'MEDPLUM_BASE_URL=https://api.medplum.com/',
      'NEXT_PUBLIC_USE_FIXTURES=false   # comentario al final',
    ].join('\n'),
  );

  assert.equal(parsed['USE_MOCKS'], 'true');
  assert.equal(parsed['STEDI_API_KEY'], '', 'una clave vacía es "no configurado", no se pierde');
  assert.equal(parsed['STEDI_TEST_PAYER_NAME'], 'Test Payer Inc');
  assert.equal(parsed['MEDPLUM_BASE_URL'], 'https://api.medplum.com/');
  assert.equal(parsed['NEXT_PUBLIC_USE_FIXTURES'], 'false');
});

test('admite comillas y el prefijo export', () => {
  const parsed = parseEnvFile(
    ['export STEDI_API_KEY="clave con espacios"', "STEDI_TEST_MEMBER_ID='M-123'"].join('\n'),
  );

  assert.equal(parsed['STEDI_API_KEY'], 'clave con espacios');
  assert.equal(parsed['STEDI_TEST_MEMBER_ID'], 'M-123');
});

test('un valor entre comillas conserva su almohadilla', () => {
  const parsed = parseEnvFile('STEDI_API_KEY="ab#cd"');
  assert.equal(parsed['STEDI_API_KEY'], 'ab#cd');
});

test('las líneas inservibles se ignoran sin lanzar', () => {
  const parsed = parseEnvFile(['esto no tiene igual', '=sin nombre', '1MAL=x', '   ', '#'].join('\n'));
  assert.deepEqual(parsed, {});
});

/* ------------------------------------------------------------------ */
/* Aplicación                                                          */
/* ------------------------------------------------------------------ */

test('aplica las claves del archivo al entorno', () => {
  withEnvFile('STEDI_API_KEY=clave-del-archivo\nUSE_MOCKS=false\n', (path) => {
    const target: NodeJS.ProcessEnv = {};
    const report = applyEnvFile({ file: path, target });

    assert.equal(report.reason, 'ok');
    assert.equal(report.path, path);
    assert.equal(target['STEDI_API_KEY'], 'clave-del-archivo');
    assert.equal(target['USE_MOCKS'], 'false');
    assert.deepEqual(report.applied.sort(), ['STEDI_API_KEY', 'USE_MOCKS']);
  });
});

test('el entorno del shell gana sobre el archivo', () => {
  withEnvFile('USE_MOCKS=false\n', (path) => {
    const target: NodeJS.ProcessEnv = { USE_MOCKS: 'true' };
    const report = applyEnvFile({ file: path, target });

    assert.equal(target['USE_MOCKS'], 'true', 'un USE_MOCKS=true del shell no se pisa');
    assert.deepEqual(report.skipped, ['USE_MOCKS']);
    assert.deepEqual(report.applied, []);
  });
});

test('COVERAGE_ENV_FILE=none desactiva la carga', () => {
  withEnvFile('STEDI_API_KEY=no-debería-aplicarse\n', (path) => {
    const target: NodeJS.ProcessEnv = { COVERAGE_ENV_FILE: 'none' };
    const report = applyEnvFile({ target });

    assert.equal(report.reason, 'disabled');
    assert.equal(target['STEDI_API_KEY'], undefined);
    assert.ok(path.length > 0); // el archivo existe, simplemente no se lee
  });
});

test('una ruta pedida a mano que no existe queda registrada', () => {
  const target: NodeJS.ProcessEnv = {};
  const report = applyEnvFile({ file: '/no/existe/.env', target });

  assert.equal(report.reason, 'not-found');
  assert.equal(report.path, null);
  assert.equal(report.requestedPath, '/no/existe/.env', 'el arranque tiene que poder avisarlo');
});

test('sin archivo no lanza ni ensucia el entorno', () => {
  const target: NodeJS.ProcessEnv = { COVERAGE_ENV_FILE: '/tampoco/existe/.env' };
  const report = applyEnvFile({ target });

  assert.equal(report.reason, 'not-found');
  assert.deepEqual(Object.keys(target), ['COVERAGE_ENV_FILE']);
});
