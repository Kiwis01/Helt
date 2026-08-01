/**
 * Tests de la sesion de llamada, el builder del episodio y el store.
 *
 * Todo con reloj inyectado: cero dependencia del reloj real, cero flakiness.
 */

import { describe, expect, it } from 'vitest';

import {
  episodeWritebackSchema,
  type CoverageCheckResponse,
  type PatientContext,
} from '../../types.js';
import { CallSession } from '../callSession.js';
import { buildEpisode, inferOutcome, toIsoUtc } from '../episodeBuilder.js';
import { SessionStore } from '../sessionStore.js';

// -----------------------------------------------------------------------------
// Ayudas de test
// -----------------------------------------------------------------------------

/** Contexto minimo pero COMPLETO, con los numeros del fixture compartido. */
function makeContext(overrides: Partial<PatientContext> = {}): PatientContext {
  return {
    patientId: 'loop-demo-patient-001',
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
      heartRate: { latest: 118, max: 126, trend: 'rising', unit: 'bpm' },
      hrv: { latest: 21, min: 18, trend: 'falling', unit: 'ms' },
      respiratoryRate: { latest: 24, max: 27, trend: 'rising', unit: 'breaths/min' },
      lastSampleAt: '2026-08-01T18:21:40Z',
    },
    deltas: {
      heartRate: { absolute: 50, sdFromBaseline: 8.3 },
      hrv: { absolute: -33, sdFromBaseline: -3 },
    },
    conditions: [],
    carePlan: { id: 'loop-demo-careplan-001', authoredBy: 'Dr. Maya Chen', lastUpdated: '2026-07-02', activities: [] },
    recentEpisodes: [],
    medications: [],
    safetyEnvelope: {
      heartRateMax: 150,
      heartRateMin: 40,
      respiratoryRateMax: 32,
      spo2Min: 92,
      note: 'Envelope del care plan del demo.',
    },
    ...overrides,
  };
}

/** Reloj falso: arranca en T0 y avanza solo cuando el test lo dice. */
function fakeClock(startIso = '2026-08-01T18:20:02Z') {
  let ms = Date.parse(startIso);
  return {
    now: (): Date => new Date(ms),
    advance(seconds: number): void {
      ms += seconds * 1000;
    },
  };
}

function makeSession(clock = fakeClock()): CallSession {
  return new CallSession('loop-demo-patient-001', makeContext(), {
    callId: 'call-8f2a',
    now: clock.now,
  });
}

const coverageCovered: CoverageCheckResponse = {
  checkId: 'cov-1a2b',
  checkedAt: '2026-08-01T18:29:40Z',
  status: 'covered',
  payerName: 'Test Payer Inc',
  planName: 'PPO Silver',
  copayCents: 2500,
  coinsurancePercent: 0,
  deductible: { individualCents: 150000, metCents: 142000, remainingCents: 8000 },
  priorAuthRequired: false,
  raw271Id: 'stedi-271-abc',
  voiceSummary: 'Tu sesion de telesalud esta cubierta.',
  latencyMs: 812,
};

// -----------------------------------------------------------------------------
// CallSession
// -----------------------------------------------------------------------------

describe('CallSession — identidad y tiempo', () => {
  it('genera un callId con el formato del contrato y sin repetirse', () => {
    const ctx = makeContext();
    const a = new CallSession('p1', ctx);
    const b = new CallSession('p1', ctx);
    expect(a.callId).toMatch(/^call-[0-9a-f]{4}$/);
    expect(b.callId).toMatch(/^call-[0-9a-f]{4}$/);
    expect(a.callId).not.toBe(b.callId);
  });

  it('sella startedAt en ISO-8601 UTC con Z', () => {
    const session = makeSession();
    expect(session.startedAt).toBe('2026-08-01T18:20:02Z');
  });

  it('calcula la duracion con el reloj de la sesion', () => {
    const clock = fakeClock();
    const session = makeSession(clock);
    clock.advance(890);
    expect(session.durationSeconds()).toBe(890);
    session.end();
    clock.advance(600);
    expect(session.durationSeconds()).toBe(890); // congelada al colgar
  });
});

describe('CallSession — transcript', () => {
  it('acumula turnos con hablante, texto y marca de tiempo', () => {
    const clock = fakeClock();
    const session = makeSession(clock);
    session.addTurn('patient', 'No puedo respirar bien');
    clock.advance(6);
    session.addTurn('agent', 'Estoy aqui contigo.');

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]).toEqual({
      speaker: 'patient',
      at: '2026-08-01T18:20:02Z',
      text: 'No puedo respirar bien',
    });
    expect(session.turns[1]!.at).toBe('2026-08-01T18:20:08Z');
  });

  it('ignora turnos vacios o solo con espacios', () => {
    const session = makeSession();
    session.addTurn('patient', '   ');
    session.addTurn('patient', '');
    expect(session.turns).toHaveLength(0);
  });
});

describe('CallSession — biometria', () => {
  it('arranca los extremos desde el contexto precargado', () => {
    const session = makeSession();
    expect(session.biometrics).toEqual({ peakHeartRate: 126, minHrv: 18, peakRespiratoryRate: 27 });
  });

  it('se queda con el MAXIMo de HR y RR y el MINIMO de HRV', () => {
    const session = makeSession();
    session.recordBiometricTick(131, 16, 29);
    session.recordBiometricTick(120, 24, 22); // valores mas suaves: no deben pisar los picos
    expect(session.biometrics).toEqual({ peakHeartRate: 131, minHrv: 16, peakRespiratoryRate: 29 });
  });

  it('ignora ticks con valores no finitos', () => {
    const session = makeSession();
    session.recordBiometricTick(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    expect(session.biometrics).toEqual({ peakHeartRate: 126, minHrv: 18, peakRespiratoryRate: 27 });
  });
});

describe('CallSession — intervenciones y cobertura', () => {
  it('abre un intento y lo CIERRA sin duplicarlo, conservando startedAt', () => {
    const clock = fakeClock();
    const session = makeSession(clock);
    session.recordIntervention('cp-act-1', false, null);
    clock.advance(260);
    session.recordIntervention('cp-act-1', true, 6);

    expect(session.interventions).toHaveLength(1);
    expect(session.interventions[0]).toEqual({
      carePlanActivityId: 'cp-act-1',
      startedAt: '2026-08-01T18:20:02Z',
      completed: true,
      patientReportedRelief: 6,
    });
  });

  it('registra intentos separados para actividades distintas', () => {
    const session = makeSession();
    session.recordIntervention('cp-act-1', true, 6);
    session.recordIntervention('cp-act-2', false, null);
    expect(session.interventions.map((i) => i.carePlanActivityId)).toEqual(['cp-act-1', 'cp-act-2']);
  });

  it('hace eco del coverage check con el serviceType consultado', () => {
    const session = makeSession();
    session.recordCoverage(coverageCovered, 'telehealth-mental-health');
    expect(session.coverageChecks[0]).toEqual({
      checkId: 'cov-1a2b',
      serviceType: 'telehealth-mental-health',
      result: 'covered',
      copayCents: 2500,
    });
  });
});

describe('CallSession — escalacion y severidad', () => {
  it('registra la regla, la accion y la hora, y pasa a estado escalated', () => {
    const clock = fakeClock();
    const session = makeSession(clock);
    session.setState('listening');
    clock.advance(30);
    session.setEscalation('RF-01-CHEST-PAIN-RADIATING', 'advise-911');

    expect(session.getState()).toBe('escalated');
    expect(session.escalation).toEqual({
      triggered: true,
      rule: 'RF-01-CHEST-PAIN-RADIATING',
      triggeredAt: '2026-08-01T18:20:32Z',
      action: 'advise-911',
    });
  });

  it('gana la PRIMERA escalacion y normaliza "advised-911"', () => {
    const session = makeSession();
    session.setEscalation('RF-09-COMBINED', 'advised-911');
    session.setEscalation('RF-07-SELF-HARM', 'advise-988');
    expect(session.escalation.rule).toBe('RF-09-COMBINED');
    expect(session.escalation.action).toBe('advise-911');
  });

  it('acota la severidad auto-reportada a 0-10', () => {
    const session = makeSession();
    session.setSeverity(7);
    expect(session.severitySelfReported).toBe(7);
    session.setSeverity(42);
    expect(session.severitySelfReported).toBe(10);
    session.setSeverity(-3);
    expect(session.severitySelfReported).toBe(0);
  });
});

describe('CallSession — maquina de estados', () => {
  it('acepta el camino normal de una llamada', () => {
    const session = makeSession();
    expect(session.getState()).toBe('idle');
    for (const next of ['greeting', 'listening', 'thinking', 'speaking', 'intervention', 'listening'] as const) {
      expect(session.setState(next)).toBe(true);
    }
    expect(session.getState()).toBe('listening');
    expect(session.rejectedTransitions).toBe(0);
  });

  it('rechaza salir de escalated hacia cualquier cosa que no sea ended', () => {
    const session = makeSession();
    session.setEscalation('RF-02-SYNCOPE', 'advise-911');
    expect(session.setState('listening')).toBe(false);
    expect(session.getState()).toBe('escalated');
    expect(session.rejectedTransitions).toBe(1);
    expect(session.setState('ended')).toBe(true);
  });

  it('ended es terminal y sella endedAt una sola vez', () => {
    const clock = fakeClock();
    const session = makeSession(clock);
    session.setState('ended');
    const sealed = session.endedAt;
    clock.advance(120);
    expect(session.setState('listening')).toBe(false);
    session.end();
    expect(session.endedAt).toBe(sealed);
  });
});

describe('CallSession — snapshot', () => {
  it('es plano, serializable y REDACTA el transcript', () => {
    const session = makeSession();
    session.addTurn('patient', 'mi ritmo esta en 118, llamame al 612345678');
    session.recordCoverage(coverageCovered, 'telehealth-mental-health');
    const snap = session.snapshot();

    expect(() => JSON.parse(JSON.stringify(snap))).not.toThrow();
    expect(snap.callId).toBe('call-8f2a');
    expect(snap.patientName).toBe('Alex Rivera');
    expect(snap.baseline.heartRate).toBe(68);
    expect(snap.turnCount).toBe(1);
    expect(snap.transcript.redacted).toBe(true);
    expect(snap.transcript.turns[0]!.text).toContain('[TELEFONO]');
    // la senal clinica sobrevive a la redaccion
    expect(snap.transcript.turns[0]!.text).toContain('118');
    // el transcript vivo sigue en crudo: el agente lo necesita para conversar
    expect(session.turns[0]!.text).toContain('612345678');
  });
});

// -----------------------------------------------------------------------------
// episodeBuilder
// -----------------------------------------------------------------------------

describe('inferOutcome', () => {
  it('escalated-emergency cuando la escalacion fue a 911', () => {
    const session = makeSession();
    session.addTurn('patient', 'me duele el pecho y se me va al brazo');
    session.setEscalation('RF-01-CHEST-PAIN-RADIATING', 'advise-911');
    expect(inferOutcome(session)).toBe('escalated-emergency');
  });

  it('escalated-human cuando la escalacion fue a 988 o a un humano', () => {
    const a = makeSession();
    a.addTurn('patient', 'no quiero seguir aqui');
    a.setEscalation('RF-07-SELF-HARM', 'advise-988');
    expect(inferOutcome(a)).toBe('escalated-human');

    const b = makeSession();
    b.addTurn('patient', 'quiero hablar con alguien');
    b.setEscalation('RF-07-SELF-HARM', 'connect-human');
    expect(inferOutcome(b)).toBe('escalated-human');
  });

  it('resolved-with-intervention cuando se completo una actividad del plan', () => {
    const session = makeSession();
    session.addTurn('patient', 'ok, vamos');
    session.recordIntervention('cp-act-1', true, 6);
    expect(inferOutcome(session)).toBe('resolved-with-intervention');
  });

  it('abandoned cuando el paciente colgo sin turnos utiles', () => {
    const session = makeSession();
    session.addTurn('agent', 'Estoy aqui contigo, no sustituyo a la atencion de emergencia.');
    session.addTurn('patient', 'eh');
    expect(inferOutcome(session)).toBe('abandoned');
  });

  it('self-resolved cuando hubo conversacion pero ni intervencion completada ni escalacion', () => {
    const session = makeSession();
    session.addTurn('patient', 'ya me siento mejor, gracias');
    session.recordIntervention('cp-act-1', false, null);
    expect(inferOutcome(session)).toBe('self-resolved');
  });

  it('la escalacion gana aunque antes se hubiera completado una intervencion', () => {
    const session = makeSession();
    session.addTurn('patient', 'hicimos la respiracion pero ahora me duele el pecho');
    session.recordIntervention('cp-act-1', true, 4);
    session.setEscalation('RF-09-COMBINED', 'advise-911');
    expect(inferOutcome(session)).toBe('escalated-emergency');
  });
});

describe('buildEpisode', () => {
  function completeCall(): CallSession {
    const clock = fakeClock();
    const session = makeSession(clock);
    session.setState('greeting');
    session.addTurn('patient', 'No puedo respirar bien, el corazon se me va a salir.');
    clock.advance(6);
    session.addTurn('agent', 'Tu ritmo cardiaco esta en 118 y tu promedio es 68.');
    clock.advance(180);
    session.recordBiometricTick(131, 16, 29);
    session.recordIntervention('cp-act-1', false, null);
    clock.advance(260);
    session.recordIntervention('cp-act-1', true, 6);
    session.setSeverity(7);
    session.recordCoverage(coverageCovered, 'telehealth-mental-health');
    clock.advance(60);
    session.end();
    return session;
  }

  it('produce un payload que valida contra episodeWritebackSchema', () => {
    const episode = completeCall().buildEpisode('resolved-with-intervention');
    expect(episodeWritebackSchema.safeParse(episode).success).toBe(true);
  });

  it('rellena los campos del Contrato 2 con los valores de la llamada', () => {
    const episode = completeCall().buildEpisode('resolved-with-intervention');
    expect(episode.patientId).toBe('loop-demo-patient-001');
    expect(episode.callId).toBe('call-8f2a');
    expect(episode.startedAt).toBe('2026-08-01T18:20:02Z');
    expect(episode.endedAt).toBe('2026-08-01T18:28:28Z');
    expect(episode.outcome).toBe('resolved-with-intervention');
    expect(episode.severitySelfReported).toBe(7);
    expect(episode.biometricsSnapshot).toEqual({ peakHeartRate: 131, minHrv: 16, peakRespiratoryRate: 29 });
    expect(episode.interventionsAttempted).toEqual([
      {
        carePlanActivityId: 'cp-act-1',
        startedAt: '2026-08-01T18:23:08Z',
        completed: true,
        patientReportedRelief: 6,
      },
    ]);
    expect(episode.coverageChecks).toEqual([
      { checkId: 'cov-1a2b', serviceType: 'telehealth-mental-health', result: 'covered', copayCents: 2500 },
    ]);
  });

  it('escalation lleva los 4 campos con null explicito cuando no hubo', () => {
    const episode = completeCall().buildEpisode('resolved-with-intervention');
    expect(Object.keys(episode.escalation).sort()).toEqual(['action', 'rule', 'triggered', 'triggeredAt']);
    expect(episode.escalation).toEqual({ triggered: false, rule: null, triggeredAt: null, action: null });
  });

  it('escalation lleva regla, accion y hora cuando si hubo', () => {
    const clock = fakeClock();
    const session = makeSession(clock);
    session.addTurn('patient', 'me duele el pecho y se me va al brazo izquierdo');
    clock.advance(4);
    session.setEscalation('RF-01-CHEST-PAIN-RADIATING', 'advise-911');
    session.end();

    const episode = session.buildEpisode(session.inferOutcome());
    expect(episode.outcome).toBe('escalated-emergency');
    expect(episode.escalation).toEqual({
      triggered: true,
      rule: 'RF-01-CHEST-PAIN-RADIATING',
      triggeredAt: '2026-08-01T18:20:06Z',
      action: 'advise-911',
    });
  });

  it('marca el transcript como redactado y aplica la redaccion a los turnos', () => {
    const session = makeSession();
    session.addTurn('patient', 'apunta mi correo alex@loop.health, mi ritmo esta en 118');
    session.end();

    const episode = session.buildEpisode('self-resolved');
    expect(episode.transcript.redacted).toBe(true);
    expect(episode.transcript.turns[0]!.text).toContain('[EMAIL]');
    expect(episode.transcript.turns[0]!.text).not.toContain('alex@loop.health');
    expect(episode.transcript.turns[0]!.text).toContain('118');
  });

  it('emite todas las fechas en ISO-8601 UTC terminadas en Z y sin milisegundos', () => {
    const episode = completeCall().buildEpisode('resolved-with-intervention');
    const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    expect(episode.startedAt).toMatch(isoUtc);
    expect(episode.endedAt).toMatch(isoUtc);
    for (const turn of episode.transcript.turns) expect(turn.at).toMatch(isoUtc);
    for (const attempt of episode.interventionsAttempted) expect(attempt.startedAt).toMatch(isoUtc);
  });

  it('cierra el episodio con la hora actual si la llamada nunca se marco como terminada', () => {
    const clock = fakeClock();
    const session = makeSession(clock);
    session.addTurn('patient', 'me tengo que ir');
    clock.advance(45);
    const episode = buildEpisode(session, undefined, { now: clock.now });
    expect(episode.endedAt).toBe('2026-08-01T18:20:47Z');
    expect(episode.outcome).toBe('self-resolved');
  });

  it('lanza un error descriptivo si el payload no cumple el schema (bug nuestro)', () => {
    const session = makeSession();
    session.end();
    // outcome fuera del enum del Contrato 2: el builder no debe dejarlo pasar.
    expect(() => buildEpisode(session, 'no-existe' as never)).toThrow(/episodeWritebackSchema/);
    expect(() => buildEpisode(session, 'no-existe' as never)).toThrow(/call-8f2a/);
  });

  it('toIsoUtc normaliza cualquier entrada y nunca devuelve una fecha invalida', () => {
    expect(toIsoUtc('2026-08-01T18:20:02.123Z')).toBe('2026-08-01T18:20:02Z');
    expect(toIsoUtc(new Date('2026-08-01T18:20:02Z'))).toBe('2026-08-01T18:20:02Z');
    expect(toIsoUtc('no-es-una-fecha', '2026-08-01T18:20:02Z')).toBe('2026-08-01T18:20:02Z');
    expect(toIsoUtc(null, '2026-08-01T18:20:02Z')).toBe('2026-08-01T18:20:02Z');
  });
});

// -----------------------------------------------------------------------------
// sessionStore
// -----------------------------------------------------------------------------

describe('SessionStore', () => {
  it('crea, encuentra y lista la llamada activa', () => {
    const store = new SessionStore();
    const session = store.create('loop-demo-patient-001', makeContext());
    expect(store.get(session.callId)).toBe(session);
    expect(store.active()).toHaveLength(1);
    expect(store.current()).toBe(session);
    expect(store.get('call-9999')).toBeNull();
  });

  it('end() cierra la sesion pero la deja consultable', () => {
    const store = new SessionStore();
    const session = store.create('p1', makeContext());
    store.end(session.callId);
    expect(session.getState()).toBe('ended');
    expect(session.endedAt).not.toBeNull();
    expect(store.get(session.callId)).toBe(session);
    expect(store.active()).toHaveLength(0);
    expect(store.current()).toBeNull();
  });

  it('descarta las sesiones terminadas hace mas de 30 minutos', () => {
    const clock = fakeClock();
    const store = new SessionStore({ now: clock.now });
    const session = store.create('p1', makeContext());
    store.end(session.callId);

    clock.advance(29 * 60);
    expect(store.sweep()).toBe(0);
    expect(store.size).toBe(1);

    clock.advance(2 * 60); // 31 min desde que colgo
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(0);
    expect(store.get(session.callId)).toBeNull();
  });

  it('soporta varias llamadas a la vez sin mezclarlas', () => {
    const store = new SessionStore();
    const a = store.create('p1', makeContext());
    const b = store.create('p2', makeContext());
    a.addTurn('patient', 'llamada A');
    b.addTurn('patient', 'llamada B');

    expect(a.callId).not.toBe(b.callId);
    expect(store.active()).toHaveLength(2);
    expect(store.get(a.callId)!.turns[0]!.text).toBe('llamada A');
    store.clear();
    expect(store.size).toBe(0);
  });
});
