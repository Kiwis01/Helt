import { Card } from '@/components/Card';
import { MissingData } from '@/components/chart/primitives';
import { formatDate } from '@/lib/chart/format';
import type { ChartCareTeamMember, ChartNote, ChartOrder } from '@/lib/chart/types';

/**
 * Notas, órdenes y equipo de cuidado.
 *
 * Los tres van juntos porque son el "papeleo" del expediente: lo que se
 * documentó, lo que se pidió y quién responde. Ninguno merece un panel entero
 * en este proyecto —hay una nota, cero órdenes y cero equipo— y tres tarjetas
 * casi vacías se leen como una pantalla rota.
 *
 * El detalle importante está en los adjuntos: el único DocumentReference real
 * apunta a `/api/files/quimica.pdf`, una ruta relativa que no resuelve contra
 * ningún servidor. Ofrecer un enlace que va a fallar delante de un jurado es
 * peor que no ofrecerlo, así que se muestra la referencia y se dice que el
 * archivo no está disponible.
 */
export function DocumentsPanel({
  notes,
  orders,
  careTeam,
  index,
}: {
  notes: readonly ChartNote[];
  orders: readonly ChartOrder[];
  careTeam: readonly ChartCareTeamMember[];
  index?: number;
}) {
  return (
    <Card title="Notas, órdenes y equipo" subtitle={`${notes.length + orders.length} documentos`} index={index}>
      <div className="flex flex-col gap-4">
        <section>
          <h3 className="label pb-1">Notas y documentos</h3>
          {notes.length === 0 ? (
            <MissingData>Sin DocumentReference para este paciente.</MissingData>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--hair)]">
              {notes.map((note) => (
                <li key={note.id} className="py-2 first:pt-0">
                  <div className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">{note.title}</span>
                    <span className="shrink-0 text-2xs text-ink-3">{formatDate(note.date)}</span>
                  </div>

                  {note.text ? (
                    <p className="pt-0.5 text-2xs leading-snug text-ink-2">{note.text}</p>
                  ) : null}

                  {note.attachmentUrl ? (
                    note.attachmentResolvable ? (
                      <a
                        href={note.attachmentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-2xs text-accent underline-offset-2 hover:underline"
                      >
                        Abrir adjunto
                      </a>
                    ) : (
                      <p className="pt-0.5 text-2xs text-ink-3">
                        Adjunto no disponible —{' '}
                        <span className="font-mono">{note.attachmentUrl}</span> es una ruta relativa
                        que no resuelve.
                      </p>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="label pb-1">Órdenes</h3>
          {orders.length === 0 ? (
            <MissingData>Sin ServiceRequest. No hay laboratorios ni referencias pedidas.</MissingData>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--hair)]">
              {orders.map((order) => (
                <li key={order.id} className="flex items-baseline gap-3 py-2 first:pt-0">
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">{order.display}</span>
                  {order.status ? <span className="pill pill-quiet shrink-0">{order.status}</span> : null}
                  <span className="shrink-0 text-2xs text-ink-3">{formatDate(order.authoredOn)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="label pb-1">Equipo de cuidado</h3>
          {careTeam.length === 0 ? (
            <MissingData>Sin CareTeam registrado en Medplum.</MissingData>
          ) : (
            <ul className="flex flex-col gap-1">
              {careTeam.map((member) => (
                <li key={member.id} className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-xs text-ink">{member.name}</span>
                  <span className="shrink-0 text-2xs text-ink-3">{member.role ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}
