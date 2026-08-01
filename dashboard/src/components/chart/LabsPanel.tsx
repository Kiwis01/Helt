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
    <Card title="Laboratorios y signos vitales" subtitle={`${withData.length} magnitudes`} index={index}>
      {withData.length === 0 ? (
        <MissingData>
          Medplum no tiene ninguna Observation para este paciente.
        </MissingData>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--hair)]">
          {withData.map((metric) => (
            <li key={metric.key} className="py-3 first:pt-0 last:pb-0">
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

  return (
    <div className="flex items-center gap-4">
      {/* Identidad de la magnitud y su rango, con fuente auditable. */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-ink">{metric.label}</p>
        <p className="truncate text-2xs text-ink-3" title={range?.source}>
          {describeRange(metric)}
        </p>
      </div>

      {/* La serie. Comprime nueve meses en 96 píxeles: se lee la forma, no el detalle. */}
      <Sparkline points={metric.points} metric={metric} />

      {/* El valor de ahora, que es el que manda. */}
      <div className="w-[8.5rem] shrink-0 text-right">
        <p className="flex items-baseline justify-end gap-1">
          <span className={`text-xl font-semibold leading-none ${rangeTextClass(latest.flag)}`}>
            {formatNumber(latest.value)}
          </span>
          {metric.unit ? <span className="text-2xs text-ink-3">{metric.unit}</span> : null}
        </p>
        <p className="flex items-baseline justify-end gap-1.5">
          <TrendMark trend={metric.trend} unit={metric.unit} />
          <span className="text-2xs text-ink-3">{formatDateShort(latest.at)}</span>
        </p>
      </div>
    </div>
  );
}

function describeRange(metric: ChartMetric): string {
  const range = metric.referenceRange;
  if (!range) return `${metric.points.length} registros · sin rango de referencia`;

  const unit = metric.unit ? ` ${metric.unit}` : '';
  if (range.high !== null && range.low !== null) {
    return `Referencia ${range.low}–${range.high}${unit}`;
  }
  if (range.high !== null) return `Referencia <${range.high}${unit}`;
  if (range.low !== null) return `Referencia ≥${range.low}${unit}`;
  return 'Sin rango de referencia';
}

/* ================================================================== */

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;

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
      <span className="w-24 shrink-0 text-center text-2xs text-ink-3" title="Un solo registro">
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
