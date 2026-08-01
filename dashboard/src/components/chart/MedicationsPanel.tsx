import { Card } from '@/components/Card';
import { MissingData } from '@/components/chart/primitives';
import { formatDate } from '@/lib/chart/format';
import type { ChartMedication } from '@/lib/chart/types';

/**
 * Medicación activa e histórica.
 *
 * Es el panel desde el que se actúa, así que su trabajo es que el médico pueda
 * confiar en lo que ve antes de tocar nada:
 *
 * - La **pauta completa** se muestra entera, sin recortar. Es donde vive el
 *   cambio de dosis ("dosis aumentada de 1x/día el 28-jul-2026") y truncarla
 *   escondería justo lo que motiva la consulta.
 * - El **RxNorm** se enseña porque es lo que hace fiables las verificaciones de
 *   duplicidad e interacción. Sin código, esas comprobaciones solo comparan
 *   nombres, y el expediente lo dice en vez de fingir seguridad.
 * - **Quién firmó** aparece siempre. En este proyecto no firmó nadie, y una
 *   receta sin prescriptor es un hallazgo, no un campo vacío que se pueda omitir.
 */
export function MedicationsPanel({
  medications,
  action,
  index,
}: {
  medications: readonly ChartMedication[];
  /** Controles de escritura. Se inyectan para que este panel siga siendo servidor. */
  action?: React.ReactNode;
  index?: number;
}) {
  const active = medications.filter((m) => m.status === 'active');
  const past = medications.filter((m) => m.status !== 'active');

  return (
    <Card
      title="Medications"
      subtitle={`${active.length} active`}
      actions={action}
      index={index}
    >
      {medications.length === 0 ? (
        <MissingData>Medplum has no MedicationRequest for this patient.</MissingData>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-[var(--hair)]">
            {active.map((med) => (
              <li key={med.id} className="py-2.5 first:pt-0">
                <MedicationRow medication={med} />
              </li>
            ))}
          </ul>

          {past.length > 0 ? (
            <section>
              <h3 className="label pb-1">Stopped and completed</h3>
              <ul className="flex flex-col divide-y divide-[var(--hair)]">
                {past.map((med) => (
                  <li key={med.id} className="py-2 first:pt-0">
                    <MedicationRow medication={med} muted />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/* ================================================================== */

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  'on-hold': 'On hold',
  cancelled: 'Canceled',
  completed: 'Completed',
  stopped: 'Stopped',
  draft: 'Draft',
  'entered-in-error': 'Entered in error',
  unknown: 'Unknown status',
};

function MedicationRow({
  medication,
  muted = false,
}: {
  medication: ChartMedication;
  muted?: boolean;
}) {
  return (
    <div className={muted ? 'opacity-55' : ''}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {medication.display}
        </span>

        {medication.asNeeded ? <span className="pill pill-quiet shrink-0">As needed</span> : null}

        {medication.status !== 'active' ? (
          <span className="pill pill-quiet shrink-0">
            {STATUS_LABELS[medication.status] ?? medication.status}
          </span>
        ) : null}
      </div>

      {/* La pauta, completa. Es el texto que el paciente sigue. */}
      {medication.dosage ? (
        <p className="pt-0.5 text-2xs leading-snug text-ink-2">{medication.dosage}</p>
      ) : (
        <p className="pt-0.5 text-2xs text-warn">No dosage instructions recorded</p>
      )}

      <p className="flex flex-wrap items-baseline gap-x-3 pt-0.5 text-2xs text-ink-3">
        {medication.rxnorm ? (
          <span className="font-mono" title={medication.rxnormDisplay ?? 'RxNorm code'}>
            RxNorm {medication.rxnorm}
          </span>
        ) : (
          <span className="text-warn">No RxNorm</span>
        )}

        <span>{medication.authoredOn ? formatDate(medication.authoredOn) : 'no date'}</span>

        {medication.prescriber ? (
          <span>{medication.prescriber}</span>
        ) : (
          <span className="text-warn">no prescriber</span>
        )}
      </p>

      {medication.statusReason ? (
        <p className="pt-0.5 text-2xs text-ink-3">Reason: {medication.statusReason}</p>
      ) : null}
    </div>
  );
}
