/**
 * Troceo de la salida del LLM en fragmentos hablables.
 *
 * ES LA PALANCA PRINCIPAL DE LATENCIA DEL BRIEF (<800ms de fin-de-habla a
 * inicio-de-respuesta). Bedrock tarda 1.5-3s en cerrar una respuesta completa,
 * pero el primer delta llega en ~250ms. Si esperamos la respuesta entera para
 * sintetizar, el paciente escucha silencio durante segundos. Troceando por
 * frases empezamos a hablar en cuanto la PRIMERA frase esta cerrada, y las
 * siguientes se sintetizan mientras la primera todavia suena.
 *
 * Todo lo de este archivo es puro y sincronico salvo el generador, que solo
 * consume el stream de deltas. Sin I/O, sin reloj, sin aleatoriedad.
 */

/** Cierre de frase duro: aqui se corta siempre. */
const TERMINATORS = new Set(['.', '?', '!', '\n']);

/** Cierre blando: solo se usa cuando la frase ya paso `maxChars`. */
const SOFT_BREAKS = new Set([',', ';', ':', '—' /* raya */]);

/** Se arrastran junto al terminador para no dejarlos huerfanos: `dijo "hola."` */
const CLOSERS = new Set(['"', "'", ')', ']', '»', '”', '’']);

/** Un fragmento sin letras ni digitos no se locuta: no vale la pena un TTS. */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * Abreviaturas que terminan en punto sin cerrar frase. Sin acentos y en
 * minusculas; la comparacion normaliza. "Dr." aparece de verdad en el demo
 * porque el care plan lo firma "Dr. Maya Chen".
 */
const ABBREVIATIONS = new Set([
  'dr',
  'dra',
  'sr',
  'sra',
  'srta',
  'lic',
  'ing',
  'aprox',
  'etc',
  'ej',
  'p',
  'vs',
  'mr',
  'mrs',
  'ms',
  'st',
]);

export interface SplitOptions {
  /** A partir de aqui una coma ya sirve como corte. Default 120. */
  maxChars?: number;
  /** Corte de emergencia por palabra cuando no hay ni un signo. Default 2x maxChars. */
  hardMaxChars?: number;
}

const DEFAULT_MAX_CHARS = 120;

/** True si el punto en `i` separa decimales ("118.5"), no frases. */
function isDecimalPoint(buffer: string, i: number): boolean {
  const before = buffer[i - 1];
  const after = buffer[i + 1];
  if (before === undefined || !/\d/.test(before)) return false;
  // Si el punto es el ultimo caracter todavia no sabemos si viene un digito.
  // Se prefiere esperar al siguiente delta antes que partir "118" de ".5".
  if (after === undefined) return true;
  return /\d/.test(after);
}

/** True si el punto en `i` cierra una abreviatura ("Dr.", "aprox."). */
function isAbbreviationDot(buffer: string, i: number): boolean {
  let start = i;
  while (start > 0 && /[\p{L}]/u.test(buffer[start - 1] as string)) start--;
  if (start === i) return false;
  const word = buffer.slice(start, i).toLowerCase();
  return ABBREVIATIONS.has(word);
}

/**
 * Busca donde termina el siguiente fragmento hablable dentro de `buffer`.
 *
 * Devuelve el indice EXCLUSIVO de fin, o -1 si todavia no hay corte y hay que
 * esperar mas deltas. Funcion pura: se testea sola.
 *
 * Prioridad de corte:
 *   1. terminador de frase (`.` `?` `!` `\n`), arrastrando la corrida ("?!", "...")
 *      y los cierres de comillas/parentesis.
 *   2. si ya se paso `maxChars`: la coma/punto y coma mas cercana a `maxChars`.
 *   3. si ya se paso `hardMaxChars` sin ningun signo: el ultimo espacio.
 */
export function findChunkEnd(
  buffer: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  hardMaxChars: number = maxChars * 2,
): number {
  // --- 1. terminador de frase -------------------------------------------------
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i] as string;
    if (!TERMINATORS.has(ch)) continue;
    if (ch === '.' && (isDecimalPoint(buffer, i) || isAbbreviationDot(buffer, i))) continue;

    let end = i + 1;
    while (end < buffer.length && TERMINATORS.has(buffer[end] as string)) end++;
    while (end < buffer.length && CLOSERS.has(buffer[end] as string)) end++;
    return end;
  }

  // --- 2. corte blando por longitud ------------------------------------------
  if (buffer.length > maxChars) {
    let best = -1;
    for (let i = 0; i < buffer.length; i++) {
      if (!SOFT_BREAKS.has(buffer[i] as string)) continue;
      if (i <= maxChars) {
        best = i; // el ultimo que cabe antes del limite
      } else if (best === -1) {
        best = i; // ninguno cabia: el primero que aparezca despues
        break;
      } else {
        break;
      }
    }
    if (best >= 0) return best + 1;
  }

  // --- 3. corte de emergencia por palabra ------------------------------------
  if (buffer.length >= hardMaxChars) {
    const space = buffer.lastIndexOf(' ', hardMaxChars);
    return space > 0 ? space + 1 : hardMaxChars;
  }

  return -1;
}

/**
 * Colapsa espacios y saltos: el TTS no gana nada con espacios dobles y el
 * transcript se lee mejor.
 */
function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Consume los deltas del LLM y va emitiendo fragmentos hablables en cuanto
 * estan cerrados. El residuo final siempre se emite (flush), asi que ninguna
 * palabra del modelo se pierde aunque la respuesta acabe sin puntuacion.
 *
 * Uso tipico en el orquestador:
 *
 *   for await (const chunk of splitIntoSpeakableChunks(llm.streamReply(req))) {
 *     const audio = await synthesize(chunk);   // el TTS arranca ya
 *     playbackQueue.push(audio);
 *   }
 */
export async function* splitIntoSpeakableChunks(
  deltaStream: AsyncIterable<string>,
  opts: SplitOptions = {},
): AsyncIterable<string> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const hardMaxChars = opts.hardMaxChars ?? maxChars * 2;

  let buffer = '';
  /** Trozos sin contenido locutable (p.ej. ".." de una elipsis partida entre
   *  deltas) que se arrastran para pegarse al siguiente fragmento real. */
  let carry = '';

  for await (const delta of deltaStream) {
    if (!delta) continue;
    buffer += delta;

    for (;;) {
      const end = findChunkEnd(buffer, maxChars, hardMaxChars);
      if (end <= 0) break;

      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end);

      const candidate = carry + raw;
      if (!HAS_CONTENT.test(candidate)) {
        // Nada que locutar: se arrastra al siguiente fragmento.
        carry = candidate;
        continue;
      }
      carry = '';
      const chunk = tidy(candidate);
      if (chunk) yield chunk;
    }
  }

  const tail = tidy(carry + buffer);
  if (tail && HAS_CONTENT.test(tail)) yield tail;
}
