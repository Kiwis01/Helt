/**
 * Tests del pipeline de turno.
 *
 * =============================================================================
 *  EL TEST QUE IMPORTA
 * =============================================================================
 * `el LLM NO se invoca cuando dispara una regla` es la afirmacion central del
 * producto, y aqui esta comprobada de la unica forma que vale: con un
 * `LlmProvider` espia que incrementa un contador. Si alguien moviera la
 * evaluacion de red-flags detras del modelo, o la convirtiera en una linea del
 * prompt del sistema, ese contador dejaria de ser cero y este archivo se pondria
 * rojo. No hay forma de pasar el test "por accidente".
 *
 * Todo lo de aqui es hermetico: contexto literal, TTS falso, cobertura falsa,
 * cero red. La suite entera corre en milisegundos.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CallSession } from '../../session/callSession.js';
import { liveBus, resetLiveBus, type LiveEvent } from '../../live/bus.js';
import { SAFE_REPLACEMENT_LINE, SCRIPT_911, SCRIPT_988 } from '../../safety/index.js';
import type {
  AgentTurnRequest,
  CallState,
  CoverageCheckResponse,
  CurrentBiometrics,
  EpisodeOutcome,
  LlmProvider,
  PatientContext,
  TtsResult,
} from '../../types.js';
import {
  BRIDGE_LINE,
  NOOP_SINK,
  parseZeroToTen,
  runPatientTurn,
  type ActiveCall,
  type CallSink,
  type PipelineDeps,
} from '../turnPipeline.js';

// =============================================================================
// Andamio
// =============================================================================

// El logger resuelve su nivel en cada evento: aqui se calla todo lo que no sea
// un error, para que la salida de la suite sean los asserts y nada mas.
process.env.LOG_LEVEL = 'error';

/** Contexto literal: nada de fixtures en disco, nada de red. */
function makeContext(overrides: Partial<PatientContext> = {}): PatientContext {
  const base: PatientContext = {
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
    carePlan: {
      id: 'loop-demo-careplan-001',
      authoredBy: 'Dr. Maya Chen',
      lastUpdated: '2026-07-02',
      activities: [
        {
          id: 'cp-act-1',
          order: 1,
          type: 'breathing',
          title: 'Box breathing',
          instruction: '4 in, 4 hold, 4 out, 4 hold',
          durationMinutes: 4,
          voiceScript: 'Vamos a hacerlo juntos.\nListo, respira normal. Del cero al diez, ¿cuánto bajó?',
        },
        {
          id: 'cp-act-3',
          order: 3,
          type: 'escalation-soft',
          title: 'Message care team',
          instruction: 'Reach out to your clinician',
          costItem: { serviceType: 'telehealth-mental-health', cptCode: '90834' },
        },
      ],
    },
    recentEpisodes: [],
    medications: [],
    safetyEnvelope: {
      heartRateMax: 150,
      heartRateMin: 40,
      respiratoryRateMax: 32,
      spo2Min: 92,
      note: 'Envelope del care plan del demo.',
    },
  };
  return { ...base, ...overrides };
}

interface Recorder {
  audioTexts: string[];
  transcripts: Array<{ speaker: string; text: string; final: boolean }>;
  states: CallState[];
  escalations: Array<{ rule: string; action: string; script: string; evidence: string | null }>;
  coverages: Array<{ status: string; voiceSummary: string }>;
  ended: Array<{ outcome: EpisodeOutcome | null; reason: string }>;
}

/**
 * Todo lo que sono, en orden y como un solo texto.
 *
 * El TTS se invoca POR FRASE (es la palanca de latencia: la primera frase suena
 * mientras se sintetiza la segunda), asi que `audioTexts` trae los fragmentos
 * sueltos. Las aserciones se hacen sobre la union, que es lo que el paciente
 * realmente oye.
 */
function spoken(rec: Recorder): string {
  return rec.audioTexts.join(' ');
}

function makeRecorder(): { sink: CallSink; rec: Recorder } {
  const rec: Recorder = {
    audioTexts: [],
    transcripts: [],
    states: [],
    escalations: [],
    coverages: [],
    ended: [],
  };
  const sink: CallSink = {
    ...NOOP_SINK,
    transcript: (speaker, text, final) => rec.transcripts.push({ speaker, text, final }),
    audio: (result) => rec.audioTexts.push(result.audio.toString('utf8')),
    state: (state) => rec.states.push(state),
    escalation: (payload) => rec.escalations.push(payload),
    coverage: (payload) => rec.coverages.push({ status: payload.status, voiceSummary: payload.voiceSummary }),
  };
  return { sink, rec };
}

interface Spy {
  callCount: number;
  lastRequest: AgentTurnRequest | null;
  aborted: number;
}

/**
 * `LlmProvider` espia. El campo que importa es `callCount`: cualquier camino de
 * escalacion tiene que dejarlo en cero.
 */
function makeSpyLlm(reply = 'Estoy contigo. Tu ritmo está en 118 y tu promedio es 68.'): {
  spy: Spy;
  provider: LlmProvider;
} {
  const spy: Spy = { callCount: 0, lastRequest: null, aborted: 0 };
  const provider: LlmProvider = {
    name: 'spy',
    async *streamReply(req: AgentTurnRequest, signal?: AbortSignal): AsyncIterable<string> {
      spy.callCount += 1;
      spy.lastRequest = req;
      for (const word of reply.split(' ')) {
        if (signal?.aborted === true) {
          spy.aborted += 1;
          return;
        }
        yield `${word} `;
      }
    },
  };
  return { spy, provider };
}

/** El "audio" es el propio texto, asi el test puede afirmar que se locuto. */
function fakeSynthesize(text: string): Promise<TtsResult> {
  return Promise.resolve({
    audio: Buffer.from(text, 'utf8'),
    contentType: 'audio/mpeg',
    provider: 'deepgram',
    latencyMs: 1,
  });
}

const COVERAGE_SUMMARY =
  'Tu sesión de telesalud está cubierta. Tu copago es de 25 dólares y ya cubriste casi todo tu deducible.';

function fakeCoverage(): Promise<CoverageCheckResponse> {
  return Promise.resolve({
    checkId: 'cov-1a2b',
    checkedAt: '2026-08-01T18:29:40Z',
    status: 'covered',
    payerName: 'Test Payer Inc',
    planName: 'PPO Silver',
    copayCents: 2500,
    coinsurancePercent: 0,
    deductible: { individualCents: 150000, metCents: 142000, remainingCents: 8000 },
    priorAuthRequired: false,
    raw271Id: 'stedi-271-test',
    voiceSummary: COVERAGE_SUMMARY,
    latencyMs: 12,
  });
}

interface Harness {
  call: ActiveCall;
  rec: Recorder;
  spy: Spy;
  deps: Partial<PipelineDeps>;
}

function makeCall(
  options: {
    llm?: LlmProvider;
    spy?: Spy;
    ctx?: PatientContext;
    biometrics?: CurrentBiometrics;
    reply?: string;
  } = {},
): Harness {
  const ctx = options.ctx ?? makeContext();
  const { sink, rec } = makeRecorder();
  const made = makeSpyLlm(options.reply);
  const spy = options.spy ?? made.spy;
  const llm = options.llm ?? made.provider;

  const session = new CallSession(ctx.patientId, ctx, { callId: 'call-test' });

  const deps: Partial<PipelineDeps> = {
    llm,
    synthesize: fakeSynthesize,
    checkCoverage: fakeCoverage,
    speedFactor: 200,
    bridgeMs: 5_000,
  };

  const call: ActiveCall = {
    callId: session.callId,
    patientId: ctx.patientId,
    session,
    ctx,
    systemPrompt: 'Eres Loop. (prompt de prueba)',
    sink,
    hooks: {
      endCall: async (outcome, reason) => {
        rec.ended.push({ outcome, reason });
        call.ended = true;
        session.end();
      },
    },
    deps,
    history: [],
    biometrics: options.biometrics ?? (structuredClone(ctx.current) as CurrentBiometrics),
    llmAbort: null,
    interventionStop: null,
    audioSeq: 0,
    pendingActivityId: null,
    awaitingRelief: null,
    awaitingSeverity: false,
    coverageDone: new Set<string>(),
    lastCoverageSummary: null,
    interventionsRun: new Set<string>(),
    ended: false,
  };

  return { call, rec, spy, deps };
}

// =============================================================================
// Frases
// =============================================================================

/** Una por regla de texto. Todas tienen que escalar SIN tocar el modelo. */
const RED_FLAG_PHRASES: ReadonlyArray<{ text: string; rule: string; action: string }> = [
  {
    text: 'me duele mucho el pecho y se me va al brazo izquierdo',
    rule: 'RF-01-CHEST-PAIN-RADIATING',
    action: 'advise-911',
  },
  { text: 'me desmaye hace un momento en la cocina', rule: 'RF-02-SYNCOPE', action: 'advise-911' },
  {
    text: 'no siento el brazo derecho, se me durmio todo ese lado',
    rule: 'RF-03-UNILATERAL-WEAKNESS',
    action: 'advise-911',
  },
  {
    text: 'se me traba la lengua y se me cayo un lado de la cara',
    rule: 'RF-04-SPEECH-FACIAL',
    action: 'advise-911',
  },
  {
    text: 'es el peor dolor de cabeza de mi vida, empezo de golpe',
    rule: 'RF-05-THUNDERCLAP-HEADACHE',
    action: 'advise-911',
  },
  { text: 'quiero matarme, ya no aguanto', rule: 'RF-07-SELF-HARM', action: 'advise-988' },
];

/** Nada de esto puede escalar: es la conversacion normal del producto. */
const BENIGN_PHRASES: readonly string[] = [
  'estoy un poco nervioso por el trabajo de mañana',
  'siento el corazon acelerado y me cuesta dormir',
  'me falta el aire pero creo que es la ansiedad',
];

// =============================================================================
// Tests
// =============================================================================

describe('turnPipeline — el LLM y el motor de red-flags', () => {
  beforeEach(() => {
    resetLiveBus();
  });

  it('NO invoca al LLM en ninguna de las 6 frases de red-flag', async () => {
    const { spy, provider } = makeSpyLlm();

    for (const phrase of RED_FLAG_PHRASES) {
      const harness = makeCall({ llm: provider, spy });
      const result = await runPatientTurn(harness.call, phrase.text, harness.deps);

      expect(result.escalated, `"${phrase.text}" deberia escalar`).toBe(true);
      expect(result.ruleId).toBe(phrase.rule);
      expect(result.action).toBe(phrase.action);
      expect(result.llmInvoked).toBe(false);
    }

    // LA asercion del repo.
    expect(spy.callCount).toBe(0);
  });

  it('SI invoca al LLM en las frases benignas', async () => {
    const { spy, provider } = makeSpyLlm();

    for (const phrase of BENIGN_PHRASES) {
      const harness = makeCall({ llm: provider, spy });
      const result = await runPatientTurn(harness.call, phrase, harness.deps);

      expect(result.escalated, `"${phrase}" no deberia escalar`).toBe(false);
      expect(result.llmInvoked).toBe(true);
      expect(result.agentText.length).toBeGreaterThan(0);
    }

    expect(spy.callCount).toBe(BENIGN_PHRASES.length);
  });

  it('escala por biometria viva (RF-08) sin que el texto diga nada grave', async () => {
    const ctx = makeContext();
    const critical = structuredClone(ctx.current) as CurrentBiometrics;
    critical.heartRate = { ...critical.heartRate, latest: 163, max: 171 };

    const harness = makeCall({ ctx, biometrics: critical });
    const result = await runPatientTurn(harness.call, 'estoy nervioso', harness.deps);

    expect(result.escalated).toBe(true);
    expect(result.ruleId).toBe('RF-08-BIOMETRIC-ENVELOPE');
    expect(harness.spy.callCount).toBe(0);
    expect(result.evidence).toContain('163');
  });

  it('locuta el guion HARDCODEADO, no una frase generada', async () => {
    const harness = makeCall();
    await runPatientTurn(
      harness.call,
      'me duele el pecho y se me corre al brazo izquierdo',
      harness.deps,
    );

    expect(spoken(harness.rec)).toContain(SCRIPT_911);
    expect(harness.rec.escalations[0]?.script).toBe(SCRIPT_911);
  });

  it('RF-07 usa el guion del 988, no el del 911', async () => {
    const harness = makeCall();
    const result = await runPatientTurn(harness.call, 'quiero suicidarme', harness.deps);

    expect(result.action).toBe('advise-988');
    expect(spoken(harness.rec)).toContain(SCRIPT_988);
    expect(spoken(harness.rec)).not.toContain(SCRIPT_911);
    expect(harness.rec.ended[0]?.outcome).toBe('escalated-human');
  });

  it('cierra la llamada con el outcome de emergencia tras un 911', async () => {
    const harness = makeCall();
    await runPatientTurn(harness.call, 'me desmaye hace un rato', harness.deps);

    expect(harness.rec.ended).toHaveLength(1);
    expect(harness.rec.ended[0]?.outcome).toBe('escalated-emergency');
    expect(harness.call.session.escalation.triggered).toBe(true);
    expect(harness.call.session.escalation.rule).toBe('RF-02-SYNCOPE');
  });

  it('registra el turno del paciente ANTES de evaluar (no se pierde si escala)', async () => {
    const harness = makeCall();
    const text = 'me duele el pecho y se me va a la mandibula';
    await runPatientTurn(harness.call, text, harness.deps);

    const patientTurns = harness.call.session.turns.filter((t) => t.speaker === 'patient');
    expect(patientTurns).toHaveLength(1);
    expect(patientTurns[0]?.text).toBe(text);
  });

  it('emite safety.escalation y transcript.turn al bus en vivo', async () => {
    const seen: LiveEvent[] = [];
    const unsubscribe = liveBus.subscribe((event) => seen.push(event));

    const harness = makeCall();
    await runPatientTurn(harness.call, 'quiero matarme', harness.deps);
    unsubscribe();

    const types = seen.map((event) => event.type);
    expect(types).toContain('transcript.turn');
    expect(types).toContain('safety.escalation');

    const escalation = seen.find((event) => event.type === 'safety.escalation');
    expect(escalation?.data['rule']).toBe('RF-07-SELF-HARM');
    expect(escalation?.data['action']).toBe('advise-988');
  });

  it('aborta la generacion en curso cuando llega un turno de red-flag', async () => {
    let releaseFirstDelta: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstDelta = resolve;
    });

    const spy: Spy = { callCount: 0, lastRequest: null, aborted: 0 };
    const slowLlm: LlmProvider = {
      name: 'slow-spy',
      async *streamReply(_req, signal): AsyncIterable<string> {
        spy.callCount += 1;
        yield 'Estoy contigo. ';
        await gate;
        if (signal?.aborted === true) {
          spy.aborted += 1;
          return;
        }
        yield 'Esto no deberia sonar nunca. ';
      },
    };

    const harness = makeCall({ llm: slowLlm, spy });

    // Turno 1: benigno -> el modelo empieza a hablar y se queda esperando.
    const inFlight = runPatientTurn(harness.call, 'estoy nervioso', harness.deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Turno 2: red-flag. Tiene que matar la generacion anterior.
    await runPatientTurn(harness.call, 'me desmaye', harness.deps);
    releaseFirstDelta();
    await inFlight;

    expect(spy.callCount).toBe(1); // el turno de red-flag no llamo al modelo
    expect(spy.aborted).toBe(1);
    expect(spoken(harness.rec)).not.toContain('Esto no deberia sonar nunca.');
    expect(spoken(harness.rec)).toContain(SCRIPT_911);
  });
});

describe('turnPipeline — post-filtro de la salida del modelo', () => {
  beforeEach(() => {
    resetLiveBus();
  });

  it('sustituye una frase de diagnostico por la linea segura ANTES del TTS', async () => {
    const harness = makeCall({ reply: 'Estás teniendo un ataque de pánico. No es nada grave.' });
    const result = await runPatientTurn(harness.call, 'me siento muy mal', harness.deps);

    expect(result.llmInvoked).toBe(true);
    expect(spoken(harness.rec)).toContain(SAFE_REPLACEMENT_LINE);
    expect(spoken(harness.rec)).not.toContain('ataque de pánico');
    expect(result.agentText).toContain(SAFE_REPLACEMENT_LINE);
  });

  it('deja pasar intacta una frase segura, con sus acentos', async () => {
    const safeReply = 'Tu ritmo está en 118 y tu promedio es 68.';
    const harness = makeCall({ reply: safeReply });
    const result = await runPatientTurn(harness.call, 'me siento acelerado', harness.deps);

    expect(result.agentText).toContain('está en 118');
    expect(spoken(harness.rec)).toContain('118');
  });

  it('el texto del agente entra al historial del modelo y al transcript', async () => {
    const harness = makeCall({ reply: 'Aquí estoy contigo.' });
    await runPatientTurn(harness.call, 'hola', harness.deps);

    const agentTurns = harness.call.session.turns.filter((t) => t.speaker === 'agent');
    expect(agentTurns).toHaveLength(1);
    expect(harness.call.history.at(-1)).toEqual({ role: 'assistant', text: 'Aquí estoy contigo.' });
  });
});

describe('turnPipeline — frase puente', () => {
  it('locuta la frase puente si el modelo tarda mas del umbral', async () => {
    const slowLlm: LlmProvider = {
      name: 'lento',
      async *streamReply(): AsyncIterable<string> {
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield 'Perdón por la espera. ';
      },
    };

    const harness = makeCall({ llm: slowLlm });
    await runPatientTurn(harness.call, 'estoy nervioso', { ...harness.deps, bridgeMs: 10 });

    expect(spoken(harness.rec)).toContain(BRIDGE_LINE);
    // La frase puente es relleno de latencia: no contamina el episodio.
    const agentTurns = harness.call.session.turns.filter((t) => t.speaker === 'agent');
    expect(agentTurns.some((turn) => turn.text === BRIDGE_LINE)).toBe(false);
  });

  it('no locuta la frase puente si el modelo responde rapido', async () => {
    const harness = makeCall({ reply: 'Estoy aquí.' });
    await runPatientTurn(harness.call, 'estoy nervioso', { ...harness.deps, bridgeMs: 5_000 });

    expect(spoken(harness.rec)).not.toContain(BRIDGE_LINE);
  });
});

describe('turnPipeline — cobertura', () => {
  beforeEach(() => {
    resetLiveBus();
  });

  it('locuta el voiceSummary LITERAL y no pasa por el modelo', async () => {
    const harness = makeCall();
    const result = await runPatientTurn(harness.call, '¿cuánto me va a costar eso?', harness.deps);

    expect(result.path).toBe('coverage');
    expect(harness.spy.callCount).toBe(0);
    expect(spoken(harness.rec)).toContain(COVERAGE_SUMMARY);
    expect(harness.rec.coverages[0]?.voiceSummary).toBe(COVERAGE_SUMMARY);
  });

  it('registra el check en la sesion y emite coverage.check', async () => {
    const seen: LiveEvent[] = [];
    const unsubscribe = liveBus.subscribe((event) => seen.push(event));

    const harness = makeCall();
    await runPatientTurn(harness.call, 'tengo copago con mi seguro?', harness.deps);
    unsubscribe();

    expect(harness.call.session.coverageChecks).toHaveLength(1);
    expect(harness.call.session.coverageChecks[0]?.serviceType).toBe('telehealth-mental-health');
    expect(seen.some((event) => event.type === 'coverage.check')).toBe(true);
  });

  it('si vuelve a preguntar por el costo, REPITE el mismo voiceSummary literal', async () => {
    const harness = makeCall();
    await runPatientTurn(harness.call, '¿cuánto me va a costar eso?', harness.deps);
    const result = await runPatientTurn(harness.call, 'perdona, ¿y el copago?', harness.deps);

    // Ni se vuelve a llamar a :3003 (el check ya se hizo)...
    expect(harness.call.session.coverageChecks).toHaveLength(1);
    // ...ni se contradice: repite la cifra de Carlos, no "no pude verificarlo".
    expect(result.agentText).toBe(COVERAGE_SUMMARY);
    expect(harness.spy.callCount).toBe(0);
  });

  it('una red-flag gana a una pregunta de cobertura en el mismo turno', async () => {
    const harness = makeCall();
    const result = await runPatientTurn(
      harness.call,
      'oye, cuanto cuesta esto? ah y me duele el pecho y se me va al brazo',
      harness.deps,
    );

    expect(result.path).toBe('escalation');
    expect(harness.call.session.coverageChecks).toHaveLength(0);
  });
});

describe('turnPipeline — intervencion guiada', () => {
  it('un "si" tras la propuesta arranca la actividad y la registra', async () => {
    const harness = makeCall();
    harness.call.pendingActivityId = 'cp-act-1';

    const result = await runPatientTurn(harness.call, 'sí, hagámoslo', harness.deps);

    expect(result.path).toBe('intervention');
    expect(harness.spy.callCount).toBe(0); // el guion del clinico, no el modelo
    expect(harness.call.session.interventions).toHaveLength(1);
    expect(harness.call.session.interventions[0]?.carePlanActivityId).toBe('cp-act-1');
    expect(harness.rec.states).toContain('intervention');
    // 22 pasos de respiracion de caja, todos locutados.
    expect(harness.rec.audioTexts.length).toBeGreaterThan(20);
  });

  it('captura el alivio 0-10 y lo guarda en el intento', async () => {
    const harness = makeCall();
    harness.call.pendingActivityId = 'cp-act-1';
    await runPatientTurn(harness.call, 'vale', harness.deps);

    expect(harness.call.awaitingRelief).toBe('cp-act-1');
    await runPatientTurn(harness.call, 'como un seis', harness.deps);

    const attempt = harness.call.session.interventions[0];
    expect(attempt?.completed).toBe(true);
    expect(attempt?.patientReportedRelief).toBe(6);
  });

  it('una red-flag durante la intervencion la corta y escala', async () => {
    const harness = makeCall();
    harness.call.pendingActivityId = 'cp-act-1';
    // Pausas largas para que la intervencion siga viva cuando llegue el segundo
    // turno; el `speedFactor` bajo hace que cada fase dure de verdad.
    const slowDeps = { ...harness.deps, speedFactor: 30 };

    const running = runPatientTurn(harness.call, 'sí', slowDeps);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const escalation = await runPatientTurn(harness.call, 'me duele el pecho y se me va al brazo', slowDeps);
    await running;

    expect(escalation.escalated).toBe(true);
    expect(harness.spy.callCount).toBe(0);
    expect(harness.call.session.escalation.rule).toBe('RF-01-CHEST-PAIN-RADIATING');
    expect(spoken(harness.rec)).toContain(SCRIPT_911);
  });

  it('un comentario benigno durante la intervencion no la interrumpe', async () => {
    const harness = makeCall();
    harness.call.pendingActivityId = 'cp-act-1';
    const slowDeps = { ...harness.deps, speedFactor: 30 };

    const running = runPatientTurn(harness.call, 'sí', slowDeps);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const during = await runPatientTurn(harness.call, 'me cuesta un poco', slowDeps);
    await running;

    expect(during.path).toBe('ignored');
    expect(harness.spy.callCount).toBe(0);
    expect(harness.call.session.interventions[0]?.completed).toBe(false);
  });
});

describe('turnPipeline — utilidades', () => {
  it('parseZeroToTen entiende digitos y palabras, e ignora un pulso', () => {
    expect(parseZeroToTen('como un 6')).toBe(6);
    expect(parseZeroToTen('diez')).toBe(10);
    expect(parseZeroToTen('cero, nada')).toBe(0);
    expect(parseZeroToTen('mi pulso está en 118')).toBeNull();
    expect(parseZeroToTen('no sé')).toBeNull();
  });

  it('un turno vacio no hace nada', async () => {
    const harness = makeCall();
    const result = await runPatientTurn(harness.call, '   ', harness.deps);

    expect(result.path).toBe('ignored');
    expect(harness.spy.callCount).toBe(0);
    expect(harness.call.session.turns).toHaveLength(0);
  });

  it('un sink que lanza no tumba el turno', async () => {
    const harness = makeCall();
    const exploding: CallSink = {
      ...NOOP_SINK,
      transcript: () => {
        throw new Error('socket muerto');
      },
      audio: () => {
        throw new Error('socket muerto');
      },
    };
    // `safeSink` lo envuelve en el orquestador; aqui se comprueba que el
    // pipeline sobrevive incluso al sink crudo del peor caso.
    const { safeSink } = await import('../turnPipeline.js');
    const guarded = safeSink(exploding);
    const call: ActiveCall = { ...harness.call, sink: guarded };

    const result = await runPatientTurn(call, 'me desmaye', harness.deps);
    expect(result.escalated).toBe(true);
  });
});

// =============================================================================
// La escalacion es un ESTADO TERMINAL, no un turno
// =============================================================================
//
// Que el modelo no vea el turno que disparo la regla no basta. El guion del 911
// tarda segundos en locutarse y el paciente sigue hablando encima. Si esos
// turnos siguieran su curso, el agente contestaria por encima de una instruccion
// de colgar y llamar al 911 — y lo haria con el modelo, sobre una llamada que ya
// habia escalado.
//
// Reproducido con un TTS lento y un turno inyectado mientras el guion suena.

describe('turnPipeline — nada pasa al LLM despues de una escalacion', () => {
  beforeEach(() => {
    resetLiveBus();
  });

  /** TTS que tarda: reproduce la ventana real entre `escalate()` y `endCall`. */
  function slowTts(ms: number): (text: string) => Promise<TtsResult> {
    return async (text: string) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return {
        audio: Buffer.from(text, 'utf8'),
        contentType: 'audio/mpeg',
        provider: 'deepgram',
        latencyMs: ms,
      };
    };
  }

  it('un turno benigno DURANTE el guion del 911 no llega al modelo', async () => {
    const harness = makeCall();
    const deps: Partial<PipelineDeps> = { ...harness.deps, synthesize: slowTts(120) };

    // El guion del 911 se esta locutando: `escalate()` sigue en vuelo.
    const escalating = runPatientTurn(
      harness.call,
      'me duele el pecho y se me va al brazo izquierdo',
      deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const during = await runPatientTurn(
      harness.call,
      'pero es que estoy muy nervioso, no se que hacer',
      deps,
    );
    const escalated = await escalating;

    expect(escalated.escalated).toBe(true);
    expect(escalated.ruleId).toBe('RF-01-CHEST-PAIN-RADIATING');
    // Lo que se audita: el contador del espia sigue en cero DESPUES de los dos
    // turnos, no solo despues del que disparo.
    expect(during.path).toBe('ignored');
    expect(during.llmInvoked).toBe(false);
    expect(harness.spy.callCount).toBe(0);
  });

  it('el turno posterior SI queda en el transcript (la auditoria no pierde nada)', async () => {
    const harness = makeCall();
    const deps: Partial<PipelineDeps> = { ...harness.deps, synthesize: slowTts(120) };

    const escalating = runPatientTurn(harness.call, 'me desmaye hace un rato', deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runPatientTurn(harness.call, 'espera, no cuelgues', deps);
    await escalating;

    const dicho = harness.call.session.turns.map((turn) => turn.text);
    expect(dicho).toContain('espera, no cuelgues');
  });

  it('una segunda red-flag durante la escalacion no re-locuta ni cambia la regla', async () => {
    const harness = makeCall();
    const deps: Partial<PipelineDeps> = { ...harness.deps, synthesize: slowTts(120) };

    const escalating = runPatientTurn(harness.call, 'quiero matarme', deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await runPatientTurn(harness.call, 'me duele el pecho y se me va al brazo', deps);
    await escalating;

    expect(second.path).toBe('ignored');
    expect(harness.spy.callCount).toBe(0);
    // GANA LA PRIMERA: la que corto la llamada es la que se audita, y sigue
    // siendo la del 988.
    expect(harness.call.session.escalation.rule).toBe('RF-07-SELF-HARM');
    expect(harness.call.session.escalation.action).toBe('advise-988');
  });
});
