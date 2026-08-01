import { Card } from '@/components/Card';
import { MissingData, TrendMark, formatNumber, rangeTextClass } from '@/components/chart/primitives';
import { formatDateShort } from '@/lib/chart/format';
import { isOutOfRange } from '@/lib/chart/insights';
import type { ChartMetric, ChartObservationPoint } from '@/lib/chart/types';

/**
 * Laboratorios y signos vitales, cada uno con su historia.
 *
 * El valor suelto no dice casi nada; lo que un médico lee es el MOVIMIENTO. Una
 * HbA1c de 8.4 es preocupante, pero "8.4 subiendo desde 6.9 en nueve meses" es
 * una decisión de tratamiento. Por eso cada fila lleva su serie completa al lado
 * del número, y no en un panel aparte al que haya que navegar.
 *
 * El rango de referencia se muestra SIEMPRE con su fuente. Un umbral sin
 * procedencia es un umbral que el médico no se puede permitir creer, y la
 * diferencia entre marcar un valor en rojo y justificar por qué está en rojo es
 * la diferencia entre un widget y una herramienta.
 */
export function LabsPanel({ metrics, index }: { metrics: readonly ChartMetric[]; index?: number }) {
  const withData = metrics.filter((m) => m.latest !== null);

  return (
    <Card
      title="Labs & vitals"
      subtitle={`${withData.length} measure${withData.length === 1 ? '' : 's'}`}
      index={index}
    >
      {withData.length === 0 ? (
        <MissingData>
          Medplum has no Observation for this patient.
        </MissingData>
      ) : (
        /* Alto acotado + scroll PROPIO.
​
           Con 54 magnitudes la tarjeta crecía sin freno y arrastraba a toda la
           página a un scroll larguísimo: para llegar al panel de abajo había
           que pasar por delante de cincuenta filas que nadie va a leer. Un
           panel no puede decidir el alto de la página.
​
           `max-h` en la lista y no en la tarjeta porque la cabecera (título y
           contador) tiene que quedarse fija: es la que dice cuántas hay, y
           perderla al hacer scroll es perder la referencia. */
        <ul className="flex max-h-[19rem] flex-col divide-y divide-[var(--hair)] overflow-y-auto">
          {withData.map((metric) => (
            <li key={metric.key} className="py-1.5 first:pt-0 last:pb-0">
              <MetricRow metric={metric} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ================================================================== */

function MetricRow({ metric }: { metric: ChartMetric }) {
  const latest = metric.latest;
  if (!latest) return null;

  const range = metric.referenceRange;
  /* El renglón secundario SOLO existe si aporta.
​
     Antes decía "1 reading · no reference range" en casi todas las filas: un
     renglón entero, cincuenta veces, para informar de que no hay información.
     Eso es lo que hacía la tarjeta el doble de alta de lo necesario. Sin rango,
     la fila es de una línea. El recuento de lecturas ya lo insinúa la
     sparkline, y el dato exacto vive en el `title`. */
  const secondary = range ? describeRange(metric) : null;

  return (
    <div className="flex items-center gap-3" title={rowTitle(metric)}>
      {/* Identidad de la magnitud y su rango, con fuente auditable. */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold leading-tight text-ink">{metric.label}</p>
        {secondary ? (
          <p className="truncate text-2xs leading-tight text-ink-3" title={range?.source}>
            {secondary}
          </p>
        ) : null}
      </div>

      {/* La serie. Comprime nueve meses en 72 píxeles: se lee la forma, no el detalle. */}
      <Sparkline points={metric.points} metric={metric} />

      {/* El valor de ahora, que es el que manda.
​
          Anchos FIJOS por bloque —número, delta, fecha— en vez de dejar que el
          flex reparta: con anchos elásticos la columna se partía en un amasijo
          ("0.1 10^3/µL ↑ 0.0 10^3/µL · 1743 d Aug 29" en cuatro líneas) y era
          justo lo que hacía ilegible el panel. */}
      <p className="flex w-[5.5rem] shrink-0 items-baseline justify-end gap-1">
        <span className={`text-base font-semibold leading-none ${rangeTextClass(latest.flag)}`}>
          {formatNumber(latest.value)}
        </span>
        {metric.unit ? (
          <span className="truncate text-[10px] text-ink-3">{metric.unit}</span>
        ) : null}
      </p>

      <span className="w-[4.5rem] shrink-0 truncate text-right text-2xs text-ink-3">
        <TrendMark trend={metric.trend} unit={metric.unit} />
      </span>

      <span className="w-[3.25rem] shrink-0 text-right text-2xs tabular-nums text-ink-3">
        {formatDateShort(latest.at)}
      </span>
    </div>
  );
}

/** Todo el detalle que se quitó de la fila sigue a un hover de distancia. */
function rowTitle(metric: ChartMetric): string {
  const n = metric.points.length;
  const parts = [metric.label, `${n} reading${n === 1 ? '' : 's'}`];
  const range = metric.referenceRange;
  parts.push(range ? describeRange(metric) : 'no reference range');
  if (range?.source) parts.push(range.source);
  return parts.join(' · ');
}

function describeRange(metric: ChartMetric): string {
  const range = metric.referenceRange;
  // Concordancia de plural: en español "1 registros" pasaba desapercibido, en
  // ingles "1 readings" no.
  const n = metric.points.length;
  if (!range) return `${n} reading${n === 1 ? '' : 's'} · no reference range`;

  // El español escribe "7 %" con espacio; el ingles escribe "7%" pegado. El
  // resto de unidades (mmHg, /min) si lo llevan. Misma convencion que ya usan
  // los `source` de reference-ranges.ts.
  const unit = metric.unit ? (metric.unit === '%' ? metric.unit : ` ${metric.unit}`) : '';
  if (range.high !== null && range.low !== null) {
    return `Reference ${range.low}–${range.high}${unit}`;
  }
  if (range.high !== null) return `Reference <${range.high}${unit}`;
  if (range.low !== null) return `Reference ≥${range.low}${unit}`;
  return 'No reference range';
}

/* ================================================================== */

/* Más ancha que alta y más baja que antes (28 -> 18): la sparkline aporta la
   FORMA, y su alto era parte de lo que inflaba la fila. A 18 px sigue
   distinguiéndose subir de bajar, que es todo lo que se le pide aquí. */
const SPARK_WIDTH = 72;
const SPARK_HEIGHT = 18;

/**
 * Serie mínima en SVG, dibujada a mano en vez de con Recharts.
 *
 * Aquí hay entre dos y cinco puntos y se repite una vez por fila: montar un
 * `ResponsiveContainer` por cada una costaría un observador de tamaño por fila
 * y una animación de entrada que solo estorba. Con SVG plano el panel se pinta
 * en el servidor y llega listo.
 *
 * El último punto va marcado y coloreado por su estado: es el que el ojo busca.
 */
function Sparkline({
  points,
  metric,
}: {
  points: readonly ChartObservationPoint[];
  metric: ChartMetric;
}) {
  if (points.length < 2) {
    return (
      <span
        className="shrink-0 text-center text-2xs text-ink-3"
        style={{ width: SPARK_WIDTH }}
        title="Only one reading"
      >
        —
      </span>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Serie plana: sin rango, todo caería en la misma línea y una división por
  // cero dejaría el trazo en blanco.
  const span = max - min || 1;

  const coords = points.map((point, i) => {
    const x = (i / (points.length - 1)) * SPARK_WIDTH;
    const y = SPARK_HEIGHT - ((point.value - min) / span) * SPARK_HEIGHT;
    return { x, y, point };
  });

  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];

  // El trazo toma el color de la lectura clínica de la tendencia, no del signo
  // del delta: bajar es bueno en el LDL y malo en el FEV1.
  const stroke =
    metric.trend?.clinical === 'worsening'
      ? 'var(--danger)'
      : metric.trend?.clinical === 'improving'
        ? 'var(--ok)'
        : 'var(--ink-3)';

  return (
    <svg
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className="shrink-0 overflow-visible"
      role="img"
      aria-label={`${metric.label}: ${points.map((p) => formatNumber(p.value)).join(', ')} ${metric.unit}`}
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle
        cx={last.x}
        cy={last.y}
        r={2.5}
        fill={isOutOfRange(last.point.flag) ? stroke : 'var(--ink)'}
      />
    </svg>
  );
}
