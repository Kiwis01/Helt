import { BaselineChart } from '@/components/BaselineChart';
import { CoverageCard } from '@/components/CoverageCard';
import { DataSourceBadge } from '@/components/DataSourceBadge';
import { DemoControls } from '@/components/DemoControls';
import { LiveCallPanel } from '@/components/LiveCallPanel';
import { LiveCallProvider } from '@/components/LiveCallProvider';
import { OutcomesChart } from '@/components/OutcomesChart';
import type { LoopPanelsData } from '@/lib/loop-panels';

/**
 * Loop dentro del expediente.
 *
 * Antes esto era una ruta hermana, `/loop`, con su propio paciente de demo. Eso
 * obligaba a saltar de pestaña para pasar del expediente clínico a la señal
 * continua del mismo paciente, y —peor— dejaba que las dos vistas hablaran de
 * personas distintas sin que nada en pantalla lo dijera. Ahora es una sección
 * más del expediente: se lee en el mismo scroll, bajo el mismo nombre.
 *
 * ## Los badges no son decoración
 *
 * Hay tres y ninguno sobra, porque esta pantalla mezcla tres orígenes. El de la
 * barra superior habla del expediente (Medplum). El de aquí habla de lo que
 * sirve loop-core: episodios y outcomes, hoy sintéticos. Y el gráfico lleva uno
 * POR MÉTRICA, porque el ritmo cardíaco ya sale de las Observations reales del
 * paciente mientras la HRV y la respiratoria siguen saliendo del fixture.
 *
 * Un solo semáforo para las tres cosas tendría que elegir entre mentir en verde
 * o desmerecer en ámbar. Cada badge pegado a lo que describe es lo que permite
 * señalar la línea del ritmo cardíaco y decir "esto es real" sin asteriscos.
 *
 * ## Altura
 *
 * La rejilla interna es la misma que tenía `/loop` a pantalla completa, con una
 * altura fija en lugar del `flex-1` de la ventana: el expediente hace scroll
 * vertical, así que aquí no hay una altura de ventana que repartir. Cada nivel
 * conserva sus `min-h-0` / `min-w-0` para que un panel que crece haga scroll
 * dentro de sí mismo en vez de empujar a sus vecinos.
 */
export function LoopSection({ data }: { data: LoopPanelsData }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex shrink-0 items-center gap-3">
        <h2 className="label">Loop · voice companion</h2>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <DataSourceBadge status={data.source} />
          <DemoControls />
        </div>
      </header>

      {/*
        Columna derecha a 25rem y no 24: el transcript es lo único de la
        pantalla que es texto corrido, y con burbujas al 88% de 384px las frases
        del paciente partían en tres líneas donde caben dos. Los 16px salen de
        la columna izquierda, que los tenía de sobra —el gráfico de baseline y
        el de outcomes son elásticos y ninguno tiene un ancho mínimo cerca—.
      */}
      <div className="grid h-[44rem] grid-cols-[minmax(0,1fr)_25rem] gap-3">
        {/*
          `LiveCallProvider` no renderiza ningún nodo del DOM, así que las dos
          columnas siguen siendo hijas directas de la rejilla. Envuelve a las
          cuatro tarjetas porque tres dependen del mismo stream: el panel lo
          pinta, la tarjeta de cobertura se rellena con `coverage.check` y el
          gráfico de outcomes se repinta con `episode.written`.
        */}
        <LiveCallProvider>
          <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1.15fr)] gap-3">
            <BaselineChart series={data.series} episodes={data.episodes} />
            <OutcomesChart outcomes={data.outcomes} />
          </div>

          {/*
            Columna derecha en flex y no en rejilla de fracciones fijas: las dos
            tarjetas se llenan en momentos distintos del demo y sus alturas no
            se pueden repartir de antemano. La de cobertura crece a lo que mide
            su contenido —vacía ocupa poco, con la respuesta de Stedi ocupa lo
            que haga falta— y el panel en vivo se queda con el resto.
          */}
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <LiveCallPanel baseline={data.baseline} />
            <CoverageCard />
          </div>
        </LiveCallProvider>
      </div>
    </section>
  );
}
