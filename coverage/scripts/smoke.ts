/**
 * Smoke test de loop-coverage.
 *
 *   npm run smoke --workspace @loop/coverage
 *
 * Levanta la app EN PROCESO en un puerto efímero (no hace falta otra terminal
 * ni que nadie más esté arriba), le pega por HTTP real, y valida CADA respuesta
 * contra los esquemas de `@loop/shared`. Sale con código != 0 si algo falla.
 *
 * Corre siempre en modo mock: un smoke que dependa de la red no sirve de nada
 * a las 3 de la mañana de un hackathon. El escenario de fallo de Stedi se
 * prueba apuntando a un puerto cerrado, que falla al instante y sin red.
 */

export {}; // marca el archivo como módulo: abajo se usa top-level await

/* El entorno se fija ANTES de importar la app: `config.ts` lee process.env al
 * cargarse, así que el import tiene que ser dinámico. */
process.env['USE_MOCKS'] = 'true';
process.env['LOG_LEVEL'] = 'silent';
delete process.env['STEDI_API_KEY'];
delete process.env['COVERAGE_MOCK_SCENARIO'];
/* Hermético a propósito: el resultado del smoke no puede depender de si en esta
 * máquina hay un `.env` con credenciales de Stedi. */
process.env['COVERAGE_ENV_FILE'] = 'none';

const { ApiError, CoverageCheckResponse, HealthResponse, TIMEOUTS_MS } = await import('@loop/shared');
const { loadConfig } = await import('../src/config.js');
const { buildServer } = await import('../src/server.js');
const { buildVoiceSummary } = await import('../src/voice-summary.js');

type Json = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Mini runner                                                         */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];

function ok(label: string): void {
  passed++;
  console.log(`  ok    ${label}`);
}

function fail(label: string, detail: string): void {
  failures.push(`${label} — ${detail}`);
  console.log(`  FALLA ${label}\n          ${detail}`);
}

function expect(label: string, condition: boolean, detail = ''): void {
  if (condition) ok(label);
  else fail(label, detail || 'la condición no se cumplió');
}

async function post(baseUrl: string, path: string, body: unknown, raw = false) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? String(body) : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* se reporta como fallo donde toque */
  }
  return { status: response.status, json, text };
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

const mockConfig = { ...loadConfig(), port: 0, host: '127.0.0.1', logLevel: 'silent' as const };
const app = await buildServer(mockConfig);
await app.listen({ port: 0, host: '127.0.0.1' });

const address = app.server.address();
if (address === null || typeof address === 'string') {
  console.error('No se pudo determinar el puerto del servidor de pruebas.');
  process.exit(1);
}
const baseUrl = `http://127.0.0.1:${address.port}`;

/**
 * Segunda instancia: Stedi "configurado" pero apuntando a un puerto cerrado.
 * Sirve para demostrar la regla más importante del servicio —nunca un 5xx—
 * sin necesitar credenciales ni salir a internet.
 *
 * Lleva payer y miembro de prueba porque sin ellos el cliente ni siquiera
 * intenta la llamada (mandaría un 270 incompleto), y aquí lo que se quiere
 * probar es justamente el camino de red que falla.
 */
const brokenStediConfig = {
  ...mockConfig,
  useMocks: false,
  stediConfigured: true,
  stediMissing: [],
  stedi: {
    ...mockConfig.stedi,
    apiKey: 'clave-falsa-de-smoke-test',
    payerId: 'PAYER-SMOKE',
    memberId: 'MEMBER-SMOKE',
    memberDob: '19920314',
    baseUrl: 'http://127.0.0.1:1', // puerto reservado: ECONNREFUSED inmediato
  },
};
const brokenApp = await buildServer(brokenStediConfig);
await brokenApp.listen({ port: 0, host: '127.0.0.1' });
const brokenAddress = brokenApp.server.address();
if (brokenAddress === null || typeof brokenAddress === 'string') {
  console.error('No se pudo determinar el puerto del servidor de fallo.');
  process.exit(1);
}
const brokenBaseUrl = `http://127.0.0.1:${brokenAddress.port}`;

console.log(`\nloop-coverage smoke — ${baseUrl} (mock) · ${brokenBaseUrl} (stedi caído)\n`);

/* ------------------------------------------------------------------ */
/* 1. /healthz                                                         */
/* ------------------------------------------------------------------ */

console.log('GET /healthz');
{
  const response = await fetch(`${baseUrl}/healthz`);
  const json: unknown = await response.json();
  expect('responde 200', response.status === 200, `status ${response.status}`);

  const parsed = HealthResponse.safeParse(json);
  expect(
    'cumple HealthResponse',
    parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error?.issues),
  );

  if (parsed.success) {
    expect('service = loop-coverage', parsed.data.service === 'loop-coverage', parsed.data.service);
    expect('useMocks = true', parsed.data.useMocks === true);
    expect(
      'upstream.stedi = not-configured (sin API key)',
      parsed.data.upstream?.['stedi'] === 'not-configured',
      String(parsed.data.upstream?.['stedi']),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 2. El camino del demo y los otros escenarios                        */
/* ------------------------------------------------------------------ */

const FORBIDDEN = [/cents?\b/i, /centavos?\b/i];

interface Scenario {
  label: string;
  body: Json;
  expectedStatus: 'covered' | 'not-covered' | 'needs-auth' | 'unknown';
  expectCopay: boolean;
}

const scenarios: Scenario[] = [
  {
    label: 'CPT 90834 · telesalud salud mental (el camino del demo)',
    body: {
      patientId: 'loop-demo-patient-001',
      serviceType: 'telehealth-mental-health',
      cptCode: '90834',
      requestedBy: 'voice-agent',
      callId: 'call-8f2a',
    },
    expectedStatus: 'covered',
    expectCopay: true,
  },
  {
    label: 'CPT 90832 · fuerza needs-auth',
    body: {
      patientId: 'loop-demo-patient-001',
      serviceType: 'outpatient-mental-health',
      cptCode: '90832',
      requestedBy: 'medplum-bot',
    },
    expectedStatus: 'needs-auth',
    expectCopay: true,
  },
  {
    label: 'CPT 99213 · fuerza el fallback unknown',
    body: {
      patientId: 'loop-demo-patient-001',
      serviceType: 'telehealth-mental-health',
      cptCode: '99213',
      requestedBy: 'dashboard',
      callId: null,
    },
    expectedStatus: 'unknown',
    expectCopay: false,
  },
  {
    label: 'serviceType prescription-drug · needs-auth por tipo de servicio',
    body: {
      patientId: 'loop-demo-patient-001',
      serviceType: 'prescription-drug',
      cptCode: 'J3490',
      requestedBy: 'voice-agent',
      callId: 'call-8f2a',
    },
    expectedStatus: 'needs-auth',
    expectCopay: true,
  },
];

const seenCheckIds = new Set<string>();

for (const scenario of scenarios) {
  console.log(`\nPOST /api/v1/coverage/check — ${scenario.label}`);
  const { status, json } = await post(baseUrl, '/api/v1/coverage/check', scenario.body);

  expect('responde 200', status === 200, `status ${status}`);

  const parsed = CoverageCheckResponse.safeParse(json);
  expect(
    'cumple CoverageCheckResponse',
    parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error?.issues),
  );
  if (!parsed.success) continue;

  const data = parsed.data;

  expect(`status = ${scenario.expectedStatus}`, data.status === scenario.expectedStatus, data.status);
  expect('checkId lleva el prefijo cov-', data.checkId.startsWith('cov-'), data.checkId);
  expect('checkId es nuevo en esta corrida', !seenCheckIds.has(data.checkId), data.checkId);
  seenCheckIds.add(data.checkId);

  expect(
    'checkedAt es de ahora (menos de 10s)',
    Math.abs(Date.now() - new Date(data.checkedAt).getTime()) < 10_000,
    data.checkedAt,
  );
  expect(
    `latencyMs medido y por debajo del presupuesto (${TIMEOUTS_MS.coverageCheck}ms)`,
    data.latencyMs >= 0 && data.latencyMs < TIMEOUTS_MS.coverageCheck,
    String(data.latencyMs),
  );

  expect('voiceSummary no está vacío', data.voiceSummary.trim().length > 0);
  expect(
    'voiceSummary sale de la plantilla, no copiado del fixture',
    data.voiceSummary ===
      buildVoiceSummary(
        {
          status: data.status,
          copayCents: data.copayCents,
          coinsurancePercent: data.coinsurancePercent,
          deductible: data.deductible,
          priorAuthRequired: data.priorAuthRequired,
          payerName: data.payerName,
        },
        mockConfig.lang,
      ),
    data.voiceSummary,
  );
  expect(
    'voiceSummary mide menos de 220 caracteres',
    data.voiceSummary.length < 220,
    `${data.voiceSummary.length} caracteres`,
  );
  expect(
    'voiceSummary no menciona centavos',
    FORBIDDEN.every((pattern) => !pattern.test(data.voiceSummary)),
    data.voiceSummary,
  );

  if (scenario.expectCopay) {
    expect('trae copayCents', data.copayCents !== null, String(data.copayCents));
  } else {
    expect(
      'unknown no inventa números',
      data.copayCents === null && data.deductible === null && data.coinsurancePercent === null,
      JSON.stringify({ copayCents: data.copayCents, deductible: data.deductible }),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 3. checkId único entre llamadas idénticas                           */
/* ------------------------------------------------------------------ */

console.log('\nDos llamadas idénticas');
{
  const body = {
    patientId: 'loop-demo-patient-001',
    serviceType: 'telehealth-mental-health',
    cptCode: '90834',
    requestedBy: 'voice-agent',
  };
  const a = CoverageCheckResponse.safeParse((await post(baseUrl, '/api/v1/coverage/check', body)).json);
  const b = CoverageCheckResponse.safeParse((await post(baseUrl, '/api/v1/coverage/check', body)).json);

  if (a.success && b.success) {
    expect('cada llamada tiene su propio checkId', a.data.checkId !== b.data.checkId);
    expect('el voiceSummary es determinista', a.data.voiceSummary === b.data.voiceSummary);
  } else {
    fail('dos llamadas idénticas', 'alguna respuesta no cumplió el contrato');
  }
}

/* ------------------------------------------------------------------ */
/* 4. Bodies inválidos → 400 con forma ApiError                        */
/* ------------------------------------------------------------------ */

const badBodies: [string, unknown, boolean][] = [
  ['body vacío', {}, false],
  ['falta cptCode', { patientId: 'p', serviceType: 's', requestedBy: 'voice-agent' }, false],
  [
    'requestedBy fuera del enum',
    { patientId: 'p', serviceType: 's', cptCode: '90834', requestedBy: 'quien-sea' },
    false,
  ],
  ['JSON malformado', '{ esto no es json', true],
];

for (const [label, body, raw] of badBodies) {
  console.log(`\nPOST /api/v1/coverage/check — ${label}`);
  const { status, json } = await post(baseUrl, '/api/v1/coverage/check', body, raw);
  expect('responde 400 (bug del cliente, no se esconde)', status === 400, `status ${status}`);
  const parsed = ApiError.safeParse(json);
  expect('el error cumple ApiError', parsed.success, JSON.stringify(json));
}

/* ------------------------------------------------------------------ */
/* 5. Stedi caído → 200 unknown, jamás un 5xx                          */
/* ------------------------------------------------------------------ */

console.log('\nPOST /api/v1/coverage/check — Stedi inalcanzable');
{
  const { status, json } = await post(brokenBaseUrl, '/api/v1/coverage/check', {
    patientId: 'loop-demo-patient-001',
    serviceType: 'telehealth-mental-health',
    cptCode: '90834',
    requestedBy: 'voice-agent',
    callId: 'call-8f2a',
  });

  expect('responde 200 aunque el upstream esté caído', status === 200, `status ${status}`);
  const parsed = CoverageCheckResponse.safeParse(json);
  expect(
    'cumple CoverageCheckResponse',
    parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error?.issues),
  );
  if (parsed.success) {
    expect('status = unknown', parsed.data.status === 'unknown', parsed.data.status);
    expect(
      'no inventa ningún monto',
      parsed.data.copayCents === null &&
        parsed.data.coinsurancePercent === null &&
        parsed.data.deductible === null,
    );
    expect(
      'voiceSummary es honesto',
      /no pude verificar|could not check/i.test(parsed.data.voiceSummary),
      parsed.data.voiceSummary,
    );
    expect(
      `respondió dentro del presupuesto de voice/ (${TIMEOUTS_MS.coverageCheck}ms)`,
      parsed.data.latencyMs < TIMEOUTS_MS.coverageCheck,
      `${parsed.data.latencyMs}ms`,
    );
  }
}

console.log('\nGET /healthz tras el fallo de Stedi');
{
  const response = await fetch(`${brokenBaseUrl}/healthz`);
  const parsed = HealthResponse.safeParse(await response.json());
  expect('cumple HealthResponse', parsed.success);
  if (parsed.success) {
    expect(
      'upstream.stedi = down',
      parsed.data.upstream?.['stedi'] === 'down',
      String(parsed.data.upstream?.['stedi']),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 6. Ruta inexistente                                                 */
/* ------------------------------------------------------------------ */

console.log('\nGET /no-existe');
{
  const response = await fetch(`${baseUrl}/no-existe`);
  expect('responde 404', response.status === 404, `status ${response.status}`);
  const parsed = ApiError.safeParse(await response.json());
  expect('el error cumple ApiError', parsed.success);
}

/* ------------------------------------------------------------------ */
/* 7. La frase no nombra un servicio que nadie pidió                   */
/* ------------------------------------------------------------------ */

console.log('\nPOST /api/v1/coverage/check — consulta de farmacia con CPT del demo');
{
  const { json } = await post(baseUrl, '/api/v1/coverage/check', {
    patientId: 'loop-demo-patient-001',
    serviceType: 'prescription-drug',
    cptCode: '90834',
    requestedBy: 'voice-agent',
  });
  const parsed = CoverageCheckResponse.safeParse(json);
  expect('cumple CoverageCheckResponse', parsed.success);
  if (parsed.success) {
    expect(
      'la frase no menciona telesalud si no se preguntó por telesalud',
      !/telesalud|telehealth/i.test(parsed.data.voiceSummary),
      parsed.data.voiceSummary,
    );
  }
}

console.log('\nPOST /api/v1/coverage/check — needs-auth dice el copago que trae la respuesta');
{
  const { json } = await post(baseUrl, '/api/v1/coverage/check', {
    patientId: 'loop-demo-patient-001',
    serviceType: 'outpatient-mental-health',
    cptCode: '90832',
    requestedBy: 'voice-agent',
  });
  const parsed = CoverageCheckResponse.safeParse(json);
  expect('cumple CoverageCheckResponse', parsed.success);
  if (parsed.success) {
    // El JSON dice copayCents 4000; la frase tiene que decir lo mismo.
    expect('la frase menciona los 40 dólares del copago', /40 dólares/.test(parsed.data.voiceSummary), parsed.data.voiceSummary);
  }
}

/* ------------------------------------------------------------------ */
/* 8. Configuración: la API key sola no saca al servicio de mock       */
/* ------------------------------------------------------------------ */

console.log('\nloadConfig — mínimo viable para hablar con Stedi');
{
  const soloApiKey = loadConfig({
    USE_MOCKS: 'false',
    STEDI_API_KEY: 'clave-de-prueba',
    COVERAGE_ENV_FILE: 'none',
  });
  expect('con solo la API key sigue en mock', soloApiKey.useMocks === true);
  expect('stediConfigured = false', soloApiKey.stediConfigured === false);
  expect(
    'dice exactamente qué falta',
    soloApiKey.stediMissing.length === 3 &&
      soloApiKey.stediMissing.every((name) => name.startsWith('STEDI_TEST_')),
    soloApiKey.stediMissing.join(', '),
  );

  const completo = loadConfig({
    USE_MOCKS: 'false',
    STEDI_API_KEY: 'clave-de-prueba',
    STEDI_TEST_PAYER_ID: 'PAYER-1',
    STEDI_TEST_MEMBER_ID: 'MEMBER-1',
    STEDI_TEST_MEMBER_DOB: '1992-03-14',
    COVERAGE_ENV_FILE: 'none',
  });
  expect('con payer y miembro sí sale a real', completo.useMocks === false);
  expect('stediConfigured = true', completo.stediConfigured === true);
  expect('la fecha queda normalizada a YYYYMMDD', completo.stedi.memberDob === '19920314', String(completo.stedi.memberDob));

  const fechaRota = loadConfig({
    USE_MOCKS: 'false',
    STEDI_API_KEY: 'clave-de-prueba',
    STEDI_TEST_PAYER_ID: 'PAYER-1',
    STEDI_TEST_MEMBER_ID: 'MEMBER-1',
    STEDI_TEST_MEMBER_DOB: 'marzo del 92',
    COVERAGE_ENV_FILE: 'none',
  });
  expect('una fecha inservible no cuenta como configurada', fechaRota.useMocks === true);
}

/* ------------------------------------------------------------------ */
/* Resumen                                                             */
/* ------------------------------------------------------------------ */

await app.close();
await brokenApp.close();

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log(`loop-coverage smoke: ${passed} comprobaciones, todo en verde.\n`);
  process.exit(0);
}
console.log(`loop-coverage smoke: ${passed} en verde, ${failures.length} en rojo:\n`);
for (const failure of failures) console.log(`  · ${failure}`);
console.log('');
process.exit(1);
