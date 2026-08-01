/**
 * Suite de los clientes HTTP de loop-voice.
 *
 * Lo que se prueba aqui no es "que la llamada funcione": es que **cuando :3001
 * o :3003 se caen, la llamada del paciente sigue**. Cada caso negativo es un
 * escalon de la cadena de degradacion.
 *
 * `fetch` va siempre mockeado con `vi.stubGlobal`: la suite no toca la red.
 * `config` va mockeado para poder mover `useMocks` y usar timeouts de
 * milisegundos sin esperar dos segundos por test.
 */

import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Mock de config (hoisted: el objeto es mutable y se toca en cada test)
// -----------------------------------------------------------------------------

const mocked = vi.hoisted(() => ({
  config: {
    useMocks: false,
    coreUrl: 'http://core.test',
    coverageUrl: 'http://coverage.test',
    patientId: 'loop-demo-patient-001',
    timeouts: { contextMs: 60, coverageMs: 60, episodeMs: 60, ttsMs: 60 },
  },
}));

vi.mock('../../config.js', () => ({ config: mocked.config }));

import {
  getContextSource,
  getPatientContext,
  postEpisode,
  resetCoreClientStateForTests,
  warmContext,
  PENDING_EPISODES_DIR,
} from '../coreClient.js';
import { checkCoverage } from '../coverageClient.js';
import { fetchJson, resetFixtureCacheForTests } from '../http.js';
import type { EpisodeWriteback, PatientContext } from '../../types.js';

// -----------------------------------------------------------------------------
// Utilidades de test
// -----------------------------------------------------------------------------

const PATIENT = 'loop-demo-patient-001';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

/** fetch que responde lo que se le diga, en orden. */
function fetchReturning(...responses: Response[]): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response.clone();
  });
}

/** fetch que nunca resuelve: solo se rinde cuando el AbortController dispara. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = (): void => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (!signal) return;
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
  );
}

/** fetch que revienta como lo haria un ECONNREFUSED. */
function failingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    throw new TypeError('fetch failed');
  });
}

function liveContext(overrides: Partial<PatientContext> = {}): PatientContext {
  return {
    patientId: PATIENT,
    displayName: 'Alex Rivera',
    age: 34,
    generatedAt: '2026-08-01T18:22:11Z',
    baseline: {
      heartRate: { mean: 68, sd: 6, unit: 'bpm' },
      hrv: { mean: 54, sd: 11, unit: 'ms' },
      respiratoryRate: { mean: 14, sd: 2, unit: 'breaths/min' },
      sleepHours: { mean: 6.8, sd: 1.1, unit: 'h' },
    },
    current: {
      windowMinutes: 30,
      heartRate: { latest: 131, max: 133, trend: 'rising', unit: 'bpm' },
      hrv: { latest: 19, min: 17, trend: 'falling', unit: 'ms' },
      respiratoryRate: { latest: 25, max: 26, trend: 'rising', unit: 'breaths/min' },
      lastSampleAt: '2026-08-01T18:21:40Z',
    },
    deltas: {
      heartRate: { absolute: 63, sdFromBaseline: 10.5 },
      hrv: { absolute: -35, sdFromBaseline: -3.2 },
    },
    conditions: [],
    carePlan: { id: 'cp-live', authoredBy: 'Dr. Maya Chen', lastUpdated: '2026-07-02', activities: [] },
    recentEpisodes: [],
    medications: [],
    safetyEnvelope: { heartRateMax: 150, heartRateMin: 40, respiratoryRateMax: 32, spo2Min: 92 },
    ...overrides,
  };
}

function sampleEpisode(callId = 'call-test-01'): EpisodeWriteback {
  return {
    patientId: PATIENT,
    callId,
    startedAt: '2026-08-01T18:20:02Z',
    endedAt: '2026-08-01T18:34:50Z',
    outcome: 'resolved-with-intervention',
    escalation: { triggered: false, rule: null, triggeredAt: null, action: null },
    severitySelfReported: 7,
    interventionsAttempted: [
      {
        carePlanActivityId: 'cp-act-1',
        startedAt: '2026-08-01T18:23:10Z',
        completed: true,
        patientReportedRelief: 6,
      },
    ],
    biometricsSnapshot: { peakHeartRate: 126, minHrv: 18, peakRespiratoryRate: 27 },
    transcript: {
      redacted: true,
      turns: [{ speaker: 'patient', at: '2026-08-01T18:20:05Z', text: 'me cuesta respirar' }],
    },
    coverageChecks: [
      {
        checkId: 'cov-1a2b',
        serviceType: 'telehealth-mental-health',
        result: 'covered',
        copayCents: 2500,
      },
    ],
  };
}

function coverageRequest(): Parameters<typeof checkCoverage>[0] {
  return {
    patientId: PATIENT,
    serviceType: 'telehealth-mental-health',
    cptCode: '90834',
    requestedBy: 'voice-agent',
    callId: 'call-test-01',
  };
}

// -----------------------------------------------------------------------------

beforeEach(() => {
  mocked.config.useMocks = false;
  resetCoreClientStateForTests();
  resetFixtureCacheForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =============================================================================
// http.ts — fetchJson
// =============================================================================

describe('fetchJson', () => {
  it('camino feliz: devuelve ok, data y latencia medida', async () => {
    vi.stubGlobal('fetch', fetchReturning(jsonResponse({ hola: 'mundo' })));

    const result = await fetchJson<{ hola: string }>('http://core.test/x');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ hola: 'mundo' });
    expect(result.error).toBeNull();
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('timeout: aborta, no lanza y marca timedOut', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const result = await fetchJson('http://core.test/lento', { timeoutMs: 30, retries: 0 });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe(0);
    expect(result.data).toBeNull();
    expect(result.error).toContain('timeout');
  });

  it('500: reintenta UNA vez y se rinde', async () => {
    const fetchMock = fetchReturning(textResponse('boom', 500), textResponse('boom', 500));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson('http://core.test/x', { timeoutMs: 500, retries: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('404: NO reintenta (un 4xx no cambia de opinion en 120ms)', async () => {
    const fetchMock = fetchReturning(textResponse('nope', 404));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson('http://core.test/x', { timeoutMs: 500, retries: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.attempts).toBe(1);
  });

  it('200 con cuerpo que no es JSON: ok=false, sin reintento y sin lanzar', async () => {
    const fetchMock = fetchReturning(textResponse('<html>gateway</html>', 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson('http://core.test/x', { retries: 1 });

    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toContain('no es JSON valido');
    expect(result.attempts).toBe(1);
  });

  it('error de red: se traduce a status 0 sin propagar la excepcion', async () => {
    vi.stubGlobal('fetch', failingFetch());

    const result = await fetchJson('http://core.test/x', { retries: 0 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain('error de red');
  });

  it('POST: serializa el cuerpo y pone content-type', async () => {
    const fetchMock = fetchReturning(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJson('http://core.test/x', { method: 'POST', body: { a: 1 } });

    const init = fetchMock.mock.calls[0]?.[1] as { method: string; body: string; headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('budgetMs: si el presupuesto total no da para el reintento, no reintenta', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchJson('http://core.test/x', {
      timeoutMs: 30,
      retries: 1,
      budgetMs: 40,
    });

    expect(result.attempts).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// coreClient — contexto
// =============================================================================

describe('coreClient.getPatientContext', () => {
  it('USE_MOCKS=true: lee el fixture feliz y no toca la red', async () => {
    mocked.config.useMocks = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const context = await getPatientContext(PATIENT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getContextSource()).toBe('fixture');
    expect(context.displayName).toBe('Alex Rivera');
    expect(context.current.heartRate.latest).toBe(118);
    expect(context.safetyEnvelope.heartRateMax).toBe(150);
  });

  it('USE_MOCKS=true + profile cardiac-redflag: sirve el fixture con biometria fuera del envelope', async () => {
    mocked.config.useMocks = true;
    vi.stubGlobal('fetch', vi.fn());

    const context = await getPatientContext(PATIENT, { profile: 'cardiac-redflag' });

    expect(context.current.heartRate.latest).toBe(163);
    expect(context.current.heartRate.latest).toBeGreaterThan(context.safetyEnvelope.heartRateMax);
    expect(context.current.respiratoryRate.latest).toBeGreaterThan(
      context.safetyEnvelope.respiratoryRateMax,
    );
  });

  it('live: valida contra el contrato, cachea y reporta fuente=live', async () => {
    const fetchMock = fetchReturning(jsonResponse(liveContext()));
    vi.stubGlobal('fetch', fetchMock);

    const context = await getPatientContext(PATIENT);

    expect(getContextSource()).toBe('live');
    expect(context.current.heartRate.latest).toBe(131);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`http://core.test/api/v1/context/${PATIENT}?window=30m`);
  });

  it('live cae despues de un exito: devuelve el ultimo contexto conocido (fuente=cache)', async () => {
    vi.stubGlobal('fetch', fetchReturning(jsonResponse(liveContext())));
    await getPatientContext(PATIENT);
    expect(getContextSource()).toBe('live');

    vi.stubGlobal('fetch', failingFetch());
    const context = await getPatientContext(PATIENT);

    expect(getContextSource()).toBe('cache');
    expect(context.current.heartRate.latest).toBe(131); // el mismo del live cacheado
  });

  it('live cae sin cache previa: cae al fixture y NUNCA devuelve null', async () => {
    vi.stubGlobal('fetch', failingFetch());

    const context = await getPatientContext(PATIENT);

    expect(context).not.toBeNull();
    expect(getContextSource()).toBe('fixture');
    expect(context.current.heartRate.latest).toBe(118); // fixture happy
    expect(context.safetyEnvelope).toBeDefined();
  });

  it('live responde 200 con un payload que no valida: degrada en vez de propagar el error de zod', async () => {
    vi.stubGlobal('fetch', fetchReturning(jsonResponse({ patientId: PATIENT, roto: true })));

    const context = await getPatientContext(PATIENT);

    expect(getContextSource()).toBe('fixture');
    expect(context.baseline.heartRate.mean).toBe(68);
  });

  it('live se queda colgado: el timeout corta y se sigue con el fixture', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const context = await getPatientContext(PATIENT);

    expect(getContextSource()).toBe('fixture');
    expect(context.patientId).toBe(PATIENT);
  });

  it('warmContext precarga: el fallo posterior se sirve desde cache', async () => {
    vi.stubGlobal('fetch', fetchReturning(jsonResponse(liveContext())));
    const warmed = await warmContext(PATIENT);
    expect(warmed.current.heartRate.latest).toBe(131);

    vi.stubGlobal('fetch', fetchReturning(textResponse('down', 503), textResponse('down', 503)));
    const context = await getPatientContext(PATIENT);

    expect(getContextSource()).toBe('cache');
    expect(context.current.heartRate.latest).toBe(131);
  });

  it('en mocks respeta el patientId pedido aunque el fixture traiga el del demo', async () => {
    mocked.config.useMocks = true;
    vi.stubGlobal('fetch', vi.fn());

    const context = await getPatientContext('otro-paciente-999');

    expect(context.patientId).toBe('otro-paciente-999');
  });
});

// =============================================================================
// Contrato 1 — tolerancia a lo que Kiwis realmente mande
// =============================================================================
//
// El modo de fallo que cubren estos tests no es una excepcion: es que loop-voice
// descarte en silencio un contexto LIVE utilizable (por un campo que ni usa) y
// hable con los numeros del fixture mientras el dashboard pinta los de verdad.
// La afirmacion de cada caso es siempre la misma: fuente=live y el HR de Kiwis.

describe('coreClient.getPatientContext — tolerancia del Contrato 1', () => {
  /** Sirve el contexto live sin la ruta indicada y afirma que se conserva. */
  async function withoutField(mutate: (ctx: Record<string, any>) => void): Promise<PatientContext> {
    const payload = liveContext() as unknown as Record<string, any>;
    mutate(payload);
    vi.stubGlobal('fetch', fetchReturning(jsonResponse(payload)));
    const context = await getPatientContext(PATIENT);
    expect(getContextSource()).toBe('live');
    expect(context.current.heartRate.latest).toBe(131); // el dato de Kiwis, no el fixture
    return context;
  }

  it('sin medications / recentEpisodes / conditions: se aceptan como listas vacias', async () => {
    const context = await withoutField((c) => {
      delete c.medications;
      delete c.recentEpisodes;
      delete c.conditions;
    });
    expect(context.medications).toEqual([]);
    expect(context.recentEpisodes).toEqual([]);
    expect(context.conditions).toEqual([]);
  });

  it('sin baseline.sleepHours: se acepta y la media queda en 0 (centinela, no se locuta)', async () => {
    const context = await withoutField((c) => {
      delete c.baseline.sleepHours;
    });
    expect(context.baseline.sleepHours.mean).toBe(0);
    expect(context.baseline.heartRate.mean).toBe(68); // lo real se conserva intacto
  });

  it('sin deltas: se DERIVAN de current y baseline, no se inventan', async () => {
    const context = await withoutField((c) => {
      delete c.deltas;
    });
    // 131 - 68 = 63 bpm sobre su promedio; 63 / sd 6 = 10.5 SD
    expect(context.deltas.heartRate.absolute).toBe(63);
    expect(context.deltas.heartRate.sdFromBaseline).toBe(10.5);
  });

  it('sin safetyEnvelope: se acepta con el envelope por defecto y RF-08 sigue evaluable', async () => {
    const context = await withoutField((c) => {
      delete c.safetyEnvelope;
    });
    expect(context.safetyEnvelope.heartRateMax).toBe(150);
    expect(context.safetyEnvelope.respiratoryRateMax).toBe(32);
    expect(context.safetyEnvelope.spo2Min).toBe(92);
  });

  it('age como string y campos extra de Kiwis: ni lo uno ni lo otro tira el payload', async () => {
    const context = await withoutField((c) => {
      c.age = '34';
      c.riskScore = 0.42;
      c.carePlan.activities = [{ id: 'cp-act-1', order: 1, type: 'breathing', title: 'Box breathing', instruction: '4-4-4-4' }];
    });
    expect(context.age).toBe(34);
    expect(context.carePlan.activities[0]?.id).toBe('cp-act-1');
    expect(context.carePlan.activities[0]?.voiceScript).toBeUndefined();
  });

  it('recentEpisodes sin interventions: se rellena a [] (el prompt hace .length sobre ella)', async () => {
    const context = await withoutField((c) => {
      c.recentEpisodes = [
        { encounterId: 'enc-1', startedAt: '2026-07-28T02:14:00Z', durationMinutes: 22, peakHeartRate: 121, resolution: 'self-resolved' },
      ];
    });
    expect(context.recentEpisodes[0]?.interventions).toEqual([]);
    expect(context.recentEpisodes[0]?.severitySelfReported).toBeNull();
  });

  it('sin frecuencia cardiaca no se rescata nada: degrada, que es lo honesto', async () => {
    const payload = liveContext() as unknown as Record<string, any>;
    delete payload.current.heartRate;
    vi.stubGlobal('fetch', fetchReturning(jsonResponse(payload)));

    const context = await getPatientContext(PATIENT);

    expect(getContextSource()).toBe('fixture');
    expect(context.current.heartRate.latest).toBe(118); // el del fixture, no un cero inventado
  });
});

// =============================================================================
// coreClient — write-back del episodio
// =============================================================================

describe('coreClient.postEpisode', () => {
  it('USE_MOCKS=true: no llama a :3001 y devuelve un id sintetico determinista', async () => {
    mocked.config.useMocks = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const first = await postEpisode(sampleEpisode('call-8f2a'));
    const second = await postEpisode(sampleEpisode('call-8f2a'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(first?.encounterId).toBe('enc-mock-call-8f2a');
    expect(second?.encounterId).toBe(first?.encounterId);
    expect(first?.medplumUrl).toContain('enc-mock-call-8f2a');
  });

  it('payload que no valida: loguea el detalle de zod y NO bloquea el cierre de la llamada', async () => {
    mocked.config.useMocks = true;
    vi.stubGlobal('fetch', vi.fn());
    const errorSpy = vi.spyOn(console, 'error');

    const broken = { ...sampleEpisode('call-roto'), outcome: 'inventado' } as unknown as EpisodeWriteback;
    const result = await postEpisode(broken);

    expect(result?.encounterId).toBe('enc-mock-call-roto');
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('episodeWritebackSchema');
    expect(logged).toContain('outcome');
  });

  it('live 201: devuelve encounterId y medplumUrl', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(
        jsonResponse(
          { encounterId: 'enc-0042', medplumUrl: 'https://app.medplum.com/Encounter/enc-0042' },
          201,
        ),
      ),
    );

    const result = await postEpisode(sampleEpisode());

    expect(result).toEqual({
      encounterId: 'enc-0042',
      medplumUrl: 'https://app.medplum.com/Encounter/enc-0042',
    });
  });

  it('live falla: escribe el episodio en .episodes-pending/ y devuelve null', async () => {
    const callId = 'call-pending-test';
    const path = resolve(PENDING_EPISODES_DIR, `${callId}.json`);
    await rm(path, { force: true });
    vi.stubGlobal('fetch', fetchReturning(textResponse('core caido', 500)));

    const result = await postEpisode(sampleEpisode(callId));

    expect(result).toBeNull();
    const saved = JSON.parse(await readFile(path, 'utf8')) as EpisodeWriteback;
    expect(saved.callId).toBe(callId);
    expect(saved.transcript.redacted).toBe(true);
    await rm(path, { force: true });
  });

  it('live no reintenta un POST (no es idempotente: duplicaria el Encounter)', async () => {
    const fetchMock = fetchReturning(textResponse('boom', 500), textResponse('boom', 500));
    vi.stubGlobal('fetch', fetchMock);

    await postEpisode(sampleEpisode('call-sin-reintento'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await rm(resolve(PENDING_EPISODES_DIR, 'call-sin-reintento.json'), { force: true });
  });
});

// =============================================================================
// coverageClient
// =============================================================================

describe('coverageClient.checkCoverage', () => {
  it('USE_MOCKS=true: sirve el fixture covered con latencia real medida', async () => {
    mocked.config.useMocks = true;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await checkCoverage(coverageRequest());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe('covered');
    expect(response.copayCents).toBe(2500);
    expect(response.voiceSummary).toContain('cubierta');
    expect(Number.isFinite(response.latencyMs)).toBe(true);
  });

  it('live feliz: devuelve el voiceSummary literal de :3003', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(
        jsonResponse({
          checkId: 'cov-live-1',
          checkedAt: '2026-08-01T18:29:40Z',
          status: 'covered',
          payerName: 'Test Payer Inc',
          planName: 'PPO Silver',
          copayCents: 4000,
          coinsurancePercent: 0,
          deductible: null,
          priorAuthRequired: false,
          raw271Id: 'stedi-271-x',
          voiceSummary: 'Esta cubierta, tu copago es de 40 dolares.',
          latencyMs: 999,
        }),
      ),
    );

    const response = await checkCoverage(coverageRequest());

    expect(response.status).toBe('covered');
    expect(response.copayCents).toBe(4000);
    expect(response.voiceSummary).toBe('Esta cubierta, tu copago es de 40 dolares.');
    // latencyMs es el MEDIDO aqui, no el que declara el downstream
    expect(response.latencyMs).not.toBe(999);
  });

  it('live 500: devuelve unknown honesto, sin lanzar y sin inventar copago', async () => {
    vi.stubGlobal('fetch', fetchReturning(textResponse('stedi down', 500)));

    const response = await checkCoverage(coverageRequest());

    expect(response.status).toBe('unknown');
    expect(response.copayCents).toBeNull();
    expect(response.deductible).toBeNull();
    expect(response.voiceSummary).toContain('No pude verificar tu cobertura');
  });

  it('live timeout: unknown, y el paciente no se queda esperando', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const response = await checkCoverage(coverageRequest());

    expect(response.status).toBe('unknown');
    expect(response.copayCents).toBeNull();
  });

  it('live responde 200 con un payload que no valida: unknown, nunca una cifra a medias', async () => {
    vi.stubGlobal('fetch', fetchReturning(jsonResponse({ status: 'covered', copayCents: 2500 })));

    const response = await checkCoverage(coverageRequest());

    expect(response.status).toBe('unknown');
    expect(response.copayCents).toBeNull();
    expect(response.voiceSummary).toContain('equipo de cuidado');
  });

  it('no reintenta el check (es caro y hay alguien en la linea)', async () => {
    const fetchMock = fetchReturning(textResponse('boom', 503), textResponse('boom', 503));
    vi.stubGlobal('fetch', fetchMock);

    await checkCoverage(coverageRequest());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
