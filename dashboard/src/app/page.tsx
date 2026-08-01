import Link from 'next/link';

import { NewPatientDialog } from '@/components/chart/NewPatientDialog';
import { Avatar, FlagRow, MetricValue } from '@/components/chart/primitives';
import { SourceBadge } from '@/components/chart/SourceBadge';
import { describeGender, formatAge, formatDateTime, formatRelativeDays } from '@/lib/chart/format';
import { readRoster } from '@/lib/chart/read';
import type { RosterEntry } from '@/lib/chart/types';
import { medplumConfigured } from '@/lib/medplum/server';

/**
 * Agenda del día — la portada.
 *
 * Es lo primero que ve un médico y lo primero que ve un jurado, y responde una
 * sola pregunta: **¿a quién tengo que atender y cuál de ellos necesita una
 * decisión hoy?**
 *
 * El orden NO es por hora de cita. Ordenar por hora pondría arriba al paciente
 * estable de las 9:00 y escondería debajo al que lleva la hemoglobina glucosilada
 * subiendo pese a un aumento de dosis. La agenda ordena por gravedad de la señal
 * y enseña la hora como dato, no como criterio.
 */
export const dynamic = 'force-dynamic';

export default async function RosterPage() {
  // Una sola marca de tiempo para toda la página: si cada tarjeta leyera el
  // reloj por su cuenta, dos pacientes podrían calcular la edad o el "faltan N
  // días" contra instantes distintos.
  const now = new Date();
  const roster = await readRoster(now);
  // El alta es lo ÚNICO de esta pantalla que no puede degradar a fixture: se
  // escribe en Medplum o no ocurre. Por eso el disparador depende de que haya
  // credenciales, y no de que la lectura del roster haya salido bien.
  const usingFallback = roster.source.source === 'fixture';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[1400px] flex-col px-6 pb-10">
      <header className="flex h-14 shrink-0 items-center gap-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="text-lg font-semibold tracking-[0.22em] text-accent">LOOP</span>
          <span className="truncate text-2xs uppercase tracking-[0.14em] text-ink-3">
            Expediente clínico
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <SourceBadge status={roster.source} />
          <NewPatientDialog canWrite={medplumConfigured} usingFallback={usingFallback} />
          <Link href="/loop" className="ghostbtn">
            Loop · ansiedad
          </Link>
          {/* Entry point to the DICOM section. That route is English on purpose
              (explicit request), so the label stays English here too — it names
              the destination rather than describing it in the page's language. */}
          <Link href="/imaging" className="ghostbtn">
            Imaging
          </Link>
        </div>
      </header>

      <div className="flex items-baseline justify-between gap-4 pb-4 pt-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
          {roster.practitioner ? (
            <span className="text-sm text-ink-3">{roster.practitioner}</span>
          ) : null}
        </div>
        <span className="text-2xs text-ink-3">
          {roster.entries.length} paciente{roster.entries.length === 1 ? '' : 's'}
        </span>
      </div>

      {roster.entries.length === 0 ? (
        // Una agenda vacía es un estado legítimo —proyecto recién creado—, no un
        // fallo. Se pinta con la salida delante en vez de dejar al médico
        // buscando dónde se empieza.
        <div className="tile flex flex-col items-center gap-3 rounded-tile px-5 py-10 text-center">
          <p className="text-sm text-ink-3">No hay pacientes en este proyecto de Medplum.</p>
          <NewPatientDialog
            canWrite={medplumConfigured}
            usingFallback={usingFallback}
            label="Dar de alta al primero"
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {roster.entries.map((entry, index) => (
            <li key={entry.patient.id}>
              <RosterRow entry={entry} index={index} now={now} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/* ================================================================== */

/**
 * Una fila del roster.
 *
 * Toda la fila es un enlace: en una pantalla clínica el objetivo de clic tiene
 * que ser grande, porque el médico está apurado y el jurado la ve proyectada.
 */
function RosterRow({ entry, index, now }: { entry: RosterEntry; index: number; now: Date }) {
  const { patient, nextAppointment, headlineMetric, flags } = entry;
  const urgent = flags.some((f) => f.severity === 'danger');
  const upcoming = nextAppointment ? Date.parse(nextAppointment.start ?? '') >= now.getTime() : false;

  return (
    <Link
      href={`/paciente/${patient.id}`}
      style={{ '--i': index } as React.CSSProperties}
      className={`glass bloom grid grid-cols-[minmax(0,2.1fr)_minmax(0,1.9fr)_minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-4 rounded-card px-5 py-4 transition-colors hover:bg-glass-2 ${
        urgent ? 'border-l-2 border-l-[var(--danger)]' : ''
      }`}
    >
      {/* Identidad. Lo primero que se lee: a quién estoy viendo. */}
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={patient.displayName} />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold leading-tight">{patient.displayName}</p>
          <p className="truncate text-2xs text-ink-3">
            {formatAge(patient.age)} · {describeGender(patient.gender)}
            {patient.mrn ? ` · ${patient.mrn}` : ''}
          </p>
        </div>
      </div>

      {/* Problemas y carga de medicación. */}
      <div className="min-w-0">
        <p className="truncate text-xs text-ink-2">
          {entry.activeConditions.length > 0 ? entry.activeConditions.join(' · ') : 'Sin problemas activos'}
        </p>
        <p className="truncate text-2xs text-ink-3">
          {entry.activeMedicationCount} medicamento{entry.activeMedicationCount === 1 ? '' : 's'} activo
          {entry.activeMedicationCount === 1 ? '' : 's'}
        </p>
      </div>

      {/* La cifra que define su estado hoy. */}
      <div className="min-w-0">
        {headlineMetric ? (
          <MetricValue metric={headlineMetric} size="sm" />
        ) : (
          <span className="text-2xs text-ink-3">Sin resultados</span>
        )}
      </div>

      {/* Cita: cuándo y por qué. El motivo es donde vive la pista clínica. */}
      <div className="min-w-0 text-right">
        <p className="text-xs font-semibold text-ink-2">
          {formatDateTime(nextAppointment?.start ?? null)}
          {nextAppointment ? (
            <span className="ml-1.5 font-normal text-ink-3">
              {upcoming
                ? formatRelativeDays(nextAppointment.start, now.getTime())
                : 'cita pasada'}
            </span>
          ) : null}
        </p>
        <p className="truncate text-2xs text-ink-3" title={nextAppointment?.description ?? undefined}>
          {nextAppointment?.description ?? 'Sin cita agendada'}
        </p>
      </div>

      {/* Banderas: ocupan la fila entera debajo, para que no compriman lo de arriba. */}
      {flags.length > 0 ? (
        <div className="col-span-4 -mb-0.5 pt-1">
          <FlagRow flags={flags} max={4} />
        </div>
      ) : null}
    </Link>
  );
}
