/**
 * Badge de origen de los datos.
 *
 * Es la pieza más importante de honestidad de toda la pantalla. El expediente
 * degrada a una captura local cuando Medplum no responde, y sin este badge
 * alguien acabaría enseñando datos congelados creyendo que están en vivo — que
 * es exactamente la clase de detalle que un jurado detecta y no perdona.
 *
 * Verde solo cuando TODAS las lecturas vinieron de Medplum. Basta con que una
 * caiga al respaldo para que la pantalla entera deje de poder presumir.
 */

import { describeChartReason, type ChartResult } from '@/lib/medplum/server';

export function SourceBadge({ status }: { status: ChartResult<null> }) {
  const live = status.source === 'medplum';
  const reason = describeChartReason(status.reason);

  return (
    <span
      className={`pill ${live ? 'pill-ok' : 'pill-warn'}`}
      title={status.detail ? `${reason} · ${status.detail}` : reason}
    >
      <span className={`dot ${live ? 'dot-live' : ''}`} aria-hidden />
      {live ? 'Medplum live' : 'Local fallback'}
    </span>
  );
}
