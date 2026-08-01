/**
 * Primitivos del expediente.
 *
 * Piezas pequeñas que aparecen en todos los módulos: banderas, valores con su
 * rango, tendencias y filas de datos. Viven juntas porque su coherencia ES el
 * lenguaje de la pantalla — si una alerta de laboratorio y una de medicación se
 * pintan distinto, el médico deja de poder leer la gravedad por el color.
 *
 * Regla de color heredada del sistema: el color solo significa ESTADO CLÍNICO.
 * Nada es rojo por decoración. Si algo tiene que destacar sin ser una alarma,
 * se hace más grande, no de otro color.
 */

import type { ReactNode } from 'react';

import type { ChartFlag, ChartMetric, MetricTrend, RangeFlag } from '@/lib/chart/types';

/* ================================================================== */
/* Banderas                                                            */
/* ================================================================== */

const FLAG_TONE: Record<ChartFlag['severity'], string> = {
  danger: 'pill-danger',
  warn: 'pill-warn',
  info: 'pill-quiet',
};

/**
 * Una bandera clínica. El `basis` va en el `title` nativo: es la evidencia que
 * permite auditar la afirmación, y esconderla tras un hover es aceptable
 * mientras el titular ya sea accionable por sí solo.
 */
export function FlagPill({ flag }: { flag: ChartFlag }) {
  return (
    <span className={`pill ${FLAG_TONE[flag.severity]}`} title={flag.basis}>
      {flag.severity === 'danger' ? <span className="dot dot-alert" aria-hidden /> : null}
      {flag.title}
    </span>
  );
}

/** Las banderas de un paciente, con tope para que una fila no se desborde. */
export function FlagRow({ flags, max = 3 }: { flags: readonly ChartFlag[]; max?: number }) {
  if (flags.length === 0) return null;
  const shown = flags.slice(0, max);
  const hidden = flags.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((flag) => (
        <FlagPill key={flag.id} flag={flag} />
      ))}
      {hidden > 0 ? (
        <span
          className="pill pill-quiet"
          title={flags
            .slice(max)
            .map((f) => f.title)
            .join(' · ')}
        >
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Valores contra su rango                                             */
/* ================================================================== */

/** Color del texto según dónde cae el valor. `normal` no lleva color: es lo esperado. */
const RANGE_TEXT: Record<RangeFlag, string> = {
  'critical-high': 'text-danger',
  'critical-low': 'text-danger',
  high: 'text-warn',
  low: 'text-warn',
  normal: 'text-ink',
  unknown: 'text-ink',
};

export function rangeTextClass(flag: RangeFlag | undefined): string {
  return RANGE_TEXT[flag ?? 'unknown'];
}

/** Redondeo estable: enteros sin decimal, el resto con uno. */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Flecha de tendencia con su lectura clínica.
 *
 * La flecha dice la DIRECCIÓN y el color dice si esa dirección es buena o mala,
 * porque no son lo mismo: un FEV1 que sube es una mejora y una HbA1c que sube
 * es un deterioro, y ambas son flechas hacia arriba.
 */
export function TrendMark({ trend, unit }: { trend: MetricTrend | null; unit?: string }) {
  if (!trend) return null;

  const arrow = trend.direction === 'rising' ? '↑' : trend.direction === 'falling' ? '↓' : '→';
  const tone =
    trend.clinical === 'worsening'
      ? 'text-danger'
      : trend.clinical === 'improving'
        ? 'text-ok'
        : 'text-ink-3';

  const magnitude = Math.abs(trend.deltaFromFirst);
  const amount = magnitude > 0 ? `${formatNumber(magnitude)}${unit ? ` ${unit}` : ''}` : null;

  return (
    <span className={`inline-flex items-baseline gap-1 text-2xs font-semibold ${tone}`}>
      <span aria-hidden>{arrow}</span>
      {amount ? <span>{amount}</span> : null}
      {trend.spanDays ? <span className="text-ink-3">· {trend.spanDays} d</span> : null}
    </span>
  );
}

/**
 * Una métrica en formato compacto: etiqueta, valor grande, unidad y tendencia.
 * Es la unidad que se repite en el roster y en la cabecera del expediente.
 */
export function MetricValue({ metric, size = 'md' }: { metric: ChartMetric; size?: 'sm' | 'md' }) {
  const latest = metric.latest;

  if (!latest) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="label">{metric.label}</span>
        <span className="text-ink-3">—</span>
      </div>
    );
  }

  const valueSize = size === 'md' ? 'text-2xl' : 'text-lg';

  return (
    <div className="flex flex-col gap-0.5">
      <span className="label truncate">{metric.label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className={`${valueSize} font-semibold leading-none ${rangeTextClass(latest.flag)}`}>
          {formatNumber(latest.value)}
        </span>
        {metric.unit ? <span className="text-2xs text-ink-3">{metric.unit}</span> : null}
        <TrendMark trend={metric.trend} unit={metric.unit} />
      </span>
    </div>
  );
}

/* ================================================================== */
/* Estructura                                                          */
/* ================================================================== */

/**
 * Fila de dato: etiqueta a la izquierda, valor a la derecha.
 * El valor cae a un guion cuando falta — nunca a un cero ni a un vacío, porque
 * "0" y "no lo sabemos" son cosas distintas en un expediente.
 */
export function DataRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'warn' | 'quiet';
}) {
  const toneClass =
    tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'quiet' ? 'text-ink-3' : 'text-ink';

  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-2xs text-ink-3">{label}</span>
      <span className={`min-w-0 truncate text-right text-xs ${toneClass}`}>{value ?? '—'}</span>
    </div>
  );
}

/**
 * Aviso de que un dato NO existe, con el motivo.
 *
 * Existe porque en el proyecto real faltan cosas de verdad —cero alergias, cero
 * órdenes, recetas sin firmante— y un panel vacío sin explicación se lee como un
 * bug. Decir "Medplum no tiene esto" convierte un hueco en información.
 */
export function MissingData({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 py-2 text-2xs leading-snug text-ink-3">
      <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-[var(--ink-3)]" />
      {children}
    </p>
  );
}

/** Iniciales para el avatar. Dos letras como máximo. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'h-11 w-11 text-sm' : 'h-8 w-8 text-2xs';
  return (
    <span
      aria-hidden
      className={`tile flex shrink-0 items-center justify-center rounded-full font-semibold text-ink-2 ${box}`}
    >
      {initialsOf(name)}
    </span>
  );
}
