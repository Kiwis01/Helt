'use client';

/**
 * Outcomes por intervención — el loop cerrado. La última visualización del
 * pitch, y la única que tiene que entenderse sin que nadie la explique.
 *
 * El argumento se cuenta en tres golpes de vista, en este orden:
 *
 * 1. **El ahorro es el titular.** "−17 min" es la conclusión; las barras son la
 *    prueba. Antes el titular no existía: había dos barras verdes iguales y
 *    había que restar mentalmente contra una línea roja para sacar el dato.
 * 2. **La línea de "no intervention" es un umbral, no otra serie.** Discontinua
 *    y sin relleno: lo que se mide es la distancia hasta ella, y ese hueco es
 *    literalmente el tiempo que la intervención le quitó al episodio.
 * 3. **El color lo decide el dato.** Verde si bate al umbral, ámbar si no. Con
 *    estos fixtures salen las dos verdes; el día que una no funcione se verá.
 *
 * EL UMBRAL NO ES UNA ALARMA. Su lecho y su línea discontinua se pintaban en
 * rojo —`--danger-soft` bajo cada pista y `--danger` cruzando el panel—, y eso
 * es más superficie roja que la que ocupa el badge de escalación al otro lado
 * de la pantalla. En un producto para gente con ataques de pánico el rojo es un
 * recurso de un solo uso y ya está gastado en la regla determinista; aquí el
 * umbral es una REFERENCIA, así que va en la escalera de blancos. El verde y el
 * ámbar de las barras siguen siendo los únicos colores del panel, y cada uno
 * significa una sola cosa.
 *
 * Se dibuja con cajas y no con Recharts a propósito: son dos barras y un
 * umbral, y en HTML se controlan la tipografía, el radio y el orden de lectura
 * mucho mejor que con `LabelList` —que además solo se pinta cuando termina la
 * animación de la barra, y aquí llegan eventos en vivo que la reinician—.
 *
 * `episodeCountByWeek` ya no es un segundo gráfico peleando por el panel: es un
 * dato de apoyo (3 → 2 por semana) en una tesela del encabezado.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { OutcomesSummary } from '@loop/shared/contracts';

import { Card, EmptyState } from '@/components/Card';
import { useLiveCall } from '@/components/LiveCallProvider';
import { DATA, STAT } from '@/components/tokens';
import { formatDuration, formatSeverity } from '@/lib/format';

/** Cuánto se queda el aviso de "updated" tras un `episode.written`. */
const REFRESH_FLASH_MS = 8_000;

/**
 * Geometría de las filas. La columna de nombres es fija para que la línea de
 * umbral —que se pinta en una capa aparte— caiga exactamente sobre las pistas.
 */
const NAME_COL_PX = 168;
const TRACK_GAP_PX = 16;
const TRACK_LEFT_PX = NAME_COL_PX + TRACK_GAP_PX;

/**
 * Aire a la derecha del valor más alto. Sin él, la barra más larga y su cifra
 * se salen de la pista.
 */
const SCALE_HEADROOM = 1.3;

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
/* Episodios por semana                                                */
/* ------------------------------------------------------------------ */

function WeeklyTile({ weeks }: { weeks: OutcomesSummary['episodeCountByWeek'] }) {
  if (weeks.length < 2) return null;

  const max = Math.max(...weeks.map((w) => w.count), 1);
  const first = weeks[0].count;
  const last = weeks[weeks.length - 1].count;

  return (
    <div
      className="tile flex shrink-0 items-center gap-3.5 px-3.5 py-2.5"
      title={weeks.map((w) => `${w.weekStart}: ${w.count}`).join(' · ')}
    >
      <div>
        <p className="label">episodes/week</p>
        <p className={`mt-1 ${STAT} text-ink`}>
          {first}
          <span className="mx-1.5 text-2xs font-medium text-ink-3">→</span>
          {last}
        </p>
      </div>

      <div aria-hidden className="flex h-7 items-end gap-1">
        {weeks.map((week) => (
          <div
            key={week.weekStart}
            className="w-[5px] rounded-full"
            style={{
              // Altura en px y no en %: la celda de la rejilla es de altura fija
              // y un porcentaje se resolvería contra un contenedor que puede
              // quedarse sin alto y colapsar las barras a 0.
              height: `${7 + (week.count / max) * 19}px`,
              background: 'var(--accent)',
              opacity: 0.3 + (week.count / max) * 0.5,
            }}
          />
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
        // De mejor a peor: la que más acorta el episodio, arriba.
        .sort((a, b) => a.minutes - b.minutes),
    [outcomes.byIntervention, baseline],
  );

  /* --- Aviso de refresco en vivo tras `episode.written` --- */
  const writtenId = state.written?.encounterId ?? null;
  const [flash, setFlash] = useState(false);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (!writtenId || seen.current === writtenId) return;
    seen.current = writtenId;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), REFRESH_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [writtenId]);

  /*
   * Las barras crecen una vez, al montar.
   *
   * Sin `requestAnimationFrame`: en una pestaña en segundo plano el navegador
   * no ejecuta los frames, y el gráfico que cierra el pitch se quedaría con las
   * pistas vacías hasta que alguien le diera el foco. Un `useEffect` corre
   * siempre; si el navegador une los dos pintados, lo peor que pasa es que la
   * barra aparezca ya crecida.
   */
  const [grown, setGrown] = useState(false);
  useEffect(() => setGrown(true), []);

  if (rows.length === 0) {
    return (
      <Card title="Outcomes by intervention" subtitle="min per episode" index={3}>
        <EmptyState>No interventions measured yet</EmptyState>
      </Card>
    );
  }

  const best = rows[0];
  const scaleMax = Math.max(baseline, ...rows.map((r) => r.minutes)) * SCALE_HEADROOM;
  const thresholdPct = (baseline / scaleMax) * 100;

  return (
    <Card
      title="Outcomes by intervention"
      subtitle="min per episode"
      index={3}
      bodyClassName="flex min-h-0 flex-col gap-3 px-5 pb-4"
      actions={
        flash ? (
          <span className="pill pill-ok">
            <span aria-hidden className="dot dot-live" />
            updated
          </span>
        ) : null
      }
    >
      {/* --- el titular: cuánto tiempo le quita al episodio la que mejor va --- */}
      <div className="flex shrink-0 items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="label truncate">
            {best.saved > 0 ? 'saved' : 'over'} · {best.title}
          </p>
          <p className="hero mt-1.5">
            {best.saved > 0 ? '−' : '+'}
            {Math.round(Math.abs(best.saved))}
            <small>min</small>
          </p>
        </div>

        <WeeklyTile weeks={outcomes.episodeCountByWeek} />
      </div>

      {/* --- rótulo del umbral, alineado con su línea --- */}
      <div className="relative h-4 shrink-0">
        <div className="absolute inset-y-0 right-0" style={{ left: TRACK_LEFT_PX }}>
          <p
            className="absolute bottom-0 whitespace-nowrap pr-2 text-2xs text-ink-2"
            style={{ right: `${100 - thresholdPct}%` }}
          >
            no intervention · {formatDuration(baseline)}
          </p>
        </div>
      </div>

      {/* --- las barras --- */}
      {/* Con dos o tres intervenciones las filas se centran en el hueco; a
          partir de ahí el panel hace scroll dentro de sí mismo en vez de
          empujar la rejilla, que es de altura fija. Centrar Y desbordar a la
          vez deja la primera fila fuera de alcance, así que es una cosa o la
          otra. */}
      <div
        className={`relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto ${
          rows.length > 3 ? 'justify-start' : 'justify-center'
        }`}
      >
        {/* El umbral vive en su propia capa para poder cruzar todas las filas
            sin depender del alto de ninguna. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0"
          style={{ left: TRACK_LEFT_PX }}
        >
          <div
            className="absolute inset-y-0 border-l border-dashed"
            style={{ left: `${thresholdPct}%`, borderColor: 'var(--ink-2)' }}
          />
        </div>

        {rows.map((row, i) => {
          const pct = (row.minutes / scaleMax) * 100;
          const color = row.beatsBaseline ? 'var(--ok)' : 'var(--warn)';
          /* La cifra va dentro de la barra si cabe: fuera se apoyaría sobre el
             lecho del umbral y ensuciaría justo el hueco que hay que leer. */
          const inside = pct >= 20;

          return (
            <div
              key={row.id}
              className="flex shrink-0 items-center"
              style={{ gap: TRACK_GAP_PX }}
            >
              <div className="shrink-0" style={{ width: NAME_COL_PX }}>
                <p className={`truncate ${DATA} font-semibold text-ink`}>{row.title}</p>
                {/* La n va pegada al nombre: un promedio de 4 intentos y uno de
                    5 no valen lo mismo y el gráfico no puede disimularlo. */}
                <p className="mt-1 truncate text-2xs text-ink-3">
                  n = {row.attempts} · relief {formatSeverity(row.relief)}
                </p>
              </div>

              <div className="relative h-9 min-w-0 flex-1">
                {/* La pista termina EN el umbral: el lecho es lo que dura el
                    episodio sin hacer nada, el relleno es lo que duró de
                    verdad, y el hueco que queda es el tiempo ahorrado. Esa
                    resta es todo el argumento y no hace falta escribirla.

                    Lecho neutro: es el CANAL por el que corre la barra, no un
                    valor con signo. Pintado en rojo hacía que cada fila
                    arrastrase una mancha de alarma detrás del dato bueno. */}
                <div
                  aria-hidden
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${thresholdPct}%`, background: 'var(--glass)' }}
                />
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{
                    width: grown ? `${pct}%` : '0%',
                    background: color,
                    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.22)',
                    transition: `width 900ms var(--ease) ${i * 90}ms`,
                  }}
                />
                <span
                  className={`absolute top-1/2 -translate-y-1/2 whitespace-nowrap ${DATA} font-semibold`}
                  style={{
                    ...(inside
                      ? { right: `calc(${100 - pct}% + 12px)`, color: 'var(--bg)' }
                      : { left: `calc(${pct}% + 12px)`, color: 'var(--ink)' }),
                    opacity: grown ? 1 : 0,
                    transition: `opacity 500ms var(--ease) ${400 + i * 90}ms`,
                  }}
                >
                  {formatDuration(row.minutes)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
