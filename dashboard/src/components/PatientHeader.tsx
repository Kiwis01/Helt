import type { PatientSummary } from '@loop/shared/contracts';

import { EMPTY, formatDate, formatRelativeDays } from '@/lib/format';

/** El contrato deja `gender` como string libre; aquí solo se traduce. */
const GENDER_LABELS: Record<string, string> = {
  female: 'Mujer',
  male: 'Hombre',
  other: 'Otro',
  unknown: 'No registrado',
};

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 flex-1 border-l border-line pl-4">
      <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink-3">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-ink" title={value}>
        {value}
      </dd>
      {hint ? <p className="mt-0.5 truncate text-2xs normal-case tracking-normal text-ink-3">{hint}</p> : null}
    </div>
  );
}

/**
 * Identidad clínica del paciente. Es lo primero que se ve en el demo, así que
 * dice quién es y qué le pasa antes de que nadie mire un gráfico.
 *
 * Server Component a propósito: no tiene interacción, y así el texto relativo
 * ("hace 1 día") se congela en el HTML y no se desincroniza al hidratar.
 */
export function PatientHeader({ summary }: { summary: PatientSummary }) {
  const now = Date.now();

  const activeCondition =
    summary.conditions.find((c) => c.clinicalStatus === 'active') ?? summary.conditions[0];
  const activeMedication =
    summary.medications.find((m) => m.status === 'active') ?? summary.medications[0];

  return (
    <header className="flex shrink-0 items-end gap-5 border-b border-line bg-surface px-5 py-3">
      <div className="min-w-0 shrink-0" style={{ width: '17rem' }}>
        <h1 className="truncate text-2xl font-semibold leading-tight tracking-tight text-ink">
          {summary.displayName}
        </h1>
        <p className="mt-1 truncate text-xs text-ink-2">
          {summary.age} años · {GENDER_LABELS[summary.gender ?? ''] ?? summary.gender ?? EMPTY} ·{' '}
          <span className="font-mono text-ink-3">{summary.patientId}</span>
        </p>
      </div>

      <dl className="flex min-w-0 flex-1 items-start gap-4">
        <Field
          label="Condición activa"
          value={activeCondition?.display ?? EMPTY}
          hint={activeCondition ? `desde ${formatDate(activeCondition.onsetDate)}` : undefined}
        />
        <Field
          label="Medicación"
          value={activeMedication?.display ?? 'Sin medicación activa'}
          hint={activeMedication ? `RxNorm ${activeMedication.rxnorm}` : undefined}
        />
        <Field
          label="Care plan"
          value={summary.carePlanAuthor}
          hint={`actualizado ${formatDate(summary.carePlanLastUpdated)}`}
        />
        <Field
          label="Episodios"
          value={`${summary.episodeCount}`}
          hint="registrados en 30 días"
        />
        <Field
          label="Último episodio"
          value={formatDate(summary.lastEpisodeAt)}
          hint={summary.lastEpisodeAt ? formatRelativeDays(summary.lastEpisodeAt, now) : 'sin episodios'}
        />
      </dl>
    </header>
  );
}
