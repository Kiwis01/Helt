/**
 * Redaccion de PII — SEGUNDA capa de defensa.
 *
 * Deepgram ya redacta con su propio modelo (`redact=pci,pii`). Esto corre
 * DESPUES, en el servidor, justo antes de persistir el transcript en el
 * episodio (Contrato 2) o de exponerlo en un snapshot. Asume que la primera
 * capa pudo fallar y no confia en ella.
 *
 * Marcadores (fijos, nunca generados):
 *   [TELEFONO] [EMAIL] [ID] [FECHA] [DIRECCION]
 *
 * ---------------------------------------------------------------------------
 * REGLA CRITICA — NO ROMPER LA SENAL CLINICA
 * ---------------------------------------------------------------------------
 * El transcript ES el demo. Los numeros de biometria y los sintomas NO se
 * tocan jamas:
 *
 *   "mi ritmo esta en 118"        -> intacto
 *   "llevo 3 dias sin dormir"     -> intacto
 *   "me tome 50 miligramos"       -> intacto
 *   "mi hrv bajo a 21"            -> intacto
 *   "del cero al diez, como un 6" -> intacto
 *
 * De ahi el diseno de los patrones: ninguna regla dispara con numeros de 1 a 3
 * digitos sueltos, y las que podrian colisionar con lenguaje natural
 * (direcciones, telefonos dictados con espacios) exigen o bien un separador de
 * puntuacion o bien una palabra-pista explicita.
 *
 * Compromiso consciente y documentado: preferimos un falso NEGATIVO raro (un
 * telefono dictado como "612 345 678", sin ninguna pista de que es un
 * telefono) antes que un falso POSITIVO que convierta "118 122 126" en
 * "[TELEFONO]" y destruya la evidencia clinica del episodio. La primera capa
 * (Deepgram) cubre ese hueco.
 *
 * Puro: sin I/O, sin reloj, sin red. Idempotente: redactText(redactText(x))
 * === redactText(x), porque ningun marcador contiene digitos ni "@".
 */

// -----------------------------------------------------------------------------
// Marcadores
// -----------------------------------------------------------------------------

export type PiiMarker = '[TELEFONO]' | '[EMAIL]' | '[ID]' | '[FECHA]' | '[DIRECCION]';

/** Marcadores de sustitucion. Son parte del contrato con el dashboard. */
export const PII_MARKERS = Object.freeze({
  phone: '[TELEFONO]',
  email: '[EMAIL]',
  id: '[ID]',
  date: '[FECHA]',
  address: '[DIRECCION]',
} as const);

// -----------------------------------------------------------------------------
// Infraestructura de reglas
// -----------------------------------------------------------------------------

interface PiiRule {
  /** ID estable. Se loguea; NUNCA se loguea el texto que disparo la regla. */
  id: string;
  marker: PiiMarker;
  apply(text: string, onHit: () => void): string;
}

/** Regla simple: todo el match se sustituye por el marcador. */
function whole(id: string, marker: PiiMarker, pattern: RegExp): PiiRule {
  return {
    id,
    marker,
    apply(text, onHit) {
      return text.replace(pattern, () => {
        onHit();
        return marker;
      });
    },
  };
}

/**
 * Regla con prefijo: el patron lleva grupos de captura y solo el ULTIMO se
 * sustituye. Sirve para conservar la pista que dio contexto
 * ("mi fecha de nacimiento es [FECHA]") sin perder legibilidad.
 */
function keepPrefix(id: string, marker: PiiMarker, pattern: RegExp): PiiRule {
  return {
    id,
    marker,
    apply(text, onHit) {
      return text.replace(pattern, (...args: unknown[]): string => {
        const match = args[0] as string;
        // args = [match, ...grupos, offset, textoCompleto]  (sin grupos con nombre)
        const groups = args.slice(1, -2) as Array<string | undefined>;
        const captured = groups[groups.length - 1];
        if (typeof captured !== 'string' || captured.length === 0) return match;
        const start = match.lastIndexOf(captured);
        if (start < 0) return match;
        onHit();
        return match.slice(0, start) + marker;
      });
    },
  };
}

/** Normaliza a minusculas sin acentos, para comparar contra listas de palabras. */
function fold(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

// -----------------------------------------------------------------------------
// Guardas de direccion
// -----------------------------------------------------------------------------

/**
 * Palabras funcionales y unidades de tiempo que NUNCA forman parte del nombre
 * de una calle. Sin esta lista, "estoy en la calle y llevo 3 dias sin dormir"
 * se redactaria como "[DIRECCION] dias sin dormir" — exactamente el falso
 * positivo que arruina el transcript del demo.
 */
const ADDRESS_STOPWORDS = new Set(
  [
    'a', 'al', 'ahora', 'aqui', 'alli', 'algo', 'asi', 'aun', 'ayer',
    'casi', 'como', 'con', 'cuando', 'cuanto',
    'de', 'del', 'desde', 'dias', 'dia', 'donde', 'dos',
    'e', 'el', 'ella', 'ellos', 'en', 'era', 'es', 'esa', 'ese', 'esta', 'este',
    'estoy', 'estas', 'estan',
    'hace', 'hacia', 'hasta', 'hora', 'horas', 'hoy',
    'la', 'las', 'le', 'llevo', 'lo', 'los', 'luego',
    'mas', 'me', 'mi', 'mis', 'minutos', 'mucho', 'muy',
    'nada', 'ni', 'no', 'noche', 'nunca',
    'o', 'otra', 'otro',
    'para', 'pero', 'poco', 'por', 'porque', 'puedo',
    'que', 'quien',
    'se', 'segundos', 'semana', 'semanas', 'si', 'sin', 'sobre', 'sola', 'solo', 'soy', 'su', 'sus',
    'tarde', 'te', 'tengo', 'ti', 'todo', 'toda', 'tres', 'tu', 'tus',
    'un', 'una', 'unos', 'unas',
    'ya', 'yo',
    'and', 'for', 'have', 'i', 'in', 'is', 'it', 'me', 'my', 'no', 'not', 'of',
    'on', 'the', 'to', 'was',
  ].map(fold),
);

/**
 * Un nombre de calle plausible: como mucho 3 tokens y ninguno es una palabra
 * funcional. Cero tokens tambien vale ("calle 50", "avenida 300").
 */
function isPlausibleStreetName(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  if (tokens.length > 3) return false;
  return tokens.every((token) => !ADDRESS_STOPWORDS.has(fold(token)));
}

/** Regla de direccion: el patron matchea, pero la guarda decide si se redacta. */
function guardedAddress(id: string, pattern: RegExp): PiiRule {
  return {
    id,
    marker: PII_MARKERS.address,
    apply(text, onHit) {
      return text.replace(pattern, (match: string, nameChunk?: string): string => {
        if (!isPlausibleStreetName(nameChunk)) return match;
        onHit();
        return PII_MARKERS.address;
      });
    },
  };
}

// -----------------------------------------------------------------------------
// Piezas reutilizables de los patrones
// -----------------------------------------------------------------------------

/** Letras aceptadas en nombres propios en espanol. */
const LETTER = "A-Za-z\\u00C0-\\u017F";

/** Formas de fecha que se consideran fecha de nacimiento cuando hay pista. */
const DATE_CORE =
  '\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}' + // 12/03/1990
  '|\\d{4}-\\d{2}-\\d{2}' + // 1990-03-12
  `|\\d{1,2}\\s+de\\s+[${LETTER}]+\\s+(?:de\\s+|del\\s+)?\\d{4}` + // 12 de marzo de 1990
  `|[${LETTER}]+\\s+\\d{1,2},?\\s+\\d{4}` + // March 12, 1990
  '|(?:19|20)\\d{2}'; // "naci en 1990"

// -----------------------------------------------------------------------------
// Las reglas, EN ORDEN. El orden importa: lo mas especifico primero.
// -----------------------------------------------------------------------------

const RULES: readonly PiiRule[] = [
  // 1. Email. Lo primero: es el patron menos ambiguo de todos.
  whole('EMAIL', PII_MARKERS.email, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g),

  // 2. Identificadores nacionales, antes que telefonos y tarjetas.
  //    CURP (MX): 4 letras + 6 digitos + H/M + 5 letras + 2 alfanumericos.
  whole('ID_CURP', PII_MARKERS.id, /\b[A-Za-z]{4}\d{6}[HMhm][A-Za-z]{5}[A-Za-z0-9]{2}\b/g),
  //    DNI/NIE (ES): 8 digitos + letra de control.
  whole('ID_DNI', PII_MARKERS.id, /\b\d{8}[-\s]?[A-Za-z]\b/g),
  //    SSN (US): 123-45-6789.
  whole('ID_SSN', PII_MARKERS.id, /\b\d{3}-\d{2}-\d{4}\b/g),
  //    Identificador con palabra-pista: "poliza 88123-A", "expediente 4471".
  //    Exige al menos un digito en el token, si no "mi expediente medico" se
  //    redactaria entero.
  keepPrefix(
    'ID_KEYWORD',
    PII_MARKERS.id,
    /\b(?:p[oó]liza|afiliaci[oó]n|n[uú]mero de afiliado|expediente|nss|curp|rfc|dni|nie|pasaporte|passport|policy(?: number)?|member(?: id)?|medicaid|medicare)\b(?:\s+(?:es|son|de|del|numero|n[uú]mero|number|is|id)\b)*[:#\s-]{0,3}(\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{5,}\b)/gi,
  ),

  // 3. Tarjeta o cuenta: 13 a 19 digitos, con o sin separadores.
  //    Va antes que telefono para que una tarjeta no se marque como telefono.
  whole('CARD_OR_ACCOUNT', PII_MARKERS.id, /\b(?:\d[ -]?){12,18}\d\b/g),

  // 4. Telefonos ES / MX / US.
  //    4a. Internacional con prefijo "+": no hay ambiguedad posible.
  whole('PHONE_INTL', PII_MARKERS.phone, /\+\d{1,3}[\s.\-]?(?:\(\d{1,4}\)[\s.\-]?)?\d(?:[\s.\-]?\d){6,13}/g),
  //    4b. US con parentesis: (415) 555-0132.
  whole('PHONE_PARENS', PII_MARKERS.phone, /\(\d{2,4}\)\s*\d{3}[\s.\-]?\d{2,4}/g),
  //    4c. Grupos separados por PUNTUACION (nunca por espacios): 415-555-0132,
  //        55-1234-5678, 612.345.678. La puntuacion es la senal de "esto es un
  //        numero de telefono, no tres cifras clinicas seguidas".
  whole('PHONE_PUNCTUATED', PII_MARKERS.phone, /\b\d{2,4}[.\-]\d{3,4}[.\-]\d{3,4}\b/g),
  //    4d. Bloque contiguo de 9 a 12 digitos: 612345678, 5512345678.
  //        Ningun valor clinico del demo tiene 9 digitos.
  whole('PHONE_PLAIN', PII_MARKERS.phone, /\b\d{9,12}\b/g),
  //    4e. Dictado con espacios SOLO si hay palabra-pista delante.
  keepPrefix(
    'PHONE_CUED',
    PII_MARKERS.phone,
    /(?:tel[eé]fono|celular|m[oó]vil|movil|whatsapp|marca(?:me)? al|ll[aá]ma(?:me|la|lo)? al|mi n[uú]mero(?: es)?|phone(?: number)?|call me at|reach me at)\b[^\d\n]{0,15}((?:\d[\s.\-]?){8,14}\d)/gi,
  ),

  // 5. Fechas.
  //    5a. Fecha de nacimiento explicita (con pista). Se conserva la pista.
  keepPrefix(
    'DATE_BIRTH',
    PII_MARKERS.date,
    new RegExp(
      `(?:fecha de nacimiento|nacimiento|nac[ií](?:o|ó|do|da)?|nacid[oa]|date of birth|born on|born|dob)\\b[^\\d\\n]{0,20}(${DATE_CORE})`,
      'gi',
    ),
  ),
  //    5b. Fecha numerica completa con ano de 4 digitos. No es senal clinica en
  //        ningun caso: la biometria no viene en formato d/m/aaaa.
  whole('DATE_NUMERIC', PII_MARKERS.date, /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-](?:19|20)\d{2}\b/g),

  // 6. Direcciones. Ultimas, y con guarda de palabras funcionales.
  guardedAddress(
    'ADDRESS_ES',
    new RegExp(
      `\\b(?:calle|avenida|avda|av|carrera|carretera|boulevard|blvd|paseo|plaza|colonia|col|fraccionamiento|privada|andador|camino)\\.?\\s+((?:[${LETTER}0-9'’-]+\\s+){0,3})(?:n[uú]m(?:ero)?\\.?\\s*|no\\.?\\s*|#\\s*)?(\\d{1,5})\\b`,
      'gi',
    ),
  ),
  guardedAddress(
    'ADDRESS_US',
    new RegExp(
      `\\b\\d{1,5}\\s+((?:[${LETTER}0-9'’.-]+\\s+){0,3})(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln)\\b\\.?`,
      'gi',
    ),
  ),
];

// -----------------------------------------------------------------------------
// API publica
// -----------------------------------------------------------------------------

/** Una regla que disparo. NUNCA lleva el texto original: eso seria la fuga. */
export interface RedactionHit {
  ruleId: string;
  marker: PiiMarker;
  count: number;
}

export interface RedactionReport {
  text: string;
  hits: RedactionHit[];
}

/**
 * Redacta y ademas informa QUE reglas dispararon y cuantas veces.
 * El informe es seguro de loguear: solo lleva IDs y conteos.
 */
export function redactWithReport(text: string): RedactionReport {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', hits: [] };
  }

  let out = text;
  const hits: RedactionHit[] = [];

  for (const rule of RULES) {
    let count = 0;
    out = rule.apply(out, () => {
      count += 1;
    });
    if (count > 0) hits.push({ ruleId: rule.id, marker: rule.marker, count });
  }

  return { text: out, hits };
}

/**
 * Sustituye la PII de `text` por marcadores fijos.
 * Puro e idempotente. Nunca lanza.
 */
export function redactText(text: string): string {
  return redactWithReport(text).text;
}

/**
 * Redacta el texto de cada turno. Conserva `speaker` y `at` intactos y NO muta
 * el array de entrada: el transcript vivo de la sesion se queda como esta
 * (el agente necesita el original para conversar), lo redactado es la copia que
 * sale del proceso.
 */
export function redactTurns<T extends { speaker: 'patient' | 'agent'; at: string; text: string }>(
  turns: readonly T[],
): T[] {
  if (!Array.isArray(turns)) return [];
  return turns.map((turn) => ({ ...turn, text: redactText(turn.text) }));
}
