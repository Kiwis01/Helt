/**
 * `voice/src/safety/` — la capa de seguridad de loop-voice.
 *
 * Superficie publica CONGELADA (otros modulos dependen de ella literalmente):
 *
 *   evaluate(input: RedFlagInput): RedFlagResult
 *   filterAgentOutput(text: string): { safe, text, matchedPhrase }
 *
 * Todo lo de aqui dentro es determinista y puro. Ni una llamada de red, ni un
 * `Date.now()`, ni una lectura de `process.env`. Es el unico modulo del
 * servicio que funciona igual con todas las credenciales caidas.
 *
 * Regla que no se toca: `evaluate` corre ANTES del LLM en cada turno del
 * paciente, y `filterAgentOutput` corre DESPUES del LLM sobre cada frase antes
 * de mandarla al TTS.
 */

// --- API principal -----------------------------------------------------------

export { evaluate } from './redFlagEngine.js';
export {
  filterAgentOutput,
  inspectAgentOutput,
  inspectAgentChunk,
  CHUNK_CONTEXT_CHARS,
  FORBIDDEN_PATTERN_COUNT,
} from './outputFilter.js';
export type { OutputFilterResult } from './outputFilter.js';

// --- Reglas (para el CLI, el log de arranque y el dashboard) ------------------

export {
  RED_FLAG_RULES,
  RULES_IN_EVALUATION_ORDER,
  findRule,
  evaluateRule,
  checkEnvelope,
  normalize,
  isNegated,
} from './rules.js';
export type { RedFlagRuleDef } from './rules.js';

// --- Guiones hardcodeados ----------------------------------------------------

export {
  OPENING_DISCLOSURE,
  SCRIPT_911,
  SCRIPT_988,
  SCRIPT_CONNECT_HUMAN,
  ESCALATION_SCRIPTS,
  scriptForAction,
  SAFE_REPLACEMENT_LINE,
  COVERAGE_UNAVAILABLE_LINE,
} from './scripts.js';

// --- Tipos del contrato interno ----------------------------------------------

export type { RedFlagInput, RedFlagResult, RedFlagRule } from '../types.js';
