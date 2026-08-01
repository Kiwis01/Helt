/**
 * =============================================================================
 *  Las 9 reglas de red-flag. LA PIEZA MAS IMPORTANTE DEL REPO.
 * =============================================================================
 *
 * Todo lo de este archivo es DETERMINISTA y PURO:
 *   - sin I/O, sin red, sin `process.env`, sin `Date`, sin aleatoriedad
 *   - sin estado entre llamadas (ni siquiera `lastIndex` de un regex global)
 *   - la misma entrada da SIEMPRE exactamente la misma salida
 *
 * Corre ANTES del LLM, en cada turno del paciente. Si dispara, el modelo nunca
 * ve ese turno.
 *
 * -----------------------------------------------------------------------------
 * CRITERIO CLINICO — las tres decisiones que hay que poder defender
 * -----------------------------------------------------------------------------
 *
 * 1. ASIMETRIA. En un contexto de emergencia, un falso positivo cuesta una
 *    llamada interrumpida y una disculpa. Un falso negativo cuesta un infarto no
 *    atendido. Por eso el motor PREFIERE el falso positivo, salvo negacion
 *    explicita del paciente.
 *
 *    Corolario: el modo hipotetico y las preguntas NO desactivan la regla.
 *    "¿qué pasa si me duele el pecho y se me va al brazo?" DISPARA RF-01.
 *    Distinguir de forma fiable una hipotesis de un sintoma real requiere
 *    entender la frase, y entender la frase es justo lo que este motor se niega
 *    a delegar en un modelo. Un STT con ruido de hackathon convierte cualquier
 *    heuristica de hipoteticos en un generador de falsos negativos. Se asume el
 *    coste: alguien que pregunta en abstracto oye el guion del 911 y sigue vivo.
 *
 *    Lo mismo con la tercera persona ("a mi papá le dolió el pecho"): tampoco se
 *    detecta, y tambien dispara. Limitacion conocida y aceptada a proposito.
 *
 * 2. NEGACION. La UNICA forma de desactivar una regla de texto es que el
 *    paciente niegue el sintoma explicitamente ("no me duele el pecho", "sin
 *    dolor de pecho", "nunca me he desmayado", "I don't have chest pain").
 *    Se implementa con una ventana corta hacia atras (5 tokens) que ademas se
 *    corta en la frontera de la oracion: sin ese corte, "ya no quiero seguir
 *    viviendo, quiero matarme" quedaria anulado por el "no" de la frase
 *    anterior. Ese seria el peor falso negativo imaginable del sistema.
 *
 *    La negacion se comprueba solo sobre la señal PRINCIPAL de cada regla. Los
 *    modificadores (irradiacion, lateralidad) no se comprueban: en "no siento el
 *    brazo izquierdo" el "no" pertenece al sintoma, no lo niega.
 *
 * 3. LA INVERSION LOGICA DEL BRIEF. Biometria dentro del envelope NUNCA descarta
 *    una regla de texto. No existe ninguna via en este archivo por la que unos
 *    datos normales, un historial limpio o un diagnostico previo de ansiedad
 *    apaguen una red-flag. Descartar es trabajo de un humano.
 */

import type {
  CurrentBiometrics,
  RedFlagInput,
  RedFlagRule,
  SafetyEnvelope,
} from '../types.js';
import { scriptForAction } from './scripts.js';

// =============================================================================
// 1. Normalizacion del texto
// =============================================================================

/**
 * Marca de frontera de oracion. La puntuacion se convierte en este simbolo en
 * vez de desaparecer, por dos motivos:
 *   - la ventana de negacion se corta aqui (ver `isNegated`)
 *   - los patrones con hueco (`[^|]{0,20}`) no pueden cruzar de una frase a otra,
 *     asi que "me duele la espalda. el pecho está bien" no se lee como un solo
 *     sintoma
 */
const CLAUSE_MARK = '|';

/**
 * Normaliza el texto del turno antes de matchear.
 *
 *   minusculas · sin acentos (NFD + strip de diacriticos) · sin apostrofos
 *   ("don't" -> "dont") · puntuacion -> frontera de oracion · el resto de
 *   simbolos -> espacio · espacios colapsados
 *
 * Los patrones de este archivo se escriben ya normalizados (sin acentos y en
 * minusculas): "mandibula", no "mandíbula". Eso hace el matching inmune a que el
 * STT acentue o no, que es exactamente lo que pasa con `nova-3 language=multi`.
 *
 * Pura. La misma cadena entra, la misma cadena sale.
 */
export function normalize(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  return (
    raw
      // 1. quita diacriticos: "está" -> "esta", "mandíbula" -> "mandibula".
      //    NFD separa la letra de la tilde y el rango ̀-ͯ borra la tilde.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      // 2. apostrofos fuera, SIN dejar espacio: "don't" -> "dont", "can't" -> "cant"
      .replace(/[\u0027\u2018\u2019\u02bc\u00b4\u0060]/g, '')
      // 3. puntuacion y saltos de linea -> frontera de oracion
      .replace(/[.,;:!?\u00a1\u00bf\u2026\r\n]+/g, ` ${CLAUSE_MARK} `)
      // 4. cualquier otro simbolo (guiones, emojis, etc.) -> espacio
      .replace(/[^a-z0-9%|\s]+/g, ' ')
      // 5. fronteras consecutivas -> una sola
      .replace(/(?:\s*\|\s*)+/g, ` ${CLAUSE_MARK} `)
      // 6. espacios colapsados
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// =============================================================================
// 2. Deteccion de negacion
// =============================================================================

/**
 * Pistas de negacion. Si una de estas aparece en los 5 tokens anteriores al
 * match (sin cruzar frontera de oracion), la señal se descarta.
 *
 * NO estan aqui a proposito: "cant" / "cannot" / "no puedo". En este dominio
 * expresan INCAPACIDAD, no negacion — "no puedo respirar" es la red-flag, no su
 * negacion. Meterlas en esta lista apagaria RF-06 entero.
 */
const NEGATION_CUES: ReadonlySet<string> = new Set([
  // espanol
  'no',
  'ni',
  'nunca',
  'jamas',
  'sin',
  'tampoco',
  'ningun',
  'ninguna',
  'ningunos',
  'ningunas',
  'nada',
  'niego',
  'negativo',
  'negar',
  // ingles
  'not',
  'dont',
  'doesnt',
  'didnt',
  'isnt',
  'arent',
  'wasnt',
  'werent',
  'havent',
  'hasnt',
  'hadnt',
  'wouldnt',
  'never',
  'without',
  'nor',
  'neither',
  'none',
  'nothing',
]);

/**
 * Tokens que cortan la ventana de negacion hacia atras.
 *
 * Sin este corte, cualquier "no" de la frase anterior contaminaria la siguiente.
 * El caso que lo justifica es literal y esta testeado:
 *   "ya no quiero seguir viviendo, quiero matarme"
 * El "no" pertenece a "no quiero seguir viviendo"; sin el corte apagaria
 * "quiero matarme" y el motor se callaria en el peor momento posible.
 */
const CLAUSE_BREAKERS: ReadonlySet<string> = new Set([
  CLAUSE_MARK,
  // conjunciones: lo que viene despues es una afirmacion nueva
  'pero',
  'aunque',
  'sino',
  'mas',
  'y',
  'e',
  'o',
  'u',
  'ademas',
  'tambien',
  'porque',
  'entonces',
  'asi',
  'igual',
  'but',
  'though',
  'although',
  'however',
  'and',
  'or',
  'also',
  'because',
  'so',
  'then',
  'anyway',
]);

/** Cuantos tokens hacia atras se miran buscando la negacion. */
const NEGATION_WINDOW = 5;

/**
 * ¿El propio match EMPIEZA por una pista de negacion?
 *
 * -----------------------------------------------------------------------------
 * EL TARTAMUDEO DEL PANICO — por que existe esta funcion
 * -----------------------------------------------------------------------------
 * Muchos patrones de este archivo ya llevan la negacion DENTRO: "no puedo
 * respirar", "no siento el brazo izquierdo", "no quiero seguir viviendo". Ahi el
 * "no" es parte del sintoma, no su desmentido.
 *
 * Alguien en plena crisis repite y se traba: *"no... no puedo respirar"*,
 * *"no, no siento el brazo"*. Sin esta comprobacion, ese primer "no" entra en la
 * ventana de negacion y APAGA la regla. El motor se callaria exactamente en la
 * frase mas grave que se puede decir por telefono, y lo haria mas cuanto mas
 * asustado estuviera el paciente.
 *
 * Por eso: si el texto que matcheo ya arranca con una pista de negacion, la
 * comprobacion hacia atras se salta. La negacion sigue funcionando para todo lo
 * demas ("no me duele el pecho" matchea 'duele el pecho', que no empieza por
 * pista, y sigue anulandose).
 */
function beginsWithNegationCue(matched: string): boolean {
  const first = matched.trim().split(' ')[0];
  return first !== undefined && NEGATION_CUES.has(first);
}

/**
 * ¿Esta negado el match que empieza en `matchStart`?
 *
 * Recorre hacia atras hasta `NEGATION_WINDOW` tokens y se detiene en la primera
 * frontera de oracion o conjuncion. Pura: no toca ningun estado.
 *
 * @param text        texto YA normalizado
 * @param matchStart  indice (en caracteres) donde empieza el match
 */
export function isNegated(text: string, matchStart: number, windowSize = NEGATION_WINDOW): boolean {
  if (matchStart <= 0) return false;

  const tokens = text.slice(0, matchStart).trim().split(' ').filter(Boolean);

  let looked = 0;
  for (let i = tokens.length - 1; i >= 0 && looked < windowSize; i -= 1, looked += 1) {
    const token = tokens[i] as string;
    if (CLAUSE_BREAKERS.has(token)) return false;
    if (NEGATION_CUES.has(token)) return true;
  }

  return false;
}

/**
 * Devuelve el primer match NO negado de la lista de patrones, o null.
 *
 * Recorre todas las apariciones de cada patron, no solo la primera: en
 * "no me duele el pecho, bueno sí me duele el pecho" la segunda vale.
 *
 * Los patrones NO llevan flag `g` y se avanza con `slice`, para que ningun
 * `lastIndex` sobreviva entre llamadas. Purity por construccion.
 */
function firstUnnegatedMatch(
  text: string,
  patterns: readonly RegExp[],
  negationAware: boolean,
): string | null {
  for (const pattern of patterns) {
    let offset = 0;
    while (offset < text.length) {
      const found = pattern.exec(text.slice(offset));
      if (found === null) break;

      const start = offset + found.index;
      const matched = found[0];
      if (matched.length === 0) break;

      if (!negationAware || beginsWithNegationCue(matched) || !isNegated(text, start)) {
        return matched;
      }
      offset = start + matched.length;
    }
  }
  return null;
}

/** Igual que `firstUnnegatedMatch` pero sin comprobar negacion (modificadores). */
function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  return firstUnnegatedMatch(text, patterns, false);
}

// =============================================================================
// 3. Vocabulario de sintomas (ES + EN)
// =============================================================================
//
// Convencion: los huecos se escriben `[^|]{0,N}` para que un patron nunca cruce
// una frontera de oracion. `\w*` cubre las variantes de genero y numero del
// espanol sin listar cada una.

/**
 * RF-01 / RF-09 · señal PRINCIPAL: dolor, opresion o presion toracica.
 *
 * `(pecho|chest)` en los patrones españoles NO es un descuido. El STT corre con
 * `nova-3 language=multi` y un paciente bilingue produce de verdad frases como
 * *"me duele el chest y radiates to my arm"*. Aceptar las dos palabras en los
 * dos juegos de patrones cuesta nada y cierra el hueco del code-switching.
 *
 * `apret\w*` en vez de listar `aprieta|apretando`: el paciente conjuga
 * ("me apretaran", "sentia que me apretaba"), y el motor no puede depender de
 * que acierte la persona verbal.
 */
const CHEST_PAIN: readonly RegExp[] = [
  /\bdolor\w*\b[^|]{0,20}\b(pecho|chest)\b/,
  /\b(duele|duelen|dolia|dolio)\b[^|]{0,20}\b(pecho|chest)\b/,
  /\b(pecho|chest)\b[^|]{0,15}\b(duele|dolor|dolia)\b/,
  // UNICA excepcion a la regla de "ningun patron cruza frontera de oracion":
  // "me agarro el pecho, el dolor se me va al cuello". El paciente parte la
  // descripcion en dos y el sintoma es uno solo. Se permite cruzar UNA frontera
  // (`\|?`) y solo en este sentido (pecho -> dolor). No abre RF-01 por su cuenta:
  // sigue haciendo falta la irradiacion.
  /\b(pecho|chest)\b[^|]{0,5}\|?[^|]{0,15}\b(duele|dolor|dolia)\b/,
  /\b(opresion|presion|peso|ardor|arde|quemazon|puntada|apret\w*|apriet\w*|cierra|cierre|cerro|encoge|encogio|estruja)\b[^|]{0,20}\b(pecho|chest)\b/,
  /\b(pecho|chest)\b[^|]{0,15}\b(apretado|oprimido|cerrado|pesado|apret\w*|cerrand\w*)\b/,
  /\bdolor\w*\b[^|]{0,20}\b(toracico|torax|esternon)\b/,
  /\bangina\b/,
  // ingles
  /\bchest\b[^|]{0,15}\b(pain|pains|pressure|tightness|tight|hurts|hurting|hurt|discomfort|heaviness|heavy|burning|squeezing)\b/,
  /\b(pain|pressure|tightness|tight|hurts|discomfort|heaviness|burning|squeezing|crushing)\b[^|]{0,20}\bchest\b/,
];

/**
 * RF-01 · MODIFICADOR: irradiacion. No se comprueba negacion sobre esto.
 *
 * `mano`/`dedos` estan aqui porque la irradiacion cardiaca clasica no se detiene
 * en el brazo: *"me hormiguea la mano"* acompañando a una opresion toracica es
 * exactamente el cuadro que RF-01 busca. Ampliar esta lista solo puede disparar
 * RF-01 cuando YA hay una señal de dolor toracico, asi que no abre la regla por
 * su cuenta.
 */
const RADIATION: readonly RegExp[] = [
  /\b(brazo|brazos|antebrazo|mandibula|quijada|maxilar|espalda|hombro|hombros|cuello|omoplato|escapula|axila)\b/,
  /\b(mano|manos|dedo|dedos|muneca)\b/,
  /\b(irradia|irradiado|se corre|se extiende|se va al|se va a la|baja por|baja al|baja a la|sube por|corre hacia)\b/,
  // ingles
  /\b(arm|arms|forearm|jaw|shoulder|shoulders|neck|shoulder blade|upper back)\b/,
  /\b(hand|hands|finger|fingers|wrist)\b/,
  /\b(radiates|radiating|spreads|spreading|shooting down|going down|travels to)\b/,
];

/**
 * RF-02 · sincope / perdida de conciencia.
 *
 * Casi nadie dice "sincope" ni "perdi el conocimiento" por telefono. Dice
 * *"me dio el patatus"*, *"se me fue la luz"*, *"se me nubla y me caigo"*. Los
 * regionalismos (patatus, soponcio, telele, yeyo) son inequivocos y no colisionan
 * con ninguna palabra del vocabulario general, asi que entran sueltos.
 *
 * La forma "se me nubla" SI exige una caida acompañandola: sin ese requisito,
 * *"se me nubla la vista cuando leo mucho"* acabaria en un guion del 911.
 */
const SYNCOPE: readonly RegExp[] = [
  /\bdesmay\w*\b/,
  /\bdesvaneci\w*\b/,
  /\bperdi\b[^|]{0,15}\b(el conocimiento|la conciencia|el sentido|el conociemiento)\b/,
  /\bme quede inconsciente\b/,
  /\bquede inconsciente\b/,
  /\b(me quede|quede)\b[^|]{0,15}\bsin (conocimiento|sentido)\b/,
  /\bsincope\b/,
  /\b(patatus|soponcio|telele|yeyo|vahido|lipotimia)\b/,
  /\bse me apagaron las luces\b/,
  // Deliberadamente SIN "se me fue la luz" a secas: eso es un apagon en casa
  // ("se me fue la luz anoche por la tormenta") y disparaba el 911. La version
  // sincopal de esa frase siempre viene acompañada de un despertar en el suelo,
  // y eso lo recoge el patron de abajo.
  /\bse me (fue|fueron|apago|apagaron)\b[^|]{0,10}\b(el mundo|todo negro|todo oscuro)\b/,
  /\bse me (nubla|nublo|nublaba|va|fue)\b[^|]{0,30}\b(me caigo|me cai|me desplom\w*|caigo al|cai al)\b/,
  /\bdesperte\b[^|]{0,20}\b(en el piso|en el suelo|tirad[oa])\b/,
  // ingles
  /\b(passed out|pass out|passing out)\b/,
  /\b(fainted|fainting|faint spell)\b/,
  /\b(blacked out|black out|blackout)\b/,
  /\blost consciousness\b/,
  /\bsyncope\b/,
];

/** RF-03 · señal PRINCIPAL: debilidad, entumecimiento, perdida de fuerza. */
const WEAKNESS: readonly RegExp[] = [
  /\bdebilidad\b/,
  /\bsin fuerza\b/,
  /\bno (siento|puedo mover|logro mover|puedo levantar|responde)\b/,
  /\bentumecid\w*\b/,
  /\badormecid\w*\b/,
  /\bdormid[oa]\b/,
  /\bse me durmio\b/,
  /\bhormigue\w*\b/,
  /\bparaliz\w*\b/,
  /\bno me responde\b/,
  /\bflojo\b/,
  // ingles
  /\bweakness\b/,
  /\bweak\b/,
  /\bnumb\w*\b/,
  /\btingling\b/,
  /\bcant (move|feel|lift|raise)\b/,
  /\bcannot (move|feel|lift)\b/,
  /\bparalyzed\b/,
  /\bgone limp\b/,
];

/**
 * RF-03 · MODIFICADOR: lateralidad.
 *
 * Es lo que separa un ictus de un brazo dormido por la postura. Sin marcador de
 * lado, RF-03 NO dispara: por eso "tengo el brazo dormido de dormir mal" pasa
 * limpio, que es uno de los negativos que exige el brief.
 */
const LATERALITY: readonly RegExp[] = [
  /\b(izquierd[oa]s?|derech[oa]s?)\b/,
  /\bun (solo )?lado\b/,
  /\bde (un|este|ese|el otro) lado\b/,
  /\bmedio cuerpo\b/,
  /\bmedia cara\b/,
  // "la mitad de la cara", "la mitad del cuerpo", "mitad del rostro": una sola
  // forma en vez de tres literales, porque el paciente elige la preposicion.
  /\bmitad\b[^|]{0,10}\b(cara|cuerpo|rostro|boca)\b/,
  /\bun costado\b/,
  // ingles
  /\b(left|right)\b[^|]{0,10}\b(side|arm|leg|hand|foot|face|half|cheek)\b/,
  /\bone (side|arm|leg|half)\b/,
  /\bhalf (of )?(my )?(body|face)\b/,
];

/** RF-04 · habla arrastrada o caida facial. */
const SPEECH_FACIAL: readonly RegExp[] = [
  /\bhabl\w*\b[^|]{0,15}\barrastr\w*\b/,
  /\barrastr\w*\b[^|]{0,15}\b(palabras|lengua|voz)\b/,
  // "se me traba la lengua" es como se describe una disartria en primera
  // persona; "se me enreda" es la misma queja con otro verbo.
  /\bse me (traba|traban|trabo|enreda|enredan|enredo)\b[^|]{0,15}\b(la lengua|las palabras|la voz)\b/,
  /\blengua trabada\b/,
  /\bno se me entiende\b/,
  // `habl(o|ando)`: "estoy hablando raro" es tan frecuente como "hablo raro".
  /\bhabl(o|ando)\b[^|]{0,10}\b(raro|chueco|torcido|mal|arrastrad\w*|enredad\w*)\b/,
  // "no me sale hablar" = no le sale el habla. Deliberadamente NO cubre
  // "no me sale la palabra", que es anomia benigna y le pasa a cualquiera.
  /\bno me sale(n)? (hablar|la voz|las palabras)\b/,
  /\b(cara|boca|labio|parpado)\b[^|]{0,20}\b(caida|caido|torcida|torcido|chueca|chueco|colgando|paralizada|paralizado|dormida|dormido)\b/,
  /\bse me (cayo|torcio|chueco|desvio)\b[^|]{0,15}\b(la cara|media cara|la boca|el labio)\b/,
  /\bparalisis facial\b/,
  // ingles
  /\bslurr\w*\b/,
  /\b(face|mouth|lip|eyelid)\b[^|]{0,15}\bdroop\w*\b/,
  /\bdroop\w*\b[^|]{0,15}\b(face|mouth|lip|side)\b/,
  /\bfacial droop\b/,
  /\b(trouble|difficulty|hard time)\b[^|]{0,10}\b(speaking|talking|getting my words)\b/,
  /\bcant get my words out\b/,
];

/**
 * RF-05 · cefalea en trueno.
 *
 * Deliberadamente estrecho: exige superlativo ("el peor de mi vida") o inicio
 * subito. Un "me duele un poco la cabeza" no puede acercarse a esto, y ese es
 * otro de los negativos obligatorios del brief.
 */
const THUNDERCLAP: readonly RegExp[] = [
  /\b(el|la) peor dolor de cabeza\b/,
  /\bpeor dolor de cabeza\b[^|]{0,20}\bvida\b/,
  /\bdolor de cabeza\b[^|]{0,25}\b(peor|mas fuerte|mas intenso)\b[^|]{0,15}\bvida\b/,
  /\bdolor de cabeza\b[^|]{0,20}\b(subito|repentino|de repente|de golpe|explosivo|fulminante)\b/,
  /\b(de repente|de golpe|de la nada|subitamente)\b[^|]{0,25}\bdolor de cabeza\b/,
  /\bcefalea (en trueno|subita|fulminante)\b/,
  /\bcomo si me (hubieran golpeado|golpearan|estallara)\b[^|]{0,15}\bcabeza\b/,
  // El paciente rara vez dice el sintagma "dolor de cabeza": dice "me explotó la
  // cabeza de dolor, de repente". Cabeza + verbo de dolor/estallido + inicio
  // subito, en ese orden.
  /\b(dolor|duele|dolio|dolid\w*|explot\w*|estall\w*|revent\w*)\b[^|]{0,25}\bcabeza\b[^|]{0,20}\b(de golpe|de repente|de la nada|subit\w*|repentin\w*|explosiv\w*)\b/,
  // Superlativo indirecto: "nunca me había dolido tanto la cabeza".
  // Exige DOS cosas para no tragarse "nunca me ha dolido la cabeza", que es lo
  // contrario (una negacion): el pluscuamperfecto (`habia`, que es el tiempo del
  // superlativo en español) y el intensificador ("tanto" / "así").
  /\bnunca\b[^|]{0,10}\bhabia\b[^|]{0,10}\bdolido\b[^|]{0,10}\b(tanto|asi)\b[^|]{0,15}\bcabeza\b/,
  /\bnunca\b[^|]{0,10}\bhabia\b[^|]{0,10}\bdolido\b[^|]{0,15}\bcabeza\b[^|]{0,10}\b(asi|tanto|de esta manera)\b/,
  // ingles
  /\bworst headache\b/,
  /\bthunderclap headache\b/,
  /\b(sudden|sudden severe|explosive)\b[^|]{0,15}\bheadache\b/,
  /\bheadache\b[^|]{0,20}\b(came on suddenly|out of nowhere|hit me suddenly|all of a sudden|worst of my life)\b/,
];

/**
 * RF-06 · disnea en reposo.
 *
 * ==== LA DECISION MAS DELICADA DEL MOTOR ====
 *
 * "me falta el aire" es el sintoma MAS comun de un ataque de panico y es un
 * criterio diagnostico del DSM. Si lo pusiera aqui, practicamente toda llamada
 * de panico acabaria en un guion de 911 y el producto entero dejaria de existir:
 * el paciente nunca llegaria a la respiracion de caja de su care plan.
 *
 * Asi que RF-06 exige INCAPACIDAD, no hambre de aire subjetiva:
 *   DISPARA     "no puedo respirar", "no me entra el aire",
 *               "no puedo terminar las frases", "me estoy ahogando", "gasping"
 *   NO DISPARA  "me falta el aire", "me cuesta respirar",
 *               "siento que me ahogo", "siento opresion al respirar"
 *
 * Esta es la linea que separa disnea de hambre de aire, y es la misma que usa un
 * triaje telefonico: lo que importa no es que el aire se sienta poco, sino que no
 * se pueda mover — y el marcador operativo de eso es no poder completar una
 * frase hablada.
 *
 * Las que NO disparan no quedan sin atender: van al LLM con el contexto
 * biometrico y al ejercicio de respiracion del plan. Y si ademas la biometria
 * esta fuera del envelope, RF-08 las recoge igual.
 */
const DYSPNEA_AT_REST: readonly RegExp[] = [
  // `[\s|]{0,5}` en vez de un espacio: quien no puede respirar no habla de
  // corrido. El STT devuelve "no puedo, respirar" o "no... no puedo... respirar"
  // y la puntuacion se normaliza a fronteras de oracion. Tolerar hasta cinco
  // caracteres de pausa entre las dos mitades es lo que convierte esa frase
  // entrecortada —la mas grave que se puede decir por telefono— en un match.
  /\bno\b[\s|]{0,5}\bpuedo\b[\s|]{0,5}\brespirar\b/,
  /\bno logro respirar\b/,
  /\bno consigo respirar\b/,
  /\bno me entra (el )?aire\b/,
  /\bno me llega (el )?aire\b/,
  /\bno me pasa (el )?aire\b/,
  /\bno puedo (tomar|jalar|agarrar) aire\b/,
  /\bme estoy ahogando\b/,
  /\bme estoy asfixiando\b/,
  /\bno puedo (terminar|acabar|completar)\b[^|]{0,20}\b(frase|frases|oracion|oraciones)\b/,
  /\bno puedo hablar de corrido\b/,
  /\bno puedo ni hablar\b/,
  /\bme quedo sin aire\b[^|]{0,15}\bhablar\b/,
  // ingles
  /\b(cant|cannot)\b[\s|]{0,5}\bbreathe\b/,
  /\b(cant|cannot) catch my breath\b/,
  /\b(cant|cannot) get (any )?air\b/,
  /\bgasping\b/,
  /\bstruggling to breathe\b/,
  /\bsuffocating\b/,
  /\b(cant|cannot) (finish|complete)\b[^|]{0,20}\bsentence\b/,
];

/**
 * RF-07 · ideacion suicida o autolesion. Unica regla que va a 988, no a 911.
 *
 * Punto critico de precision: "siento que me voy a morir" es sensacion de muerte
 * inminente, un sintoma de panico de manual, y NO es ideacion suicida. Confundir
 * las dos cosas es grave en las dos direcciones: manda a la linea de crisis a
 * alguien que no la necesita, y le enseña al paciente que el sistema no
 * distingue. Por eso los patrones exigen INTENCION ("quiero", "voy a",
 * "myself"), nunca la simple mencion de la muerte.
 */
const SELF_HARM: readonly RegExp[] = [
  /\b(quiero|quisiera|deseo) morirme\b/,
  /\bme quiero morir\b/,
  /\bme (quiero|voy a) matar\b/,
  /\b(quiero|quisiera) matarme\b/,
  /\bmatarme\b/,
  /\bsuicid\w*\b/,
  /\bquitarme la vida\b/,
  /\bacabar con (mi vida|todo)\b/,
  /\bterminar con (mi vida|todo esto)\b/,
  /\bno quiero (seguir viviendo|seguir vivo|vivir mas|estar aqui)\b/,
  /\bno vale la pena vivir\b/,
  /\bestarian mejor sin mi\b/,
  // Ideacion PASIVA. Es la forma en que mas gente lo dice la primera vez, y la
  // que menos se parece a la palabra "suicidio". Cada patron esta anclado a un
  // objeto explicito (nada / la vida / vivir / seguir) justo para no tragarse
  // "no le veo sentido a esta reunion" ni "no quiero seguir hablando de esto".
  /\bno (le )?veo (el )?sentido a (nada|la vida|seguir|vivir)\b/,
  /\bya no tiene sentido (nada|vivir|seguir)\b/,
  /\b(prefiero|preferiria|quisiera|ojala) no (despertar|despertarme|amanecer)\b/,
  /\b(para que|pa que) (sigo|vivo|vivir|seguir viviendo|estoy aqui|existo)\b/,
  /\b(hacerme|hacer me) dano\b/,
  /\bme quiero hacer dano\b/,
  /\blastimarme\b/,
  /\bautolesion\w*\b/,
  /\bcortarme (las venas|los brazos|la piel)\b/,
  /\bquiero desaparecer\b/,
  // ingles
  /\b(kill|killing) myself\b/,
  /\bend (my life|it all)\b/,
  /\bsuicid\w*\b/,
  /\b(want|wanna) to die\b/,
  /\bwanna die\b/,
  /\b(hurt|harm|cut) myself\b/,
  /\bself harm\b/,
  /\bbetter off without me\b/,
  /\bdont want to (live|be here)\b/,
];

// =============================================================================
// 4. Envelope biometrico (RF-08 / RF-09)
// =============================================================================

/** Numero utilizable: descarta null, undefined y NaN llegados de la red. */
function isUsable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Compara la biometria contra el `safetyEnvelope` del care plan.
 * Devuelve evidencia legible ("heartRate 163 bpm > max 150") o null.
 *
 * Detalles que importan:
 *   - Se comprueba `latest` (estado actual) Y el pico/valle de la ventana: un
 *     paciente que estuvo a 171 hace tres minutos ya se salio del envelope
 *     aunque ahora marque 140.
 *   - Los umbrales son ESTRICTOS: el brief dice "HR > 150", asi que 150 clavado
 *     NO dispara y 151 si. Igual con RR > 32 y con SpO2 < 92.
 *   - Un `heartRate.latest` de 0 se ignora para el minimo: eso es un sensor
 *     caido o el reloj fuera de la muñeca, no bradicardia. Escalar por un cero
 *     seria escalar por un artefacto, y los artefactos rompen la confianza en el
 *     motor mas rapido que cualquier otra cosa.
 *   - SpO2 es opcional en el contrato: si el wearable no lo publica, se salta.
 */
export function checkEnvelope(bio: CurrentBiometrics, env: SafetyEnvelope): string | null {
  const hr = bio.heartRate;
  if (hr) {
    if (isUsable(hr.latest) && isUsable(env.heartRateMax) && hr.latest > env.heartRateMax) {
      return `heartRate ${hr.latest} ${hr.unit} > max ${env.heartRateMax}`;
    }
    if (isUsable(hr.max) && isUsable(env.heartRateMax) && hr.max > env.heartRateMax) {
      return `heartRate pico ${hr.max} ${hr.unit} > max ${env.heartRateMax}`;
    }
    if (
      isUsable(hr.latest) &&
      isUsable(env.heartRateMin) &&
      hr.latest > 0 &&
      hr.latest < env.heartRateMin
    ) {
      return `heartRate ${hr.latest} ${hr.unit} < min ${env.heartRateMin}`;
    }
  }

  const rr = bio.respiratoryRate;
  if (rr && isUsable(env.respiratoryRateMax)) {
    if (isUsable(rr.latest) && rr.latest > env.respiratoryRateMax) {
      return `respiratoryRate ${rr.latest} ${rr.unit} > max ${env.respiratoryRateMax}`;
    }
    if (isUsable(rr.max) && rr.max > env.respiratoryRateMax) {
      return `respiratoryRate pico ${rr.max} ${rr.unit} > max ${env.respiratoryRateMax}`;
    }
  }

  const spo2 = bio.spo2;
  if (spo2 && isUsable(env.spo2Min)) {
    if (isUsable(spo2.latest) && spo2.latest > 0 && spo2.latest < env.spo2Min) {
      return `spo2 ${spo2.latest} ${spo2.unit} < min ${env.spo2Min}`;
    }
    if (isUsable(spo2.min) && spo2.min > 0 && spo2.min < env.spo2Min) {
      return `spo2 valle ${spo2.min} ${spo2.unit} < min ${env.spo2Min}`;
    }
  }

  return null;
}

// =============================================================================
// 5. Definicion de las reglas
// =============================================================================

/**
 * Forma de una regla.
 *
 * Extiende `RedFlagRule` (congelada en `voice/src/types.ts`) partiendo el match
 * en dos mitades declarativas:
 *   - `matchText(normalized)`       -> evidencia de texto, o null
 *   - `matchBiometrics(bio, env)`   -> evidencia numerica, o null
 *
 * Semantica de la combinacion, resuelta una sola vez en `evaluateRule`:
 *   solo texto        -> RF-01 .. RF-07
 *   solo biometria    -> RF-08
 *   las dos (AND)     -> RF-09
 */
export interface RedFlagRuleDef extends RedFlagRule {
  matchText?(normalized: string): string | null;
  matchBiometrics?(bio: CurrentBiometrics, env: SafetyEnvelope): string | null;
}

/**
 * Aplica una regla a un turno ya normalizado. Devuelve la evidencia o null.
 * Pura. Es el unico sitio donde se decide como se combinan texto y biometria.
 */
export function evaluateRule(
  rule: RedFlagRuleDef,
  normalizedText: string,
  biometrics: CurrentBiometrics | null,
  envelope: SafetyEnvelope,
): string | null {
  let textEvidence: string | null = null;
  if (rule.matchText) {
    textEvidence = rule.matchText(normalizedText);
    if (textEvidence === null) return null;
  }

  let bioEvidence: string | null = null;
  if (rule.matchBiometrics) {
    // Sin lectura del wearable, las reglas biometricas se saltan enteras.
    // Nunca se inventa un valor ni se asume "normal".
    if (biometrics === null) return null;
    bioEvidence = rule.matchBiometrics(biometrics, envelope);
    if (bioEvidence === null) return null;
  }

  const parts = [textEvidence, bioEvidence].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' + ') : null;
}

/** Construye una regla completa a partir de sus mitades. */
function defineRule(
  spec: Omit<RedFlagRuleDef, 'script' | 'match'> & { script?: string },
): RedFlagRuleDef {
  const rule: RedFlagRuleDef = {
    ...spec,
    script: spec.script ?? scriptForAction(spec.action),
    // `match` existe para cumplir la interfaz congelada `RedFlagRule`. El motor
    // no lo usa: normaliza UNA vez y llama a `evaluateRule` con el resultado.
    match(input: RedFlagInput): string | null {
      return evaluateRule(rule, normalize(input.transcriptText), input.biometrics, input.safetyEnvelope);
    },
  };
  return Object.freeze(rule);
}

/**
 * Las 9 reglas.
 *
 * `priority`: numero MAS ALTO se evalua primero. El orden es el que exige el
 * brief — RF-09 por encima de todo, luego RF-01..RF-07 en orden, y RF-08 al
 * final. La primera que dispara gana y corta la evaluacion.
 *
 * `severity`: es una ETIQUETA para el log, el dashboard y el episodio. NO cambia
 * la accion. RF-08 se marca `urgent` en vez de `critical` porque una lectura
 * aislada fuera de envelope puede ser artefacto de movimiento del wearable —
 * se escala al 911 igual, pero el episodio deja constancia de que la evidencia
 * era solo numerica. En cuanto hay un sintoma que la acompaña (RF-09) ya no hay
 * excusa de artefacto y sube a `critical`.
 */
export const RED_FLAG_RULES: readonly RedFlagRuleDef[] = Object.freeze([
  defineRule({
    id: 'RF-09-COMBINED',
    description: 'Dolor de pecho (irradie o no) CON biometria fuera del safety envelope',
    action: 'advise-911',
    severity: 'critical',
    priority: 100,
    matchText: (t) => {
      const chest = firstUnnegatedMatch(t, CHEST_PAIN, true);
      return chest === null ? null : `dolor toracico: '${chest}'`;
    },
    matchBiometrics: (bio, env) => {
      const breach = checkEnvelope(bio, env);
      return breach === null ? null : `envelope: ${breach}`;
    },
  }),

  defineRule({
    id: 'RF-01-CHEST-PAIN-RADIATING',
    description: 'Dolor u opresion en el pecho QUE IRRADIA a brazo, mandibula, espalda, hombro o cuello',
    action: 'advise-911',
    severity: 'critical',
    priority: 90,
    // Dos señales obligatorias. Un "me duele el pecho" a secas NO basta para
    // RF-01: se queda para RF-09 (si la biometria acompaña) o para el LLM.
    matchText: (t) => {
      const chest = firstUnnegatedMatch(t, CHEST_PAIN, true);
      if (chest === null) return null;
      // La irradiacion es un modificador anatomico: no se le aplica negacion.
      const radiation = firstMatch(t, RADIATION);
      if (radiation === null) return null;
      return `dolor toracico: '${chest}' + irradiacion: '${radiation}'`;
    },
  }),

  defineRule({
    id: 'RF-02-SYNCOPE',
    description: 'Desmayo, sincope o perdida de conciencia',
    action: 'advise-911',
    severity: 'critical',
    priority: 89,
    matchText: (t) => {
      const hit = firstUnnegatedMatch(t, SYNCOPE, true);
      return hit === null ? null : `sincope: '${hit}'`;
    },
  }),

  defineRule({
    id: 'RF-03-UNILATERAL-WEAKNESS',
    description: 'Debilidad o entumecimiento de UN SOLO lado del cuerpo',
    action: 'advise-911',
    severity: 'critical',
    priority: 88,
    matchText: (t) => {
      const weakness = firstUnnegatedMatch(t, WEAKNESS, true);
      if (weakness === null) return null;
      // Sin lateralidad no hay RF-03: "el brazo dormido" bilateral o postural
      // no es un ictus.
      const side = firstMatch(t, LATERALITY);
      if (side === null) return null;
      return `deficit: '${weakness}' + lateralidad: '${side}'`;
    },
  }),

  defineRule({
    id: 'RF-04-SPEECH-FACIAL',
    description: 'Habla arrastrada o caida facial',
    action: 'advise-911',
    severity: 'critical',
    priority: 87,
    matchText: (t) => {
      const hit = firstUnnegatedMatch(t, SPEECH_FACIAL, true);
      return hit === null ? null : `habla/facial: '${hit}'`;
    },
  }),

  defineRule({
    id: 'RF-05-THUNDERCLAP-HEADACHE',
    description: 'Cefalea en trueno: el peor dolor de cabeza de su vida o de inicio subito',
    action: 'advise-911',
    severity: 'critical',
    priority: 86,
    matchText: (t) => {
      const hit = firstUnnegatedMatch(t, THUNDERCLAP, true);
      return hit === null ? null : `cefalea: '${hit}'`;
    },
  }),

  defineRule({
    id: 'RF-06-DYSPNEA-AT-REST',
    description: 'Disnea en reposo: no puede respirar o no puede terminar frases',
    action: 'advise-911',
    severity: 'critical',
    priority: 85,
    matchText: (t) => {
      const hit = firstUnnegatedMatch(t, DYSPNEA_AT_REST, true);
      return hit === null ? null : `disnea: '${hit}'`;
    },
  }),

  defineRule({
    id: 'RF-07-SELF-HARM',
    description: 'Ideacion suicida o intencion de autolesion — linea de crisis 988, NO 911',
    action: 'advise-988',
    severity: 'critical',
    priority: 84,
    matchText: (t) => {
      const hit = firstUnnegatedMatch(t, SELF_HARM, true);
      return hit === null ? null : `autolesion/ideacion: '${hit}'`;
    },
  }),

  defineRule({
    id: 'RF-08-BIOMETRIC-ENVELOPE',
    description: 'Biometria fuera del safety envelope (HR, RR o SpO2). No mira el texto',
    action: 'advise-911',
    severity: 'urgent',
    priority: 10,
    matchBiometrics: (bio, env) => checkEnvelope(bio, env),
  }),
]);

/**
 * Las reglas en orden de evaluacion (prioridad descendente).
 *
 * El `sort` se hace UNA vez al cargar el modulo, sobre una copia. Es estable en
 * todos los motores JS modernos, asi que empates de prioridad conservan el orden
 * de declaracion.
 */
export const RULES_IN_EVALUATION_ORDER: readonly RedFlagRuleDef[] = Object.freeze(
  [...RED_FLAG_RULES].sort((a, b) => b.priority - a.priority),
);

/** Busca una regla por ID. Util para el CLI, los tests y el dashboard. */
export function findRule(id: string): RedFlagRuleDef | undefined {
  return RED_FLAG_RULES.find((rule) => rule.id === id);
}
