'use client';

/**
 * Imaging inside the patient chart.
 *
 * ENGLISH ON PURPOSE. The rest of `components/chart/` is Spanish; this file —
 * like everything under `lib/dicom/` and `components/dicom/` — is English by
 * explicit request. Do not translate it back on the next i18n pass.
 *
 * Why this panel exists at all: Medplum's `DicomStudy` has no reference to a
 * `Patient`, only the DICOM header's patient-name/patient-id TEXT. So the
 * project-wide study list (`/api/dicom/studies`) cannot answer "what imaging
 * belongs to THIS patient" — pointing it at a chart would show every patient's
 * studies inside every chart. The linkage lives in a FHIR `ImagingStudy` whose
 * `subject` is `Patient/{id}`, and it is read and written exclusively through
 * `/api/dicom/patients/{patientId}/studies`. That is why this panel does not
 * reuse `StudyList` or `DicomDropzone`: both talk to the patient-less routes.
 *
 * Zero linked studies is a healthy answer, not a failure — it renders an empty
 * state, never a fallback to somebody else's imaging.
 *
 * The viewer opens in a portal overlay rather than inline. Two reasons: `Card`
 * carries `backdrop-filter`, which makes it the containing block for any
 * `position: fixed` descendant (so a non-portaled overlay would be clipped to
 * the panel), and a DICOM viewport is the one thing on this screen that gets
 * meaningfully better with more pixels.
 */

import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type InputHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

import { Card, EmptyState } from '@/components/Card';
import { MissingData } from '@/components/chart/primitives';
import {
  DICOM_API,
  DICOM_CONTENT_TYPE,
  EMPTY_UPLOAD_SUMMARY,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_FORM_FIELD,
  apiDegraded,
  describeDicomReason,
  isLikelyDicomFilename,
  isRenderableInstance,
  type ApiResult,
  type DicomSource,
  type InstancesResult,
  type RenderableInstance,
  type SliceInfo,
  type StoredStudy,
  type StudiesResult,
  type UploadResult,
  type UploadSummary,
} from '@/lib/dicom/types';

/**
 * cornerstone touches `window` at import time, so the viewer can never be part
 * of a server render. `ssr: false` is illegal inside a Server Component in
 * Next 15 — which is exactly why this panel is a Client Component and why the
 * `dynamic()` call lives here rather than in `app/paciente/[id]/page.tsx`.
 */
const DicomViewer = dynamic(
  () => import('@/components/dicom/DicomViewer').then((module) => module.DicomViewer),
  { ssr: false, loading: () => <ViewerBooting /> },
);

/** Parallel byte fetches. Enough to saturate the link, few enough to stay polite. */
const BINARY_CONCURRENCY = 6;

/** FHIR id grammar. A malformed id must not reach a route that builds a search query. */
const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/* ================================================================== */
/* Route contract                                                      */
/* ================================================================== */

/**
 * `GET|POST /api/dicom/patients/{patientId}/studies`.
 *
 * Built here rather than added to `DICOM_API` so this panel does not have to
 * modify a file two other sessions are editing. `encodeURIComponent` is not
 * decoration: the id reaches the server as a path segment.
 */
function patientStudiesPath(patientId: string): string {
  return `/api/dicom/patients/${encodeURIComponent(patientId)}/studies`;
}

/**
 * The instances of ONE of this patient's studies.
 *
 * Deliberately NOT `DICOM_API.instances(uid)`. That route resolves any UID in
 * the project, so reading through it would make the panel's correctness depend
 * on the UID having come from this patient's list — true today, and exactly the
 * kind of implicit invariant that breaks silently later. The patient-scoped
 * handler proves an `ImagingStudy` names this subject BEFORE it resolves
 * anything, so the ownership check sits on the server where it belongs. Same
 * `InstancesResult` envelope either way.
 */
function patientInstancesPath(patientId: string, studyInstanceUid: string): string {
  return `${patientStudiesPath(patientId)}?studyUid=${encodeURIComponent(studyInstanceUid)}`;
}

/**
 * Linkage fields the POST handler adds on top of the plain upload summary.
 *
 * Every one is optional and read defensively. STOW and the `ImagingStudy` write
 * are two different operations: bytes can land in Medplum while the linkage
 * fails, and that half-success is the single most important thing this panel has
 * to say out loud — an unlinked study exists but will never appear in this
 * chart, and re-uploading will not fix it, because STOW is idempotent.
 */
interface PatientLinkage {
  /** Study UIDs now pointed at this patient by an `ImagingStudy`. */
  readonly linkedStudyInstanceUids?: readonly string[];
  /** Study UIDs whose bytes were stored but that could not be linked. */
  readonly unlinkedStudyInstanceUids?: readonly string[];
  /**
   * Files that are NOT visible in this chart. This is what the route actually
   * reports, and it counts one case the UID list cannot: a file stored with no
   * readable StudyInstanceUID has nothing to name, so it never appears in
   * `unlinkedStudyInstanceUids` yet is just as invisible here.
   */
  readonly unlinkedFileCount?: number;
  /** Older spelling of the same idea. Read so a rename cannot silence the warning. */
  readonly unlinkedCount?: number;
  /** Short reason the linkage write failed. Safe to render. */
  readonly linkError?: string | null;
}

type PatientUploadSummary = UploadSummary & PatientLinkage;
type PatientUploadResult = ApiResult<PatientUploadSummary>;

/** A per-file verdict that may also report whether that file's study got linked. */
type PatientUploadFileResult = UploadResult & { readonly linked?: boolean };

/**
 * Turns the linkage fields into one sentence, or `null` when everything landed.
 *
 * Deliberately tolerant: if the route reports none of these fields, the absence
 * is treated as "nothing to warn about" rather than as an error. A false alarm
 * on a projected screen costs more than a missing one here, because the study
 * list right below is the ground truth — a linked study appears in it.
 */
function linkageWarning(summary: PatientUploadSummary): string | null {
  const reason = typeof summary.linkError === 'string' ? summary.linkError.trim() : '';
  if (reason) {
    // The route already builds `linkError` out of complete, period-terminated
    // sentences that name exactly how many studies or files failed to link.
    // Wrapping it produced a doubled period, and — worse — asserted that the
    // whole upload had failed to link. On a partial link (two studies, one
    // times out) that claim is false while the study that DID link renders in
    // the list directly below. Pass the server's sentence through untouched.
    return reason;
  }

  // Studies first — naming them is more useful than counting files — then the
  // file count, which also covers a file that had no study UID to name.
  const studies = summary.unlinkedStudyInstanceUids?.length ?? 0;
  if (studies > 0) {
    return studies === 1
      ? '1 study was stored but could not be linked to this patient — it will not appear in this chart.'
      : `${studies} studies were stored but could not be linked to this patient — they will not appear in this chart.`;
  }

  const files = summary.unlinkedFileCount ?? summary.unlinkedCount ?? 0;
  if (files > 0) {
    return files === 1
      ? '1 file was stored but could not be linked to this patient — it will not appear in this chart.'
      : `${files} files were stored but could not be linked to this patient — they will not appear in this chart.`;
  }

  // The route answered the linkage question explicitly and the answer was
  // "nothing". Only meaningful when files really were stored.
  const linked = summary.linkedStudyInstanceUids;
  if (summary.okCount > 0 && linked !== undefined && linked.length === 0) {
    return 'Stored in Medplum, but no study could be linked to this patient — it will not appear in this chart.';
  }

  return null;
}

/* ================================================================== */
/* Panel                                                               */
/* ================================================================== */

interface ImagingPanelProps {
  /** FHIR `Patient` id. Every read and write in this panel is scoped to it. */
  patientId: string;
  /** Chart display name. Used for the overlay title and header-mismatch notes. */
  patientName: string;
  /** Bloom stagger order, same convention as the other chart panels. */
  index?: number;
  className?: string;
}

/** What is on the viewer right now. */
interface ViewerTarget {
  source: DicomSource;
  /** One identity line under the overlay title. */
  caption: string;
  /** Provenance handed to the viewer, so its header cannot say "local files". */
  viewerLabel: string;
  /** Remount key — a fresh key tears cornerstone down between studies. */
  key: string;
}

interface OpenProgress {
  studyInstanceUid: string;
  done: number;
  total: number;
  stage: 'instances' | 'bytes';
}

export function ImagingPanel({ patientId, patientName, index, className }: ImagingPanelProps) {
  const validId = FHIR_ID_PATTERN.test(patientId);

  // `null` means "still loading". The envelope itself is never null: the route
  // always answers with one, and a transport failure is turned into one here.
  const [studies, setStudies] = useState<StudiesResult | null>(null);
  const [progress, setProgress] = useState<OpenProgress | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [sliceInfo, setSliceInfo] = useState<SliceInfo | null>(null);

  const [picked, setPicked] = useState<readonly File[]>([]);
  const [clipped, setClipped] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [upload, setUpload] = useState<PatientUploadResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Drag depth, not a boolean: `dragleave` fires every time the pointer crosses
  // into a child, so a flag makes the highlight strobe while the folder is still
  // being held over the strip.
  const dragDepth = useRef(0);
  // One in-flight open at a time. Clicking a second study aborts the first,
  // otherwise two series race to the viewer and the loser wins at random.
  const openRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!validId) return;
    setStudies(null);
    // These two describe an open against the previous list. Once the list is
    // replaced they describe nothing, and a red line that survives the Refresh
    // meant to clear it is worse than no line at all.
    setOpenError(null);
    setPartial(null);
    try {
      const response = await fetch(patientStudiesPath(patientId), { cache: 'no-store' });
      setStudies(
        response.ok
          ? ((await response.json()) as StudiesResult)
          : apiDegraded([], 'network', `HTTP ${response.status}`),
      );
    } catch (error) {
      setStudies(apiDegraded([], 'network', messageOf(error)));
    }
  }, [patientId, validId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Next navigates on the client, so without this a study keeps pulling
  // megabytes after the chart has been left.
  useEffect(() => () => openRef.current?.abort(), []);

  // Escape closes the overlay and the page behind it stops scrolling while it is
  // open — otherwise a wheel gesture meant for slices scrolls the chart instead.
  useEffect(() => {
    if (!target) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setTarget(null);
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [target]);

  /* ---------------- open a stored study ---------------- */

  const openStudy = useCallback(
    async (study: StoredStudy) => {
      openRef.current?.abort();
      const controller = new AbortController();
      openRef.current = controller;

      setOpenError(null);
      setPartial(null);
      setSliceInfo(null);
      setProgress({
        studyInstanceUid: study.studyInstanceUid,
        done: 0,
        total: 0,
        stage: 'instances',
      });

      try {
        const response = await fetch(patientInstancesPath(patientId, study.studyInstanceUid), {
          cache: 'no-store',
          signal: controller.signal,
        });
        const envelope: InstancesResult = response.ok
          ? ((await response.json()) as InstancesResult)
          : apiDegraded([], 'network', `HTTP ${response.status}`);

        const renderable = envelope.data
          .filter(isRenderableInstance)
          // The viewer re-sorts along the slice normal when the geometry is
          // there; this is the fallback order when it is not, and it is also the
          // order the bytes arrive in.
          .slice()
          .sort(byInstanceNumber);

        const unusable = envelope.data.length - renderable.length;

        if (renderable.length === 0) {
          setProgress(null);
          setOpenError(
            envelope.source === 'none'
              ? `Could not read the study — ${describeDicomReason(envelope.reason)}.`
              : 'This study has no retrievable image data.',
          );
          return;
        }

        setProgress({
          studyInstanceUid: study.studyInstanceUid,
          done: 0,
          total: renderable.length,
          stage: 'bytes',
        });

        const { files, failed } = await downloadInstances(renderable, controller.signal, (done) => {
          setProgress({
            studyInstanceUid: study.studyInstanceUid,
            done,
            total: renderable.length,
            stage: 'bytes',
          });
        });

        if (controller.signal.aborted) return;
        setProgress(null);

        if (files.length === 0) {
          setOpenError('None of the instances could be downloaded.');
          return;
        }

        const missing = failed + unusable;
        setPartial(
          missing > 0
            ? `${missing} of ${envelope.data.length} instances unavailable — showing the rest.`
            : null,
        );

        // Handing the bytes over as `local` is not a downgrade: it means a
        // stored study and a dropped folder share ONE decode path in the viewer.
        // The study's identity is not lost, it is rendered by this panel.
        setTarget({
          source: { kind: 'local', files },
          caption: describeStudy(study),
          viewerLabel: `From Medplum · ${files.length === 1 ? '1 image' : `${files.length} images`}`,
          key: `${study.id}-${files.length}`,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setProgress(null);
        setOpenError(messageOf(error));
      }
    },
    [patientId],
  );

  /* ---------------- intake ---------------- */

  const adopt = useCallback((incoming: readonly File[]) => {
    const { kept, note } = clampSelection(incoming);
    setPicked(kept);
    setClipped(note);
    // A new selection invalidates the previous verdict. Leaving "12 stored" on
    // screen next to a different file list is how someone reads a result about
    // files that were never sent.
    setUpload(null);
  }, []);

  const onDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);

      // The DataTransfer is emptied as soon as this handler returns, so every
      // entry has to be captured synchronously — before the first `await`.
      const entries = Array.from(event.dataTransfer.items)
        .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
        .filter((entry): entry is FileSystemEntry => entry !== null);

      if (entries.length === 0) {
        adopt(Array.from(event.dataTransfer.files));
        return;
      }

      setReading(true);
      try {
        const collected: File[] = [];
        for (const entry of entries) {
          await walkEntry(entry, collected, MAX_UPLOAD_FILES);
          if (collected.length >= MAX_UPLOAD_FILES) break;
        }
        adopt(collected);
      } finally {
        setReading(false);
      }
    },
    [adopt],
  );

  async function startUpload() {
    if (picked.length === 0 || uploading || !validId) return;
    setUploading(true);
    setUpload(null);

    try {
      const body = new FormData();
      for (const file of picked) body.append(UPLOAD_FORM_FIELD, file, file.name);

      const response = await fetch(patientStudiesPath(patientId), { method: 'POST', body });
      // The route contract is HTTP 200 + envelope, always. Anything else means
      // the request never reached the handler, so the envelope is built here
      // rather than letting an exception escape into a client error boundary.
      const result: PatientUploadResult = response.ok
        ? ((await response.json()) as PatientUploadResult)
        : apiDegraded(EMPTY_UPLOAD_SUMMARY, 'network', `HTTP ${response.status}`);

      setUpload(result);
      if (result.data.okCount > 0) {
        setPicked([]);
        setClipped(null);
        // A study that was just stored has to appear without anyone reaching for
        // the reload button in front of an audience.
        void load();
      }
    } catch (error) {
      setUpload(apiDegraded(EMPTY_UPLOAD_SUMMARY, 'network', messageOf(error)));
    } finally {
      setUploading(false);
    }
  }

  /* ---------------- render ---------------- */

  if (!validId) {
    return (
      <Card title="Imaging" index={index} className={className}>
        <MissingData>
          This chart has no usable patient id, so imaging cannot be scoped to it.
        </MissingData>
      </Card>
    );
  }

  const degraded = studies !== null && studies.source === 'none';
  const count = studies?.data.length ?? 0;
  const busy = uploading || reading;
  const summary = upload?.data ?? null;
  const warning = summary ? linkageWarning(summary) : null;
  const totalBytes = picked.reduce((sum, file) => sum + file.size, 0);

  return (
    <>
      <Card
        title="Imaging"
        subtitle={studies ? `${count} stud${count === 1 ? 'y' : 'ies'}` : undefined}
        index={index}
        className={className}
        actions={
          <>
            {degraded ? (
              <span
                className="pill pill-warn"
                title={
                  studies.detail
                    ? `${describeDicomReason(studies.reason)} · ${studies.detail}`
                    : describeDicomReason(studies.reason)
                }
              >
                <span className="dot" aria-hidden style={{ background: 'var(--warn)' }} />
                No data
              </span>
            ) : null}
            <button
              type="button"
              className="ghostbtn"
              onClick={() => void load()}
              disabled={studies === null}
            >
              Refresh
            </button>
          </>
        }
        bodyClassName="flex min-h-0 min-w-0 flex-col gap-3 px-5 pb-5"
      >
        {/* ---------------- intake strip ---------------- */}

        <div
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          // `dragover` must be prevented on every tick or the browser refuses the
          // drop and opens the file in a new tab instead.
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(event) => void onDrop(event)}
          className="tile flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-tile px-4 py-3 transition-colors"
          style={
            dragging
              ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }
              : undefined
          }
        >
          <p className="min-w-0 flex-1 text-xs leading-snug text-ink-2">
            {reading
              ? 'Reading folder…'
              : picked.length > 0
                ? `${countLabel(picked.length)} ready · ${formatBytes(totalBytes)}`
                : `Drop a study here to add it to ${patientName}'s chart`}
          </p>

          <div className="flex shrink-0 items-center gap-2">
            {picked.length === 0 ? (
              <>
                <button
                  type="button"
                  className="ghostbtn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                >
                  Choose files
                </button>
                <button
                  type="button"
                  className="ghostbtn"
                  onClick={() => folderInputRef.current?.click()}
                  disabled={busy}
                >
                  Choose folder
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ghostbtn"
                  onClick={() => {
                    setPicked([]);
                    setClipped(null);
                    setUpload(null);
                  }}
                  disabled={busy}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="ghostbtn"
                  data-on="true"
                  onClick={() => void startUpload()}
                  disabled={busy}
                >
                  {uploading ? 'Uploading…' : 'Upload to this patient'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Hidden pickers. No `accept`: real DICOM files often have no extension
            at all (`IM_0001`, `I10`), and an accept list makes them unselectable. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            adopt(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          hidden
          {...DIRECTORY_PICKER_PROPS}
          onChange={(event) => {
            adopt(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />

        {clipped ? <p className="shrink-0 text-2xs leading-snug text-warn">{clipped}</p> : null}

        {/* ---------------- upload verdict ---------------- */}

        {upload && summary ? (
          <div className="flex shrink-0 flex-col gap-2" aria-live="polite">
            <div className="flex flex-wrap items-center gap-1.5">
              {summary.okCount > 0 ? (
                <span className="pill pill-ok">{summary.okCount} stored</span>
              ) : null}
              {summary.failedCount > 0 ? (
                <span className="pill pill-danger">
                  <span className="dot dot-alert" aria-hidden />
                  {summary.failedCount} failed
                </span>
              ) : null}
              {upload.source === 'none' && summary.results.length === 0 ? (
                <span className="pill pill-warn" title={upload.detail ?? undefined}>
                  Upload rejected — {describeDicomReason(upload.reason)}
                </span>
              ) : null}
            </div>

            {/*
              The half-success that must never be swallowed: the bytes are in
              Medplum, but no `ImagingStudy` points them at this patient, so the
              study will not show up in the list below — and re-uploading will
              not fix it, because STOW is idempotent server-side.
            */}
            {warning ? (
              <p
                className="rounded-tile px-3.5 py-2.5 text-2xs leading-relaxed text-warn"
                style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn-line)' }}
                role="alert"
              >
                {warning}
              </p>
            ) : null}

            {summary.results.length > 0 ? (
              /* Capped rather than `flex-1`: a 400-file verdict scrolls inside
                 itself instead of pushing the study list down the chart. */
              <ul className="max-h-32 overflow-y-auto pr-1">
                {(summary.results as readonly PatientUploadFileResult[]).map((result, position) => (
                  <li
                    key={`${result.filename}-${position}`}
                    className="flex items-baseline gap-2 border-b border-hair py-1.5 last:border-b-0"
                  >
                    <span
                      aria-hidden
                      className="dot mt-1 shrink-0"
                      style={{ background: result.ok ? 'var(--ok)' : 'var(--danger)' }}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-2xs text-ink-2"
                      title={result.filename}
                    >
                      {result.filename}
                    </span>
                    <span
                      className={`shrink-0 text-2xs ${
                        result.ok
                          ? result.linked === false
                            ? 'text-warn'
                            : 'text-ink-3'
                          : 'text-danger'
                      }`}
                      title={result.ok ? result.sopInstanceUid : result.error}
                    >
                      {result.ok
                        ? result.linked === false
                          ? 'stored, not linked'
                          : 'stored'
                        : (result.error ?? 'failed')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* ---------------- linked studies ---------------- */}

        {studies === null ? (
          <LoadingRows />
        ) : count === 0 ? (
          <div className="py-6">
            <EmptyState>
              {degraded
                ? `Nothing to show — ${describeDicomReason(studies.reason)}.`
                : 'No imaging studies for this patient.'}
            </EmptyState>
          </div>
        ) : (
          /* Capped height so a patient with twenty studies scrolls inside the
             panel instead of stretching the chart column. */
          <ul className="max-h-[26rem] min-h-0 space-y-1.5 overflow-y-auto pr-1">
            {studies.data.map((study) => (
              <li key={study.id}>
                <StudyRow
                  study={study}
                  patientName={patientName}
                  progress={progress?.studyInstanceUid === study.studyInstanceUid ? progress : null}
                  disabled={progress !== null}
                  onOpen={() => void openStudy(study)}
                />
              </li>
            ))}
          </ul>
        )}

        {openError ? (
          <p className="shrink-0 text-2xs leading-snug text-danger" role="alert">
            {openError}
          </p>
        ) : null}
        {partial ? <p className="shrink-0 text-2xs leading-snug text-warn">{partial}</p> : null}
      </Card>

      {target ? (
        <ViewerOverlay
          target={target}
          patientName={patientName}
          sliceInfo={sliceInfo}
          onSliceInfo={setSliceInfo}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>
  );
}

/* ================================================================== */
/* Viewer overlay                                                      */
/* ================================================================== */

/**
 * The viewer, over the chart.
 *
 * Portaled to `document.body` on purpose. `Card` and `AppNav` both carry
 * `backdrop-filter`, and that property turns an element into the containing
 * block for its `position: fixed` descendants — the same way `transform` does.
 * Anchored inside the panel, `inset-0` would be measured against the panel
 * instead of the viewport and the overlay would come out clipped to a card.
 *
 * It only mounts after a click, so `document` is never touched during SSR.
 */
function ViewerOverlay({
  target,
  patientName,
  sliceInfo,
  onSliceInfo,
  onClose,
}: {
  target: ViewerTarget;
  patientName: string;
  sliceInfo: SliceInfo | null;
  onSliceInfo: (info: SliceInfo) => void;
  onClose: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm sm:px-6 sm:py-8"
      // Compares the target with the backdrop itself so a drag that starts on
      // the image and ends outside does not close the study mid-gesture.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Imaging viewer — ${patientName}`}
        className="glass flex min-h-0 min-w-0 w-full max-w-[1200px] flex-col rounded-card p-4"
        // A definite height, not `flex-1`: cornerstone renders a zero-pixel
        // canvas into an element of indeterminate height, and that looks exactly
        // like a crash.
        style={{ height: 'min(88vh, 880px)' }}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-ink">{patientName}</h2>
            <p className="truncate pt-0.5 text-2xs text-ink-3" title={target.caption}>
              {target.caption}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {sliceInfo ? <span className="pill pill-quiet">{describeSlices(sliceInfo)}</span> : null}
            <span className="pill pill-accent">Medplum</span>
            <button type="button" className="ghostbtn" onClick={onClose} aria-label="Close viewer">
              Esc
            </button>
          </div>
        </header>

        {/*
          Darker than the `.tile` surface the rest of the dashboard uses, on
          purpose: a CT slice is mostly black, and a frosted-white well makes the
          image read as a hole in the panel.

          `[&>*]:h-full` forces whatever the viewer renders at its root to adopt
          the definite height this flex child already has.
        */}
        <div
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-tile border border-hair [&>*]:h-full [&>*]:w-full"
          style={{ background: 'rgba(0, 0, 0, 0.32)' }}
        >
          <DicomViewer
            key={target.key}
            source={target.source}
            sourceLabel={target.viewerLabel}
            onSliceInfo={onSliceInfo}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Loading fallback for the dynamic import.
 *
 * Not a blank black rectangle: this screen gets projected, and the second or two
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

/* ================================================================== */
/* Study row                                                           */
/* ================================================================== */

function StudyRow({
  study,
  patientName,
  progress,
  disabled,
  onOpen,
}: {
  study: StoredStudy;
  patientName: string;
  progress: OpenProgress | null;
  disabled: boolean;
  onOpen: () => void;
}) {
  const ratio =
    progress && progress.stage === 'bytes' && progress.total > 0
      ? progress.done / progress.total
      : null;

  // The DICOM header carries its own patient name, and it is only a string —
  // the link to this chart is the `ImagingStudy.subject`, not the tag. When the
  // two disagree it is worth showing, quietly: it is information, not an alarm,
  // and colour on this dashboard means clinical state only.
  const headerName =
    study.patientName && !sameName(study.patientName, patientName) ? study.patientName : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      // EVERY row is disabled while any study is downloading — a second open
      // would race the first over one viewer. `.tile` carries no disabled state
      // of its own, so without the explicit dimming below the rows kept their
      // hover affordance and read as clickable while doing nothing.
      disabled={disabled}
      className="tile w-full rounded-tile px-3.5 py-3 text-left transition-colors hover:bg-glass-2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-semibold text-ink">
          {study.studyDescription ?? 'Study'}
        </span>
        <span className="shrink-0 text-2xs text-ink-3">{formatStudyDate(study.studyDate)}</span>
      </div>

      <p className="truncate pt-0.5 font-mono text-2xs text-ink-3" title={study.studyInstanceUid}>
        {study.studyInstanceUid}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 pt-2">
        {study.modalities.map((modality) => (
          <span key={modality} className="pill pill-accent">
            {modality}
          </span>
        ))}
        <span className="text-2xs text-ink-3">
          {describeCounts(study.seriesCount, study.instanceCount)}
        </span>
        {headerName ? (
          <span
            className="pill pill-quiet"
            title="Name recorded in the DICOM header. The link to this chart is the ImagingStudy subject, not this tag."
          >
            Header: {headerName}
          </span>
        ) : null}
      </div>

      {progress ? (
        <div className="pt-2.5">
          <div
            className="h-[3px] w-full overflow-hidden rounded-full"
            style={{ background: 'rgba(255, 255, 255, 0.08)' }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total || 1}
            aria-valuenow={progress.done}
          >
            <div
              className="h-full rounded-full transition-[width] duration-200 ease-ease"
              style={{
                width: ratio === null ? '18%' : `${Math.round(ratio * 100)}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
          <p className="pt-1.5 text-2xs text-ink-3">
            {progress.stage === 'instances'
              ? 'Reading instance list…'
              : `Downloading ${progress.done} / ${progress.total}`}
          </p>
        </div>
      ) : null}
    </button>
  );
}

/**
 * Loading placeholder.
 *
 * Two grey tiles instead of a spinner, so the panel keeps its shape while the
 * request is in flight and nothing on the projected screen jumps when the rows
 * land. Deliberately not animated: a pulsing skeleton next to a live-data badge
 * reads as activity that is not happening.
 */
function LoadingRows() {
  return (
    <div className="flex min-h-0 flex-col gap-1.5" aria-busy="true">
      {[0, 1].map((row) => (
        <div key={row} className="tile h-[74px] rounded-tile" />
      ))}
      <p className="pt-1 text-2xs text-ink-3">Loading imaging…</p>
    </div>
  );
}

/* ================================================================== */
/* Bytes                                                               */
/* ================================================================== */

/**
 * Pulls every instance's original `.dcm` bytes through our own route.
 *
 * A failed instance does NOT sink the study: a series missing three slices out
 * of two hundred is still worth showing, and the caller reports the gap rather
 * than hiding it. The array is filled by index so the download order imposed by
 * the worker pool cannot reshuffle the slices.
 */
async function downloadInstances(
  instances: readonly RenderableInstance[],
  signal: AbortSignal,
  onProgress: (done: number) => void,
): Promise<{ files: File[]; failed: number }> {
  const slots = new Array<File | null>(instances.length).fill(null);
  let cursor = 0;
  let done = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const position = cursor;
      cursor += 1;
      if (position >= instances.length || signal.aborted) return;

      const instance = instances[position];
      try {
        // Addressed by instance id: the route resolves `raw` server-side, so
        // this can never be used to pull an arbitrary Binary out of the project.
        const response = await fetch(DICOM_API.instanceBytes(instance.id), {
          cache: 'no-store',
          signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        slots[position] = new File([blob], `${instance.sopInstanceUid}.dcm`, {
          type: DICOM_CONTENT_TYPE,
        });
      } catch {
        // An aborted fetch is not a failure — the user moved on.
        if (signal.aborted) return;
        failed += 1;
      }

      done += 1;
      onProgress(done);
    }
  }

  const lanes = Math.min(BINARY_CONCURRENCY, instances.length);
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  return { files: slots.filter((file): file is File => file !== null), failed };
}

/* ================================================================== */
/* Intake helpers                                                      */
/* ================================================================== */

/**
 * `webkitdirectory` is a real, load-bearing attribute — it is the only way to
 * let someone pick a whole study folder — but React's typings do not know it.
 */
const DIRECTORY_PICKER_PROPS = {
  webkitdirectory: '',
  directory: '',
} as unknown as InputHTMLAttributes<HTMLInputElement>;

/**
 * Walks a dropped entry, collecting files. Directories are read in batches:
 * `readEntries` returns at most ~100 per call and signals the end with an empty
 * batch, so a single call silently truncates a 300-slice CT series.
 */
async function walkEntry(entry: FileSystemEntry, out: File[], limit: number): Promise<void> {
  if (out.length >= limit) return;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(
        (result) => resolve(result),
        () => resolve(null),
      );
    });
    if (file) out.push(file);
    return;
  }

  if (!entry.isDirectory) return;

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(
        (entries) => resolve(entries),
        () => resolve([]),
      );
    });
    if (batch.length === 0) return;
    for (const child of batch) {
      await walkEntry(child, out, limit);
      if (out.length >= limit) return;
    }
  }
}

/**
 * Applies the file-count and byte ceilings and says so out loud.
 *
 * A folder drop routinely contains `DICOMDIR`, thumbnails and `.DS_Store`; those
 * are dropped silently because they are noise. Hitting a ceiling is different —
 * it means files the user chose are NOT going to be uploaded, and that has to be
 * visible rather than inferred from a count that looks slightly off.
 */
function clampSelection(incoming: readonly File[]): { kept: readonly File[]; note: string | null } {
  const candidates = incoming.filter((file) => isLikelyDicomFilename(file.name));
  const notes: string[] = [];

  let kept = candidates;
  if (kept.length > MAX_UPLOAD_FILES) {
    notes.push(`Only the first ${MAX_UPLOAD_FILES} files are kept (${kept.length} were dropped).`);
    kept = kept.slice(0, MAX_UPLOAD_FILES);
  }

  let bytes = 0;
  const withinBudget: File[] = [];
  for (const file of kept) {
    if (bytes + file.size > MAX_UPLOAD_BYTES) {
      notes.push(`Selection trimmed to ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      break;
    }
    bytes += file.size;
    withinBudget.push(file);
  }

  const skipped = incoming.length - candidates.length;
  if (skipped > 0) notes.push(`${skipped} non-DICOM file${skipped === 1 ? '' : 's'} ignored.`);

  return { kept: withinBudget, note: notes.length > 0 ? notes.join(' ') : null };
}

/* ================================================================== */
/* Formatting                                                          */
/* ================================================================== */

/**
 * Fixed locale and fixed time zone, same reasoning as `lib/chart/format.ts`:
 * this panel hydrates on the client and a date that formats differently on the
 * two sides is a hydration error mid-demo. English here because this whole
 * section is English.
 */
const STUDY_DATE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatStudyDate(iso: string | null): string {
  if (!iso) return 'No date';
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed) ? 'No date' : STUDY_DATE.format(new Date(parsed));
}

/** `null` counts stay unknown. A "0 instances" that means "we did not count" is a lie. */
function describeCounts(seriesCount: number | null, instanceCount: number | null): string {
  const parts: string[] = [];
  if (seriesCount !== null) parts.push(`${seriesCount} series`);
  if (instanceCount !== null) {
    parts.push(instanceCount === 1 ? '1 image' : `${instanceCount} images`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Counts unknown';
}

/** Identity line for the overlay. Never empty — the UID is the last resort. */
function describeStudy(study: StoredStudy): string {
  const parts = [study.studyDescription, formatStudyDate(study.studyDate)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(' · ') : study.studyInstanceUid;
}

/** Totals only, never the current index — the viewer owns that readout. */
function describeSlices(info: SliceInfo): string {
  if (!info.triPlane) {
    const total = info.singleTotal ?? 0;
    return total === 1 ? '1 slice' : `${total} slices`;
  }
  const total = (info.axialTotal ?? 0) + (info.coronalTotal ?? 0) + (info.sagittalTotal ?? 0);
  return `Tri-plane · ${total} slices`;
}

/**
 * Loose name comparison, for deciding whether the DICOM header name is worth
 * showing next to the chart name. Accents, case and word order are all noise
 * here; the point is only to hide the label when the two obviously agree.
 */
function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[\s^,]+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function countLabel(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** Byte sizes for humans. One decimal only while it still means something. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ascending instance number; instances without one sink to the bottom, order kept. */
function byInstanceNumber(a: RenderableInstance, b: RenderableInstance): number {
  if (a.instanceNumber === null && b.instanceNumber === null) return 0;
  if (a.instanceNumber === null) return 1;
  if (b.instanceNumber === null) return -1;
  return a.instanceNumber - b.instanceNumber;
}
