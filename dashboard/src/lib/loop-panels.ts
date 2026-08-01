/**
 * Lecturas de los paneles de Loop, en una sola tanda.
 *
 * Vive aparte del componente por la misma razón que `chart/read.ts`: la página
 * necesita los datos Y el origen de los datos, y el origen sube a un badge que
 * se pinta al lado del encabezado de la sección. Un componente que se
 * autoabastece no puede contar de dónde vino lo que enseña.
 *
 * ## Orden de preferencia de las series
 *
 * **Medplum primero, fixture solo si falta.** Las Observations del expediente
 * son las del paciente de verdad; el fixture son 3255 puntos que generó un
 * script. Cada serie recuerda cuál de las dos cosas es, porque conviven: hoy el
 * ritmo cardíaco existe en Medplum y la HRV no, y la pantalla tiene que poder
 * decir eso exactamente, no un promedio de las dos verdades.
 *
 * Ninguna de estas lecturas lanza —`core-client` y `medplumRead` garantizan el
 * fixture como suelo—, así que la sección no necesita error boundary ni estados
 * de carga.
 */

import type { EpisodeListItem, OutcomesSummary, PatientSummary } from '@loop/shared/contracts';

import {
  aggregateSource,
  fetchEpisodes,
  fetchObservations,
  fetchOutcomes,
  fetchSummary,
  type DataResult,
} from './core-client';
import { readVitals } from './medplum/vitals';
import {
  BASELINE_METRICS,
  toDrawableSeries,
  type BaselineMetricKey,
  type DrawableSeries,
} from './series';

export interface LoopPanelsData {
  series: Record<BaselineMetricKey, DrawableSeries>;
  episodes: EpisodeListItem[];
  outcomes: OutcomesSummary;
  /** Referencia biométrica del paciente. La consume el panel de llamada. */
  baseline: PatientSummary['baseline'];
  /**
   * Origen de lo que NO es serie: episodios, outcomes y baseline del resumen.
   * Las series llevan el suyo propio porque pueden diferir entre ellas.
   */
  source: DataResult<null>;
}

export async function readLoopPanels(patientId: string): Promise<LoopPanelsData> {
  const [summary, episodes, outcomes, heartRate, hrv, respiratoryRate, vitals] = await Promise.all([
    fetchSummary(),
    fetchEpisodes(),
    fetchOutcomes(),
    fetchObservations({ metric: 'heartRate' }),
    fetchObservations({ metric: 'hrv' }),
    fetchObservations({ metric: 'respiratoryRate' }),
    readVitals(patientId),
  ]);

  const fromCore = { heartRate, hrv, respiratoryRate };

  // El submuestreo se hace aquí, en el servidor: el fixture son ~3255 puntos
  // por métrica y mandarlos enteros al navegador serían ~650 KB de payload RSC
  // para dibujar 600. El selector de métrica queda instantáneo y sin estado de
  // carga porque las tres llegan ya listas.
  const series = Object.fromEntries(
    BASELINE_METRICS.map((metric) => {
      const real = vitals.series[metric];
      return [
        metric,
        real
          ? toDrawableSeries(real, 'medplum')
          : toDrawableSeries(fromCore[metric].data, 'fixture'),
      ];
    }),
  ) as Record<BaselineMetricKey, DrawableSeries>;

  return {
    series,
    episodes: episodes.data.episodes,
    outcomes: outcomes.data,
    baseline: summary.data.baseline,
    source: aggregateSource([summary, episodes, outcomes]),
  };
}
