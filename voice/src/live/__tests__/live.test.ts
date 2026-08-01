/**
 * Tests del bus de eventos y del stream SSE (Contrato 5).
 *
 * Lo que se protege aqui, en orden de importancia:
 *
 *   1. Los shapes de `data`. Son el contrato con el dashboard de Carlos; si un
 *      campo cambia de nombre, su pantalla se queda en blanco en el demo.
 *   2. La serializacion SSE. Un salto de linea sin escapar dentro del texto de
 *      un turno parte el evento en dos y rompe el parser del navegador.
 *   3. Que no haya fugas: cada cliente SSE que se va tiene que dejar el bus
 *      exactamente como lo encontro.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUFFER_CAPACITY,
  bufferedCount,
  emitBiometricsTick,
  emitCallEnded,
  emitCallStarted,
  emitCoverageCheck,
  emitEpisodeWritten,
  emitSafetyEscalation,
  emitTranscriptTurn,
  LIVE_EVENT_TYPES,
  liveBus,
  resetLiveBus,
  subscriberCount,
} from '../bus.js';
import { EVENTS_PATH, formatSseEvent, registerSseRoutes, STREAM_PATH, TEST_EVENT_PATH } from '../sse.js';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  resetLiveBus();
});

/** Claves de `data` ordenadas, para comparar shapes sin depender del orden. */
function keysOf(data: Record<string, unknown>): string[] {
  return Object.keys(data).sort();
}

// =============================================================================
// 1. Bus: emit / subscribe
// =============================================================================

describe('liveBus.emit / subscribe', () => {
  it('entrega el evento a los suscriptores y sella `at` en ISO-8601', () => {
    const recibidos: Array<{ type: string; data: Record<string, unknown> }> = [];
    liveBus.subscribe((e) => recibidos.push(e));

    liveBus.emit('call.started', { callId: 'call-8f2a', patientId: 'loop-demo-patient-001' });

    expect(recibidos).toHaveLength(1);
    expect(recibidos[0].type).toBe('call.started');
    expect(recibidos[0].data.callId).toBe('call-8f2a');
    expect(recibidos[0].data.patientId).toBe('loop-demo-patient-001');
    expect(String(recibidos[0].data.at)).toMatch(ISO_8601);
  });

  it('respeta el `at` que ya venga en el payload (replay / tests deterministas)', () => {
    const recibidos: Array<Record<string, unknown>> = [];
    liveBus.subscribe((e) => recibidos.push(e.data));

    liveBus.emit('episode.written', {
      callId: 'call-8f2a',
      encounterId: 'enc-0042',
      at: '2026-08-01T18:34:50Z',
    });

    expect(recibidos[0].at).toBe('2026-08-01T18:34:50Z');
  });

  it('entrega a varios suscriptores y el unsubscribe corta la entrega solo a uno', () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = liveBus.subscribe((e) => a.push(e.type));
    liveBus.subscribe((e) => b.push(e.type));

    emitCallStarted({ callId: 'c1', patientId: 'p1' });
    expect(subscriberCount()).toBe(2);

    unsubA();
    expect(subscriberCount()).toBe(1);

    emitEpisodeWritten({ callId: 'c1', encounterId: 'enc-1' });

    expect(a).toEqual(['call.started']); // A dejo de recibir
    expect(b).toEqual(['call.started', 'episode.written']); // B sigue vivo

    // Idempotente: llamar dos veces al mismo unsubscribe no da de baja a B.
    unsubA();
    expect(subscriberCount()).toBe(1);
  });

  it('un suscriptor que lanza no rompe a los demas ni al emisor', () => {
    // El bus loguea el fallo aislado; aqui se silencia para no ensuciar la
    // salida de `npm test` con un error que es justo lo que se esta probando.
    const logueado = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const vivos: string[] = [];
    liveBus.subscribe(() => {
      throw new Error('cliente SSE muerto a media escritura');
    });
    liveBus.subscribe((e) => vivos.push(e.type));

    // La llamada del paciente no se puede caer porque un dashboard se colgo.
    expect(() => emitCallStarted({ callId: 'c1', patientId: 'p1' })).not.toThrow();
    expect(vivos).toEqual(['call.started']);
    expect(logueado).toHaveBeenCalledOnce(); // el fallo se registra, no se traga

    logueado.mockRestore();
  });

  it('congela el evento: un consumidor no puede mutar lo que otro va a serializar', () => {
    emitTranscriptTurn({ callId: 'c1', speaker: 'patient', text: 'hola' });
    const [evento] = liveBus.recent(1);

    expect(Object.isFrozen(evento)).toBe(true);
    expect(Object.isFrozen(evento.data)).toBe(true);
  });
});

// =============================================================================
// 2. Bus: buffer circular
// =============================================================================

describe('liveBus.recent', () => {
  it('devuelve [] con el bus vacio y con limites no positivos', () => {
    expect(liveBus.recent()).toEqual([]);

    emitCallStarted({ callId: 'c1', patientId: 'p1' });
    expect(liveBus.recent(0)).toEqual([]);
    expect(liveBus.recent(-5)).toEqual([]);
    expect(liveBus.recent(Number.NaN)).toEqual([]);
  });

  it('respeta el limite y devuelve los MAS RECIENTES en orden cronologico', () => {
    for (let i = 1; i <= 10; i += 1) {
      emitTranscriptTurn({ callId: 'c1', speaker: 'patient', text: `turno-${i}` });
    }

    const ultimos3 = liveBus.recent(3);
    expect(ultimos3.map((e) => e.data.text)).toEqual(['turno-8', 'turno-9', 'turno-10']);

    // Sin argumento: el limite por defecto es 50, y aqui solo hay 10.
    expect(liveBus.recent()).toHaveLength(10);
    // Un limite mayor que lo guardado no inventa eventos.
    expect(liveBus.recent(999)).toHaveLength(10);
  });

  it('es circular: descarta los mas antiguos al pasar de BUFFER_CAPACITY', () => {
    const total = BUFFER_CAPACITY + 25;
    for (let i = 1; i <= total; i += 1) {
      emitTranscriptTurn({ callId: 'c1', speaker: 'agent', text: `t-${i}` });
    }

    expect(bufferedCount()).toBe(BUFFER_CAPACITY);

    const todos = liveBus.recent(BUFFER_CAPACITY);
    expect(todos).toHaveLength(BUFFER_CAPACITY);
    expect(todos[0].data.text).toBe(`t-${total - BUFFER_CAPACITY + 1}`); // el mas viejo que sobrevive
    expect(todos[todos.length - 1].data.text).toBe(`t-${total}`);
  });
});

// =============================================================================
// 3. Helpers tipados — shape EXACTO del Contrato 5
// =============================================================================

describe('helpers por evento', () => {
  it('emitCallStarted -> {callId, patientId, at}', () => {
    emitCallStarted({ callId: 'call-8f2a', patientId: 'loop-demo-patient-001' });
    const [e] = liveBus.recent(1);

    expect(e.type).toBe('call.started');
    expect(keysOf(e.data)).toEqual(['at', 'callId', 'patientId']);
    expect(e.data.callId).toBe('call-8f2a');
    expect(e.data.patientId).toBe('loop-demo-patient-001');
  });

  it('emitTranscriptTurn -> {callId, speaker, text, at}', () => {
    emitTranscriptTurn({ callId: 'call-8f2a', speaker: 'patient', text: 'me cuesta respirar' });
    const [e] = liveBus.recent(1);

    expect(e.type).toBe('transcript.turn');
    expect(keysOf(e.data)).toEqual(['at', 'callId', 'speaker', 'text']);
    expect(e.data.speaker).toBe('patient');
    expect(e.data.text).toBe('me cuesta respirar');
  });

  it('emitBiometricsTick -> {callId, heartRate, hrv, respiratoryRate, at}', () => {
    emitBiometricsTick({ callId: 'call-8f2a', heartRate: 118, hrv: 21, respiratoryRate: 24 });
    const [e] = liveBus.recent(1);

    expect(e.type).toBe('biometrics.tick');
    expect(keysOf(e.data)).toEqual(['at', 'callId', 'heartRate', 'hrv', 'respiratoryRate']);
    expect(e.data.heartRate).toBe(118);
    expect(e.data.hrv).toBe(21);
    expect(e.data.respiratoryRate).toBe(24);
  });

  it('emitSafetyEscalation -> {callId, rule, action, at} con el ID exacto de la regla', () => {
    emitSafetyEscalation({
      callId: 'call-8f2a',
      rule: 'RF-01-CHEST-PAIN-RADIATING',
      action: 'advise-911',
    });
    const [e] = liveBus.recent(1);

    expect(e.type).toBe('safety.escalation');
    expect(keysOf(e.data)).toEqual(['action', 'at', 'callId', 'rule']);
    // El ID de la regla viaja LITERAL: es lo que el juez lee en la pantalla.
    expect(e.data.rule).toBe('RF-01-CHEST-PAIN-RADIATING');
    expect(e.data.action).toBe('advise-911');
  });

  it('emitCoverageCheck -> {callId, checkId, status, copayCents, at}, copayCents puede ser null', () => {
    emitCoverageCheck({ callId: 'call-8f2a', checkId: 'cov-1a2b', status: 'covered', copayCents: 2500 });
    emitCoverageCheck({ callId: 'call-8f2a', checkId: 'cov-9z9z', status: 'unknown', copayCents: null });
    const [cubierto, desconocido] = liveBus.recent(2);

    expect(cubierto.type).toBe('coverage.check');
    expect(keysOf(cubierto.data)).toEqual(['at', 'callId', 'checkId', 'copayCents', 'status']);
    expect(cubierto.data.copayCents).toBe(2500);

    // `null` no se convierte en undefined ni desaparece del JSON.
    expect(keysOf(desconocido.data)).toEqual(['at', 'callId', 'checkId', 'copayCents', 'status']);
    expect(desconocido.data.copayCents).toBeNull();
    expect(JSON.parse(JSON.stringify(desconocido.data)).copayCents).toBeNull();
  });

  it('emitCallEnded -> {callId, outcome, durationSeconds, at}', () => {
    emitCallEnded({ callId: 'call-8f2a', outcome: 'escalated-emergency', durationSeconds: 42 });
    const [e] = liveBus.recent(1);

    expect(e.type).toBe('call.ended');
    expect(keysOf(e.data)).toEqual(['at', 'callId', 'durationSeconds', 'outcome']);
    expect(e.data.outcome).toBe('escalated-emergency');
    expect(e.data.durationSeconds).toBe(42);
  });

  it('emitEpisodeWritten -> {callId, encounterId, at}', () => {
    emitEpisodeWritten({ callId: 'call-8f2a', encounterId: 'enc-0042' });
    const [e] = liveBus.recent(1);

    expect(e.type).toBe('episode.written');
    expect(keysOf(e.data)).toEqual(['at', 'callId', 'encounterId']);
    expect(e.data.encounterId).toBe('enc-0042');
  });

  it('los helpers cubren los 7 tipos del contrato, ni uno mas ni uno menos', () => {
    emitCallStarted({ callId: 'c', patientId: 'p' });
    emitTranscriptTurn({ callId: 'c', speaker: 'agent', text: 'hola' });
    emitBiometricsTick({ callId: 'c', heartRate: 70, hrv: 50, respiratoryRate: 14 });
    emitSafetyEscalation({ callId: 'c', rule: 'RF-07-SELF-HARM', action: 'advise-988' });
    emitCoverageCheck({ callId: 'c', checkId: 'cov-1', status: 'needs-auth', copayCents: null });
    emitCallEnded({ callId: 'c', outcome: 'self-resolved', durationSeconds: 10 });
    emitEpisodeWritten({ callId: 'c', encounterId: 'enc-1' });

    expect(liveBus.recent().map((e) => e.type)).toEqual([...LIVE_EVENT_TYPES]);
  });
});

// =============================================================================
// 4. Serializacion SSE
// =============================================================================

describe('formatSseEvent', () => {
  it('produce exactamente las dos lineas del contrato mas la linea en blanco', () => {
    liveBus.emit('transcript.turn', {
      callId: 'call-8f2a',
      speaker: 'patient',
      text: 'me duele el pecho',
      at: '2026-08-01T18:20:05Z',
    });
    const [e] = liveBus.recent(1);

    expect(formatSseEvent(e)).toBe(
      'event: transcript.turn\n' +
        'data: {"callId":"call-8f2a","speaker":"patient","text":"me duele el pecho","at":"2026-08-01T18:20:05Z"}\n' +
        '\n',
    );
  });

  it('un texto con saltos de linea y comillas NO rompe el formato: sigue en una sola linea', () => {
    const texto = 'dijo "me duele"\ny colgo\r\nsegunda linea\tcon tab';
    emitTranscriptTurn({ callId: 'call-8f2a', speaker: 'patient', text: texto });
    const [e] = liveBus.recent(1);

    const wire = formatSseEvent(e);
    const lineas = wire.split('\n');

    // event / data / '' / '' — si el salto de linea se colara, habria mas.
    expect(lineas).toHaveLength(4);
    expect(lineas[0]).toBe('event: transcript.turn');
    expect(lineas[1].startsWith('data: ')).toBe(true);
    expect(lineas[2]).toBe('');
    expect(lineas[3]).toBe('');

    // Y el texto llega intacto al otro lado.
    const parsed = JSON.parse(lineas[1].slice('data: '.length)) as { text: string };
    expect(parsed.text).toBe(texto);
  });

  it('escapa U+2028 / U+2029 (invisibles que rompen a los consumidores que hacen eval)', () => {
    const texto = `linea1${String.fromCharCode(0x2028)}linea2${String.fromCharCode(0x2029)}linea3`;
    emitTranscriptTurn({ callId: 'c', speaker: 'agent', text: texto });
    const [e] = liveBus.recent(1);

    const wire = formatSseEvent(e);
    expect(wire).not.toContain(String.fromCharCode(0x2028));
    expect(wire).not.toContain(String.fromCharCode(0x2029));
    expect(wire).toContain('\\u2028');

    // Sigue siendo JSON valido y el texto se recupera igual.
    const data = JSON.parse(wire.split('\n')[1].slice('data: '.length)) as { text: string };
    expect(data.text).toBe(texto);
  });
});

// =============================================================================
// 5. Rutas HTTP
// =============================================================================

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerSseRoutes(app);
  return app;
}

describe('GET /api/v1/live/events (fallback JSON)', () => {
  it('devuelve los eventos en JSON plano, en orden cronologico', async () => {
    const app = buildApp();
    emitCallStarted({ callId: 'call-8f2a', patientId: 'p1' });
    emitTranscriptTurn({ callId: 'call-8f2a', speaker: 'patient', text: 'hola' });

    const res = await app.inject({ method: 'GET', url: EVENTS_PATH });
    const body = res.json<{ count: number; limit: number; events: Array<{ type: string }> }>();

    expect(res.statusCode).toBe(200);
    expect(body.count).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.events.map((e) => e.type)).toEqual(['call.started', 'transcript.turn']);

    await app.close();
  });

  it('clampea un limit raro en vez de devolver 400 (nunca rompe el dashboard)', async () => {
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) {
      emitTranscriptTurn({ callId: 'c', speaker: 'agent', text: `t-${i}` });
    }

    const conLimite = await app.inject({ method: 'GET', url: `${EVENTS_PATH}?limit=2` });
    expect(conLimite.json<{ count: number }>().count).toBe(2);

    const basura = await app.inject({ method: 'GET', url: `${EVENTS_PATH}?limit=abc` });
    expect(basura.statusCode).toBe(200);
    expect(basura.json<{ limit: number }>().limit).toBe(50);

    const enorme = await app.inject({ method: 'GET', url: `${EVENTS_PATH}?limit=999999` });
    expect(enorme.statusCode).toBe(200);
    expect(enorme.json<{ limit: number }>().limit).toBe(BUFFER_CAPACITY);

    await app.close();
  });
});

describe('POST /api/v1/live/test-event', () => {
  it('emite un evento de ejemplo valido para cada uno de los 7 tipos', async () => {
    const app = buildApp();

    for (const tipo of LIVE_EVENT_TYPES) {
      const res = await app.inject({ method: 'POST', url: TEST_EVENT_PATH, payload: { type: tipo } });
      const body = res.json<{ ok: boolean; emitted: { type: string; data: Record<string, unknown> } }>();

      expect(res.statusCode).toBe(202);
      expect(body.ok).toBe(true);
      expect(body.emitted.type).toBe(tipo);
      expect(body.emitted.data.callId).toBeTypeOf('string');
      expect(String(body.emitted.data.at)).toMatch(ISO_8601);
    }

    expect(liveBus.recent().map((e) => e.type)).toEqual([...LIVE_EVENT_TYPES]);
    await app.close();
  });

  it('acepta un data propio y lo emite tal cual (mas el `at` sellado)', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: TEST_EVENT_PATH,
      payload: {
        type: 'safety.escalation',
        data: { callId: 'call-demo', rule: 'RF-09-COMBINED', action: 'advise-911' },
      },
    });

    expect(res.statusCode).toBe(202);
    const [e] = liveBus.recent(1);
    expect(e.data.rule).toBe('RF-09-COMBINED');
    expect(String(e.data.at)).toMatch(ISO_8601);

    await app.close();
  });

  it('sin body usa transcript.turn, y rechaza un type invalido con 400 + la lista valida', async () => {
    const app = buildApp();

    const vacio = await app.inject({ method: 'POST', url: TEST_EVENT_PATH });
    expect(vacio.statusCode).toBe(202);
    expect(vacio.json<{ emitted: { type: string } }>().emitted.type).toBe('transcript.turn');

    const malo = await app.inject({
      method: 'POST',
      url: TEST_EVENT_PATH,
      payload: { type: 'no.existe' },
    });
    expect(malo.statusCode).toBe(400);
    expect(malo.json<{ validTypes: string[] }>().validTypes).toEqual([...LIVE_EVENT_TYPES]);

    await app.close();
  });
});

// =============================================================================
// 6. El stream SSE de verdad (servidor escuchando + fetch real)
// =============================================================================

describe('GET /api/v1/live/stream', () => {
  it('manda `: connected`, rehidrata con recent(), entrega en vivo y limpia al cerrar', async () => {
    const app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const direccion = app.server.address();
    const puerto = typeof direccion === 'object' && direccion !== null ? direccion.port : 0;

    // Un evento ANTES de conectar: el dashboard que llega tarde debe verlo.
    emitCallStarted({ callId: 'call-8f2a', patientId: 'loop-demo-patient-001' });

    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${puerto}${STREAM_PATH}`, { signal: abort.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acumulado = '';

    const leerHasta = async (predicado: (texto: string) => boolean): Promise<void> => {
      const limite = Date.now() + 4000;
      while (!predicado(acumulado)) {
        if (Date.now() > limite) {
          throw new Error(`timeout esperando; recibido: ${JSON.stringify(acumulado)}`);
        }
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) => {
            const t = setTimeout(() => resolve({ value: undefined, done: true }), 1000);
            t.unref();
          }),
        ]);
        if (done) break;
        acumulado += decoder.decode(value, { stream: true });
      }
      if (!predicado(acumulado)) {
        throw new Error(`stream cerrado antes de tiempo; recibido: ${JSON.stringify(acumulado)}`);
      }
    };

    // 1. Comentario de apertura + 2. replay del buffer.
    //    El predicado exige la linea en blanco final: el parser del navegador
    //    no da por cerrado un evento hasta verla.
    await leerHasta((t) => /event: call\.started\ndata: .+\n\n/.test(t));
    expect(acumulado.startsWith(': connected\n\n')).toBe(true);
    expect(acumulado).toContain('"patientId":"loop-demo-patient-001"');

    // 3. Evento nuevo, ya conectado.
    expect(subscriberCount()).toBe(1);
    emitSafetyEscalation({
      callId: 'call-8f2a',
      rule: 'RF-01-CHEST-PAIN-RADIATING',
      action: 'advise-911',
    });

    await leerHasta((t) => /event: safety\.escalation\ndata: .+\n\n/.test(t));
    expect(acumulado).toContain('"rule":"RF-01-CHEST-PAIN-RADIATING"');

    // 4. El cliente se va -> cero fugas (ni suscriptor ni intervalo).
    abort.abort();
    await reader.cancel().catch(() => undefined);

    const limite = Date.now() + 3000;
    while (subscriberCount() !== 0 && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(subscriberCount()).toBe(0);

    await app.close();
  });
});
