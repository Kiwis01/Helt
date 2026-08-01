/**
 * Suite del post-filtro de salida del LLM.
 *
 * Dos mitades que pesan lo mismo:
 *   - lo que TIENE que bloquear (diagnostico, minimizacion, medicacion)
 *   - lo que NO puede bloquear (el guion de respiracion del care plan, los
 *     numeros del baseline, la lectura literal del voiceSummary de cobertura)
 *
 * La segunda mitad es la que evita que el filtro se coma el demo.
 */

import { describe, expect, it } from 'vitest';
import { filterAgentOutput, inspectAgentChunk, inspectAgentOutput } from '../outputFilter.js';
import { splitIntoSpeakableChunks } from '../../audio/sentenceSplitter.js';
import { SAFE_REPLACEMENT_LINE } from '../scripts.js';

describe('filterAgentOutput · frases que DEBEN bloquearse', () => {
  const BLOCKED: ReadonlyArray<[string, string]> = [
    ['Estás teniendo un ataque de pánico.', 'diagnostico explicito — la frase prohibida #1'],
    ['Esto es un ataque de ansiedad, nada más.', 'diagnostico + minimizacion'],
    ['Lo que tienes es ansiedad.', 'atribuye el sintoma a una condicion'],
    ['Es solo ansiedad, se te va a pasar.', 'minimiza a "solo ansiedad"'],
    ['Tranquilo, no es nada grave.', 'minimizacion: descarta gravedad'],
    ['No te preocupes, no es nada.', 'minimizacion clasica'],
    ['No tienes nada, de verdad.', 'falsa certeza'],
    ['Estás bien, no pasa nada.', 'falsa certeza'],
    ['Te lo aseguro, no te va a pasar nada.', 'promesa que el agente no puede hacer'],
    ['Te diagnostico un trastorno de ansiedad.', 'el agente se atribuye un diagnostico'],
    ['Esto no es el corazón, quédate tranquilo.', 'descarta causa cardiaca — prohibido'],
    ['Deberías tomar media pastilla de tu ansiolítico.', 'recomendacion de medicacion'],
    ['Te recomiendo tomar una dosis extra de sertralina.', 'ajuste de medicacion'],
    ['Deja de tomar el medicamento por hoy.', 'suspension de medicacion'],
    ["You're having a panic attack.", 'diagnostico en ingles'],
    ["It's just anxiety, nothing serious.", 'minimizacion en ingles'],
    ['You should take an extra pill tonight.', 'medicacion en ingles'],
  ];

  for (const [text, why] of BLOCKED) {
    it(`bloquea: "${text}" (${why})`, () => {
      const result = filterAgentOutput(text);
      expect(result.safe).toBe(false);
      expect(result.text).toBe(SAFE_REPLACEMENT_LINE);
      expect(result.matchedPhrase).not.toBeNull();
      expect(result.text).not.toContain(text);
    });
  }
});

describe('filterAgentOutput · frases que NO pueden bloquearse', () => {
  const ALLOWED: ReadonlyArray<[string, string]> = [
    [
      'Tu frecuencia cardiaca está en 118 y tu baseline es 68. Eso es lo que muestran tus datos ahora mismo.',
      'la frase estrella del demo: contexto biometrico, cero diagnostico',
    ],
    [
      'Vamos a hacerlo juntos. Toma aire por la nariz mientras cuento cuatro: uno, dos, tres, cuatro.',
      'guion de respiracion de caja — "toma aire" NO es medicacion',
    ],
    ['Tómate un momento, yo espero.', '"tomate un momento" no es una pastilla'],
    ['Deberías tomar agua si tienes la boca seca.', 'agua, excluida explicitamente'],
    [
      'Tu plan de cuidado dice que el siguiente paso es avisar a tu equipo de cuidado.',
      'lectura del care plan',
    ],
    [
      'Tu sesión de telesalud está cubierta. Tu copago es de 25 dólares.',
      'voiceSummary literal de loop-coverage',
    ],
    [
      'No puedo decirte qué está causando esto, pero puedo decirte qué muestran tus datos.',
      'la postura correcta del agente',
    ],
    [
      'Tu ritmo está bajando: pasó de 126 a 104 en los últimos tres minutos.',
      'desescalada basada en datos, sin descartar nada',
    ],
    ['¿Del cero al diez, cuánto bajó?', 'captura de patientReportedRelief'],
    ['Estoy aquí contigo. Vamos por el segundo ciclo.', 'acompañamiento'],
    ['Tomas sertralina 50 mg según tu registro, ¿verdad?', 'menciona la medicacion sin recomendarla'],
  ];

  for (const [text, why] of ALLOWED) {
    it(`deja pasar: "${text.slice(0, 48)}..." (${why})`, () => {
      const result = filterAgentOutput(text);
      expect(result.safe).toBe(true);
      expect(result.text).toBe(text);
      expect(result.matchedPhrase).toBeNull();
    });
  }
});

describe('filterAgentOutput · contrato y comportamiento', () => {
  it('devuelve el texto ORIGINAL intacto, con sus acentos, cuando es seguro', () => {
    const text = 'Tu variabilidad cardiaca está en 21 milisegundos.';
    expect(filterAgentOutput(text).text).toBe(text);
  });

  it('es insensible a mayusculas y acentos al bloquear', () => {
    expect(filterAgentOutput('ESTÁS TENIENDO UN ATAQUE DE PÁNICO').safe).toBe(false);
    expect(filterAgentOutput('estas teniendo un ataque de panico').safe).toBe(false);
  });

  it('un texto vacio es seguro y no revienta', () => {
    expect(filterAgentOutput('').safe).toBe(true);
    expect(filterAgentOutput('   ').safe).toBe(true);
  });

  it('es determinista: mismas entradas, mismas salidas', () => {
    const text = 'No te preocupes, no es nada.';
    expect(filterAgentOutput(text)).toEqual(filterAgentOutput(text));
  });

  it('funciona por frase suelta (el TTS locuta por frases)', () => {
    const chunks = ['Tu ritmo está en 118.', 'Es solo ansiedad.', 'Vamos a respirar juntos.'];
    const verdicts = chunks.map((c) => filterAgentOutput(c).safe);
    expect(verdicts).toEqual([true, false, true]);
  });

  it('inspectAgentOutput ademas devuelve el motivo legible para el log', () => {
    const result = inspectAgentOutput('Estás teniendo un ataque de pánico.');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('diagnostico');
  });

  it('inspectAgentOutput no da motivo cuando el texto es seguro', () => {
    expect(inspectAgentOutput('Tu baseline es 68 bpm.').reason).toBeNull();
  });
});

// =============================================================================
// Frases prohibidas PARTIDAS entre dos fragmentos de TTS
// =============================================================================
//
// El agujero que `inspectAgentChunk` tapa, reproducido contra el troceador real.
// El modelo escribe una frase larga sin punto; `splitIntoSpeakableChunks` corta
// por la coma mas cercana a 120 caracteres; las dos mitades resultantes son
// inocentes por separado y la frase prohibida sale entera por el altavoz.

describe('inspectAgentChunk · frases prohibidas partidas por el troceador', () => {
  /** Como trocea de verdad el pipeline cuando Bedrock emite palabra a palabra. */
  async function chunksOf(text: string): Promise<string[]> {
    async function* words(): AsyncIterable<string> {
      for (const w of text.split(' ')) yield `${w} `;
    }
    const out: string[] = [];
    for await (const chunk of splitIntoSpeakableChunks(words())) out.push(chunk);
    return out;
  }

  /** Corre el filtro como lo corre `runLlmTurn`: por fragmento y con contexto. */
  async function speak(text: string): Promise<{ spoken: string[]; blocked: number }> {
    const spoken: string[] = [];
    let blocked = 0;
    let accumulated = '';
    for (const chunk of await chunksOf(text)) {
      const verdict = inspectAgentChunk(chunk, accumulated);
      if (!verdict.safe) blocked += 1;
      spoken.push(verdict.text);
      accumulated = spoken.join(' ');
    }
    return { spoken, blocked };
  }

  const LONG_MINIMIZATION =
    'Alex, con todo lo que me estás contando y con los números que estoy viendo ' +
    'en tu reloj ahora mismo, no te preocupes, no es nada.';

  const LONG_FALSE_CERTAINTY =
    'Mira, llevo un rato mirando tus datos y todo lo que veo encaja con lo que ' +
    'ya conocemos de ti desde hace semanas, estás bien, no pasa nada.';

  it('la frase larga SI se parte en dos fragmentos (premisa del ataque)', async () => {
    expect((await chunksOf(LONG_MINIMIZATION)).length).toBeGreaterThan(1);
  });

  it('cada mitad por separado pasaria el filtro (por eso hacia falta el arreglo)', async () => {
    for (const chunk of await chunksOf(LONG_MINIMIZATION)) {
      expect(inspectAgentOutput(chunk).safe).toBe(true);
    }
  });

  it('"no te preocupes, ... no es nada" se bloquea aunque caiga a caballo', async () => {
    const { blocked, spoken } = await speak(LONG_MINIMIZATION);
    expect(blocked).toBe(1);
    expect(spoken.at(-1)).toBe(SAFE_REPLACEMENT_LINE);
  });

  it('"estás bien, ... no pasa nada" se bloquea aunque caiga a caballo', async () => {
    const { blocked, spoken } = await speak(LONG_FALSE_CERTAINTY);
    expect(blocked).toBe(1);
    expect(spoken.at(-1)).toBe(SAFE_REPLACEMENT_LINE);
  });

  it('marca `straddled` para distinguirlo en el log de un bloqueo normal', () => {
    const partido = inspectAgentChunk('no es nada.', 'y con lo que veo, no te preocupes,');
    expect(partido.safe).toBe(false);
    expect(partido.straddled).toBe(true);

    const entero = inspectAgentChunk('Estás teniendo un ataque de pánico.', '');
    expect(entero.safe).toBe(false);
    expect(entero.straddled).toBe(false);
  });

  it('NO bloquea el guion de la respiracion, que tambien lleva "no pasa nada"', async () => {
    // El care plan dice literalmente "si no te sale a la primera no pasa nada".
    // Bloquearlo mataria la intervencion central del producto.
    const guion =
      'Vamos a empezar despacio: inhala cuatro tiempos conmigo, sostenlo cuatro, ' +
      'y suelta el aire cuatro. Si no te sale a la primera no pasa nada, lo repetimos.';
    expect((await speak(guion)).blocked).toBe(0);
  });

  it('NO bloquea una respuesta normal con numeros del baseline', async () => {
    const normal =
      'Tu frecuencia cardiaca está en 118 y tu promedio de reposo es 68. ' +
      'Tu plan dice empezar con respiración de caja, tómate tu tiempo, no hay prisa.';
    expect((await speak(normal)).blocked).toBe(0);
  });

  it('sin contexto previo se comporta exactamente como inspectAgentOutput', () => {
    for (const text of ['Tu baseline es 68 bpm.', 'Es solo ansiedad.', '']) {
      const chunk = inspectAgentChunk(text, '');
      const whole = inspectAgentOutput(text);
      expect(chunk.safe).toBe(whole.safe);
      expect(chunk.text).toBe(whole.text);
    }
  });
});
