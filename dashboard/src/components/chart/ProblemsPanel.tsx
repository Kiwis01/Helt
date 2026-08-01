import { Card } from '@/components/Card';
import { MissingData } from '@/components/chart/primitives';
import { formatDate } from '@/lib/chart/format';
import type { ChartAllergy, ChartCondition } from '@/lib/chart/types';

/**
 * Problemas activos y alergias.
 *
 * Van en el mismo panel porque se leen juntos: al recetar, "qué tiene" y "a qué
 * reacciona" son la misma pregunta. Separarlos en dos tarjetas obliga a mirar a
 * dos sitios en el momento en que menos conviene equivocarse.
 *
 * Las condiciones inactivas se muestran atenuadas en vez de esconderse: un
 * diagnóstico resuelto sigue siendo contexto clínico, y un expediente que borra
 * su historia deja de ser un expediente.
 */
export function ProblemsPanel({
  conditions,
  allergies,
  index,
}: {
  conditions: readonly ChartCondition[];
  allergies: readonly ChartAllergy[];
  index?: number;
}) {
  const active = conditions.filter((c) => c.clinicalStatus === 'active');
  const inactive = conditions.filter((c) => c.clinicalStatus !== 'active');

  return (
    <Card title="Problems & allergies" subtitle={`${active.length} active`} index={index}>
      {/* Alto acotado y scroll propio, igual que los otros tres paneles del
          expediente: ninguno puede decidir el alto de la página. */}
      <div className="flex max-h-[19rem] flex-col gap-3 overflow-y-auto">
        <section>
          {conditions.length === 0 ? (
            <MissingData>Medplum has no Condition for this patient.</MissingData>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--hair)]">
              {[...active, ...inactive].map((condition) => (
                <li key={condition.id} className="flex items-baseline gap-3 py-2 first:pt-0">
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${
                      condition.clinicalStatus === 'active' ? 'text-ink' : 'text-ink-3 line-through'
                    }`}
                  >
                    {condition.display}
                  </span>

                  {condition.code ? (
                    <span
                      className="shrink-0 font-mono text-2xs text-ink-3"
                      title={condition.codeSystem ?? undefined}
                    >
                      {condition.code}
                    </span>
                  ) : null}

                  <span className="w-24 shrink-0 text-right text-2xs text-ink-3">
                    {/* Ninguna Condition de este proyecto trae fecha de inicio.
                        Se dice en vez de dejar un hueco que parece un bug. */}
                    {condition.onsetDate ? `since ${formatDate(condition.onsetDate)}` : 'no date'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="label pb-1">Allergies</h3>
          {allergies.length === 0 ? (
            <MissingData>
              No AllergyIntolerance resources on file. That is not the same as &ldquo;no known
              allergies&rdquo; — it is a gap in the chart, and it must be asked before prescribing.
            </MissingData>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--hair)]">
              {allergies.map((allergy) => (
                <li key={allergy.id} className="py-2 first:pt-0">
                  <div className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-danger">
                      {allergy.display}
                    </span>
                    {allergy.criticality ? (
                      <span
                        className={`pill ${allergy.criticality === 'high' ? 'pill-danger' : 'pill-quiet'}`}
                      >
                        {allergy.criticality === 'high'
                          ? 'High'
                          : allergy.criticality === 'low'
                            ? 'Low'
                            : 'Not assessed'}
                      </span>
                    ) : null}
                  </div>
                  {allergy.reactions.length > 0 ? (
                    <p className="truncate text-2xs text-ink-3">{allergy.reactions.join(', ')}</p>
                  ) : null}
                  {allergy.note ? <p className="text-2xs text-ink-3">{allergy.note}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}
