import { BaselineChart } from '@/components/BaselineChart';
import { CoverageCard } from '@/components/CoverageCard';
import { DataSourceBadge } from '@/components/DataSourceBadge';
import { DemoControls } from '@/components/DemoControls';
import { LiveCallPanel } from '@/components/LiveCallPanel';
import { LiveCallProvider } from '@/components/LiveCallProvider';
import { AppNav } from '@/components/nav/AppNav';
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

        Sin subtítulo. Lo que había era una nota del pitch —"vista clínica ·
        compañero de voz de circuito cerrado"— en versalitas con tracking
        ancho: ocho palabras que no le dicen nada a un clínico, y encima la
        primera línea que se leía en toda la pantalla. El wordmark solo basta
        como identidad.

        Transparente sobre la aurora: llevaba una clase `bg-surface` que no
        existe en el tema, así que no generaba ninguna regla y la franja ya
        estaba transparente de hecho. Ahora lo está a propósito. Una quinta
        superficie de vidrio aquí solo competiría con los cuatro paneles.
        ----------------------------------------------------------------
      */}
      {/*
        Antes esta franja llevaba solo el wordmark y los controles de demo: no
        tenía UN SOLO enlace, así que desde aquí no se podía volver al
        expediente sin el botón atrás del navegador. Ahora es la misma barra
        que las otras dos vistas —wordmark, control segmentado de mundo— con
        las acciones propias de esta pantalla a la derecha.
      */}
      <AppNav
        actions={
          <>
            <DataSourceBadge status={source} />
            <DemoControls />
          </>
        }
      />

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
            que haga falta— y el panel en vivo se queda con el resto.

            Quién cede el alto cuando no caben las dos: la cobertura, y solo por
            su zona de scroll. Su héroe (el copago) y su pie viven fuera de esa
            zona, así que ceder nunca puede recortarlos. El panel en vivo, en
            cambio, reclama un suelo cuando hay una regla disparada: una barrera
            de escalación a medio pintar no es una opción.
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
