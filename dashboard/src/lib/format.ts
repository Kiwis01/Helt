/**
 * Formateo de valores para la vista clínica.
 *
 * Dos decisiones que no son obvias:
 *
 * 1. Todos los formateadores fijan `locale` e incluso `timeZone: 'UTC'`. Los
 *    datos vienen del servidor (RSC) y algunos paneles se re-renderizan en el
 *    cliente; si cada lado usara su zona horaria, el mismo episodio saldría
 *    con hora distinta según dónde se pintó. UTC fijo hace el demo
 *    reproducible en cualquier máquina.
 * 2. Nada lanza. Un ISO corrupto devuelve el guion largo, nunca una excepción
 *    que tumbe la página delante de los jueces.
 */

/** Marcador de dato ausente. Un guion largo se lee mejor que "N/A" de lejos. */
export const EMPTY = '—';

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const DATE = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const DATE_SHORT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});

const TIME = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const MS_PER_DAY = 86_400_000;

/** Devuelve null en vez de un `Date` inválido, para que el resto sea trivial. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/* Dinero                                                              */
/* ------------------------------------------------------------------ */

/**
 * Centavos → moneda. El contrato mueve todos los importes en centavos
 * (`copayCents`, `deductible.remainingCents`) precisamente para no arrastrar
 * errores de coma flotante hasta la pantalla.
 */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return EMPTY;
  return USD.format(cents / 100);
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return `${value.toFixed(digits)} %`;
}

/* ------------------------------------------------------------------ */
/* Tiempo                                                              */
/* ------------------------------------------------------------------ */

/** "22 min" · "1 h 22 min". */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return EMPTY;
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "31 jul 2026". Acepta tanto `2026-07-31` como un ISO completo. */
export function formatDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? DATE.format(d) : EMPTY;
}

/** "31 jul". Para ejes de gráficos y listas densas. */
export function formatDateShort(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? DATE_SHORT.format(d) : EMPTY;
}

/** "20:05" en UTC, 24 h. */
export function formatTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? TIME.format(d) : EMPTY;
}

/** "31 jul 2026 · 20:05". */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? `${DATE.format(d)} · ${TIME.format(d)}` : EMPTY;
}

/**
 * Índice de día UTC. La época empieza en medianoche UTC, así que dividir por
 * un día y truncar da directamente el número de día del calendario.
 */
const utcDay = (ms: number): number => Math.floor(ms / MS_PER_DAY);

/**
 * "hoy" · "ayer" · "hace 3 días".
 *
 * Cuenta días de CALENDARIO, no bloques de 24 h: un episodio de anoche a las
 * 22:05 visto esta mañana es "ayer", aunque hayan pasado 10 horas. Es como lo
 * lee un clínico, y evita que la fecha de al lado ("31 jul") contradiga al
 * texto relativo.
 *
 * `now` es un parámetro y no `Date.now()` escondido dentro para que quien lo
 * llame decida el reloj: en un Server Component el reloj es el del servidor y
 * el texto se congela en el HTML; en un componente cliente hay que pasarlo
 * explícito para no desincronizar la hidratación.
 */
export function formatRelativeDays(iso: string | null | undefined, now: number): string {
  const d = parseDate(iso);
  if (!d) return EMPTY;
  const days = utcDay(now) - utcDay(d.getTime());
  if (days < 0) return 'programado';
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  return `hace ${days} días`;
}

/* ------------------------------------------------------------------ */
/* Biometría                                                           */
/* ------------------------------------------------------------------ */

/** "118 bpm". */
export function formatBpm(value: number | null | undefined): string {
  return formatMetric(value, 'bpm');
}

/** Valor + unidad tal como viene del contrato (`unit` es un string libre). */
export function formatMetric(
  value: number | null | undefined,
  unit: string,
  digits = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return `${value.toFixed(digits)} ${unit}`;
}

/** Banda de baseline: "68 ± 6 bpm". */
export function formatBaselineBand(
  mean: number,
  sd: number,
  unit: string,
  digits = 0,
): string {
  return `${mean.toFixed(digits)} ± ${sd.toFixed(digits)} ${unit}`;
}

/**
 * Desviaciones respecto al baseline personal, con signo: "+8.3 SD".
 * El signo importa — es la diferencia entre taquicardia y bradicardia.
 */
export function formatSd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)} SD`;
}

/** Severidad autorreportada 0–10 → "7/10". */
export function formatSeverity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}/10`;
}

/* ------------------------------------------------------------------ */
/* Etiquetas de dominio                                                */
/* ------------------------------------------------------------------ */

/** Nombres de métrica en español para ejes y selectores. */
export const METRIC_LABELS: Record<string, string> = {
  heartRate: 'Frecuencia cardiaca',
  hrv: 'Variabilidad (HRV)',
  respiratoryRate: 'Frecuencia respiratoria',
  sleepHours: 'Sueño',
};

/** Abreviaturas para chips y leyendas donde no cabe el nombre completo. */
export const METRIC_SHORT: Record<string, string> = {
  heartRate: 'HR',
  hrv: 'HRV',
  respiratoryRate: 'RR',
  sleepHours: 'Sueño',
};

/** `EpisodeResolution` → texto legible. */
export const OUTCOME_LABELS: Record<string, string> = {
  'self-resolved': 'Resuelto solo',
  'resolved-with-intervention': 'Resuelto con intervención',
  'escalated-emergency': 'Escalado a emergencias',
  'escalated-human': 'Escalado a humano',
  abandoned: 'Abandonado',
};

export function labelOutcome(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

export function labelMetric(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}
