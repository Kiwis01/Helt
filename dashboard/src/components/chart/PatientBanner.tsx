import Link from 'next/link';

import { Avatar, FlagRow } from '@/components/chart/primitives';
import { describeGender, formatAge, formatDateTime, formatRelativeDays } from '@/lib/chart/format';
import type { ChartAppointment, ChartFlag, ChartPatient } from '@/lib/chart/types';

/**
 * Banda de identidad del paciente.
 *
 * Un médico decide en tres segundos si está viendo el expediente correcto, y
 * equivocarse de paciente es EL error grave de una pantalla clínica. Por eso el
 * nombre es lo más grande de la página, la identidad va acompañada de edad, sexo
 * y número de expediente —tres datos que raramente coinciden entre dos personas—
 * y la banda se queda pegada arriba al hacer scroll: nunca se pierde de vista a
 * quién pertenece lo que se está leyendo.
 *
 * Las alergias viven aquí y no en un panel de abajo a propósito: es lo único del
 * expediente que puede matar a alguien si se pasa por alto al recetar.
 */
export function PatientBanner({
  patient,
  flags,
  allergyLabels,
  appointment,
  now,
}: {
  patient: ChartPatient;
  flags: readonly ChartFlag[];
  allergyLabels: readonly string[];
  appointment: ChartAppointment | null;
  now: Date;
}) {
  return (
    <header className="glass sticky top-0 z-20 flex flex-col gap-3 rounded-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link
          href="/"
          className="ghostbtn shrink-0"
          aria-label="Volver a la agenda"
          title="Volver a la agenda"
        >
          ← Agenda
        </Link>

        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={patient.displayName} />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold leading-tight">{patient.displayName}</h1>
            <p className="truncate text-2xs text-ink-3">
              {formatAge(patient.age)} · {describeGender(patient.gender)}
              {patient.birthDate ? ` · nac. ${patient.birthDate}` : ''}
              {patient.mrn ? ` · ${patient.mrn}` : ''}
            </p>
          </div>
        </div>

        {/* Alergias: el dato que se consulta antes de recetar. */}
        <div className="min-w-0">
          <p className="label">Alergias</p>
          {allergyLabels.length > 0 ? (
            <p className="truncate text-xs font-semibold text-danger">
              {allergyLabels.join(' · ')}
            </p>
          ) : (
            // "Sin registrar" NO es "sin alergias conocidas", y la diferencia
            // importa justo en el momento de recetar. Se dice tal cual.
            <p className="truncate text-xs text-warn">Sin registrar</p>
          )}
        </div>

        {appointment ? (
          <div className="ml-auto shrink-0 text-right">
            <p className="label">Próxima cita</p>
            <p className="text-xs font-semibold text-ink-2">
              {formatDateTime(appointment.start)}
              <span className="ml-1.5 font-normal text-ink-3">
                {formatRelativeDays(appointment.start, now.getTime())}
              </span>
            </p>
            {appointment.description ? (
              <p className="max-w-[36ch] truncate text-2xs text-ink-3">{appointment.description}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {flags.length > 0 ? <FlagRow flags={flags} max={6} /> : null}
    </header>
  );
}
