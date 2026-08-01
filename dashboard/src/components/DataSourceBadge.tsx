import { describeReason, type DataResult } from '@/lib/core-client';
import { config } from '@/lib/config';

/**
 * Origen de los datos.
 *
 * Es información honesta, no decoración: si el dashboard puede caer a fixtures
 * en silencio, tarde o temprano alguien enseña datos inventados creyéndolos
 * reales delante de un jurado.
 *
 * Pero honesto no es lo mismo que ruidoso. En pantalla van dos palabras y un
 * color de estado; el host, el motivo del fallback y el detalle técnico viven
 * en el `title`, disponibles al pasar el mouse. Un rectángulo grande aquí
 * competía con el título de la página por una información que, cuando todo va
 * bien, nadie necesita leer.
 */
export function DataSourceBadge({ status }: { status: DataResult<unknown> }) {
  const live = status.source === 'live';

  const hint = live
    ? `Datos en vivo desde ${config.coreUrl}`
    : [`shared/fixtures · ${describeReason(status.reason)}`, status.detail]
        .filter(Boolean)
        .join(' — ');

  return (
    <span className={`pill ${live ? 'pill-ok' : 'pill-warn'}`} title={hint}>
      <span
        aria-hidden
        className={`dot ${live ? 'dot-live' : ''}`}
        // El ámbar estático dice "esto no está latiendo" sin necesidad de
        // escribirlo: solo la ruta en vivo respira.
        style={live ? undefined : { background: 'var(--warn)' }}
      />
      {live ? 'En vivo' : 'Fixtures'}
    </span>
  );
}
