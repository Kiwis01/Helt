/**
 * Guia de intervenciones del care plan, con timing REAL.
 *
 * Esto es lo que hace que el demo se sienta humano: el agente no lee la
 * respiracion de caja de corrido, la ACOMPAÑA. Cuenta cuatro tiempos, espera
 * cuatro segundos de verdad, y sigue. Cinco ciclos y termina.
 *
 * Diseño:
 *   - `planIntervention()` es PURA: devuelve la lista de pasos con sus pausas.
 *     Es lo que se testea y lo que alimenta a `estimateDurationMs()`.
 *   - `runIntervention()` es el generador asincrono que respeta las pausas.
 *     Emite el paso, el orquestador lo locuta, y aqui se espera.
 *   - `speedFactor` divide todas las pausas. 1.0 = tiempo real (demo en
 *     escenario). 10 = ensayo rapido. 200 = tests.
 *
 * Sin I/O mas alla del reloj.
 */

import type { CarePlanActivity } from '../types.js';

// -----------------------------------------------------------------------------
// Tipos
// -----------------------------------------------------------------------------

export interface InterventionStep {
  /** Lo que el agente dice. Ya viene listo para el TTS. */
  text: string;
  /**
   * Cuanto se espera DESPUES de locutar este paso, en milisegundos.
   * 0 = no se espera (tipicamente el ultimo paso, donde toca escuchar).
   */
  pauseMsAfter: number;
}

export interface InterventionOptions {
  /**
   * Multiplicador de velocidad. Divide todas las pausas.
   * 1.0 (default) = tiempo real. 10 = ensayo. 200 = tests.
   */
  speedFactor?: number;
}

// -----------------------------------------------------------------------------
// Constantes de timing (en tiempo real, speedFactor = 1)
// -----------------------------------------------------------------------------

/** Cada fase de la respiracion de caja: 4 segundos. Es literalmente el 4-4-4-4. */
export const BREATHING_PHASE_MS = 4000;

/** Ciclos de la respiracion de caja. Cinco y se acaba: nunca es infinito. */
export const BREATHING_CYCLES = 5;

/** Pausa despues de la intro, para que la persona se acomode. */
export const INTRO_PAUSE_MS = 2000;

/** Cada consigna del 5-4-3-2-1: 6 segundos para que la persona responda. */
export const GROUNDING_PROMPT_MS = 6000;

/** Pausa despues de la intro del grounding. */
export const GROUNDING_INTRO_PAUSE_MS = 2500;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Normaliza el multiplicador: cualquier valor invalido cae a 1.0. */
function resolveSpeedFactor(options?: InterventionOptions): number {
  const raw = options?.speedFactor;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 1;
  return raw;
}

/** Aplica el multiplicador a una pausa. */
function scale(ms: number, speedFactor: number): number {
  return Math.round(ms / speedFactor);
}

/** Lineas locutables del voiceScript (la convencion del contrato: separadas por \n). */
function scriptLines(activity: CarePlanActivity): string[] {
  const script = activity.voiceScript;
  if (script === undefined) return [];
  return script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// -----------------------------------------------------------------------------
// Respiracion de caja
// -----------------------------------------------------------------------------

/**
 * Prefijo de cada ciclo. Va pegado a la frase de inhalar, no como paso aparte,
 * para no romper el ritmo de 4 segundos con locuciones sueltas.
 */
const CYCLE_PREFIX: readonly string[] = [
  '',
  'Segundo ciclo. ',
  'Tercer ciclo. No busques respirar profundo, solo parejo. ',
  'Cuarto ciclo. Hombros abajo, mandíbula suelta. ',
  'Último ciclo, el quinto. Ya casi. ',
];

const DEFAULT_BREATHING_INTRO =
  'Vamos a hacerlo juntos, sin prisa. Si puedes, siéntate y suelta los hombros.';

const DEFAULT_BREATHING_CLOSING =
  'Listo. Respira normal un momento. Del cero al diez, ¿cuánto bajó?';

/**
 * Respiracion de caja: 4 dentro, 4 sostener, 4 fuera, 4 vacio, por 5 ciclos.
 *
 * Las fases se generan aqui y no se leen del `voiceScript` a proposito: el
 * guion del clinico describe la tecnica, pero el TIMING es lo que hace que
 * funcione, y eso tiene que ser explicito en codigo. Del guion se toman la
 * intro (primera linea) y el cierre (ultima linea) para que la voz siga siendo
 * la que escribio el clinico.
 */
function planBreathing(activity: CarePlanActivity, speedFactor: number): InterventionStep[] {
  const lines = scriptLines(activity);
  const intro = lines.length > 0 ? lines[0] : DEFAULT_BREATHING_INTRO;
  const closing = lines.length > 1 ? lines[lines.length - 1] : DEFAULT_BREATHING_CLOSING;

  const steps: InterventionStep[] = [
    { text: intro, pauseMsAfter: scale(INTRO_PAUSE_MS, speedFactor) },
  ];

  const phasePause = scale(BREATHING_PHASE_MS, speedFactor);

  for (let cycle = 0; cycle < BREATHING_CYCLES; cycle += 1) {
    const prefix = CYCLE_PREFIX[cycle] ?? '';
    steps.push({
      text: `${prefix}Inhala por la nariz mientras cuento cuatro: uno, dos, tres, cuatro.`,
      pauseMsAfter: phasePause,
    });
    steps.push({
      text: 'Sostén el aire: uno, dos, tres, cuatro.',
      pauseMsAfter: phasePause,
    });
    steps.push({
      text: 'Exhala despacio por la boca: uno, dos, tres, cuatro.',
      pauseMsAfter: phasePause,
    });
    steps.push({
      text: 'Quédate vacío un momento: uno, dos, tres, cuatro.',
      pauseMsAfter: phasePause,
    });
  }

  // Sin pausa al final: aqui toca escuchar la respuesta, no esperar.
  steps.push({ text: closing, pauseMsAfter: 0 });

  return steps;
}

// -----------------------------------------------------------------------------
// Grounding 5-4-3-2-1
// -----------------------------------------------------------------------------

const DEFAULT_GROUNDING_LINES: readonly string[] = [
  'Vamos a anclarte en el lugar donde estás ahora mismo.',
  'Mira alrededor y dime cinco cosas que puedas ver. Tómate tu tiempo, yo espero.',
  'Ahora cuatro cosas que puedas tocar. Toca cada una mientras la nombras.',
  'Tres cosas que puedas oír, aunque sean lejanas.',
  'Dos cosas que puedas oler.',
  'Y una cosa que puedas saborear.',
  'Eso es. Estás aquí, en este cuarto, y tu cuerpo se está regulando.',
];

/**
 * Grounding: se locutan las lineas del guion del clinico (o las canonicas si
 * no hay guion) con pausas largas, porque cada consigna espera una respuesta
 * hablada de la persona.
 */
function planGrounding(activity: CarePlanActivity, speedFactor: number): InterventionStep[] {
  const fromScript = scriptLines(activity);
  const lines = fromScript.length >= 3 ? fromScript : [...DEFAULT_GROUNDING_LINES];

  const introPause = scale(GROUNDING_INTRO_PAUSE_MS, speedFactor);
  const promptPause = scale(GROUNDING_PROMPT_MS, speedFactor);

  return lines.map((text, index) => {
    if (index === lines.length - 1) return { text, pauseMsAfter: 0 };
    if (index === 0) return { text, pauseMsAfter: introPause };
    return { text, pauseMsAfter: promptPause };
  });
}

// -----------------------------------------------------------------------------
// Resto de actividades
// -----------------------------------------------------------------------------

/**
 * Cualquier otro tipo (`escalation-soft`, etc.): se locuta el `voiceScript`
 * de una. Si no hay guion, se cae a la indicacion del clinico y, en ultimo
 * termino, al titulo. Nunca se inventa texto clinico.
 */
function planSpoken(activity: CarePlanActivity): InterventionStep[] {
  const lines = scriptLines(activity);
  const text =
    lines.length > 0
      ? lines.join(' ')
      : activity.instruction.trim() !== ''
        ? activity.instruction.trim()
        : activity.title;

  return [{ text, pauseMsAfter: 0 }];
}

// -----------------------------------------------------------------------------
// API publica
// -----------------------------------------------------------------------------

/**
 * Devuelve los pasos de la intervencion con sus pausas ya escaladas.
 * Funcion pura: sin reloj, sin red, sin aleatoriedad.
 */
export function planIntervention(
  activity: CarePlanActivity,
  options?: InterventionOptions,
): InterventionStep[] {
  const speedFactor = resolveSpeedFactor(options);

  switch (activity.type) {
    case 'breathing':
      return planBreathing(activity, speedFactor);
    case 'grounding':
      return planGrounding(activity, speedFactor);
    default:
      return planSpoken(activity);
  }
}

/**
 * Duracion estimada de la intervencion en milisegundos: la suma de las pausas.
 * No incluye el tiempo de locucion del TTS, que depende del proveedor.
 */
export function estimateDurationMs(
  activity: CarePlanActivity,
  options?: InterventionOptions,
): number {
  return planIntervention(activity, options).reduce((total, step) => total + step.pauseMsAfter, 0);
}

/**
 * Locuta la actividad respetando el timing.
 *
 * El consumidor recibe el paso, lo manda al TTS, y este generador espera
 * `pauseMsAfter` antes de entregar el siguiente. Si el consumidor abandona el
 * bucle (`break`), el generador se cierra y no queda ningun timer colgado.
 */
export async function* runIntervention(
  activity: CarePlanActivity,
  options?: InterventionOptions,
): AsyncIterable<InterventionStep> {
  const steps = planIntervention(activity, options);

  for (const step of steps) {
    yield step;
    if (step.pauseMsAfter > 0) {
      await sleep(step.pauseMsAfter);
    }
  }
}
