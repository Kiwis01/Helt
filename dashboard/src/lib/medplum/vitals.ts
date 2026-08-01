/**
 * Signos vitales del paciente, leídos de Medplum — SOLO SERVIDOR.
 *
 * Es la pieza que quita el ritmo cardíaco del terreno de lo inventado. El
 * fixture de `shared/fixtures/observations.heartRate.json` son 3255 puntos
 * sintéticos generados por `generate.mjs`; esto son las Observations que el
 * paciente tiene DE VERDAD en el expediente, con su cadencia real y su número
 * real de lecturas, sean cinco o cinco mil.
 *
 * ## Qué se devuelve y qué no
 *
 * Solo las métricas que Medplum tiene. Una métrica sin observaciones NO sale en
 * el mapa —no sale vacía, ni sale con ceros—, y el llamante decide si cae al
 * fixture y lo declara. Devolver una serie vacía disfrazada de real sería el
 * peor de los dos fallos posibles: un gráfico plano que parece un paciente en
 * calma cuando en realidad es un paciente sin datos.
 *
 * ## La baseline se calcula, no se hereda
 *
 * `mean` y `sd` salen de los propios puntos. Es tentador reutilizar los del
 * fixture —quedan más redondos— pero entonces la banda de referencia del
 * gráfico describiría a otra persona, y es justo la banda contra la que el ojo
 * juzga si un valor está alto. Con una sola lectura no hay dispersión que medir
 * y `sd` vale 0: la banda se degenera en una línea, que es exactamente lo
 * honesto cuando no hay con qué comparar.
 */

import 'server-only';

import type { Observation } from '@medplum/fhirtypes';

import { LOINC } from '@loop/shared/constants';
import type { ObservationSeries } from '@loop/shared/contracts';

import type { BaselineMetricKey } from '../series';
import { aggregateChartSource, medplumRead, type ChartResult } from './server';

/** LOINC de cada métrica del selector del gráfico. */
const LOINC_BY_METRIC: Record<BaselineMetricKey, string> = {
  heartRate: LOINC.heartRate,
  hrv: LOINC.heartRateVariability,
  respiratoryRate: LOINC.respiratoryRate,
};

/**
 * Unidad que se pinta bajo el número héroe.
 *
 * FHIR trae la unidad que escribió quien sembró el dato —"beats/minute",
 * "/min", "bpm" para lo mismo—, así que se normaliza a la del contrato. No es
 * cosmético: la unidad se muestra pegada a la cifra y tres formas distintas de
 * decir lo mismo en tres sesiones distintas se leen como un bug.
 */
const CANONICAL_UNIT: Record<BaselineMetricKey, string> = {
  heartRate: 'bpm',
  hrv: 'ms',
  respiratoryRate: 'breaths/min',
};

const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;

export interface VitalsResult {
  /** Solo las métricas que Medplum tiene. Las demás no aparecen. */
  series: Partial<Record<BaselineMetricKey, ObservationSeries>>;
  /** Origen de la lectura, para el badge. */
  source: ChartResult<null>;
}

/* ================================================================== */
/* Utilidades                                                          */
/* ================================================================== */

/** Media y desviación estándar muestral de la propia serie. */
function baselineOf(values: readonly number[]): { mean: number; sd: number } {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (values.length < 2) return { mean: round1(mean), sd: 0 };

  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean: round1(mean), sd: round1(Math.sqrt(variance)) };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Cadencia real de la serie, descrita para la UI.
 *
 * Se usa la MEDIANA de los intervalos y no la media porque un solo hueco
 * —un fin de semana sin sincronizar el reloj— arrastraría la media y haría
 * pasar por diaria una serie que es horaria.
 */
function bucketOf(timestamps: readonly number[]): string {
  if (timestamps.length < 2) return 'single reading';

  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  if (median >= 7 * DAY_MS) return '1w';
  if (median >= DAY_MS) return '1d';
  if (median >= 3_600_000) return `${Math.round(median / 3_600_000)}h`;
  return `${Math.max(1, Math.round(median / 60_000))}m`;
}

/** Instante de una Observation, con los tres campos que FHIR permite usar. */
function instantOf(resource: Observation): number | null {
  const raw = resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ================================================================== */
/* Lectura                                                             */
/* ================================================================== */

/**
 * Series de signos vitales del paciente. **Nunca lanza**: si Medplum no
 * responde devuelve el mapa vacío y lo dice en `source`, y el llamante cae al
 * fixture como haría con cualquier otra lectura degradada.
 *
 * Una sola búsqueda para las tres métricas en vez de tres: son pocos recursos y
 * el reparto en memoria sale más barato que tres viajes de red en una pantalla
 * que se proyecta en vivo.
 */
export async function readVitals(patientId: string): Promise<VitalsResult> {
  const codes = Object.values(LOINC_BY_METRIC)
    .map((code) => `http://loinc.org|${code}`)
    .join(',');

  const observations = await medplumRead<Observation[]>(
    (medplum) =>
      medplum
        .searchResources('Observation', {
          subject: `Patient/${patientId}`,
          code: codes,
          _count: PAGE_SIZE,
        })
        .then((r) => [...r]),
    [],
  );

  const series: Partial<Record<BaselineMetricKey, ObservationSeries>> = {};

  for (const [metric, loinc] of Object.entries(LOINC_BY_METRIC) as [
    BaselineMetricKey,
    string,
  ][]) {
    const points = observations.data
      .filter((o) => (o.code?.coding ?? []).some((c) => c.code === loinc))
      .flatMap((o) => {
        const t = instantOf(o);
        const v = o.valueQuantity?.value;
        // Un punto sin fecha o sin cifra se descarta en vez de colarse como
        // NaN, que rompería el eje entero del gráfico.
        return t !== null && typeof v === 'number' ? [{ t, v }] : [];
      })
      .sort((a, b) => a.t - b.t);

    if (points.length === 0) continue;

    series[metric] = {
      metric,
      unit: CANONICAL_UNIT[metric],
      bucket: bucketOf(points.map((p) => p.t)),
      baseline: { ...baselineOf(points.map((p) => p.v)), unit: CANONICAL_UNIT[metric] },
      points: points.map((p) => ({ t: new Date(p.t).toISOString(), v: p.v })),
    };
  }

  return { series, source: aggregateChartSource([observations]) };
}
