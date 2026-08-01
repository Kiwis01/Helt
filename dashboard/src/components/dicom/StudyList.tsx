'use client';

/**
 * Studies stored in Medplum.
 *
 * ENGLISH ON PURPOSE, like everything under `components/dicom/`.
 *
 * This panel owns the whole read path, from `GET /api/dicom/studies` down to the
 * raw bytes. Opening a study is three hops — study → instances → one `Binary`
 * per instance — and the last one is N requests, which for a CT series is
 * hundreds. That is why the progress bar is not decoration: without it, clicking
 * a study looks like nothing happened for fifteen seconds.
 *
 * The bytes are turned into `File` objects here and handed up to the viewer, so
 * a stored study and a locally dropped folder converge on exactly the same
 * cornerstone code path. The bearer token never leaves the server — the browser
 * only ever talks to our own routes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Card, EmptyState } from '@/components/Card';
import {
  DICOM_API,
  DICOM_CONTENT_TYPE,
  apiDegraded,
  describeDicomReason,
  isRenderableInstance,
  type InstancesResult,
  type RenderableInstance,
  type StoredStudy,
  type StudiesResult,
} from '@/lib/dicom/types';

/** Parallel `Binary` fetches. Enough to saturate the link, few enough to stay polite. */
const BINARY_CONCURRENCY = 6;

interface StudyListProps {
  /** Increment to refetch — the dropzone bumps it after a successful upload. */
  refreshToken: number;
  /** Called once every retrievable instance of the study is in memory. */
  onOpenStudy: (study: StoredStudy, files: readonly File[]) => void;
  /** `studyInstanceUid` currently on screen, so the row can show it. */
  selectedStudyUid: string | null;
  index?: number;
  /** Layout only — the shell decides how this card claims height in its column. */
  className?: string;
}

interface OpenProgress {
  studyInstanceUid: string;
  done: number;
  total: number;
  /** `null` until the instance list arrives; the download has no total before that. */
  stage: 'instances' | 'bytes';
}

export function StudyList({
  refreshToken,
  onOpenStudy,
  selectedStudyUid,
  index,
  className,
}: StudyListProps) {
  // `null` means "still loading". The envelope itself can never be null: the
  // route always answers with one, and a network failure is turned into one here.
  const [studies, setStudies] = useState<StudiesResult | null>(null);
  const [progress, setProgress] = useState<OpenProgress | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);

  // One in-flight open at a time. Clicking a second study aborts the first —
  // otherwise two series race to the viewer and the loser wins at random.
  const openRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setStudies(null);
    // Both messages describe an open that happened against the previous list.
    // Once the list is replaced they describe nothing, and a red line that
    // survives the Refresh meant to fix it is worse than no line at all.
    setOpenError(null);
    setPartial(null);
    try {
      const response = await fetch(DICOM_API.studies, { cache: 'no-store' });
      setStudies(
        response.ok
          ? ((await response.json()) as StudiesResult)
          : apiDegraded([], 'network', `HTTP ${response.status}`),
      );
    } catch (error) {
      setStudies(apiDegraded([], 'network', messageOf(error)));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // Nothing from this panel is on the viewport any more — the viewer was closed
  // or replaced by a local preview — so "3 of 40 instances unavailable" no longer
  // has a study to be about.
  useEffect(() => {
    if (selectedStudyUid === null) {
      setOpenError(null);
      setPartial(null);
    }
  }, [selectedStudyUid]);

  // Abort whatever is downloading when the panel goes away. Next navigates on
  // the client, so without this a study keeps pulling megabytes after the user
  // has left the page.
  useEffect(() => () => openRef.current?.abort(), []);

  async function openStudy(study: StoredStudy) {
    openRef.current?.abort();
    const controller = new AbortController();
    openRef.current = controller;

    setOpenError(null);
    setPartial(null);
    setProgress({ studyInstanceUid: study.studyInstanceUid, done: 0, total: 0, stage: 'instances' });

    try {
      const response = await fetch(DICOM_API.instances(study.studyInstanceUid), {
        cache: 'no-store',
        signal: controller.signal,
      });
      const envelope: InstancesResult = response.ok
        ? ((await response.json()) as InstancesResult)
        : apiDegraded([], 'network', `HTTP ${response.status}`);

      const renderable = envelope.data
        .filter(isRenderableInstance)
        // Sorted by instance number up front. The viewer re-sorts along the
        // slice normal when the geometry is there, but this is the fallback
        // order when it is not, and it is also the order bytes arrive in.
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
      onOpenStudy(study, files);
    } catch (error) {
      if (controller.signal.aborted) return;
      setProgress(null);
      setOpenError(messageOf(error));
    }
  }

  /* ---------------- render ---------------- */

  const degraded = studies !== null && studies.source === 'none';

  return (
    <Card
      title="Stored studies"
      subtitle={studies ? `${studies.data.length}` : undefined}
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
      bodyClassName="flex min-h-0 flex-col gap-2 px-5 pb-5"
    >
      {studies === null ? (
        <LoadingRows />
      ) : studies.data.length === 0 ? (
        <EmptyState>
          {degraded
            ? `Nothing to show — ${describeDicomReason(studies.reason)}.`
            : 'No studies in this Medplum project yet. Upload one to see it here.'}
        </EmptyState>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {studies.data.map((study) => (
            <li key={study.id}>
              <StudyRow
                study={study}
                selected={study.studyInstanceUid === selectedStudyUid}
                progress={progress?.studyInstanceUid === study.studyInstanceUid ? progress : null}
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
  );
}

/* ================================================================== */
/* Row                                                                 */
/* ================================================================== */

function StudyRow({
  study,
  selected,
  progress,
  onOpen,
}: {
  study: StoredStudy;
  selected: boolean;
  progress: OpenProgress | null;
  onOpen: () => void;
}) {
  const ratio =
    progress && progress.stage === 'bytes' && progress.total > 0
      ? progress.done / progress.total
      : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      // Only the row that is loading gets disabled. Disabling the whole list
      // during a download makes the panel look frozen rather than working.
      disabled={progress !== null}
      className={`tile w-full rounded-tile px-3.5 py-3 text-left transition-colors hover:bg-glass-2 disabled:cursor-default ${
        selected ? 'border-l-2 border-l-[var(--accent)]' : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-semibold text-ink">
          {study.patientName ?? 'Unnamed patient'}
        </span>
        <span className="shrink-0 text-2xs text-ink-3">{formatStudyDate(study.studyDate)}</span>
      </div>

      <p
        className="truncate pt-0.5 text-2xs text-ink-2"
        title={study.studyDescription ?? study.studyInstanceUid}
      >
        {study.studyDescription ?? study.studyInstanceUid}
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
 * Three grey tiles instead of a spinner: the panel keeps its shape while the
 * request is in flight, so nothing on the projected screen jumps when the rows
 * land. `busy` is not styled with animation on purpose — a pulsing skeleton next
 * to a live-data badge reads as activity that is not happening.
 */
function LoadingRows() {
  return (
    <div className="flex min-h-0 flex-col gap-1.5" aria-busy="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="tile h-[74px] rounded-tile" />
      ))}
      <p className="pt-1 text-2xs text-ink-3">Loading studies…</p>
    </div>
  );
}

/* ================================================================== */
/* Bytes                                                               */
/* ================================================================== */

/**
 * Pulls every instance's original `.dcm` bytes through our own route.
 *
 * A failed instance does NOT sink the study: a series that is missing three
 * slices out of two hundred is still worth showing, and the caller reports the
 * gap rather than hiding it. The array is filled by index so the download order
 * imposed by the worker pool cannot reshuffle the slices.
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
        // Addressed by instance id: the route resolves `raw` server-side.
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
/* Formatting                                                          */
/* ================================================================== */

/**
 * Fixed locale and fixed time zone, same reasoning as `lib/chart/format.ts`:
 * this component is rendered on the server during hydration, and a date that
 * formats differently on the two sides is a hydration error mid-demo. English
 * here because this whole section is English.
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

/** Ascending instance number; instances without one sink to the bottom, order kept. */
function byInstanceNumber(a: RenderableInstance, b: RenderableInstance): number {
  if (a.instanceNumber === null && b.instanceNumber === null) return 0;
  if (a.instanceNumber === null) return 1;
  if (b.instanceNumber === null) return -1;
  return a.instanceNumber - b.instanceNumber;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
