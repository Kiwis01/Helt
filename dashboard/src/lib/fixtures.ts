/**
 * Fixtures de `shared/fixtures/`, importados estáticamente.
 *
 * Van al bundle a propósito, no por comodidad: el modo respaldo tiene que
 * funcionar con el wifi caído y con loop-core apagado. Son ~650 KB de JSON
 * (las series de 30 días son 3255 puntos cada una), un coste aceptable para
 * una app que corre en localhost delante de un proyector.
 *
 * `shared/` es de SOLO LECTURA. Estos archivos los genera y valida Kiwis con
 * `npm run fixtures:validate` desde la raíz.
 */

import type {
  EpisodeList,
  ObservationMetric,
  ObservationSeries,
  OutcomesSummary,
  PatientSummary,
  CoverageCheckResponse,
} from '@loop/shared/contracts';

import summaryJson from '@loop/shared/fixtures/summary.sample.json';
import episodesJson from '@loop/shared/fixtures/episodes.sample.json';
import outcomesJson from '@loop/shared/fixtures/outcomes.sample.json';
import heartRateJson from '@loop/shared/fixtures/observations.heartRate.json';
import hrvJson from '@loop/shared/fixtures/observations.hrv.json';
import respiratoryRateJson from '@loop/shared/fixtures/observations.respiratoryRate.json';
import sleepHoursJson from '@loop/shared/fixtures/observations.sleepHours.json';
import coverageCoveredJson from '@loop/shared/fixtures/coverage.covered.json';

/**
 * TypeScript infiere de un JSON los tipos abiertos (`string`), no las uniones
 * cerradas del contrato (`'active' | 'remission' | 'resolved'`), así que el
 * doble cast es inevitable. Es seguro porque `npm run fixtures:validate`
 * comprueba cada archivo contra su esquema zod antes de que nadie construya
 * encima — y core-client vuelve a validar lo que llega por red.
 */
const asContract = <T>(raw: unknown): T => raw as T;

export const FIXTURE_SUMMARY = asContract<PatientSummary>(summaryJson);
export const FIXTURE_EPISODES = asContract<EpisodeList>(episodesJson);
export const FIXTURE_OUTCOMES = asContract<OutcomesSummary>(outcomesJson);
export const FIXTURE_COVERAGE = asContract<CoverageCheckResponse>(coverageCoveredJson);

/** Una serie por métrica del Contrato 4. Cubre las cuatro del enum. */
export const FIXTURE_OBSERVATIONS: Record<ObservationMetric, ObservationSeries> = {
  heartRate: asContract<ObservationSeries>(heartRateJson),
  hrv: asContract<ObservationSeries>(hrvJson),
  respiratoryRate: asContract<ObservationSeries>(respiratoryRateJson),
  sleepHours: asContract<ObservationSeries>(sleepHoursJson),
};
