/**
 * Suite de la capa de agente.
 *
 * NINGUN test toca la red. El cliente de Bedrock siempre se inyecta como doble;
 * el proveedor de respaldo no tiene red por diseño; el motor de intervenciones
 * corre con `speedFactor` alto para que las pausas de 4 segundos no conviertan
 * el suite en una siesta.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';

import type { AgentTurnRequest, CarePlanActivity, PatientContext } from '../../types.js';
import { parsePatientContext } from '../../types.js';
import {
  MAX_OUTPUT_TOKENS,
  TEMPERATURE,
  detectStreamError,
  extractDeltaText,
  normalizeMessages,
  streamTextDeltas,
  toConverseInput,
  type BedrockClientLike,
} from '../bedrockProvider.js';
import {
  SCRIPTED_PROVIDER_NAME,
  buildScriptedReply,
  createScriptedProvider,
  selectProvider,
} from '../llm.js';
import {
  BREATHING_CYCLES,
  BREATHING_PHASE_MS,
  GROUNDING_PROMPT_MS,
  INTRO_PAUSE_MS,
  estimateDurationMs,
  planIntervention,
  runIntervention,
} from '../interventionGuide.js';
import {
  DISCLOSURE_LINE,
  POSTURE_RULES,
  buildOpeningLine,
  buildSystemPrompt,
  parsePromptSnapshot,
} from '../systemPrompt.js';

// -----------------------------------------------------------------------------
// Fixture
// -----------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url)); // voice/src/agent/__tests__
const FIXTURE_PATH = resolve(here, '../../../../shared/fixtures/context.happy.json');

/** Contexto del demo, validado contra el contrato compartido. */
function loadHappyContext(): PatientContext {
  return parsePatientContext(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
}

const happy = loadHappyContext();
const happyPrompt = buildSystemPrompt(happy);

/** Clon profundo para los tests que degradan el contexto. */
function cloneContext(): PatientContext {
  return JSON.parse(JSON.stringify(happy)) as PatientContext;
}

function activityById(id: string): CarePlanActivity {
  const found = happy.carePlan.activities.find((activity) => activity.id === id);
  if (found === undefined) throw new Error(`fixture sin actividad ${id}`);
  return found;
}

/**
 * Primera linea locutable del guion del clinico, leida del fixture.
 *
 * Los textos de `shared/fixtures/` los regenera `generate.mjs` y ya cambiaron
 * una vez en la integracion. Lo que estos tests defienden es que el agente usa
 * la VOZ DEL CLINICO, no una cadena concreta: se compara contra el fixture.
 */
function firstScriptLine(activity: CarePlanActivity): string {
  const first = (activity.voiceScript ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (first === undefined) throw new Error(`fixture sin voiceScript en ${activity.id}`);
  return first;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

async function* fakeStream(events: ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const event of events) yield event;
}

// =============================================================================
// buildSystemPrompt
// =============================================================================

describe('buildSystemPrompt', () => {
  it('inyecta los numeros reales del fixture, con sus desviaciones estandar', () => {
    // Actual vs referencia de las tres metricas.
    expect(happyPrompt).toContain('Frecuencia cardiaca ahora: 118 bpm | referencia: 68 bpm');
    expect(happyPrompt).toContain('Variabilidad cardiaca ahora: 21 ms | referencia: 54 ms');
    expect(happyPrompt).toContain('Respiraciones por minuto ahora: 24 | referencia: 14');

    // Las SD son lo que convierte "esta acelerado" en un dato.
    expect(happyPrompt).toContain('desviación: 8.3 SD sobre su promedio');
    expect(happyPrompt).toContain('desviación: -3 SD');

    // Extremos de la ventana y sueño de referencia.
    expect(happyPrompt).toContain('máximo en la ventana: 126 bpm');
    expect(happyPrompt).toContain('mínimo en la ventana: 18 ms');
    expect(happyPrompt).toContain('6.8 h por noche');

    // Identidad.
    expect(happyPrompt).toContain('- Paciente: Alex Rivera, 34 años.');
  });

  it('incluye LAS SEIS reglas de postura, textuales', () => {
    expect(POSTURE_RULES).toHaveLength(6);
    for (const rule of POSTURE_RULES) {
      expect(happyPrompt).toContain(rule);
    }
    // Las dos prohibiciones que un juez clinico va a buscar.
    expect(happyPrompt).toContain('NUNCA DIAGNOSTIQUES');
    expect(happyPrompt).toContain('NUNCA para descartar una emergencia');
    expect(happyPrompt).toContain(DISCLOSURE_LINE);
  });

  it('vuelca el care plan completo, en orden, con instruction y voiceScript', () => {
    expect(happyPrompt).toContain('Escrito por Dr. Maya Chen, actualizado 2026-07-02');
    expect(happyPrompt).toContain('1. Box breathing (breathing, ~4 min)');
    expect(happyPrompt).toContain('2. 5-4-3-2-1 grounding (grounding, ~3 min)');
    expect(happyPrompt).toContain('3. Message care team (escalation-soft)');

    expect(happyPrompt).toContain('Indicación del clínico: 4 in, 4 hold, 4 out, 4 hold — 5 cycles');
    // `flattenScript` une las lineas con ' / ', asi que la primera linea del
    // guion del clinico va siempre justo detras de la etiqueta.
    expect(happyPrompt).toContain(`Guion de voz: ${firstScriptLine(activityById('cp-act-1'))}`);

    // El orden importa: el plan se sigue de arriba abajo.
    const first = happyPrompt.indexOf('1. Box breathing');
    const second = happyPrompt.indexOf('2. 5-4-3-2-1 grounding');
    const third = happyPrompt.indexOf('3. Message care team');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);

    // La actividad con costo avisa de que el resumen de cobertura se lee literal.
    expect(happyPrompt).toContain('telehealth-mental-health, CPT 90834');
    expect(happyPrompt).toContain('se lee LITERAL');
  });

  it('incluye condicion activa, episodios recientes y medicacion', () => {
    expect(happyPrompt).toContain('Anxiety disorder (SNOMED 197480006), desde 2023-04-12');

    // El FORMATO de la linea es lo que se fija aqui; las cifras salen del
    // fixture, que regenera `shared/fixtures/generate.mjs`.
    const episode = happy.recentEpisodes[1];
    expect(episode).toBeDefined();
    expect(happyPrompt).toContain(
      `- ${episode.startedAt.slice(0, 10)}, duró ${episode.durationMinutes} min, ` +
        `pico de ${episode.peakHeartRate} bpm, hizo ${episode.interventions.join(', ')}, ` +
        `terminó ${episode.resolution}, severidad ${episode.severitySelfReported}/10.`,
    );
    expect(happyPrompt).toContain('Sertraline 50mg (active)');
    expect(happyPrompt).toContain('no sugieres cambios');
  });

  it('no deja huecos de plantilla sin resolver', () => {
    expect(happyPrompt).not.toContain('undefined');
    expect(happyPrompt).not.toContain('NaN');
    expect(happyPrompt).not.toContain('[object Object]');
  });
});

// =============================================================================
// buildOpeningLine
// =============================================================================

describe('buildOpeningLine', () => {
  it('dice el ritmo actual (118) y el de referencia (68) sin pasar por el LLM', () => {
    const line = buildOpeningLine(happy);
    expect(line).toContain('118');
    expect(line).toContain('68');
    expect(line).toContain('Alex');
    expect(line).toContain('Box breathing');
    expect(line).toContain(DISCLOSURE_LINE);
  });

  it('suena a voz: una sola linea, sin markdown, sin listas, sin emojis', () => {
    const line = buildOpeningLine(happy);
    expect(line).not.toContain('\n');
    expect(line).not.toMatch(/[*#_`]/);
    expect(line).not.toMatch(/^\s*[-•]/m);
    // Rango de emojis mas comun: no debe aparecer ninguno.
    expect(line).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('degrada con honestidad si no hay biometria utilizable', () => {
    const broken = cloneContext();
    // Simula un wearable que dejo de reportar a mitad de la llamada.
    (broken.current.heartRate as { latest: number }).latest = Number.NaN;

    const line = buildOpeningLine(broken, { includeDisclosure: false });
    expect(line).toContain('no estoy recibiendo lecturas');
    expect(line).not.toContain('NaN');
    expect(line).not.toContain(DISCLOSURE_LINE);
  });
});

// =============================================================================
// parsePromptSnapshot (lo usa el proveedor de respaldo)
// =============================================================================

describe('parsePromptSnapshot', () => {
  it('recupera nombre, ritmo, referencia y primera actividad del prompt generado', () => {
    const snapshot = parsePromptSnapshot(happyPrompt);
    expect(snapshot.displayName).toBe('Alex Rivera');
    expect(snapshot.heartRate).toBe(118);
    expect(snapshot.heartRateBaseline).toBe(68);
    // No debe confundir la regla de postura numero 1 con la actividad numero 1.
    expect(snapshot.firstActivityTitle).toBe('Box breathing');
  });

  it('sigue recuperando el nombre cuando el contexto llego sin edad', () => {
    const ctx = cloneContext();
    ctx.age = 0; // centinela de contextCoercion: "loop-core no mando la edad"
    expect(parsePromptSnapshot(buildSystemPrompt(ctx)).displayName).toBe('Alex Rivera');
  });
});

// =============================================================================
// Centinelas de contexto incompleto — nunca se locutan
// =============================================================================
//
// `contextCoercion.ts` acepta un contexto de loop-core al que le falten campos
// no criticos y marca lo ausente con 0 en vez de tirar el payload entero. Estos
// tests fijan la otra mitad del trato: un 0 asi NUNCA sale por el altavoz.
// Sin ellos, un contexto sin `baseline.hrv` haria que el agente afirmara
// "tu variabilidad de referencia es 0 ms", que es peor que no decir nada.

describe('buildSystemPrompt con centinelas de dato ausente', () => {
  it('omite la linea entera de una metrica cuyo baseline llego en 0', () => {
    const ctx = cloneContext();
    ctx.baseline.hrv = { mean: 0, sd: 0, unit: 'ms' };

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).not.toContain('referencia: 0 ms');
    expect(prompt).not.toContain('Variabilidad cardiaca ahora');
    // Lo que si llego se sigue diciendo: no se castiga al resto del contexto.
    expect(prompt).toContain('Frecuencia cardiaca ahora: 118 bpm | referencia: 68 bpm');
  });

  it('omite el sueño de referencia y la edad cuando llegaron en 0', () => {
    const ctx = cloneContext();
    ctx.baseline.sleepHours = { mean: 0, sd: 0, unit: 'h' };
    ctx.age = 0;

    const prompt = buildSystemPrompt(ctx);

    expect(prompt).not.toContain('Sueño de referencia');
    expect(prompt).not.toContain('0 años');
    expect(prompt).toContain('- Paciente: Alex Rivera, edad no registrada.');
  });

  it('la frase de apertura no cita un ritmo de 0: degrada al saludo honesto', () => {
    const ctx = cloneContext();
    ctx.baseline.heartRate = { mean: 0, sd: 0, unit: 'bpm' };

    const line = buildOpeningLine(ctx);

    expect(line).not.toContain('tu promedio de las últimas semanas es 0');
    expect(line).toContain('no estoy recibiendo lecturas de tu reloj');
  });
});

// =============================================================================
// interventionGuide
// =============================================================================

describe('runIntervention — respiracion de caja', () => {
  const breathing = activityById('cp-act-1');

  it('produce intro + 4 fases x 5 ciclos + cierre, y nada mas', () => {
    const steps = planIntervention(breathing);

    expect(steps).toHaveLength(1 + BREATHING_CYCLES * 4 + 1);

    // La intro es la voz del clinico, no una constante de loop-voice.
    expect(steps[0]?.text).toBe(firstScriptLine(breathing));
    expect(steps[0]?.pauseMsAfter).toBe(INTRO_PAUSE_MS);

    const inhales = steps.filter((step) => step.text.includes('Inhala por la nariz'));
    const holds = steps.filter((step) => step.text.startsWith('Sostén el aire'));
    const exhales = steps.filter((step) => step.text.startsWith('Exhala despacio'));
    const empties = steps.filter((step) => step.text.startsWith('Quédate vacío'));
    expect(inhales).toHaveLength(BREATHING_CYCLES);
    expect(holds).toHaveLength(BREATHING_CYCLES);
    expect(exhales).toHaveLength(BREATHING_CYCLES);
    expect(empties).toHaveLength(BREATHING_CYCLES);

    // Cada fase espera 4 segundos de verdad.
    for (const step of [...inhales, ...holds, ...exhales, ...empties]) {
      expect(step.pauseMsAfter).toBe(BREATHING_PHASE_MS);
    }

    // El quinto ciclo se anuncia como ultimo: no es infinito.
    expect(inhales[BREATHING_CYCLES - 1]?.text).toContain('Último ciclo, el quinto');

    // El cierre pregunta el alivio y NO espera: ahi toca escuchar.
    const last = steps[steps.length - 1];
    expect(last?.text).toContain('cuánto bajó?');
    expect(last?.pauseMsAfter).toBe(0);
  });

  it('estima 82 segundos en tiempo real y escala con speedFactor', () => {
    const realTime = INTRO_PAUSE_MS + BREATHING_CYCLES * 4 * BREATHING_PHASE_MS;
    expect(estimateDurationMs(breathing)).toBe(realTime);
    expect(estimateDurationMs(breathing)).toBe(82_000);

    expect(estimateDurationMs(breathing, { speedFactor: 10 })).toBe(8_200);
    expect(estimateDurationMs(breathing, { speedFactor: 200 })).toBe(410);

    // Un speedFactor invalido no puede acelerar ni congelar la intervencion.
    expect(estimateDurationMs(breathing, { speedFactor: 0 })).toBe(realTime);
    expect(estimateDurationMs(breathing, { speedFactor: Number.NaN })).toBe(realTime);
  });

  it('emite los pasos respetando las pausas de verdad', async () => {
    const speedFactor = 200;
    const expected = planIntervention(breathing, { speedFactor });

    const startedAt = Date.now();
    const emitted = await collect(runIntervention(breathing, { speedFactor }));
    const elapsed = Date.now() - startedAt;

    expect(emitted).toEqual(expected);
    // Las pausas son reales: no se pueden haber saltado.
    expect(elapsed).toBeGreaterThanOrEqual(estimateDurationMs(breathing, { speedFactor }) * 0.7);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('runIntervention — grounding y resto de actividades', () => {
  it('el 5-4-3-2-1 usa el guion del clinico con pausas largas', () => {
    const steps = planIntervention(activityById('cp-act-2'));

    expect(steps).toHaveLength(7);
    expect(steps[1]?.text).toContain('cinco cosas que puedas ver');
    expect(steps[1]?.pauseMsAfter).toBe(GROUNDING_PROMPT_MS);
    expect(steps[5]?.text).toContain('saborear');
    expect(steps[5]?.pauseMsAfter).toBe(GROUNDING_PROMPT_MS);
    expect(steps[6]?.pauseMsAfter).toBe(0);
    expect(estimateDurationMs(activityById('cp-act-2'))).toBe(2_500 + 5 * GROUNDING_PROMPT_MS);
  });

  it('cualquier otro tipo locuta el voiceScript de una, sin pausas', () => {
    const steps = planIntervention(activityById('cp-act-3'));

    expect(steps).toHaveLength(1);
    expect(steps[0]?.pauseMsAfter).toBe(0);
    expect(steps[0]?.text).toContain('avisarle a tu equipo de cuidado');
    expect(steps[0]?.text).toContain('¿Quieres que lo revise?');
    expect(steps[0]?.text).not.toContain('\n');
    expect(estimateDurationMs(activityById('cp-act-3'))).toBe(0);
  });

  it('sin voiceScript cae a la indicacion del clinico, nunca a texto inventado', () => {
    // `physical` es un tipo sin tratamiento propio: cae en la rama `default`,
    // igual que cualquier tipo futuro. (`escalation-soft` ya no sirve para este
    // caso: tiene su propio respaldo en espanol.)
    const activity: CarePlanActivity = {
      id: 'cp-act-x',
      order: 9,
      type: 'physical',
      title: 'Escribir dos lineas',
      instruction: 'Anota lo que estabas haciendo cuando empezó',
    };
    const steps = planIntervention(activity);
    expect(steps).toEqual([
      { text: 'Anota lo que estabas haciendo cuando empezó', pauseMsAfter: 0 },
    ]);
  });
});

// =============================================================================
// llm — seleccion y respaldo
// =============================================================================

describe('capa LLM', () => {
  const turnRequest: AgentTurnRequest = {
    systemPrompt: happyPrompt,
    messages: [{ role: 'user', text: 'siento el corazón muy rápido' }],
  };

  it('sin AGENT_MODEL_ID usa el proveedor de respaldo y aun asi cita los numeros', async () => {
    const provider = selectProvider(undefined, 'us-east-1');
    expect(provider.name).toBe(SCRIPTED_PROVIDER_NAME);

    const reply = (await collect(provider.streamReply(turnRequest))).join('');
    expect(reply).toContain('118');
    expect(reply).toContain('68');
    expect(reply).toContain('Box breathing');
    expect(reply).toContain('Alex');
    // El respaldo tampoco diagnostica.
    expect(reply.toLowerCase()).not.toContain('ataque de pánico');
  });

  it('con AGENT_MODEL_ID usa Bedrock y transmite sus deltas', async () => {
    const client: BedrockClientLike = {
      send: async () => ({
        $metadata: {},
        stream: fakeStream([
          { contentBlockDelta: { delta: { text: 'Tu ritmo ' }, contentBlockIndex: 0 } },
          { contentBlockDelta: { delta: { text: 'está en 118.' }, contentBlockIndex: 0 } },
          { messageStop: { stopReason: 'end_turn' } },
        ]),
      }),
    };

    const provider = selectProvider('us.anthropic.fake-model-v1:0', 'us-east-1', {
      createClient: () => client,
    });

    const deltas = await collect(provider.streamReply(turnRequest));
    expect(deltas).toEqual(['Tu ritmo ', 'está en 118.']);
  });

  it('si Bedrock falla, degrada al respaldo sin que la llamada se caiga', async () => {
    let degradedTo: string | null = null;

    const provider = selectProvider('us.anthropic.fake-model-v1:0', 'us-east-1', {
      createClient: () => ({
        send: async () => {
          throw new Error('throttled');
        },
      }),
      hooks: {
        onDegrade: (name) => {
          degradedTo = name;
        },
      },
    });

    const reply = (await collect(provider.streamReply(turnRequest))).join('');
    expect(degradedTo).toBe(SCRIPTED_PROVIDER_NAME);
    expect(reply).toContain('118');
    expect(reply).toContain('68');
  });

  it('un turno abortado no dispara el respaldo: el silencio es intencional', async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = selectProvider('us.anthropic.fake-model-v1:0', 'us-east-1', {
      createClient: () => ({
        send: async () => {
          throw new Error('aborted');
        },
      }),
    });

    const deltas = await collect(provider.streamReply(turnRequest, controller.signal));
    expect(deltas).toEqual([]);
  });

  it('el respaldo es determinista y no repite la misma frase turno tras turno', () => {
    const first = buildScriptedReply(turnRequest);
    expect(buildScriptedReply(turnRequest)).toBe(first);

    const later = buildScriptedReply({
      systemPrompt: happyPrompt,
      messages: [
        { role: 'user', text: 'no puedo parar de temblar' },
        { role: 'assistant', text: first },
        { role: 'user', text: 'sigue igual' },
      ],
    });
    expect(later).not.toBe(first);
    expect(later.length).toBeGreaterThan(20);
  });

  it('el respaldo emite por frases, para que el TTS empiece antes', async () => {
    const deltas = await collect(createScriptedProvider().streamReply(turnRequest));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(buildScriptedReply(turnRequest));
  });
});

// =============================================================================
// bedrockProvider — payload y lectura del stream
// =============================================================================

describe('bedrockProvider', () => {
  it('arma el payload de Converse con maxTokens bajo a proposito', () => {
    const input = toConverseInput(
      { systemPrompt: 'SYS', messages: [{ role: 'user', text: 'hola' }] },
      'us.anthropic.fake-model-v1:0',
    );

    expect(input.modelId).toBe('us.anthropic.fake-model-v1:0');
    expect(input.system).toEqual([{ text: 'SYS' }]);
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'hola' }] }]);
    expect(input.inferenceConfig?.maxTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(MAX_OUTPUT_TOKENS).toBe(400);
    expect(input.inferenceConfig?.temperature).toBe(TEMPERATURE);
  });

  it('normaliza la conversacion: sin vacios, alternando, empezando y cerrando en el paciente', () => {
    const normalized = normalizeMessages([
      { role: 'assistant', text: 'saludo que ya se dijo' },
      { role: 'user', text: 'me falta el aire' },
      { role: 'user', text: '   ' },
      { role: 'user', text: 'un poco' },
      { role: 'assistant', text: 'te escucho' },
      { role: 'user', text: 'sigo igual' },
      { role: 'assistant', text: 'frase colgada' },
    ]);

    expect(normalized).toEqual([
      { role: 'user', text: 'me falta el aire\nun poco' },
      { role: 'assistant', text: 'te escucho' },
      { role: 'user', text: 'sigo igual' },
    ]);
  });

  it('extrae el texto de un stream simulado y se detiene en messageStop', async () => {
    const deltas = await collect(
      streamTextDeltas(
        fakeStream([
          { messageStart: { role: 'assistant' } },
          { contentBlockStart: { start: undefined, contentBlockIndex: 0 } },
          { contentBlockDelta: { delta: { text: 'Hola' }, contentBlockIndex: 0 } },
          { contentBlockDelta: { delta: { text: ', estoy contigo.' }, contentBlockIndex: 0 } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { messageStop: { stopReason: 'end_turn' } },
          { contentBlockDelta: { delta: { text: 'esto ya no debe salir' }, contentBlockIndex: 0 } },
        ]),
      ),
    );

    expect(deltas).toEqual(['Hola', ', estoy contigo.']);
    expect(deltas.join('')).toBe('Hola, estoy contigo.');
  });

  it('convierte los eventos de error de Converse en Error con mensaje util', async () => {
    await expect(
      collect(
        streamTextDeltas(
          fakeStream([
            { contentBlockDelta: { delta: { text: 'parcial' }, contentBlockIndex: 0 } },
            { throttlingException: { name: 'ThrottlingException', $fault: 'client', $metadata: {}, message: 'demasiadas peticiones' } },
          ]),
        ),
      ),
    ).rejects.toThrow(/throttlingException.*demasiadas peticiones/);

    expect(
      detectStreamError({
        validationException: {
          name: 'ValidationException',
          $fault: 'client',
          $metadata: {},
          message: 'modelId invalido',
        },
      })?.message,
    ).toContain('modelId invalido');

    expect(detectStreamError({ messageStop: { stopReason: 'end_turn' } })).toBeNull();
    expect(extractDeltaText({ messageStop: { stopReason: 'end_turn' } })).toBeNull();
  });
});
