import { notFound } from 'next/navigation';

import { DocumentsPanel } from '@/components/chart/DocumentsPanel';
import { ImagingPanel } from '@/components/chart/ImagingPanel';
import { LabsPanel } from '@/components/chart/LabsPanel';
import { MedicationsPanel } from '@/components/chart/MedicationsPanel';
import { PatientBanner } from '@/components/chart/PatientBanner';
import { ProblemsPanel } from '@/components/chart/ProblemsPanel';
import { SourceBadge } from '@/components/chart/SourceBadge';
import { LoopSection } from '@/components/loop/LoopSection';
import { AppNav } from '@/components/nav/AppNav';
import { BackLink } from '@/components/nav/BackLink';
import { chartFlags, readPatientChart } from '@/lib/chart/read';
import { readLoopPanels } from '@/lib/loop-panels';
import { isLoopPatient } from '@/lib/medplum/loop-patient';

/**
 * Expediente de un paciente.
 *
 * Orden de la pantalla, de arriba abajo y de izquierda a derecha: identidad →
 * lo que hay que decidir → lo que lo sustenta. La medicación va arriba a la
 * izquierda porque es desde donde se actúa; los laboratorios a su derecha porque
 * son la evidencia que justifica el cambio, y quedan a un golpe de vista sin
 * tener que desplazarse.
 *
 * Es scroll vertical y no una rejilla de altura fija: un expediente crece con el
 * paciente, y comprimirlo en una pantalla obligaría a recortar contenido clínico
 * para que quepa. La banda de identidad se queda pegada arriba justamente para
 * que el scroll no haga perder de vista de quién es lo que se está leyendo.
 *
 * Loop vive DENTRO de esta pantalla, no en una pestaña hermana. El compañero de
 * voz y el expediente hablan del mismo paciente, y separarlos obligaba a saltar
 * de vista para cruzar una escalada con la medicación que la explica. Aparece
 * solo en el paciente enrolado: ver `lib/medplum/loop-patient.ts`.
 */
export const dynamic = 'force-dynamic';

export default async function PatientChartPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const now = new Date();

  // Las dos tandas van en paralelo porque no dependen entre sí: el expediente
  // sale de Medplum y los paneles de Loop de loop-core. Encadenarlas sumaría
  // los dos peores casos de latencia en una pantalla que se proyecta en vivo.
  const [{ chart, source }, loop] = await Promise.all([
    readPatientChart(id, now),
    isLoopPatient(id) ? readLoopPanels(id) : null,
  ]);

  // Ni Medplum ni el respaldo conocen a este paciente: es una URL escrita a mano.
  if (!chart) notFound();

  const flags = chartFlags(chart, now);
  const nextAppointment =
    chart.appointments.find((a) => Date.parse(a.start ?? '') >= now.getTime()) ??
    chart.appointments[chart.appointments.length - 1] ??
    null;

  return (
    <main className="flex w-full flex-col">
      <AppNav actions={<SourceBadge status={source} />} />

      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-6 pb-10 pt-4">
        {/* El retroceso va SOBRE el banner y no en la barra: pertenece al
            contenido —vuelve a la lista de la que salió este paciente—, no al
            chrome de la aplicación, que es el mismo en las tres vistas. */}
        <BackLink href="/" label="Schedule" shortcut="Esc" />

        <PatientBanner
          patient={chart.patient}
          flags={flags}
          allergyLabels={chart.allergies.map((a) => a.display)}
          appointment={nextAppointment}
          now={now}
        />

        {/* Loop va sobre la rejilla clínica, no debajo: es lo único de esta
            pantalla que cambia mientras se mira. Una escalada en curso importa
            más que una receta de hace tres semanas, y si el paciente no está
            enrolado esto no existe en vez de dejar un hueco que explicar. */}
        {loop ? <LoopSection data={loop} /> : null}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MedicationsPanel medications={chart.medications} index={1} />
          <LabsPanel metrics={chart.metrics} index={2} />
          <ProblemsPanel conditions={chart.conditions} allergies={chart.allergies} index={3} />
          <DocumentsPanel
            notes={chart.notes}
            orders={chart.orders}
            careTeam={chart.careTeam}
            index={4}
          />
        </div>

        {/* A todo el ancho, no como celda de la rejilla: el visor de imagen es lo
            único de esta pantalla que mejora de verdad con más píxeles. */}
        <ImagingPanel
          patientId={chart.patient.id}
          patientName={chart.patient.displayName}
          index={5}
        />
      </div>
    </main>
  );
}
