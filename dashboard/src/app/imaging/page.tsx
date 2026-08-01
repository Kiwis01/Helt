import type { Metadata } from 'next';
import Link from 'next/link';

import { ImagingSection } from '@/components/dicom/ImagingSection';

/**
 * Imaging — DICOM upload and viewing.
 *
 * ENGLISH ON PURPOSE. This route and everything it renders is English by
 * explicit request; the rest of the dashboard stays in Spanish. Do not translate
 * the neighbouring pages, and do not let Spanish copy leak into this one.
 *
 * Same shape as `/loop`: a fixed-height page that never scrolls. Everything that
 * grows — the upload verdict, the study list, the slice stack — scrolls inside
 * its own panel. The chart at `/paciente/[id]` scrolls vertically because a
 * record grows with the patient; this screen does not, because a viewport that
 * you have to scroll to is a viewport you cannot project.
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
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-hair px-5">
        <span className="shrink-0 text-[15px] font-semibold tracking-[0.2em] text-ink">LOOP</span>
        <span className="truncate text-2xs uppercase tracking-[0.14em] text-ink-3">Imaging</span>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <Link href="/" className="ghostbtn">
            Patients
          </Link>
          <Link href="/loop" className="ghostbtn">
            Loop
          </Link>
        </div>
      </div>

      <ImagingSection />
    </main>
  );
}
