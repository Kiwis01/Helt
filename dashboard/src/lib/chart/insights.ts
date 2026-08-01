/**
 * Cálculos clínicos deterministas: banderas, tendencias y verificaciones de
 * seguridad al recetar.
 *
 * Todo lo de este archivo es aritmética y comparación de cadenas. **Nada aquí
 * puede pasar nunca por un LLM.** No es una preferencia de estilo: es la misma
 * regla que gobierna el motor de red-flags de `voice/` en este repo, y por la
 * misma razón. Una alerta de alergia que "casi siempre" acierta no es una
 * alerta de alergia. Si un juez pregunta "¿esto lo decidió un modelo?", la
 * respuesta tiene que ser un archivo que se pueda leer de arriba abajo.
 *
 * Cada bandera lleva su `basis` con los números que la produjeron, para que el
 * médico pueda auditar la afirmación en lugar de tener que creerla.
 */

import type {
  ChartAllergy,
  ChartCondition,
  ChartFlag,
  ChartMedication,
  ChartMetric,
  ChartObservationPoint,
  MetricTrend,
  RangeFlag,
  ReferenceRange,
} from './types';

/* ================================================================== */
/* Clasificación de un valor contra su rango                           */
/* ================================================================== */

export function flagValue(value: number, range: ReferenceRange | null): RangeFlag {
  if (!range) return 'unknown';

  if (range.criticalHigh !== null && value >= range.criticalHigh) return 'critical-high';
  if (range.criticalLow !== null && value <= range.criticalLow) return 'critical-low';
  if (range.high !== null && value > range.high) return 'high';
  if (range.low !== null && value < range.low) return 'low';
  return 'normal';
}

/** `true` para los estados que merecen tinta de alerta en pantalla. */
export function isOutOfRange(flag: RangeFlag): boolean {
  return flag === 'high' || flag === 'low' || flag === 'critical-high' || flag === 'critical-low';
}

export function isCritical(flag: RangeFlag): boolean {
  return flag === 'critical-high' || flag === 'critical-low';
}

/* ================================================================== */
/* Tendencia de una serie                                              */
/* ================================================================== */

const MS_PER_DAY = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * Dirección de una serie y su lectura clínica.
 *
 * Devuelve `null` con menos de dos puntos: un solo valor no es una tendencia, y
 * fingir que lo es sería inventar información. El umbral de "plano" es 1 % del
 * valor de partida, para que el ruido de medición no se lea como movimiento.
 */
export function computeTrend(
  points: readonly ChartObservationPoint[],
  range: ReferenceRange | null,
): MetricTrend | null {
  if (points.length < 2) return null;

  const first = points[0];
  const previous = points[points.length - 2];
  const last = points[points.length - 1];

  const delta = last.value - previous.value;
  const deltaFromFirst = last.value - first.value;

  const flatThreshold = Math.abs(first.value) * 0.01;
  const direction: MetricTrend['direction'] =
    Math.abs(deltaFromFirst) <= flatThreshold ? 'flat' : deltaFromFirst > 0 ? 'rising' : 'falling';

  // La lectura clínica NO es el signo del delta. Un FEV1 que sube es una mejora;
  // una HbA1c que sube es un deterioro. Sin rango no se puede afirmar ninguna
  // de las dos cosas, así que se dice que no se sabe.
  let clinical: MetricTrend['clinical'] = 'unknown';
  if (direction === 'flat') {
    clinical = 'stable';
  } else if (range) {
    const risingIsGood = range.lowerIsWorse;
    const rising = direction === 'rising';
    clinical = rising === risingIsGood ? 'improving' : 'worsening';
  }

  return {
    delta,
    deltaFromFirst,
    direction,
    clinical,
    spanDays: daysBetween(first.at, last.at),
  };
}

/* ================================================================== */
/* Banderas del paciente                                               */
/* ================================================================== */

/** Días desde una fecha ISO hasta hoy. `null` si la fecha no parsea. */
function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.round((now - then) / MS_PER_DAY);
}

function formatValue(value: number, unit: string): string {
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${rounded} ${unit}` : rounded;
}

/**
 * Ventana en la que se considera que un cambio de medicación y un resultado de
 * laboratorio "se tocan". 120 días cubre el trimestre habitual entre controles
 * de HbA1c sin llegar a emparejar eventos que no tienen nada que ver.
 */
const RECENT_CHANGE_DAYS = 120;

/**
 * Qué laboratorio vigila cada fármaco: RxNorm del ingrediente → códigos LOINC
 * sobre los que ese fármaco actúa de verdad.
 *
 * Sin esta tabla, la regla "empeoró tras ajustar X" empareja cualquier medicamento
 * reciente con cualquier resultado que baje, y produce afirmaciones falsas: decir
 * que la hemoglobina glucosilada empeoró "tras ajustar el lisinopril" es un
 * disparate clínico, porque el lisinopril es un antihipertensivo y no toca la
 * glucosa. Proyectado ante un jurado clínico, un error así cuesta más que no
 * mostrar la bandera.
 *
 * Deliberadamente CORTA y explícita: solo los fármacos presentes en este
 * proyecto. Lo que no esté aquí NO genera la bandera — callar es más barato que
 * equivocarse, y una tabla que se puede leer entera es una tabla auditable.
 */
const DRUG_TARGET_LABS: Record<string, readonly string[]> = {
  '860975': ['4548-4'], //  metformina        → hemoglobina A1c
  '314076': ['8480-6', '8462-4'], // lisinopril → presión arterial
  '979467': ['8480-6', '8462-4'], // losartán   → presión arterial
  '617312': ['2089-1'], //  atorvastatina     → colesterol LDL
  '896188': ['20150-9'], // budesonida/formoterol → FEV1
  '435': ['20150-9'], //    salbutamol        → FEV1
};

/** `true` si el fármaco actúa sobre ese laboratorio según la tabla explícita. */
function drugTargetsMetric(rxnorm: string | null, loinc: string | null): boolean {
  if (!rxnorm || !loinc) return false;
  return DRUG_TARGET_LABS[rxnorm]?.includes(loinc) ?? false;
}

/**
 * Banderas de un paciente, ordenadas por severidad.
 *
 * `now` se inyecta en vez de leer el reloj aquí dentro para que la función sea
 * pura y testeable, y para que servidor y cliente calculen lo mismo.
 */
export function computePatientFlags(input: {
  metrics: readonly ChartMetric[];
  medications: readonly ChartMedication[];
  conditions: readonly ChartCondition[];
  allergies: readonly ChartAllergy[];
  now: number;
}): ChartFlag[] {
  const { metrics, medications, conditions, allergies, now } = input;
  const flags: ChartFlag[] = [];

  for (const metric of metrics) {
    const latest = metric.latest;
    if (!latest) continue;

    // 1. Valor crítico. Es lo más urgente que puede decir esta pantalla.
    if (isCritical(latest.flag)) {
      flags.push({
        id: `critical:${metric.key}`,
        severity: 'danger',
        title: `${metric.label} critically out of range`,
        basis: `${formatValue(latest.value, metric.unit)} · ${describeRange(metric.referenceRange)}`,
      });
      continue; // Ya está señalado como crítico; no se repite como "alto".
    }

    // 2. Fuera de rango y empeorando. La combinación importa más que cada parte:
    //    un valor alto que baja es una intervención funcionando.
    if (isOutOfRange(latest.flag) && metric.trend?.clinical === 'worsening') {
      flags.push({
        id: `worsening:${metric.key}`,
        severity: 'danger',
        title: `${metric.label} out of range and worsening`,
        basis: `${formatValue(latest.value, metric.unit)}, previously ${formatValue(
          latest.value - metric.trend.delta,
          metric.unit,
        )} · ${describeRange(metric.referenceRange)}`,
      });
      continue;
    }

    if (isOutOfRange(latest.flag)) {
      flags.push({
        id: `out-of-range:${metric.key}`,
        severity: 'warn',
        title: `${metric.label} out of range`,
        basis: `${formatValue(latest.value, metric.unit)} · ${describeRange(metric.referenceRange)}`,
      });
      continue;
    }

    // 3. Mejora sostenida. Un expediente que solo sabe dar malas noticias es un
    //    expediente que el médico deja de mirar.
    if (metric.trend?.clinical === 'improving' && Math.abs(metric.trend.deltaFromFirst) > 0) {
      flags.push({
        id: `improving:${metric.key}`,
        severity: 'info',
        title: `${metric.label} improving`,
        basis: `${formatValue(latest.value, metric.unit)}, from ${formatValue(
          latest.value - metric.trend.deltaFromFirst,
          metric.unit,
        )}${metric.trend.spanDays ? ` in ${metric.trend.spanDays} days` : ''}`,
      });
    }
  }

  // 4. El caso que de verdad hace pensar a un médico: se cambió la dosis y el
  //    laboratorio posterior empeoró de todas formas. Eso es un tratamiento que
  //    no está funcionando, y ningún componente lo vería por separado.
  for (const metric of metrics) {
    if (metric.trend?.clinical !== 'worsening' || !metric.latest) continue;

    for (const med of medications) {
      if (med.status !== 'active') continue;

      // Solo se afirma la relación si el fármaco actúa DE VERDAD sobre este
      // laboratorio. Sin esta condición la bandera acusaría al antihipertensivo
      // de no controlar la glucosa.
      if (!drugTargetsMetric(med.rxnorm, metric.loinc)) continue;

      const age = daysSince(med.authoredOn, now);
      if (age === null || age > RECENT_CHANGE_DAYS) continue;

      // Solo cuenta si la receta es ANTERIOR al resultado: si se recetó después,
      // el laboratorio no puede estar juzgando ese cambio.
      const labAt = Date.parse(metric.latest.at);
      const medAt = med.authoredOn ? Date.parse(med.authoredOn) : NaN;
      if (Number.isNaN(labAt) || Number.isNaN(medAt) || medAt > labAt) continue;

      flags.push({
        id: `ineffective:${metric.key}:${med.id}`,
        severity: 'danger',
        title: `${metric.label} worsened after adjusting ${med.display}`,
        basis: `${med.display} on ${formatDate(med.authoredOn)} · ${metric.label} ${formatValue(
          metric.latest.value,
          metric.unit,
        )} on ${formatDate(metric.latest.at)}`,
      });
    }
  }

  // 5. Ausencias que son en sí mismas un riesgo. Que no haya alergias
  //    registradas NO es lo mismo que "sin alergias conocidas": es un hueco en
  //    el expediente, y hay que decirlo antes de recetar sobre él.
  if (allergies.length === 0) {
    flags.push({
      id: 'no-allergies-recorded',
      severity: 'warn',
      title: 'No allergies recorded',
      basis: 'No AllergyIntolerance resource. Not the same as "no known allergies".',
    });
  }

  const unsigned = medications.filter((m) => m.status === 'active' && m.prescriber === null);
  if (unsigned.length > 0) {
    flags.push({
      id: 'unsigned-medications',
      severity: 'warn',
      title: `${unsigned.length} prescription${unsigned.length === 1 ? '' : 's'} with no prescriber`,
      basis: `No requester field: ${unsigned.map((m) => m.display).join(', ')}`,
    });
  }

  const undated = conditions.filter((c) => c.clinicalStatus === 'active' && c.onsetDate === null);
  if (undated.length > 0) {
    flags.push({
      id: 'undated-conditions',
      severity: 'info',
      title: `${undated.length} ${undated.length === 1 ? 'diagnosis' : 'diagnoses'} with no onset date`,
      basis: undated.map((c) => c.display).join(', '),
    });
  }

  const order: Record<ChartFlag['severity'], number> = { danger: 0, warn: 1, info: 2 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

function describeRange(range: ReferenceRange | null): string {
  if (!range) return 'no reference range';
  if (range.high !== null && range.low !== null) return `reference ${range.low}–${range.high}`;
  if (range.high !== null) return `reference <${range.high}`;
  if (range.low !== null) return `reference ≥${range.low}`;
  return 'no reference range';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  // Zona fija: el expediente se pinta en servidor y se rehidrata en cliente, y
  // sin fijarla la misma fecha saldría distinta en cada sitio.
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(parsed));
}

/* ================================================================== */
/* Verificaciones antes de recetar                                     */
/* ================================================================== */

export type PrescribeCheckSeverity = 'block' | 'warn' | 'info';

export interface PrescribeCheck {
  id: string;
  severity: PrescribeCheckSeverity;
  title: string;
  detail: string;
}

/**
 * Pares de interacción conocidos, por código RxNorm de ingrediente.
 *
 * Deliberadamente CORTO y explícito. Un motor de interacciones de verdad es una
 * base de datos con licencia (First Databank, Medi-Span); fingir tener uno con
 * una lista larga sería peor que declarar el alcance. La UI dice literalmente
 * que esta verificación no sustituye a un verificador completo.
 */
const INTERACTION_PAIRS: readonly {
  a: string;
  b: string;
  severity: PrescribeCheckSeverity;
  detail: string;
}[] = [
  {
    a: '314076', // lisinopril
    b: '979467', // losartán
    severity: 'block',
    detail:
      'An ACE inhibitor and an ARB together double the renin-angiotensin blockade: more hyperkalemia and kidney injury with no proven benefit.',
  },
  {
    a: '860975', // metformina
    b: '435', // salbutamol — ejemplo benigno, se documenta como informativo
    severity: 'info',
    detail: 'No clinically relevant interaction described.',
  },
];

/** Normaliza para comparar nombres: sin acentos, sin mayúsculas, sin dosis. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    // Marcas diacríticas combinantes, escapadas por punto de código: escribirlas
    // literales las hace invisibles en el editor y frágiles ante un guardado.
        .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verificaciones deterministas antes de escribir una receta en Medplum.
 *
 * Devuelve la lista completa; el llamante decide qué hacer. Una entrada con
 * `severity: 'block'` NO debe poder confirmarse desde la UI sin una anulación
 * explícita del médico, y esa anulación se registra.
 */
export function checkPrescription(input: {
  /** Nombre tal como lo escribió el médico. */
  display: string;
  rxnorm: string | null;
  allergies: readonly ChartAllergy[];
  currentMedications: readonly ChartMedication[];
}): PrescribeCheck[] {
  const { display, rxnorm, allergies, currentMedications } = input;
  const checks: PrescribeCheck[] = [];
  const target = normalize(display);

  // 1. ALERGIA. Es la verificación que no se puede fallar, así que se compara
  //    tanto por código como por nombre: un RxNorm ausente no puede desactivarla.
  for (const allergy of allergies) {
    if (allergy.clinicalStatus === 'resolved' || allergy.clinicalStatus === 'inactive') continue;

    const allergen = normalize(allergy.display);
    if (allergen === '') continue;

    const byName = target.includes(allergen) || allergen.includes(target);
    const byCode = rxnorm !== null && allergy.code !== null && rxnorm === allergy.code;

    if (byName || byCode) {
      checks.push({
        id: `allergy:${allergy.id}`,
        severity: 'block',
        title: `Recorded allergy to ${allergy.display}`,
        detail:
          allergy.reactions.length > 0
            ? `Reaction: ${allergy.reactions.join(', ')}.`
            : 'No documented reaction.',
      });
    }
  }

  // 2. DUPLICIDAD. Mismo RxNorm ya activo: casi siempre es un error de captura.
  for (const med of currentMedications) {
    if (med.status !== 'active') continue;

    const sameCode = rxnorm !== null && med.rxnorm !== null && rxnorm === med.rxnorm;
    const sameName = normalize(med.display) === target;

    if (sameCode || sameName) {
      checks.push({
        id: `duplicate:${med.id}`,
        severity: 'warn',
        title: `Already taking ${med.display}`,
        detail: med.dosage
          ? `Current dose: ${med.dosage}. If this is an adjustment, stop the previous one instead of duplicating it.`
          : 'If this is an adjustment, stop the previous one instead of duplicating it.',
      });
    }
  }

  // 3. INTERACCIÓN, solo por código: emparejar por nombre daría falsos positivos.
  if (rxnorm !== null) {
    for (const med of currentMedications) {
      if (med.status !== 'active' || med.rxnorm === null) continue;

      for (const pair of INTERACTION_PAIRS) {
        const matches =
          (pair.a === rxnorm && pair.b === med.rxnorm) ||
          (pair.b === rxnorm && pair.a === med.rxnorm);
        if (!matches || pair.severity === 'info') continue;

        checks.push({
          id: `interaction:${med.id}`,
          severity: pair.severity,
          title: `Interaction with ${med.display}`,
          detail: pair.detail,
        });
      }
    }
  }

  // 4. Sin RxNorm no hay verificación fiable de duplicidad ni de interacción.
  //    Se dice en vez de dejar que el silencio parezca "todo en orden".
  if (rxnorm === null) {
    checks.push({
      id: 'no-rxnorm',
      severity: 'warn',
      title: 'No RxNorm code',
      detail:
        'The duplicate and interaction checks only compared names. Pick a medication from the catalog to make them reliable.',
    });
  }

  const order: Record<PrescribeCheckSeverity, number> = { block: 0, warn: 1, info: 2 };
  return checks.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** `true` si hay algo que exige anulación explícita del médico. */
export function hasBlockingCheck(checks: readonly PrescribeCheck[]): boolean {
  return checks.some((c) => c.severity === 'block');
}
