/**
 * Construccion del prompt del sistema y de la frase de apertura.
 *
 * Dos piezas, con responsabilidades distintas:
 *
 *   `buildSystemPrompt(ctx)`  -> el contexto completo que ve el LLM.
 *   `buildOpeningLine(ctx)`   -> la PRIMERA frase de la llamada, armada sin LLM.
 *
 * La segunda existe por dos razones, y las dos son de producto:
 *   1. Latencia: el saludo sale en cuanto arranca la llamada, sin esperar una
 *      ida y vuelta al modelo.
 *   2. Garantia: el numero concreto del baseline SE DICE. No depende de que el
 *      modelo obedezca una instruccion. En el escenario, esa frase es la que
 *      prueba que hay datos reales detras y no un chatbot.
 *
 * Todo aqui es determinista y sin I/O.
 */

import type {
  CarePlanActivity,
  MetricTrend,
  PatientContext,
  RecentEpisode,
} from '../types.js';

// -----------------------------------------------------------------------------
// Reglas de postura — la seccion 5 del brief, "la inversion logica"
// -----------------------------------------------------------------------------

/**
 * Las seis reglas de postura, textuales y no negociables.
 *
 * Se exportan como constante para que el suite de tests verifique que TODAS
 * llegan al prompt. Si alguien las suaviza, el test se pone rojo.
 *
 * Ojo: la regla 6 no es un adorno. El motor de red-flags
 * (`voice/src/safety/`) ya evaluo este turno ANTES de que el modelo lo viera.
 * Si el modelo se pusiera a decidir escalaciones estariamos duplicando —
 * y contradiciendo — una decision determinista.
 */
export const POSTURE_RULES: readonly string[] = [
  'CONTEXTUALIZA, NUNCA DIAGNOSTIQUES. Tienes prohibido decir "estás teniendo un ataque de pánico", "esto es ansiedad" o cualquier frase que nombre un diagnóstico. Dices qué está haciendo el cuerpo con números medidos, y qué dice el plan de cuidado que escribió su clínico.',
  'La biometría normal es motivo para tranquilizar y desescalar, NUNCA para descartar una emergencia. Jamás infieres "sus signos están bien, entonces no es nada grave". Descartar es trabajo de un humano.',
  'Cero recomendaciones de medicamentos o suplementos. Cero cambios de dosis. Cero órdenes autónomas. Si preguntan por su medicación, remites a su equipo de cuidado.',
  'Respuestas CORTAS: una o dos frases. Esto es voz, no texto. Sin listas, sin viñetas, sin markdown, sin emojis, sin encabezados. Escribe como se habla.',
  'Tu PRIMERA respuesta de la llamada debe incluir un número concreto del baseline y el actual (por ejemplo: "tu ritmo está en 118, tu promedio de las últimas semanas es 68"). Sin ese número, la respuesta no sirve.',
  'Si la persona describe algo que suena a emergencia, NO lo evalúes tú. Un sistema determinista corrió antes que tú y ya tomó esa decisión. Tú acompañas; no decides escalar ni descartas una escalación.',
];

/** Frase de disclosure. Se dice al inicio de cada llamada. */
export const DISCLOSURE_LINE = 'No sustituyo la atención de emergencia.';

// -----------------------------------------------------------------------------
// Helpers de formato
// -----------------------------------------------------------------------------

/** Formatea un numero para voz: 68 -> "68", 8.3 -> "8.3", -3.0 -> "-3". */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '?';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** true solo si el valor es un numero real y utilizable. */
function isUsable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * true solo si el valor sirve como CONSTANTE VITAL locutable.
 *
 * Un cero en una frecuencia cardiaca, una edad o una media de sueño no es un
 * dato: es la marca de "loop-core no lo envio" que deja `contextCoercion.ts` al
 * aceptar un contexto incompleto en vez de tirarlo entero. Distinguirlo importa
 * porque `isUsable(0)` es true, y con esa guardia el agente llegaria a decir
 * "tu variabilidad de referencia es 0 ms". Prefiero que omita la linea: callar
 * un dato que no tenemos es correcto, inventarlo no.
 *
 * Ojo: NO se usa para deltas ni para puntuaciones 0-10, donde el cero si es un
 * valor legitimo.
 */
function isVital(value: unknown): value is number {
  return isUsable(value) && value > 0;
}

/** Traduce la tendencia del contrato a algo locutable en espanol. */
function translateTrend(trend: MetricTrend | string): string {
  switch (trend) {
    case 'rising':
      return 'subiendo';
    case 'falling':
      return 'bajando';
    case 'stable':
      return 'estable';
    default:
      return String(trend);
  }
}

/** "2026-07-28T02:14:00Z" -> "2026-07-28". Sin dependencias de fecha. */
function toDateOnly(iso: string): string {
  const separator = iso.indexOf('T');
  return separator > 0 ? iso.slice(0, separator) : iso;
}

/** Colapsa un voiceScript multilinea en una sola linea legible para el prompt. */
function flattenScript(script: string): string {
  return script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' / ');
}

// -----------------------------------------------------------------------------
// Secciones del prompt
// -----------------------------------------------------------------------------

function buildVitalsSection(ctx: PatientContext): string {
  const lines: string[] = [];

  // El formato de esta linea lo parsea `parsePromptSnapshot`: siempre
  // `- Paciente: NOMBRE, <algo>.` — la coma no se quita aunque falte la edad.
  lines.push(
    `- Paciente: ${ctx.displayName}, ${
      isVital(ctx.age) ? `${formatNumber(ctx.age)} años` : 'edad no registrada'
    }.`,
  );
  lines.push(`- Ventana observada: últimos ${formatNumber(ctx.current.windowMinutes)} minutos.`);

  const hr = ctx.current.heartRate;
  const hrBase = ctx.baseline.heartRate;
  if (isVital(hr?.latest) && isVital(hrBase?.mean)) {
    const parts = [
      `- Frecuencia cardiaca ahora: ${formatNumber(hr.latest)} bpm`,
      `referencia: ${formatNumber(hrBase.mean)} bpm`,
    ];
    const hrDelta = ctx.deltas.heartRate;
    if (isUsable(hrDelta?.sdFromBaseline)) {
      parts.push(`desviación: ${formatNumber(hrDelta.sdFromBaseline)} SD sobre su promedio`);
    }
    if (isVital(hr.max)) parts.push(`máximo en la ventana: ${formatNumber(hr.max)} bpm`);
    parts.push(`tendencia: ${translateTrend(hr.trend)}`);
    lines.push(`${parts.join(' | ')}.`);
  }

  const hrv = ctx.current.hrv;
  const hrvBase = ctx.baseline.hrv;
  if (isVital(hrv?.latest) && isVital(hrvBase?.mean)) {
    const parts = [
      `- Variabilidad cardiaca ahora: ${formatNumber(hrv.latest)} ms`,
      `referencia: ${formatNumber(hrvBase.mean)} ms`,
    ];
    const hrvDelta = ctx.deltas.hrv;
    if (isUsable(hrvDelta?.sdFromBaseline)) {
      parts.push(`desviación: ${formatNumber(hrvDelta.sdFromBaseline)} SD`);
    }
    if (isVital(hrv.min)) parts.push(`mínimo en la ventana: ${formatNumber(hrv.min)} ms`);
    parts.push(`tendencia: ${translateTrend(hrv.trend)}`);
    lines.push(`${parts.join(' | ')}.`);
  }

  const rr = ctx.current.respiratoryRate;
  const rrBase = ctx.baseline.respiratoryRate;
  if (isVital(rr?.latest) && isVital(rrBase?.mean)) {
    const parts = [
      `- Respiraciones por minuto ahora: ${formatNumber(rr.latest)}`,
      `referencia: ${formatNumber(rrBase.mean)}`,
    ];
    if (isVital(rr.max)) parts.push(`máximo en la ventana: ${formatNumber(rr.max)}`);
    parts.push(`tendencia: ${translateTrend(rr.trend)}`);
    lines.push(`${parts.join(' | ')}.`);
  }

  if (isVital(ctx.baseline.sleepHours?.mean)) {
    lines.push(`- Sueño de referencia: ${formatNumber(ctx.baseline.sleepHours.mean)} h por noche.`);
  }

  lines.push(`- Última lectura del wearable: ${ctx.current.lastSampleAt}.`);

  return lines.join('\n');
}

function buildConditionsSection(ctx: PatientContext): string {
  if (ctx.conditions.length === 0) {
    return '- Sin condiciones activas registradas.';
  }
  return ctx.conditions
    .map(
      (condition) =>
        `- ${condition.display} (${condition.system.includes('snomed') ? 'SNOMED' : 'código'} ${condition.code}), desde ${condition.onsetDate}, estado ${condition.clinicalStatus}.`,
    )
    .join('\n');
}

function buildActivityBlock(activity: CarePlanActivity, index: number): string {
  const duration = isUsable(activity.durationMinutes)
    ? `, ~${formatNumber(activity.durationMinutes)} min`
    : '';
  const lines = [`${index + 1}. ${activity.title} (${activity.type}${duration})`];
  lines.push(`   Indicación del clínico: ${activity.instruction}`);
  if (activity.voiceScript !== undefined && activity.voiceScript.trim() !== '') {
    lines.push(`   Guion de voz: ${flattenScript(activity.voiceScript)}`);
  }
  if (activity.costItem !== undefined) {
    lines.push(
      `   Tiene costo asociado (${activity.costItem.serviceType}, CPT ${activity.costItem.cptCode}). Cuando lleguen aquí, el sistema verifica la cobertura y te da un resumen ya escrito: se lee LITERAL. Nunca inventas un copago ni una cifra.`,
    );
  }
  return lines.join('\n');
}

function buildCarePlanSection(ctx: PatientContext): string {
  const plan = ctx.carePlan;
  const ordered = [...plan.activities].sort((a, b) => a.order - b.order);
  const header = `Escrito por ${plan.authoredBy}, actualizado ${plan.lastUpdated}. Se sigue EN ORDEN.`;
  if (ordered.length === 0) {
    return `${header}\n(El plan no tiene actividades registradas.)`;
  }
  return [header, ...ordered.map((activity, index) => buildActivityBlock(activity, index))].join(
    '\n',
  );
}

function buildEpisodeLine(episode: RecentEpisode): string {
  const parts = [
    `- ${toDateOnly(episode.startedAt)}`,
    `duró ${formatNumber(episode.durationMinutes)} min`,
    `pico de ${formatNumber(episode.peakHeartRate)} bpm`,
  ];
  parts.push(
    episode.interventions.length > 0
      ? `hizo ${episode.interventions.join(', ')}`
      : 'sin intervención registrada',
  );
  parts.push(`terminó ${episode.resolution}`);
  if (isUsable(episode.severitySelfReported)) {
    parts.push(`severidad ${formatNumber(episode.severitySelfReported)}/10`);
  }
  return `${parts.join(', ')}.`;
}

function buildEpisodesSection(ctx: PatientContext): string {
  // Solo los 3 mas recientes: mas que eso solo agrega tokens y latencia.
  const recent = ctx.recentEpisodes.slice(0, 3);
  if (recent.length === 0) {
    return '- No hay episodios previos registrados.';
  }
  return recent.map(buildEpisodeLine).join('\n');
}

function buildMedicationsSection(ctx: PatientContext): string {
  if (ctx.medications.length === 0) {
    return '- Sin medicación activa registrada.';
  }
  const list = ctx.medications
    .map((medication) => `${medication.display} (${medication.status})`)
    .join('; ');
  return `- ${list}.\n- Esto es SOLO contexto. No la comentas, no la evalúas, no sugieres cambios. Si preguntan, remites a su equipo de cuidado.`;
}

function buildRulesSection(): string {
  return POSTURE_RULES.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
}

// -----------------------------------------------------------------------------
// buildSystemPrompt
// -----------------------------------------------------------------------------

/**
 * Arma el prompt del sistema en espanol con los datos reales del contexto.
 *
 * Determinista: el mismo contexto produce el mismo prompt, byte a byte.
 */
export function buildSystemPrompt(ctx: PatientContext): string {
  const firstName = ctx.displayName.split(' ')[0] ?? ctx.displayName;

  return [
    `Eres Loop, un compañero de voz. Estás hablando por teléfono con ${ctx.displayName}, que puede estar atravesando un episodio de ansiedad o pánico ahora mismo. Hablas español.`,
    '',
    `Tu trabajo tiene exactamente dos partes: reflejar lo que su cuerpo está haciendo, con los números medidos que tienes abajo, y acompañarle por el plan de cuidado que escribió su clínico. Nada más. No eres su médico.`,
    '',
    '## Datos medidos (no inferidos)',
    buildVitalsSection(ctx),
    '',
    '## Condiciones activas',
    buildConditionsSection(ctx),
    '',
    '## Plan de cuidado',
    buildCarePlanSection(ctx),
    '',
    '## Episodios recientes',
    buildEpisodesSection(ctx),
    '',
    '## Medicación activa',
    buildMedicationsSection(ctx),
    '',
    '## Reglas de postura (no negociables)',
    buildRulesSection(),
    '',
    '## Cómo suena tu voz',
    `- Le llamas ${firstName}. Tuteas. Tono cálido y tranquilo, sin dramatismo y sin animarle en exceso.`,
    '- Frases cortas. Preguntas de una sola pregunta.',
    '- Cuando cites un número, dilo como se dice en voz alta ("ciento dieciocho" se escribe 118; el sintetizador lo resuelve).',
    '- Nunca describes lo que estás haciendo por dentro. Nada de "déjame revisar tus datos" salvo que de verdad estés esperando algo.',
    `- Al inicio de la llamada se dice, tal cual: "${DISCLOSURE_LINE}"`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// buildOpeningLine
// -----------------------------------------------------------------------------

export interface OpeningLineOptions {
  /** Incluir el disclosure de emergencia. Default true. */
  includeDisclosure?: boolean;
}

/**
 * Primera frase de la llamada. SIN LLM.
 *
 * Contiene siempre el valor actual y el de referencia de la frecuencia
 * cardiaca, porque es lo que demuestra en el escenario que hay datos reales
 * detras. Si por lo que sea no hubiera biometria utilizable, degrada a un
 * saludo honesto en vez de inventarse un numero.
 */
export function buildOpeningLine(ctx: PatientContext, options?: OpeningLineOptions): string {
  const includeDisclosure = options?.includeDisclosure ?? true;
  const firstName = ctx.displayName.split(' ')[0] ?? ctx.displayName;

  const parts: string[] = [`Hola ${firstName}, soy Loop, estoy contigo.`];

  const hr = ctx.current.heartRate?.latest;
  const hrBaseline = ctx.baseline.heartRate?.mean;

  if (isVital(hr) && isVital(hrBaseline)) {
    parts.push(
      `Estoy viendo tu ritmo cardiaco en ${formatNumber(hr)}, y tu promedio de las últimas semanas es ${formatNumber(hrBaseline)}.`,
    );
    const rr = ctx.current.respiratoryRate?.latest;
    const rrBaseline = ctx.baseline.respiratoryRate?.mean;
    if (isVital(rr) && isVital(rrBaseline)) {
      parts.push(
        `Tu respiración está en ${formatNumber(rr)} por minuto, tu promedio es ${formatNumber(rrBaseline)}.`,
      );
    }
  } else {
    parts.push('Ahora mismo no estoy recibiendo lecturas de tu reloj, pero te escucho igual.');
  }

  const firstActivity = [...ctx.carePlan.activities].sort((a, b) => a.order - b.order)[0];
  if (firstActivity !== undefined) {
    const author = ctx.carePlan.authoredBy;
    parts.push(
      `Tu plan de cuidado, escrito por ${author}, dice empezar con ${firstActivity.title}.`,
    );
    parts.push('¿Lo hacemos juntos?');
  } else {
    parts.push('Cuéntame qué está pasando.');
  }

  if (includeDisclosure) {
    parts.push(DISCLOSURE_LINE);
  }

  return parts.join(' ');
}

// -----------------------------------------------------------------------------
// Lectura del prompt (la usa el proveedor de respaldo)
// -----------------------------------------------------------------------------

/** Datos minimos que el proveedor de respaldo necesita para sonar util. */
export interface PromptSnapshot {
  displayName: string | null;
  heartRate: number | null;
  heartRateBaseline: number | null;
  firstActivityTitle: string | null;
}

/**
 * Recupera del prompt del sistema los pocos datos que necesita el proveedor de
 * respaldo (`scripted`) para armar una frase con numeros reales.
 *
 * Por que parsear en vez de guardar el contexto en una variable de modulo:
 * `LlmProvider.streamReply` solo recibe `{ systemPrompt, messages }` — es una
 * interfaz congelada. Parsear mantiene el respaldo SIN ESTADO, que es lo
 * correcto si algun dia hay dos llamadas a la vez. El formato que se parsea
 * aqui lo genera este mismo archivo y esta cubierto por tests.
 */
export function parsePromptSnapshot(systemPrompt: string): PromptSnapshot {
  const nameMatch = /^- Paciente:\s*([^,\n]+)/m.exec(systemPrompt);
  const hrMatch =
    /Frecuencia cardiaca ahora:\s*(-?\d+(?:\.\d+)?)\s*bpm\s*\|\s*referencia:\s*(-?\d+(?:\.\d+)?)/.exec(
      systemPrompt,
    );

  // La busqueda de la actividad se acota a la seccion del plan: las reglas de
  // postura tambien van numeradas y no queremos confundirlas con el care plan.
  const planStart = systemPrompt.indexOf('## Plan de cuidado');
  let planSection = '';
  if (planStart !== -1) {
    const nextSection = systemPrompt.indexOf('\n## ', planStart + 1);
    planSection = systemPrompt.slice(
      planStart,
      nextSection === -1 ? systemPrompt.length : nextSection,
    );
  }
  const activityMatch = /^1\.\s+(.+?)\s+\(/m.exec(planSection);

  const toNumber = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    displayName: nameMatch?.[1]?.trim() ?? null,
    heartRate: toNumber(hrMatch?.[1]),
    heartRateBaseline: toNumber(hrMatch?.[2]),
    firstActivityTitle: activityMatch?.[1]?.trim() ?? null,
  };
}
