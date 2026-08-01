import type { Metadata } from 'next';

import { ImagingSection } from '@/components/dicom/ImagingSection';
import { AppNav } from '@/components/nav/AppNav';

/**
 * Imaging — DICOM upload and viewing.
 *
 * Same shape as `/loop`: a fixed-height page that never scrolls. Everything that
 * grows — the upload verdict, the study list, the slice stack — scrolls inside
 * its own panel. The chart at `/paciente/[id]` scrolls vertically because a
 * record grows with the patient; this screen does not, because a viewport that
 * you have to scroll to is a viewport you cannot project.
 *
 * Esta vista nació con cabecera propia —enlaces sueltos a la agenda y a
 * `/loop`— y era la cuarta cabecera distinta del producto, que es exactamente
 * lo que `AppNav` vino a eliminar. Ahora comparte la de las otras tres: el
 * control segmentado la marca dentro del mundo del expediente, que es donde
 * pertenece, y los atajos `1`/`2`/`Esc` funcionan igual que en el resto.
 *
 * No data is read on the server here. Studies, instances and bytes all arrive
 * through the route handlers under `/api/dicom/`, which is what keeps the
 * Medplum client secret and its access token out of the browser bundle.
 */
export const metadata: Metadata = {
  title: 'Loop — Imaging',
  description: 'Upload DICOM studies to Medplum and read them in the browser.',
};

export default function ImagingPage() {
  return (
    <main className="flex h-dvh min-h-[640px] flex-col overflow-hidden">
      <AppNav
        actions={
          <span className="truncate text-2xs uppercase tracking-[0.14em] text-ink-3">Imaging</span>
        }
      />

      <ImagingSection />
    </main>
  );
}
