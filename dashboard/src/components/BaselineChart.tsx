'use client';

/**
 * Serie de 30 días con la banda de baseline detrás y los episodios marcados.
 *
 * Composición: un rail a la izquierda con EL número —el baseline de esta
 * persona— y la serie ocupando todo lo demás. El número manda; la línea lo
 * ilustra. Antes había un párrafo de pitch, una leyenda que repetía lo que el
 * gráfico ya decía y un contador de puntos dibujados: nada de eso era
 * información clínica.
 *
 * La banda es una `ReferenceArea` horizontal y no una `Area` de datos porque el
 * baseline del Contrato 4 es un único `mean ± sd` para toda la ventana, no una
 * serie: dibujarlo como área por punto sería inventar variación que el
 * contrato no tiene. Se pinta como atmósfera (fill muy bajo, sin borde y sin
 * línea de media) para que no compita con la serie real.
 *
 * Los episodios se marcaban con globos numerados que llenaban la mitad superior
 * del área de dibujo. Ahora cada uno es un hilo fino rematado por un punto de
 * 2.5 px, y el detalle —duración, desenlace, pico, intervención— vive en el
 * tooltip, que es donde se pregunta por él.
 */

import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { EpisodeListItem } from '@loop/shared/contracts';

import { Card, EmptyState } from '@/components/Card';
import { DATA, FLOATING_SURFACE, STAT } from '@/components/tokens';
import {
  formatDateShort,
  formatDateTime,
  formatDuration,
  formatMetric,
  formatSd,
  labelMetric,
  labelOutcome,
  METRIC_SHORT,
} from '@/lib/format';
import { BASELINE_METRICS, type BaselineMetricKey, type DrawableSeries } from '@/lib/series';

const SERIES_COLOR: Record<BaselineMetricKey, string> = {
  heartRate: 'var(--chart-hr)',
  hrv: 'var(--chart-hrv)',
  respiratoryRate: 'var(--chart-rr)',
};

const DAY_MS = 86_400_000;

/** La respiratoria es la única que se mide con decimal. */
const digitsFor = (metric: BaselineMetricKey): number => (metric === 'respiratoryRate' ? 1 : 0);

/**
 * Cuánto margen se le da a un episodio para reclamar el cursor.
 *
 * A ~600 puntos dibujados sobre 30 días cada punto cubre ~72 min, así que el
 * punto más cercano a un marcador puede estar a media hora de él. Sin esta
 * tolerancia, poner el cursor justo encima de la marca del episodio enseñaría
 * el tooltip genérico y la marca parecería no hacer nada.
 */
const EPISODE_HOVER_TOLERANCE_MS = 60 * 60_000;

interface EpisodeMark {
  episode: EpisodeListItem;
  start: number;
  end: number;
}

/**
 * Paso "redondo" para el eje Y.
 *
 * Recharts reparte el dominio en partes iguales, así que un rango de 87 bpm
 * sale como 43 · 64,75 · 86,5 · 130. En una pantalla que se lee desde el fondo
 * de una sala eso cuesta más de descifrar que un eje con menos marcas pero
 * redondas, así que las marcas se calculan aquí y el dominio se deja pegado a
 * los datos para no desperdiciar alto.
 */
function niceStep(range: number, targetTicks: number): number {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const rough = range / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const factor of [1, 2, 2.5, 5]) {
    if (factor * magnitude >= rough) return factor * magnitude;
  }
  return 10 * magnitude;
}

/* ------------------------------------------------------------------ */
/* Marca de episodio                                                   */
/* ------------------------------------------------------------------ */

interface LabelViewBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Recharts llama a esta función con el `viewBox` de la línea de referencia: para
 * una línea vertical es `{ x, y: arriba del área de dibujo, width: 0, height }`.
 * Se devuelve siempre un `<g>` (vacío si no hay viewBox) porque el tipo del
 * prop `label` no admite `null`.
 */
function renderEpisodeDot(escalated: boolean) {
  return function EpisodeDot(props: { viewBox?: LabelViewBox }) {
    const x = props.viewBox?.x;
    const y = props.viewBox?.y;
    if (x === undefined || y === undefined) return <g />;

    return (
      <circle
        cx={x}
        cy={y}
        r={escalated ? 3.2 : 2.5}
        fill={escalated ? 'var(--danger)' : 'var(--chart-episode)'}
        fillOpacity={escalated ? 1 : 0.85}
      />
    );
  };
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

interface BaselineTooltipProps {
  marks: readonly EpisodeMark[];
  series: DrawableSeries;
  metric: BaselineMetricKey;
  /** Los inyecta Recharts al clonar el elemento. */
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ value?: number | string }>;
}

function BaselineTooltip({ marks, series, metric, active, label, payload }: BaselineTooltipProps) {
  if (!active) return null;

  const t = typeof label === 'number' ? label : Number(label);
  if (!Number.isFinite(t)) return null;

  const raw = payload?.[0]?.value;
  const value = typeof raw === 'number' ? raw : Number(raw);

  const mark = marks.find(
    (m) => t >= m.start - EPISODE_HOVER_TOLERANCE_MS && t <= m.end + EPISODE_HOVER_TOLERANCE_MS,
  );

  const sd =
    series.baseline.sd > 0 && Number.isFinite(value)
      ? (value - series.baseline.mean) / series.baseline.sd
      : null;

  return (
    /* Sombra flotante, no otra capa de vidrio: el tooltip se posa SOBRE una
       tarjeta de vidrio y apilar dos blurs ensucia el fondo. */
    <div
      className="max-w-[17rem] rounded-tile border border-hair px-3 py-2.5"
      style={{
        background: FLOATING_SURFACE,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <p className="text-2xs text-ink-3">{formatDateTime(new Date(t).toISOString())}</p>

      {Number.isFinite(value) ? (
        <p className="mt-1.5 flex items-baseline gap-2">
          <span className={`${STAT} text-ink`}>
            {formatMetric(value, series.unit, digitsFor(metric))}
          </span>
          {sd !== null ? <span className="text-2xs text-ink-3">{formatSd(sd)}</span> : null}
        </p>
      ) : null}

      {mark ? (
        <div className="mt-2.5 border-t border-hair pt-2.5">
          <p className="flex items-baseline gap-2">
            <span className={`${DATA} font-semibold text-ink`}>
              {formatDuration(mark.episode.durationMinutes)}
            </span>
            <span className="text-2xs text-ink-2">{labelOutcome(mark.episode.outcome)}</span>
          </p>
          <p className="mt-1 text-2xs text-ink-3">
            pico {mark.episode.peakHeartRate} bpm
            {mark.episode.minHrv !== null ? ` · HRV mín. ${mark.episode.minHrv} ms` : ''}
          </p>
          {mark.episode.interventions.length > 0 ? (
            <p className="mt-0.5 text-2xs text-ink-3">
              {mark.episode.interventions.map((i) => i.title).join(' · ')}
            </p>
          ) : null}
          {mark.episode.escalation.triggered ? (
            <span className="pill pill-danger mt-2">escalado</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componente                                                          */
/* ------------------------------------------------------------------ */

interface BaselineChartProps {
  series: Record<BaselineMetricKey, DrawableSeries>;
  episodes: readonly EpisodeListItem[];
}

export function BaselineChart({ series, episodes }: BaselineChartProps) {
  const [metric, setMetric] = useState<BaselineMetricKey>('heartRate');
  const active = series[metric];
  const digits = digitsFor(metric);

  const marks = useMemo<EpisodeMark[]>(
    () =>
      episodes
        .map((episode) => ({
          episode,
          start: Date.parse(episode.startedAt),
          end: Date.parse(episode.endedAt),
        }))
        .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end)),
    [episodes],
  );

  /**
   * El extremo del periodo, con su fecha. En HRV lo relevante es la caída
   * (mínimo); en las otras dos, el pico. El submuestreo es min/max por tramo,
   * así que el extremo dibujado es literalmente el de la serie completa: por
   * eso este número se puede enseñar sin asteriscos.
   */
  const extreme = useMemo(() => {
    if (active.points.length === 0) return null;
    let best = active.points[0];
    for (const point of active.points) {
      const better = metric === 'hrv' ? point.v < best.v : point.v > best.v;
      if (better) best = point;
    }
    return best;
  }, [active.points, metric]);

  const { yDomain, yTicks, xTicks } = useMemo(() => {
    const { points, baseline } = active;
    if (points.length === 0) {
      return { yDomain: [0, 1] as [number, number], yTicks: [] as number[], xTicks: [] as number[] };
    }

    let lo = baseline.mean - baseline.sd;
    let hi = baseline.mean + baseline.sd;
    for (const p of points) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    const pad = Math.max(1, (hi - lo) * 0.08);
    const low = Math.floor(lo - pad);
    const high = Math.ceil(hi + pad);

    const step = niceStep(high - low, 4);
    const ticks: number[] = [];
    for (let v = Math.ceil(low / step) * step; v <= high; v += step) {
      ticks.push(Math.round(v * 100) / 100);
    }

    // Una marca cada 5 días, alineada a medianoche UTC como el resto del
    // formateo — así el eje no baila según la zona horaria de la máquina.
    const first = points[0].t;
    const last = points[points.length - 1].t;
    const days: number[] = [];
    for (let t = Math.ceil(first / DAY_MS) * DAY_MS; t <= last; t += 5 * DAY_MS) days.push(t);

    return { yDomain: [low, high] as [number, number], yTicks: ticks, xTicks: days };
  }, [active]);

  const bandLow = active.baseline.mean - active.baseline.sd;
  const bandHigh = active.baseline.mean + active.baseline.sd;

  return (
    <Card
      title="Baseline"
      subtitle="30 días"
      index={2}
      bodyClassName="flex min-h-0 gap-4 px-5 pb-4"
      actions={BASELINE_METRICS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => setMetric(key)}
          aria-pressed={key === metric}
          title={labelMetric(key)}
          data-on={key === metric}
          className="ghostbtn px-2.5 py-1"
        >
          {METRIC_SHORT[key] ?? key}
        </button>
      ))}
    >
      {/* --- rail del número héroe ---

          La unidad va DEBAJO de la cifra, no pegada a ella: "breaths/min" es
          casi tan ancho como el rail entero y colgado del número se metía
          encima del gráfico. Así el héroe es siempre solo la cifra, mida lo que
          mida la unidad, y de paso la unidad deja de escribirse dos veces. */}
      <div className="flex w-[146px] shrink-0 flex-col">
        {/* "media" y no "baseline": la tarjeta ya se llama Baseline y repetirlo
            aquí era decir dos veces lo mismo a dos tamaños distintos. Además es
            más exacto — lo que se pinta es `baseline.mean`. */}
        <p className="label leading-none">media</p>
        <p className="hero mt-2">{active.baseline.mean.toFixed(digits)}</p>
        <p className="mt-2 text-2xs leading-tight text-ink-3">
          {active.unit} · ± {active.baseline.sd.toFixed(digits)}
        </p>

        {/* Tesela y no otra caja de vidrio: agrupar dentro de un panel se hace
            con un relleno plano, nunca apilando superficies.

            El extremo lleva su fecha porque es lo que lo ata a un punto
            concreto de la serie. El recuento de episodios no está aquí: ya lo
            dicen las marcas del gráfico y la cabecera del paciente. */}
        <div className="tile mt-auto flex shrink-0 flex-col px-3 py-2.5">
          <p className="label leading-none">
            {metric === 'hrv' ? 'mínimo' : 'pico'} del periodo
          </p>
          <p className={`mt-2 ${STAT} text-ink`}>
            {extreme === null ? '—' : extreme.v.toFixed(digits)}
          </p>
          <p className="mt-1.5 text-2xs leading-tight text-ink-3">
            {active.unit} · {extreme === null ? '—' : formatDateShort(new Date(extreme.t).toISOString())}
          </p>
        </div>
      </div>

      {/* --- serie --- */}
      {active.points.length === 0 ? (
        <div className="min-h-0 min-w-0 flex-1">
          <EmptyState>Sin observaciones en esta ventana</EmptyState>
        </div>
      ) : (
        <div
          className="min-h-0 min-w-0 flex-1"
          /* La telemetría del submuestreo no es información clínica, pero
             ocultarla del todo sería mentir sobre lo que se está dibujando:
             vive en el title nativo, a un hover de distancia. */
          title={`${active.sourcePoints.toLocaleString('es-ES')} observaciones · ${active.points.length} dibujadas (min/máx por tramo)`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={active.points} margin={{ top: 10, right: 6, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />

              {/* Atmósfera del baseline: mean ± sd, sin borde y sin línea de
                  media para que no se lea como una segunda serie. Se tiñe del
                  color de la métrica activa, no de un azul fijo, para que la
                  banda siga perteneciendo a la serie que hay encima. */}
              <ReferenceArea
                y1={bandLow}
                y2={bandHigh}
                fill={SERIES_COLOR[metric]}
                fillOpacity={0.13}
                stroke="none"
                ifOverflow="extendDomain"
              />

              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                ticks={xTicks}
                tickFormatter={(value: number) => formatDateShort(new Date(value).toISOString())}
                tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: 'var(--hair)' }}
                minTickGap={20}
              />
              <YAxis
                domain={yDomain}
                ticks={yTicks}
                width={34}
                tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />

              {/* Marcas de episodio: hilo fino + punto. Van después de los ejes
                  para quedar sobre la rejilla y bajo el tooltip. */}
              {marks.map((mark) => (
                <ReferenceLine
                  key={mark.episode.encounterId}
                  x={mark.start}
                  stroke={
                    mark.episode.escalation.triggered ? 'var(--danger)' : 'var(--chart-episode)'
                  }
                  strokeOpacity={mark.episode.escalation.triggered ? 0.5 : 0.22}
                  strokeWidth={1}
                  label={renderEpisodeDot(mark.episode.escalation.triggered)}
                />
              ))}

              <Tooltip
                cursor={{ stroke: 'var(--hair)', strokeWidth: 1 }}
                wrapperStyle={{ outline: 'none' }}
                content={<BaselineTooltip marks={marks} series={active} metric={metric} />}
              />

              <Line
                type="monotone"
                dataKey="v"
                stroke={SERIES_COLOR[metric]}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                // Con ~600 puntos la animación de entrada tarda más que el propio
                // render y hace que la vista de apertura del demo parezca lenta.
                isAnimationActive={false}
                name={labelMetric(metric)}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
