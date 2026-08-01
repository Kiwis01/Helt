'use client';

/**
 * Imaging — the shell that holds intake, stored studies and the viewer together.
 *
 * ENGLISH ON PURPOSE, like everything under `components/dicom/`.
 *
 * Layout: a left rail for the two panels that produce a study and a large
 * viewport that consumes one. The rail is fixed-width and the viewport takes the
 * rest, because a DICOM image is the only thing on this screen that gets better
 * with more pixels. Every level carries `min-h-0` / `min-w-0`: the page itself
 * never scrolls, panels scroll inside themselves, and a 400-slice series cannot
 * push anything off a projector at 1280x720.
 *
 * Why the viewer is loaded with `next/dynamic` + `ssr: false`: cornerstone
 * touches `window` at import time. A server render would crash before the page
 * ever reached the browser. `ssr: false` is not allowed inside a Server
 * Component in Next 15, which is precisely why this file — and not
 * `app/imaging/page.tsx` — is where the `dynamic()` call lives.
 */

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';

import { Card, EmptyState } from '@/components/Card';
import { DicomDropzone } from '@/components/dicom/DicomDropzone';
import { StudyList } from '@/components/dicom/StudyList';
import { countDicomSourceItems, type DicomSource, type StoredStudy } from '@/lib/dicom/types';

/**
 * The viewer is a named export, matching the convention every other component in
 * this dashboard follows (`Card`, `DataSourceBadge`, `DocumentsPanel`). If it
 * ends up a default export instead, this is the single line that changes.
 */
const DicomViewer = dynamic(
  () => import('@/components/dicom/DicomViewer').then((module) => module.DicomViewer),
  { ssr: false, loading: () => <ViewerBooting /> },
);

/**
 * What is on the viewport right now.
 *
 * The viewer only ever receives a `DicomSource`; the identity of the study —
 * who, when, what — is rendered by this shell instead, so the viewer stays a
 * pure renderer with no opinion about where its bytes came from.
 */
interface ViewerTarget {
  source: DicomSource;
  /** One line under the card header. Already truncated by the layout. */
  caption: string;
  /** Short origin label for the header pill. */
  origin: 'Local files' | 'Medplum';
  /**
   * Provenance line handed down to the viewer. Undefined lets the viewer derive
   * it, which is only correct when the files really did come from this machine —
   * a study downloaded from Medplum arrives as `File` objects too, and the
   * derived label would then contradict the "Medplum" pill above it.
   */
  viewerLabel?: string;
  /** `studyInstanceUid` when the target came from Medplum, so the list can mark it. */
  studyUid: string | null;
  /** Remount key. A fresh key guarantees the viewer tears cornerstone down
      between studies instead of trying to reconcile two different volumes. */
  key: string;
}

export function ImagingSection() {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const previewLocal = useCallback((files: readonly File[]) => {
    setTarget({
      source: { kind: 'local', files: [...files] },
      caption: `${files.length === 1 ? '1 file' : `${files.length} files`} from this machine · not uploaded`,
      origin: 'Local files',
      studyUid: null,
      key: `local-${Date.now()}`,
    });
  }, []);

  const openStored = useCallback((study: StoredStudy, files: readonly File[]) => {
    // The bytes are already in memory by the time we get here — `StudyList`
    // downloaded them so it could show progress over N requests. Handing them
    // over as `local` is not a downgrade: it means stored and dropped studies
    // share ONE decode path in the viewer, and the study identity is not lost,
    // it just lives in this shell instead.
    setTarget({
      source: { kind: 'local', files: [...files] },
      caption: [study.patientName, study.studyDescription, study.studyDate]
        .filter((part): part is string => Boolean(part))
        .join(' · '),
      origin: 'Medplum',
      viewerLabel: `From Medplum · ${files.length === 1 ? '1 image' : `${files.length} images`}`,
      studyUid: study.studyInstanceUid,
      key: `stored-${study.id}-${files.length}`,
    });
  }, []);

  const onUploaded = useCallback(() => {
    // Refetch the study list. A study that was just stored has to appear without
    // anyone reaching for the reload button in front of an audience.
    setRefreshToken((token) => token + 1);
  }, []);

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[23rem_minmax(0,1fr)] gap-3 p-3">
      <div className="flex min-h-0 min-w-0 flex-col gap-3">
        <DicomDropzone
          onPreview={previewLocal}
          onUploaded={onUploaded}
          index={0}
          className="shrink-0"
        />
        <StudyList
          refreshToken={refreshToken}
          onOpenStudy={openStored}
          selectedStudyUid={target?.studyUid ?? null}
          index={1}
          className="min-h-0 flex-1"
        />
      </div>

      <Card
        title="Viewer"
        subtitle={target ? imageCountLabel(target.source) : undefined}
        index={2}
        className="min-w-0"
        actions={
          target ? (
            <>
              <span className={`pill ${target.origin === 'Medplum' ? 'pill-accent' : 'pill-quiet'}`}>
                {target.origin}
              </span>
              <button type="button" className="ghostbtn" onClick={() => setTarget(null)}>
                Close
              </button>
            </>
          ) : null
        }
        bodyClassName="flex min-h-0 min-w-0 flex-col gap-2 px-3 pb-3"
      >
        {target ? (
          <p className="shrink-0 truncate px-1 text-2xs text-ink-3" title={target.caption}>
            {target.caption}
          </p>
        ) : null}

        {/*
          The viewport.

          Darker than the `.tile` surface the rest of the dashboard uses, on
          purpose: a CT slice is mostly black, and a frosted-white well makes the
          image look like a hole in the panel. This is the one place where a dark
          well beats glass.

          `[&>*]:h-full` forces whatever the viewer renders at its root to adopt
          the definite height this flex child already has — a cornerstone element
          with an indeterminate height silently renders a zero-pixel canvas,
          which looks exactly like a broken panel.
        */}
        <div
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-tile border border-hair [&>*]:h-full [&>*]:w-full"
          style={{ background: 'rgba(0, 0, 0, 0.32)' }}
        >
          {target ? (
            <DicomViewer
              key={target.key}
              source={target.source}
              sourceLabel={target.viewerLabel}
            />
          ) : (
            <EmptyState>Drop a study on the left, or open one stored in Medplum.</EmptyState>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ================================================================== */

/**
 * Loading fallback for the dynamic import.
 *
 * Not a blank black rectangle: this screen gets projected, and the two seconds
 * the decoder bundle takes to arrive must read as "working", not as "crashed".
 */
function ViewerBooting() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <span
        aria-hidden
        className="h-px w-8 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-60"
      />
      <p className="text-sm text-ink-3">Loading the DICOM viewer…</p>
    </div>
  );
}

function imageCountLabel(source: DicomSource): string {
  const count = countDicomSourceItems(source);
  return count === 1 ? '1 image' : `${count} images`;
}
