import { describeReason, type DataResult } from '@/lib/core-client';
import { config } from '@/lib/config';

/**
 * Indicador de origen de los datos.
 *
 * Es información honesta, no decoración: si el dashboard puede caer a
 * fixtures sin decirlo, tarde o temprano alguien enseña datos inventados
 * creyéndolos reales delante de un jurado. Por eso está en la barra
 * superior, no escondido en un pie de página.
 */
export function DataSourceBadge({ status }: { status: DataResult<unknown> }) {
  const live = status.source === 'live';

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
        live ? 'tint-ok border-line-strong' : 'tint-warn border-line-strong'
      }`}
      title={status.detail ?? undefined}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: live ? 'var(--ok)' : 'var(--warn)' }}
      />
      <div className="leading-none">
        <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink">
          {live ? 'Datos en vivo' : 'Fixtures'}
        </p>
        <p className="mt-1 font-mono text-2xs normal-case tracking-normal text-ink-3">
          {live ? config.coreUrl : `shared/fixtures · ${describeReason(status.reason)}`}
        </p>
      </div>
    </div>
  );
}
