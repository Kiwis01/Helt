'use client';

/**
 * Outcomes por intervención — el loop cerrado.
 *
 * Es la última visualización que ven los jueces y la frase de cierre del pitch:
 * *esta es la parte que nadie más está construyendo*. Todo lo demás del
 * dashboard existe en otros productos; esto no.
 *
 * Tres decisiones que sostienen el argumento:
 *
 * 1. **La línea de "sin intervención" es el gráfico.** Las barras solas no
 *    dicen nada — 14 minutos no es bueno ni malo hasta que se ve contra los 31
 *    que dura un episodio cuando no se hace nada. Por eso la línea es roja,
 *    gruesa y etiquetada, y cada barra lleva escrita su distancia hasta ella.
 * 2. **La n va SIEMPRE visible, junto al título de cada intervención.** Un
 *    promedio de 3 intentos y uno de 5 no valen lo mismo y el gráfico no puede
 *    disimularlo. Sin la n a la vista, esto no es honesto.
 * 3. **El color lo decide el dato, no el diseño.** Verde si la intervención
 *    bate al baseline, ámbar si no. Con estos fixtures salen las dos verdes,
 *    pero el día que una no funcione se verá.
 *
 * La tira semanal de abajo es la segunda mitad del argumento: no solo los
 * episodios duran menos, además son menos.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

import type { OutcomesSummary } from '@loop/shared/contracts';

import { Card } from '@/components/Card';
import { useLiveCall } from '@/components/LiveCallProvider';
import { formatDateShort, formatDuration, formatSeverity } from '@/lib/format';

/** Cuánto se queda el aviso de "actualizado" tras un `episode.written`. */
const REFRESH_FLASH_MS = 8_000;

interface OutcomeRow {
  id: string;
  title: string;
  minutes: number;
  attempts: number;
  relief: number;
  /** Minutos ahorrados frente a no hacer nada. Positivo = la intervención ayuda. */
  saved: number;
  beatsBaseline: boolean;
}

/* ------------------------------------------------------------------ */
/* Etiquetas del gráfico                                               */
/* ------------------------------------------------------------------ */

interface LabelViewBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Recharts tipa las coordenadas de ticks y etiquetas como `string | number`
 * (los ejes de categorías pueden dar strings). Aquí solo sirven números, y un
 * valor no numérico tiene que degradar a "no dibujo" en vez de a un `NaN` que
 * saca el elemento del SVG sin decir nada.
 */
function coord(value: string | number | undefined): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Etiqueta de la línea de referencia: una pastilla roja encima del eje.
 *
 * El ancho se estima a partir del número de caracteres porque en SVG no hay
 * forma barata de medir texto antes de pintarlo. 6.2 px por carácter es lo que
 * mide la tipografía del sistema a 11 px en peso 700.
 */
function renderNoInterventionLabel(minutes: number) {
  return function NoInterventionLabel(props: { viewBox?: LabelViewBox }) {
    const x = props.viewBox?.x;
    const y = props.viewBox?.y;
    if (x === undefined || y === undefined) return <g />;

    const text = `sin intervención · ${formatDuration(minutes)}`;
    const width = text.length * 6.2 + 18;

    return (
      <g>
        <rect x={x - width / 2} y={y - 21} width={width} height={17} rx={4} fill="var(--danger)" />
        <text
          x={x}
          y={y - 12.5}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={11}
          fontWeight={700}
          fill="var(--bg)"
        >
          {text}
        </text>
      </g>
    );
  };
}

/**
 * Nombre de la intervención + su n. Dos líneas dentro de un tick del eje Y para
 * que la muestra viaje pegada al nombre y no se pueda leer una sin la otra.
 */
function renderInterventionTick(rows: readonly OutcomeRow[]) {
  return function InterventionTick(props: {
    x?: string | number;
    y?: string | number;
    payload?: { index?: number };
  }) {
    const x = coord(props.x);
    const y = coord(props.y);
    const row = rows[props.payload?.index ?? -1];
    if (x === null || y === null || !row) return <g />;

    return (
      <g transform={`translate(${x},${y})`}>
        <text x={-12} y={-4} textAnchor="end" fontSize={13} fontWeight={600} fill="var(--ink)">
          {row.title}
        </text>
        <text x={-12} y={12} textAnchor="end" fontSize={11} fill="var(--ink-3)">
          n = {row.attempts} · alivio {formatSeverity(row.relief)}
        </text>
      </g>
    );
  };
}

/** Duración al final de la barra, con los minutos ahorrados debajo. */
function renderBarLabel(rows: readonly OutcomeRow[]) {
  return function BarLabel(props: {
    x?: string | number;
    y?: string | number;
    width?: string | number;
    height?: string | number;
    index?: number;
  }) {
    const x = coord(props.x);
    const y = coord(props.y);
    const width = coord(props.width);
    const height = coord(props.height);
    const row = rows[props.index ?? -1];
    if (x === null || y === null || width === null || height === null || !row) return <g />;

    const left = x + width + 12;
    const middle = y + height / 2;

    return (
      <g>
        <text x={left} y={middle - 5} fontSize={15} fontWeight={700} fill="var(--ink)">
          {formatDuration(row.minutes)}
        </text>
        <text
          x={left}
          y={middle + 11}
          fontSize={11}
          fill={row.beatsBaseline ? 'var(--ok)' : 'var(--warn)'}
        >
          {row.beatsBaseline
            ? `−${formatDuration(row.saved)} vs. sin intervención`
            : `+${formatDuration(-row.saved)} vs. sin intervención`}
        </text>
      </g>
    );
  };
}

/* ------------------------------------------------------------------ */
/* Tira de episodios por semana                                        */
/* ------------------------------------------------------------------ */

function WeeklyTrend({ weeks }: { weeks: OutcomesSummary['episodeCountByWeek'] }) {
  if (weeks.length === 0) {
    return (
      <p className="shrink-0 border-t border-line pt-2 text-2xs text-ink-3">
        Sin episodios agrupados por semana todavía.
      </p>
    );
  }

  const max = Math.max(...weeks.map((w) => w.count), 1);
  const total = weeks.reduce((sum, w) => sum + w.count, 0);
  const first = weeks[0].count;
  const last = weeks[weeks.length - 1].count;
  const falling = last < first;

  return (
    <div className="shrink-0 border-t border-line pt-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink-3">
          Episodios por semana
        </p>
        <p className="truncate text-2xs text-ink-3">
          {total} episodios en {weeks.length} semanas ·{' '}
          <span className={falling ? 'text-ok' : 'text-ink-2'}>
            {first} {falling ? '↓' : '→'} {last} por semana
          </span>
        </p>
      </div>

      <div className="mt-1.5 flex items-end gap-1.5">
        {weeks.map((week) => (
          <div key={week.weekStart} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
            <span className="text-2xs leading-none text-ink-2">{week.count}</span>
            {/* Altura en px y no en %: la celda de la rejilla ya es de altura
                fija y un porcentaje aquí se resolvería contra un contenedor
                que puede quedarse sin alto y colapsar las barras a 0. */}
            <div
              className="w-full rounded-sm"
              style={{
                height: `${6 + (week.count / max) * 18}px`,
                backgroundColor: 'var(--accent)',
                opacity: 0.35 + (week.count / max) * 0.45,
              }}
            />
            <span className="truncate text-2xs leading-none text-ink-3">
              {formatDateShort(week.weekStart)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Componente                                                          */
/* ------------------------------------------------------------------ */

export function OutcomesChart({ outcomes }: { outcomes: OutcomesSummary }) {
  const { state } = useLiveCall();
  const baseline = outcomes.baselineNoInterventionAvgDurationMinutes;

  const rows = useMemo<OutcomeRow[]>(
    () =>
      outcomes.byIntervention
        .map((item) => ({
          id: item.carePlanActivityId,
          title: item.title,
          minutes: item.avgEpisodeDurationMinutes,
          attempts: item.timesAttempted,
          relief: item.avgReliefScore,
          saved: baseline - item.avgEpisodeDurationMinutes,
          beatsBaseline: item.avgEpisodeDurationMinutes < baseline,
        }))
        // De mejor a peor: la intervención que más acorta el episodio arriba.
        .sort((a, b) => a.minutes - b.minutes),
    [outcomes.byIntervention, baseline],
  );

  /* --- Aviso de refresco en vivo tras `episode.written` --- */
  const writtenId = state.written?.encounterId ?? null;
  const [flash, setFlash] = useState<string | null>(null);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (!writtenId || seen.current === writtenId) return;
    seen.current = writtenId;
    setFlash(writtenId);
    const timer = window.setTimeout(() => setFlash(null), REFRESH_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [writtenId]);

  // Un poco de aire por encima del valor más alto para que la pastilla de la
  // línea de referencia no toque el borde cuando el baseline es el máximo.
  const maxValue = Math.max(baseline, ...rows.map((r) => r.minutes));
  const xMax = Math.ceil((maxValue * 1.06) / 5) * 5;

  /*
   * El subárbol de Recharts se memoiza sobre los datos, no sobre el render.
   *
   * Esta tarjeta consume el contexto de la llamada en vivo para el aviso de
   * "actualizado", así que se vuelve a renderizar con CADA `biometrics.tick`
   * —uno cada pocos segundos mientras dura la llamada—. Devolviendo el mismo
   * elemento, React se salta el subárbol entero y el gráfico solo se rehace
   * cuando cambian los datos de verdad.
   *
   * Va ANTES del estado vacío a propósito: un `useMemo` después de un `return`
   * temprano se salta en unos renders y en otros no, y React revienta con
   * "rendered fewer hooks than expected" en cuanto `/outcomes` devuelva una
   * lista vacía —justo lo que pasaría con un paciente sin intervenciones aún.
   */
  const chart = useMemo(
    () => (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={rows}
          // `right` deja sitio a la etiqueta del final de la barra, que se
          // pinta fuera del área de dibujo cuando la barra es larga.
          margin={{ top: 26, right: 170, bottom: 2, left: 0 }}
          barCategoryGap="34%"
        >
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis
            type="number"
            domain={[0, xMax]}
            tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
          />
          <YAxis
            type="category"
            dataKey="title"
            width={196}
            tickLine={false}
            axisLine={false}
            tick={renderInterventionTick(rows)}
          />

          {/*
            Sin animación de entrada, y no por gusto.

            Recharts solo pinta el `LabelList` cuando la animación de la barra
            ha terminado, y esa animación se reinicia con cada re-render. Con
            eventos llegando a mitad de llamada se queda interrumpida en torno
            al 10 %: las barras aparecen como muñones junto al eje y las
            etiquetas de minutos no llegan a salir nunca. Es el peor fallo
            posible en el gráfico que cierra el pitch, y una animación de medio
            segundo no vale ese riesgo.
          */}
          <Bar dataKey="minutes" barSize={26} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {rows.map((row) => (
              <Cell key={row.id} fill={row.beatsBaseline ? 'var(--ok)' : 'var(--warn)'} />
            ))}
            <LabelList dataKey="minutes" content={renderBarLabel(rows)} />
          </Bar>

          {/* El argumento entero: todo lo que quede a la izquierda de esta
              línea es tiempo que la intervención le quitó al episodio. */}
          <ReferenceLine
            x={baseline}
            stroke="var(--danger)"
            strokeWidth={2}
            strokeDasharray="6 4"
            ifOverflow="extendDomain"
            label={renderNoInterventionLabel(baseline)}
          />
        </BarChart>
      </ResponsiveContainer>
    ),
    [rows, xMax, baseline],
  );

  if (rows.length === 0) {
    return (
      <Card title="Outcomes por intervención" subtitle="intervención → resultado medido">
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm font-medium text-ink-2">Todavía no hay intervenciones medidas</p>
          <p className="max-w-sm text-xs leading-relaxed text-ink-3">
            El gráfico aparece en cuanto se registre el primer episodio con una actividad del care
            plan. Sin intervención, un episodio dura {formatDuration(baseline)} de media.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Outcomes por intervención"
      subtitle="esta es la parte que nadie más está construyendo"
      bodyClassName="flex min-h-0 flex-col gap-2 p-3 pt-3"
      actions={
        flash ? (
          <span className="tint-ok flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1">
            <span
              aria-hidden
              className="size-1.5 animate-pulse rounded-full"
              style={{ backgroundColor: 'var(--ok)' }}
            />
            <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-ok">
              actualizado · {flash}
            </span>
          </span>
        ) : null
      }
    >
      <div className="min-h-0 flex-1">{chart}</div>

      <WeeklyTrend weeks={outcomes.episodeCountByWeek} />
    </Card>
  );
}
