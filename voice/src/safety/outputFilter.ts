/**
 * Post-filtro determinista sobre la salida del LLM.
 *
 * Riesgo #4 de la tabla del brief: "El LLM dice algo que suena a diagnostico".
 * La mitigacion NO es una instruccion mas en el prompt del sistema — un prompt
 * es una peticion, esto es un `if`. El texto pasa por aqui ANTES de llegar al
 * TTS, y si matchea se sustituye por una frase segura pre-escrita.
 *
 * Es la contraparte del motor de red-flags: aquel vigila lo que entra, este
 * vigila lo que sale. Los dos son deterministas y ninguno de los dos consulta a
 * un modelo para decidir.
 *
 * -----------------------------------------------------------------------------
 * ASIMETRIA INVERSA A LA DEL MOTOR DE RED-FLAGS
 * -----------------------------------------------------------------------------
 * Aqui un falso positivo SI cuesta: cada bloqueo indebido sustituye una frase
 * util del agente por una generica y el demo se siente robotico. Por eso los
 * patrones de este archivo son ESTRECHOS y varios exigen dos señales, mientras
 * que los del motor de entrada son deliberadamente anchos. Las direcciones del
 * riesgo son distintas, y las heuristicas tambien.
 *
 * El caso que lo demuestra: la guia de respiracion del care plan dice "toma
 * aire". Un patron ingenuo de "recomendacion de medicacion" ("toma...") mataria
 * la intervencion central del producto. Por eso la deteccion de medicacion exige
 * verbo de recomendacion Y vocabulario farmacologico en la misma frase.
 */

import { SAFE_REPLACEMENT_LINE } from './scripts.js';
import { normalize } from './rules.js';

/** Resultado del filtro. `text` es el que se manda al TTS. */
export interface OutputFilterResult {
  /** false = el modelo dijo algo que no puede salir por el altavoz. */
  safe: boolean;
  /** Si `safe`, el texto ORIGINAL sin tocar. Si no, la frase segura. */
  text: string;
  /** Fragmento normalizado que disparo el bloqueo. Va al log y al episodio. */
  matchedPhrase: string | null;
}

/** Una regla del filtro: por que se bloquea y con que patron se detecta. */
interface ForbiddenPattern {
  /** Etiqueta para el log. */
  reason: string;
  pattern: RegExp;
}

/**
 * Frases prohibidas.
 *
 * Cuatro familias, todas con el mismo denominador: el agente cruzando de
 * "contextualizo" a "dictamino".
 *
 *   1. DIAGNOSTICO      — nombrar lo que le pasa al paciente
 *   2. MINIMIZACION     — descartar la posibilidad de que sea grave
 *   3. FALSA CERTEZA    — prometer que esta bien
 *   4. MEDICACION       — recomendar, ajustar o suspender un farmaco
 *
 * La familia 2 es la mas peligrosa de las cuatro y la mas facil de decir: es
 * exactamente la inversion logica que el brief prohibe. "No es nada grave" es
 * una frase que solo puede decir alguien que ha explorado al paciente.
 *
 * Los patrones se aplican sobre el texto NORMALIZADO (minusculas, sin acentos,
 * puntuacion convertida en `|`), asi que se escriben sin acentos y los huecos
 * `[^|]{0,N}` no cruzan de una frase a otra.
 */
const FORBIDDEN: readonly ForbiddenPattern[] = [
  // --- 1. Diagnostico --------------------------------------------------------
  {
    reason: 'diagnostico: nombra un ataque de panico/ansiedad',
    pattern: /\b(estas|estas teniendo|tienes|es|esto es|eso es|fue|seria)\b[^|]{0,25}\bataque de (panico|ansiedad|nervios)\b/,
  },
  {
    reason: 'diagnostico: "es un ataque de ..."',
    pattern: /\bes un ataque de\b/,
  },
  {
    reason: 'diagnostico: atribuye los sintomas a ansiedad',
    pattern: /\b(esto|eso|lo que (tienes|sientes|te pasa))\b[^|]{0,20}\b(es|son)\b[^|]{0,15}\b(ansiedad|estres|nervios|panico)\b/,
  },
  {
    reason: 'diagnostico: minimiza a "solo ansiedad"',
    pattern: /\b(solo|solamente|nada mas|puro|pura|simplemente)\b[^|]{0,15}\b(ansiedad|estres|nervios|panico)\b/,
  },
  {
    reason: 'diagnostico: el agente se atribuye un diagnostico',
    pattern: /\b(te diagnostico|mi diagnostico|el diagnostico es|te puedo diagnosticar)\b/,
  },
  {
    reason: 'diagnostico: descarta una causa cardiaca',
    pattern: /\bno\b[^|]{0,15}\b(es|tiene nada que ver con)\b[^|]{0,15}\b(el corazon|cardiaco|un infarto|infarto)\b/,
  },

  // --- 2. Minimizacion -------------------------------------------------------
  {
    reason: 'minimizacion: "no es nada grave"',
    pattern: /\bno es nada (grave|serio|malo|preocupante)\b/,
  },
  {
    // Este patron SI cruza la frontera de oracion (`.` en vez de `[^|]`): las
    // dos mitades son una sola formula retorica partida por una coma
    // ("No te preocupes, no es nada"). Es la excepcion, no la norma.
    reason: 'minimizacion: "no te preocupes ... no es nada"',
    pattern: /\bno te preocupes\b.{0,25}\bno (es nada|tienes nada|pasa nada)\b/,
  },
  {
    reason: 'minimizacion: "no tienes nada"',
    pattern: /\bno tienes nada\b/,
  },
  {
    reason: 'minimizacion: "no es peligroso"',
    pattern: /\bno (es|resulta) (peligroso|grave|riesgoso)\b/,
  },
  {
    reason: 'minimizacion (EN): nothing serious / nothing to worry about',
    pattern: /\b(nothing (serious|to worry about)|its nothing|not (serious|dangerous))\b/,
  },

  // --- 3. Falsa certeza ------------------------------------------------------
  {
    // Misma excepcion que arriba: "Estás bien, no pasa nada" lleva coma en medio.
    reason: 'falsa certeza: "estas bien, no pasa nada"',
    pattern: /\bestas (bien|perfectamente|sano)\b.{0,20}\bno (pasa nada|te va a pasar nada|es nada)\b/,
  },
  {
    reason: 'falsa certeza: promete que no va a pasar nada',
    pattern: /\b(no te va a pasar nada|nada te va a pasar|te lo aseguro que estas bien|estas fuera de peligro)\b/,
  },
  {
    reason: 'falsa certeza (EN): youre fine / youre okay, nothing is wrong',
    pattern: /\byoure (fine|okay|ok)\b[^|]{0,20}\bnothing\b/,
  },
  {
    reason: 'falsa certeza (EN): panic attack / just anxiety',
    pattern: /\b(youre having a panic attack|this is a panic attack|its just anxiety|its only stress)\b/,
  },

  // --- 4. Medicacion ---------------------------------------------------------
  // Dos señales obligatorias (verbo de recomendacion + vocabulario farmacologico)
  // para no bloquear "toma aire", "toma un respiro" ni "toma tu tiempo", que son
  // literalmente el guion de la respiracion de caja del care plan.
  {
    reason: 'medicacion: recomienda, sube o suspende un farmaco',
    pattern:
      /\b(toma|tomate|tomar|deberias|debes|tienes que|te recomiendo|te sugiero|sube|aumenta|baja|reduce|duplica|deja de tomar|suspende)\b[^|]{0,30}\b(pastilla|pastillas|comprimido|tableta|capsula|dosis|miligramos|mg|ansiolitico|ansioliticos|benzodiacepina|clonazepam|alprazolam|lorazepam|diazepam|xanax|rivotril|sertralina|sertraline|antidepresivo|medicamento|medicina|farmaco|suplemento|melatonina|valeriana)\b/,
  },
  {
    reason: 'medicacion: "deberias tomar ..." (algo que no es aire ni agua)',
    pattern:
      /\b(deberias|debes|tienes que|podrias) tomar(te)?\b(?!\s+(aire|agua|un respiro|una pausa|un momento|asiento|tu tiempo|aliento|un descanso)\b)/,
  },
  {
    reason: 'medicacion (EN): you should take / increase your dose',
    pattern:
      /\b(you should take|take (an|another|an extra|one more)|increase your dose|double your dose|stop taking)\b(?!\s+(a )?(breath|deep breath|break|moment|seat|your time)\b)/,
  },
];

/**
 * Filtra la salida del LLM antes de mandarla al TTS.
 *
 * Determinista y pura: mismo texto de entrada, mismo veredicto siempre.
 * Pensada para llamarse POR FRASE (el TTS locuta por frases para bajar la
 * latencia), asi que no guarda estado entre invocaciones.
 *
 * Si es segura devuelve el texto ORIGINAL intacto — con sus acentos, que el TTS
 * necesita para la prosodia. Solo se sustituye cuando algo matchea.
 */
export function filterAgentOutput(text: string): OutputFilterResult {
  const original = typeof text === 'string' ? text : '';
  if (original.trim().length === 0) {
    return { safe: true, text: original, matchedPhrase: null };
  }

  const normalized = normalize(original);

  for (const { pattern } of FORBIDDEN) {
    const found = pattern.exec(normalized);
    if (found !== null && found[0].length > 0) {
      return {
        safe: false,
        text: SAFE_REPLACEMENT_LINE,
        matchedPhrase: found[0],
      };
    }
  }

  return { safe: true, text: original, matchedPhrase: null };
}

/**
 * Igual que `filterAgentOutput` pero devuelve tambien el motivo legible.
 * La usa el log del servidor y el evento SSE; el orquestador se queda con la
 * version corta, que es la que congela el contrato.
 */
export function inspectAgentOutput(
  text: string,
): OutputFilterResult & { reason: string | null } {
  const original = typeof text === 'string' ? text : '';
  if (original.trim().length === 0) {
    return { safe: true, text: original, matchedPhrase: null, reason: null };
  }

  const normalized = normalize(original);

  for (const { pattern, reason } of FORBIDDEN) {
    const found = pattern.exec(normalized);
    if (found !== null && found[0].length > 0) {
      return { safe: false, text: SAFE_REPLACEMENT_LINE, matchedPhrase: found[0], reason };
    }
  }

  return { safe: true, text: original, matchedPhrase: null, reason: null };
}

/** Cuantas familias de frase prohibida hay activas. Para el log de arranque. */
export const FORBIDDEN_PATTERN_COUNT = FORBIDDEN.length;

// -----------------------------------------------------------------------------
// Frases prohibidas que se parten entre dos fragmentos de TTS
// -----------------------------------------------------------------------------

/**
 * Cuanto texto ya locutado se arrastra como contexto del siguiente fragmento.
 *
 * 120 caracteres = el `maxChars` del troceador, o sea el fragmento anterior
 * completo en el peor caso. Mas no hace falta: ningun patron de `FORBIDDEN`
 * abarca mas de una frase.
 */
export const CHUNK_CONTEXT_CHARS = 120;

/**
 * =============================================================================
 *  EL AGUJERO QUE ESTA FUNCION TAPA
 * =============================================================================
 * El TTS locuta POR FRASES para bajar la latencia, asi que el filtro se aplica
 * fragmento a fragmento. Cuando el modelo escribe una frase larga sin punto,
 * `splitIntoSpeakableChunks` corta por la coma mas cercana a 120 caracteres — y
 * las DOS unicas familias de patrones que cruzan coma a proposito
 * ("no te preocupes, no es nada", "estás bien, no pasa nada") son justo las que
 * ese corte puede partir en dos mitades inocentes:
 *
 *   trozo 1: "...con los números que estoy viendo, no te preocupes,"   -> pasa
 *   trozo 2: "no es nada."                                             -> pasa
 *
 * Cada mitad es inofensiva por separado; juntas son exactamente la minimizacion
 * que el brief prohibe, y salian enteras por el altavoz. Verificado contra el
 * troceador real con deltas palabra a palabra, que es como llega Bedrock.
 *
 * La solucion es mirar el fragmento CON la cola de lo ya locutado delante. Si la
 * frase prohibida solo aparece al juntarlos, se bloquea el fragmento actual: la
 * primera mitad ya sono y no se puede retirar, pero la peligrosa es siempre la
 * segunda ("no es nada", "no pasa nada"), y esa no llega a sonar.
 *
 * `previousText` es texto YA filtrado, asi que nunca puede ser el causante del
 * match por si solo.
 */
export function inspectAgentChunk(
  chunk: string,
  previousText = '',
): OutputFilterResult & { reason: string | null; straddled: boolean } {
  const alone = inspectAgentOutput(chunk);
  if (!alone.safe) return { ...alone, straddled: false };

  const tail = typeof previousText === 'string' ? previousText.slice(-CHUNK_CONTEXT_CHARS) : '';
  if (tail.trim() === '' || chunk.trim() === '') return { ...alone, straddled: false };

  const joined = inspectAgentOutput(`${tail} ${chunk}`);
  if (joined.safe) return { ...alone, straddled: false };

  // La frase prohibida solo existe a caballo entre los dos fragmentos.
  return {
    safe: false,
    text: SAFE_REPLACEMENT_LINE,
    matchedPhrase: joined.matchedPhrase,
    reason: joined.reason,
    straddled: true,
  };
}
