'use client';

/**
 * Serie de 30 días con la banda de baseline detrás y los episodios marcados.
 *
 * Es el primer plano del demo y sostiene una frase: *estos datos ya existen,
 * solo que no están en ningún lugar útil*. Para que la frase se sostenga tienen
 * que verse tres cosas a la vez: el rango normal de esta persona, la línea real
 * de su wearable, y en qué momentos exactos se salió de ese rango.
 *
 * La banda es una `ReferenceArea` horizontal y no una `Area` de datos porque el
 * baseline del Contrato 4 es un único `mean ± sd` para toda la ventana, no una
 * serie: dibujarlo como área por punto sería inventar variación que el
 * contrato no tiene.
 *
 * El tooltip es uno solo y decide qué contar según dónde esté el cursor. Si el
 * punto cae dentro (o cerca) de un episodio, cuenta el episodio; si no, cuenta
 * el valor y a cuántas desviaciones está del baseline. Un tooltip aparte para
 * los marcadores obligaría a competir con el de la serie y a solaparse.
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

import { Card } from '@/components/Card';
import {
  EMPTY,
  formatBaselineBand,
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

/**
 * Cuánto margen se le da a un episodio para reclamar el cursor.
 *
 * A 600 puntos dibujados sobre 30 días cada punto cubre ~72 min, así que el
 * punto más cercano a un marcador puede estar a media hora de él. Sin esta
 * tolerancia, poner el cursor justo encima de la línea del episodio enseñaría
 * el tooltip genérico y el marcador parecería no hacer nada.
 */
const EPISODE_HOVER_TOLERANCE_MS = 60 * 60_000;

interface EpisodeMark {
  episode: EpisodeListItem;
  /** 1..n, en orden cronológico. Es lo que se pinta dentro del marcador. */
  index: number;
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
/* Marcador de episodio                                                */
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
function renderEpisodeFlag(index: number, escalated: boolean) {
  return function EpisodeFlag(props: { viewBox?: LabelViewBox }) {
    const x = props.viewBox?.x;
    const y = props.viewBox?.y;
    if (x === undefined || y === undefined) return <g />;

    return (
      <g>
        <circle cx={x} cy={y + 7} r={7} fill={escalated ? 'var(--danger)' : 'var(--chart-episode)'} />
        <text
          x={x}
          y={y + 7}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={9}
          fontWeight={700}
          fill="var(--bg)"
        >
          {index}
        </text>
      </g>
    );
  };
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

interface BaselineTooltipProps {
  marks: readonly EpisodeMark[];
  series: DrawableSeries;
  /** Los inyecta Recharts al clonar el elemento. */
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ value?: number | string }>;
}

function BaselineTooltip({ marks, series, active, label, payload }: BaselineTooltipProps) {
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
    <div className="max-w-[19rem] rounded-md border border-line-strong bg-surface-2 px-3 py-2 shadow-xl">
      <p className="text-2xs uppercase tracking-[0.1em] text-ink-3">
        {formatDateTime(new Date(t).toISOString())}
      </p>

      {Number.isFinite(value) ? (
        <p className="mt-1 flex items-baseline gap-2">
          <span className="text-lg font-semibold leading-none text-ink">
            {formatMetric(value, series.unit, series.metric === 'respiratoryRate' ? 1 : 0)}
          </span>
          {sd !== null ? <span className="text-2xs text-ink-3">{formatSd(sd)} del baseline</span> : null}
        </p>
      ) : null}

      {mark ? (
        <div className="mt-2 border-t border-line pt-2">
          <p className="flex items-baseline gap-2">
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full"
              style={{
                backgroundColor: mark.episode.escalation.triggered
                  ? 'var(--danger)'
                  : 'var(--chart-episode)',
              }}
            />
            <span className="text-xs font-semibold text-ink">
              Episodio {mark.index} · {formatDuration(mark.episode.durationMinutes)}
            </span>
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-ink-2">
            {labelOutcome(mark.episode.outcome)} · pico {mark.episode.peakHeartRate} bpm
            {mark.episode.minHrv !== null ? ` · HRV mín. ${mark.episode.minHrv} ms` : ''}
          </p>
          <p className="mt-0.5 text-2xs leading-relaxed text-ink-3">
            {mark.episode.interventions.length > 0
              ? mark.episode.interventions.map((i) => i.title).join(' · ')
              : 'sin intervención'}
          </p>
          {mark.episode.escalation.triggered && mark.episode.escalation.rule ? (
            <p className="mt-1 font-mono text-2xs text-danger">{mark.episode.escalation.rule}</p>
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

  const marks = useMemo<EpisodeMark[]>(
    () =>
      episodes
        .map((episode, i) => ({
          episode,
          index: i + 1,
          start: Date.parse(episode.startedAt),
          end: Date.parse(episode.endedAt),
        }))
        .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end)),
    [episodes],
  );

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
    const marks: number[] = [];
    for (let v = Math.ceil(low / step) * step; v <= high; v += step) {
      marks.push(Math.round(v * 100) / 100);
    }

    // Una marca cada 5 días, alineada a medianoche UTC como el resto del
    // formateo — así el eje no baila según la zona horaria de la máquina.
    const first = points[0].t;
    const last = points[points.length - 1].t;
    const days: number[] = [];
    for (let t = Math.ceil(first / DAY_MS) * DAY_MS; t <= last; t += 5 * DAY_MS) days.push(t);

    return { yDomain: [low, high] as [number, number], yTicks: marks, xTicks: days };
  }, [active]);

  const bandLow = active.baseline.mean - active.baseline.sd;
  const bandHigh = active.baseline.mean + active.baseline.sd;

  return (
    <Card
      title="Baseline · 30 días"
      subtitle="estos datos ya existen, solo que no están en ningún lugar útil"
      bodyClassName="flex min-h-0 flex-col gap-1.5 p-3 pt-2"
      actions={
        <div className="flex items-center gap-1 rounded-md border border-line-strong p-0.5">
          {BASELINE_METRICS.map((key) => {
            const selected = key === metric;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setMetric(key)}
                aria-pressed={selected}
                title={labelMetric(key)}
                className={`rounded px-2 py-1 text-2xs font-semibold uppercase tracking-[0.08em] transition-colors ${
                  selected ? 'text-bg' : 'text-ink-3 hover:text-ink-2'
                }`}
                style={selected ? { backgroundColor: SERIES_COLOR[key] } : undefined}
              >
                {METRIC_SHORT[key] ?? key}
              </button>
            );
          })}
        </div>
      }
    >
      {/* Leyenda: dice qué es cada capa y, sobre todo, cuántos puntos se están
          dibujando de los que hay. Submuestrear sin decirlo es engañar. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-3">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-4 rounded-[2px] border"
            style={{ backgroundColor: 'var(--chart-band)', borderColor: SERIES_COLOR[metric] }}
          />
          baseline {formatBaselineBand(active.baseline.mean, active.baseline.sd, active.unit, metric === 'respiratoryRate' ? 1 : 0)}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: 'var(--chart-episode)' }}
          />
          {marks.length} episodios marcados
        </span>
        <span className="ml-auto font-mono">
          {active.sourcePoints.toLocaleString('es-ES')} puntos · {active.points.length} dibujados
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={active.points} margin={{ top: 14, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />

            {/* Banda de baseline: mean ± sd, detrás de todo lo demás. */}
            <ReferenceArea
              y1={bandLow}
              y2={bandHigh}
              fill="var(--chart-band)"
              stroke="none"
              ifOverflow="extendDomain"
            />
            <ReferenceLine
              y={active.baseline.mean}
              stroke={SERIES_COLOR[metric]}
              strokeOpacity={0.45}
              strokeDasharray="4 5"
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
              axisLine={{ stroke: 'var(--line)' }}
              minTickGap={20}
            />
            <YAxis
              domain={yDomain}
              ticks={yTicks}
              width={40}
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />

            {/* Marcadores de episodio. Van después de los ejes para quedar por
                encima de la rejilla y por debajo del tooltip. */}
            {marks.map((mark) => (
              <ReferenceLine
                key={mark.episode.encounterId}
                x={mark.start}
                stroke={
                  mark.episode.escalation.triggered ? 'var(--danger)' : 'var(--chart-episode)'
                }
                strokeOpacity={0.65}
                strokeWidth={1.5}
                label={renderEpisodeFlag(mark.index, mark.episode.escalation.triggered)}
              />
            ))}

            <Tooltip
              cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }}
              wrapperStyle={{ outline: 'none' }}
              content={<BaselineTooltip marks={marks} series={active} />}
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

      {active.points.length === 0 ? (
        <p className="shrink-0 text-2xs text-ink-3">Sin observaciones en la ventana {EMPTY}</p>
      ) : null}
    </Card>
  );
}
