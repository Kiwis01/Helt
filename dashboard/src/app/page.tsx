import { BaselineChart } from '@/components/BaselineChart';
import { CoverageCard } from '@/components/CoverageCard';
import { DataSourceBadge } from '@/components/DataSourceBadge';
import { DemoControls } from '@/components/DemoControls';
import { LiveCallPanel } from '@/components/LiveCallPanel';
import { LiveCallProvider } from '@/components/LiveCallProvider';
import { OutcomesChart } from '@/components/OutcomesChart';
import { PatientHeader } from '@/components/PatientHeader';
import {
  aggregateSource,
  fetchEpisodes,
  fetchObservations,
  fetchOutcomes,
  fetchSummary,
} from '@/lib/core-client';
import { toDrawableSeries, type BaselineMetricKey, type DrawableSeries } from '@/lib/series';

/**
 * Sin prerender estático: loop-core puede estar apagado durante el build y
 * arriba durante el demo. Renderizar en cada petición es lo que hace que un
 * `router.refresh()` tras un spike —o tras un `episode.written`— traiga datos
 * nuevos de verdad.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // En paralelo: las lecturas del Contrato 4. Ninguna lanza —core-client
  // garantiza el fixture como suelo— así que no hace falta Promise.allSettled
  // ni un error boundary para esta ruta.
  const [summary, episodes, outcomes, heartRate, hrv, respiratoryRate] = await Promise.all([
    fetchSummary(),
    fetchEpisodes(),
    fetchOutcomes(),
    fetchObservations({ metric: 'heartRate' }),
    fetchObservations({ metric: 'hrv' }),
    fetchObservations({ metric: 'respiratoryRate' }),
  ]);

  const source = aggregateSource([summary, episodes, outcomes, heartRate, hrv, respiratoryRate]);

  // El submuestreo se hace aquí, en el servidor: las tres series suman ~9800
  // puntos y mandarlas enteras al navegador serían ~650 KB de payload RSC para
  // dibujar 1800. El selector de métrica queda instantáneo y sin estado de
  // carga porque las tres llegan ya listas.
  const series: Record<BaselineMetricKey, DrawableSeries> = {
    heartRate: toDrawableSeries(heartRate.data),
    hrv: toDrawableSeries(hrv.data),
    respiratoryRate: toDrawableSeries(respiratoryRate.data),
  };

  return (
    <main className="flex h-dvh min-h-[640px] flex-col overflow-hidden">
      {/*
        ----------------------------------------------------------------
        Barra superior: identidad, origen de los datos y control de demo.
        ----------------------------------------------------------------
      */}
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface px-5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-lg font-semibold tracking-[0.22em] text-accent">LOOP</span>
          <span className="truncate text-2xs uppercase tracking-[0.14em] text-ink-3">
            Vista clínica · compañero de voz de circuito cerrado
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <DataSourceBadge status={source} />
          <DemoControls />
        </div>
      </div>

      <PatientHeader summary={summary.data} />

      {/*
        ----------------------------------------------------------------
        Rejilla principal. Fracciones y `min-h-0` en cada nivel para que a
        1280x720 todo quepa sin scroll y sin recortes.

        `LiveCallProvider` no renderiza ningún nodo del DOM, así que las dos
        columnas siguen siendo hijas directas de la rejilla. Envuelve a las
        cuatro tarjetas porque tres dependen del mismo stream: el panel lo
        pinta, la tarjeta de cobertura se rellena con `coverage.check` y el
        gráfico de outcomes se repinta con `episode.written`.
        ----------------------------------------------------------------
      */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_24rem] gap-3 p-3">
        <LiveCallProvider>
          <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1.15fr)] gap-3">
            <BaselineChart series={series} episodes={episodes.data.episodes} />
            <OutcomesChart outcomes={outcomes.data} />
          </div>

          {/*
            Columna derecha en flex y no en rejilla de fracciones fijas: las dos
            tarjetas se llenan en momentos distintos del demo y sus alturas no
            se pueden repartir de antemano. La de cobertura crece a lo que mide
            su contenido —vacía ocupa poco, con la respuesta de Stedi ocupa lo
            que haga falta para que el `voiceSummary` se lea entero— y el panel
            en vivo se queda con el resto. Con reparto fijo, o se corta la frase
            que el paciente escuchó o se aplasta el transcript.
          */}
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <LiveCallPanel baseline={summary.data.baseline} />
            <CoverageCard />
          </div>
        </LiveCallProvider>
      </div>
    </main>
  );
}
