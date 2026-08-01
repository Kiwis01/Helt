/**
 * `voiceSummary` — el campo más importante del servicio.
 *
 * El agente de voz lo lee LITERAL, sin pasarlo por un LLM. Eso quita latencia
 * y, sobre todo, quita el riesgo de que un modelo se invente un copago frente
 * a un paciente en medio de un episodio de ansiedad.
 *
 * Por eso este módulo es una PLANTILLA DETERMINISTA:
 *   - función pura, cero I/O, cero aleatoriedad, cero red;
 *   - misma entrada → misma frase, siempre;
 *   - si un dato no se conoce, la frase LO DICE. Nunca se omite en silencio.
 *
 * Reglas de redacción (las escucha el público del demo):
 *   - segunda persona, frase corta, sin jerga de seguros;
 *   - montos en lenguaje humano: 2500 → "25 dólares", nunca "2500 cents";
 *   - la palabra "cents"/"centavos" NO puede aparecer jamás en la salida.
 */

/** Deducible tal y como lo define el Contrato 3. Todos los montos en centavos. */
export interface VoiceSummaryDeductible {
  individualCents: number;
  metCents: number;
  remainingCents: number;
}

/** Lo mínimo que hace falta para redactar la frase. Nada más entra aquí. */
export interface VoiceSummaryInput {
  status: 'covered' | 'not-covered' | 'needs-auth' | 'unknown';
  copayCents: number | null;
  coinsurancePercent: number | null;
  deductible: VoiceSummaryDeductible | null;
  priorAuthRequired: boolean | null;
  payerName: string;
}

export type VoiceLang = 'es' | 'en';

/**
 * Límite duro de longitud. `shared/validate-fixtures.ts` exige < 220 caracteres
 * para los fixtures; la frase generada respeta el mismo techo porque es la misma
 * frase que el agente lee en voz alta.
 */
export const VOICE_SUMMARY_MAX_LENGTH = 220;

/* ------------------------------------------------------------------ */
/* Formateo de montos                                                  */
/* ------------------------------------------------------------------ */

/**
 * Centavos → lenguaje hablado. 2500 → "25 dólares" / "25 dollars".
 *
 * Cuando el monto no cae en dólares enteros NO decimos los centavos (la palabra
 * está prohibida) ni leemos un decimal ("25 punto 5" suena a robot): redondeamos
 * al dólar y marcamos la frase como aproximada. Sigue siendo honesto porque la
 * frase dice "alrededor de".
 *
 * El tramo de 1 a 99 centavos es la excepción: redondear ahí daría "alrededor de
 * 0 dólares", y como el copago de 0 tiene su propia frase ("No tienes que pagar
 * copago"), decir cero cuando no es cero solo puede entenderse como que no hay
 * nada que pagar. Un copago de 49 centavos se lee "menos de un dólar".
 */
export function centsToSpokenAmount(cents: number, lang: VoiceLang): string {
  const abs = Math.abs(Math.round(cents));

  if (abs > 0 && abs < 100) {
    return lang === 'es' ? 'menos de un dólar' : 'less than a dollar';
  }

  const isWholeDollars = abs % 100 === 0;
  const dollars = isWholeDollars ? abs / 100 : Math.round(abs / 100);

  const unit =
    lang === 'es' ? (dollars === 1 ? 'dólar' : 'dólares') : dollars === 1 ? 'dollar' : 'dollars';
  const approx = isWholeDollars ? '' : lang === 'es' ? 'alrededor de ' : 'about ';

  return `${approx}${dollars} ${unit}`;
}

/**
 * ¿El monto hablado lleva verbo en singular? "Te queda menos de un dólar" /
 * "Te queda 1 dólar" frente a "Te quedan 80 dólares".
 */
function isSingularAmount(cents: number): boolean {
  const abs = Math.abs(Math.round(cents));
  return abs < 100 ? abs > 0 : abs === 100;
}

/** 20 → "20", 12.5 → "12.5". Sin ceros decimales inútiles para el TTS. */
function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/* ------------------------------------------------------------------ */
/* Cláusulas                                                           */
/* ------------------------------------------------------------------ */

/**
 * Qué paga el paciente. `mood: 'conditional'` se usa cuando el servicio todavía
 * necesita autorización: el copago aún no es un hecho, es lo que costaría.
 *
 * Nota de idioma: en inglés se usa el símbolo "%" en vez de la palabra
 * "percent" porque esa palabra contiene la subcadena "cent", que este servicio
 * tiene prohibida por contrato. El TTS lee "%" correctamente.
 */
function costClause(input: VoiceSummaryInput, lang: VoiceLang, mood: 'actual' | 'conditional'): string {
  const { copayCents, coinsurancePercent } = input;

  if (copayCents !== null) {
    if (copayCents === 0) {
      return lang === 'es' ? 'No tienes que pagar copago.' : 'You have no copay.';
    }
    const amount = centsToSpokenAmount(copayCents, lang);
    if (mood === 'conditional') {
      return lang === 'es' ? `Tu copago sería de ${amount}.` : `Your copay would be ${amount}.`;
    }
    return lang === 'es' ? `Tu copago es de ${amount}.` : `Your copay is ${amount}.`;
  }

  if (coinsurancePercent !== null) {
    if (coinsurancePercent === 0) {
      // El coaseguro del 0% se aplica DESPUÉS del deducible: hasta cubrirlo,
      // paga el paciente. Decir "tu plan cubre el costo completo" con deducible
      // pendiente es la mitad favorable de la verdad, y es la mitad que un
      // paciente ansioso se va a quedar.
      const deductiblePending =
        input.deductible !== null && input.deductible.remainingCents > 0;

      if (lang === 'es') {
        const verb = mood === 'conditional' ? 'cubriría' : 'cubre';
        return deductiblePending
          ? `Tu plan ${verb} el costo completo una vez que cubras tu deducible.`
          : `Tu plan ${verb} el costo completo.`;
      }
      const verb = mood === 'conditional' ? 'would cover' : 'covers';
      return deductiblePending
        ? `Your plan ${verb} the full cost once you meet your deductible.`
        : `Your plan ${verb} the full cost.`;
    }
    const pct = formatPercent(coinsurancePercent);
    if (mood === 'conditional') {
      return lang === 'es' ? `Pagarías el ${pct} por ciento del costo.` : `You would pay ${pct}% of the cost.`;
    }
    return lang === 'es' ? `Pagas el ${pct} por ciento del costo.` : `You pay ${pct}% of the cost.`;
  }

  // No lo sabemos. Se dice, no se calla.
  return lang === 'es' ? 'No pude confirmar tu copago.' : 'I could not confirm your copay.';
}

/** Cuánto le falta al paciente para cubrir su deducible. */
function deductibleClause(input: VoiceSummaryInput, lang: VoiceLang): string {
  const { deductible } = input;

  if (deductible === null) {
    return lang === 'es' ? 'No pude confirmar tu deducible.' : 'I could not confirm your deductible.';
  }
  if (deductible.remainingCents <= 0) {
    return lang === 'es' ? 'Ya cubriste tu deducible.' : 'You have already met your deductible.';
  }
  const amount = centsToSpokenAmount(deductible.remainingCents, lang);
  const verb = isSingularAmount(deductible.remainingCents) ? 'Te queda' : 'Te quedan';
  return lang === 'es'
    ? `${verb} ${amount} por cubrir de tu deducible.`
    : `You have ${amount} left on your deductible.`;
}

/* ------------------------------------------------------------------ */
/* Ensamblado                                                          */
/* ------------------------------------------------------------------ */

/**
 * Une las cláusulas respetando el techo de longitud. Las partes van en orden de
 * importancia, así que cuando hay que recortar cae siempre lo menos crítico —
 * y nunca se parte una palabra por la mitad.
 */
function joinWithinLimit(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    const next = out === '' ? part : `${out} ${part}`;
    if (next.length >= VOICE_SUMMARY_MAX_LENGTH) break;
    out = next;
  }
  return out;
}

/**
 * Construye la frase que el agente de voz lee literal.
 *
 * @param input  hechos de cobertura ya normalizados (nunca un 271 crudo).
 * @param lang   'es' | 'en'. El servicio soporta los dos porque el equipo aún
 *               no decidió el idioma del demo; así ese riesgo desaparece.
 */
export function buildVoiceSummary(input: VoiceSummaryInput, lang: VoiceLang): string {
  const parts: string[] = [];

  switch (input.status) {
    case 'covered': {
      parts.push(
        lang === 'es' ? 'Este servicio sí está cubierto por tu plan.' : 'This service is covered by your plan.',
      );
      parts.push(costClause(input, lang, 'actual'));
      parts.push(deductibleClause(input, lang));
      // Cubierto pero con autorización previa: el paciente tiene que saberlo.
      if (input.priorAuthRequired === true) {
        parts.push(lang === 'es' ? 'También necesita autorización previa.' : 'It also needs prior approval.');
      }
      break;
    }

    case 'not-covered': {
      parts.push(
        lang === 'es'
          ? 'Este servicio no está cubierto por tu plan.'
          : 'This service is not covered by your plan.',
      );
      parts.push(
        lang === 'es'
          ? 'Tu equipo de cuidado puede ver otras opciones contigo.'
          : 'Your care team can look at other options with you.',
      );
      break;
    }

    case 'needs-auth': {
      parts.push(
        lang === 'es'
          ? 'Este servicio está en tu plan, pero necesita autorización previa antes de la cita.'
          : 'This service is in your plan, but it needs prior approval before the visit.',
      );
      parts.push(
        lang === 'es' ? 'Tu equipo de cuidado puede tramitarla.' : 'Your care team can request it.',
      );
      parts.push(costClause(input, lang, 'conditional'));
      break;
    }

    case 'unknown': {
      parts.push(
        lang === 'es'
          ? 'No pude verificar tu cobertura en este momento.'
          : 'I could not check your coverage right now.',
      );
      parts.push(
        lang === 'es'
          ? 'Tu equipo de cuidado puede confirmarlo por ti.'
          : 'Your care team can confirm it for you.',
      );
      break;
    }
  }

  return joinWithinLimit(parts);
}
