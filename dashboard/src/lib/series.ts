/**
 * Preparación de las series de observaciones para dibujarlas.
 *
 * Las series de 30 días traen ~3255 puntos y el panel mide unos 850 px: pintar
 * el punto 3200 no aporta nada y sí cuesta. Lo delicado no es reducir, es
 * decidir QUÉ punto se tira.
 *
 * Por eso el algoritmo es min/max por tramo y no LTTB: se parte la serie en N
 * tramos y de cada uno se conservan su mínimo y su máximo, en orden temporal.
 * Es la única familia de submuestreo que GARANTIZA que ningún extremo local
 * desaparece. Importa porque el `peakHeartRate` que declara cada episodio en
 * `episodes.sample.json` es el máximo de la serie dentro de su ventana: si el
 * submuestreo se lo come, el marcador vertical del episodio cae sobre una
 * línea plana y la primera vista del pitch deja de sostener lo que dice.
 * LTTB conserva la silueta, pero puede suavizar justo ese pico —y también las
 * caídas de HRV, que son mínimos.
 */

import type {
  BaselineMetric,
  ObservationMetric,
  ObservationPoint,
  ObservationSeries,
} from '@loop/shared/contracts';

/** Las tres métricas que el selector del gráfico de baseline ofrece. */
export const BASELINE_METRICS = ['heartRate', 'hrv', 'respiratoryRate'] as const;
export type BaselineMetricKey = (typeof BASELINE_METRICS)[number];

/**
 * Presupuesto de puntos dibujados. Con ~850 px de ancho salen a 1.4 px por
 * punto: por debajo de eso ya no se distingue nada a simple vista.
 */
export const DRAWN_POINT_BUDGET = 600;

export interface DrawablePoint {
  /** Época en ms. El eje X es numérico para poder situar los episodios por fecha. */
  t: number;
  v: number;
}

/**
 * De dónde salió una serie concreta.
 *
 * Va por serie y no por pantalla porque conviven: el ritmo cardíaco puede venir
 * de Medplum mientras la HRV sigue siendo sintética, y un único badge arriba no
 * puede decir las dos cosas a la vez. El selector del gráfico cambia de métrica
 * sin recargar nada, así que el origen tiene que viajar pegado a la serie.
 */
export type SeriesSource = 'medplum' | 'fixture';

export interface DrawableSeries {
  metric: ObservationMetric;
  unit: string;
  bucket: string;
  baseline: BaselineMetric;
  points: DrawablePoint[];
  /** Puntos que traía la serie original. La UI lo enseña: submuestrear a escondidas es engañar. */
  sourcePoints: number;
  source: SeriesSource;
}

/** ISO → época. Un punto con fecha o valor no finito se descarta en vez de meter un NaN que rompe el eje entero. */
function toDrawablePoints(points: readonly ObservationPoint[]): DrawablePoint[] {
  const out: DrawablePoint[] = [];
  for (const point of points) {
    const t = Date.parse(point.t);
    if (Number.isFinite(t) && Number.isFinite(point.v)) out.push({ t, v: point.v });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Submuestreo que conserva los extremos.
 *
 * Los índices que se van guardando son monótonos crecientes (los tramos van en
 * orden y dentro de cada tramo se emite primero el que ocurre antes), así que
 * basta comparar con el último guardado para no repetir puntos.
 */
export function downsampleExtremes(
  points: readonly DrawablePoint[],
  budget: number = DRAWN_POINT_BUDGET,
): DrawablePoint[] {
  if (budget < 4 || points.length <= budget) return points.slice();

  const buckets = Math.floor(budget / 2);
  const size = points.length / buckets;
  const kept: number[] = [];

  const keep = (index: number): void => {
    if (kept[kept.length - 1] !== index) kept.push(index);
  };

  // Primero y último se fijan siempre: son los que definen el dominio del eje.
  keep(0);

  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * size);
    const end = Math.min(points.length, Math.floor((bucket + 1) * size));
    if (end <= start) continue;

    let lowest = start;
    let highest = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i].v < points[lowest].v) lowest = i;
      if (points[i].v > points[highest].v) highest = i;
    }

    keep(Math.min(lowest, highest));
    keep(Math.max(lowest, highest));
  }

  keep(points.length - 1);

  return kept.map((index) => points[index]);
}

export function toDrawableSeries(
  series: ObservationSeries,
  source: SeriesSource,
  budget: number = DRAWN_POINT_BUDGET,
): DrawableSeries {
  return {
    metric: series.metric,
    unit: series.unit,
    bucket: series.bucket,
    baseline: series.baseline,
    points: downsampleExtremes(toDrawablePoints(series.points), budget),
    sourcePoints: series.points.length,
    source,
  };
}
