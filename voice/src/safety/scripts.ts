/**
 * Guiones de escalacion — HARDCODEADOS.
 *
 * =============================================================================
 *  REGLA IRRENUNCIABLE: nada de este archivo lo genera un LLM. Nunca.
 * =============================================================================
 *
 * Cuando el motor de red-flags dispara, loop-voice locuta LITERALMENTE una de
 * estas constantes. El modelo no ve ese turno, no lo reformula y no lo suaviza.
 * Motivo: un guion de emergencia generado es un guion que puede salir mal una de
 * cada mil veces, y una de cada mil veces es demasiado cuando el numero que hay
 * que marcar es el 911.
 *
 * Estan escritos para ser LOCUTADOS, no leidos:
 *   - frases cortas, una idea por frase (el TTS respira mejor y se entiende)
 *   - numeros deletreados donde la lectura automatica suele fallar
 *     ("veinticuatro horas" en vez de "24/7", "nueve ocho ocho" tras el digito)
 *   - acentos correctos: Aura-2 y Polly los usan para la prosodia. Aqui SI se
 *     acentua, aunque los comentarios del repo vayan sin acentos.
 *
 * Texto base: seccion 5 del brief `plandevs/02-LEWIS-voice-safety.md`, adaptado
 * a voz natural sin cambiar ninguna de las instrucciones accionables.
 */

import type { EscalationAction } from '../types.js';

// -----------------------------------------------------------------------------
// Apertura de llamada
// -----------------------------------------------------------------------------

/**
 * Disclosure de apertura. Se locuta al inicio de CADA llamada, antes de
 * cualquier turno del paciente y antes de cualquier llamada al LLM.
 *
 * Requisito del DoD del brief: "Disclosure de 'no sustituye atencion de
 * emergencia' al inicio".
 */
export const OPENING_DISCLOSURE =
  'Antes de empezar, algo que necesito decirte: soy un acompañante, ' +
  'no soy un sustituto de atención de emergencia. ' +
  'Si en cualquier momento esto se siente como una emergencia médica, ' +
  'cuelga y llama al nueve uno uno. ' +
  'Dicho eso, aquí estoy. Cuéntame qué está pasando.';

// -----------------------------------------------------------------------------
// Guiones de escalacion
// -----------------------------------------------------------------------------

/**
 * 911 — reglas RF-01 a RF-06, RF-08 y RF-09.
 *
 * Estructura deliberada:
 *   1. cortar (el paciente tiene que dejar de hablar conmigo)
 *   2. la instruccion accionable, primero y sin adornos
 *   3. el disclosure otra vez (el brief lo pide dentro del guion)
 *   4. una salida practica por si no puede marcar solo
 */
export const SCRIPT_911 =
  'Voy a parar aquí un momento. ' +
  'Lo que me estás describiendo necesita atención médica inmediata. ' +
  'Por favor cuelga y llama al nueve uno uno ahora. ' +
  'No soy un sustituto de atención de emergencia. ' +
  'Si hay alguien contigo, pídele que llame por ti y que se quede a tu lado. ' +
  'Voy a dejar registrado esto para tu equipo de cuidado.';

/**
 * 988 — regla RF-07 (ideacion suicida o autolesion) y SOLO esa.
 *
 * Nunca se manda a alguien en crisis suicida al 911: la linea 988 tiene gente
 * entrenada para esto. Por eso RF-07 es la unica regla con accion distinta.
 *
 * El guion no interroga, no evalua riesgo y no pide detalles: reconoce, da el
 * numero, y ofrece compañia mientras marca.
 */
export const SCRIPT_988 =
  'Gracias por decírmelo. Me alegra que me lo hayas dicho. ' +
  'Quiero conectarte con una persona ahora mismo. ' +
  'La línea nueve ocho ocho tiene gente disponible las veinticuatro horas, ' +
  'todos los días, y están justo para esto. ' +
  'Marca nueve ocho ocho desde tu teléfono. ' +
  '¿Te quedas conmigo mientras marcas?';

/**
 * Conectar con un humano del equipo de cuidado.
 *
 * Ninguna de las 9 reglas usa hoy esta accion: existe porque el contrato
 * (`EscalationAction`) la define y porque el orquestador la necesita para las
 * escalaciones NO deterministas (el paciente pide hablar con alguien, la
 * intervencion no da alivio despues de dos intentos, etc.). Se deja aqui para
 * que ese camino tampoco pase nunca por el LLM.
 */
export const SCRIPT_CONNECT_HUMAN =
  'Esto necesita una persona, no me necesita a mí. ' +
  'Voy a avisar a tu equipo de cuidado ahora mismo para que te contacten. ' +
  'Me quedo contigo hasta que alguien te responda. ' +
  'Y si mientras tanto sientes que esto es una emergencia, ' +
  'cuelga y llama al nueve uno uno.';

/** Guion por accion. Lo usa el motor para resolver `RedFlagResult.script`. */
export const ESCALATION_SCRIPTS: Readonly<Record<EscalationAction, string>> = Object.freeze({
  'advise-911': SCRIPT_911,
  'advise-988': SCRIPT_988,
  'connect-human': SCRIPT_CONNECT_HUMAN,
});

/** Devuelve el guion hardcodeado de una accion. Nunca devuelve vacio. */
export function scriptForAction(action: EscalationAction): string {
  return ESCALATION_SCRIPTS[action];
}

// -----------------------------------------------------------------------------
// Post-filtro de la salida del LLM
// -----------------------------------------------------------------------------

/**
 * Frase de reemplazo cuando `filterAgentOutput` detecta que el modelo dijo algo
 * que suena a diagnostico, a minimizacion o a recomendacion de medicacion.
 *
 * Riesgo #4 de la tabla del brief. La frase reafirma la postura del producto
 * ("contextualizo, no diagnostico") sin dejar al paciente colgado y sin
 * descartar nada: el guion vuelve al plan escrito por su clinico.
 */
export const SAFE_REPLACEMENT_LINE =
  'No me toca a mí decirte qué es lo que está pasando en tu cuerpo, eso es de tu clínico. ' +
  'Lo que sí puedo hacer es decirte qué están mostrando tus datos ahora mismo ' +
  'y acompañarte con el plan que escribió tu doctora. ' +
  'Y si en algún momento esto se siente como una emergencia, cuelga y llama al nueve uno uno.';

/**
 * Frase honesta para cuando loop-coverage (:3003) no responde.
 * Vive aqui porque es la misma familia: texto fijo que NUNCA pasa por el LLM.
 * Regla del brief: nunca inventar un copago.
 */
export const COVERAGE_UNAVAILABLE_LINE =
  'No pude verificar tu cobertura ahora mismo. ' +
  'Tu equipo de cuidado puede confirmártelo, y lo dejo anotado para que lo revisen.';
