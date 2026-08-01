'use client';

/**
 * DICOM intake — drop a study, preview it, or store it.
 *
 * ENGLISH ON PURPOSE. Everything under `components/dicom/` is English by explicit
 * request, unlike the rest of the dashboard. Do not translate.
 *
 * Two actions, deliberately separated, because they have nothing in common
 * except the file list:
 *
 *   - **Preview locally** touches no network at all. It is the action that works
 *     when the hackathon wifi dies, and it is the one to reach for on stage.
 *   - **Upload to Medplum** is a write. It can fail, so it reports per FILE and
 *     never collapses a partial result into a single green tick — "9 of 12
 *     stored" is the honest sentence and it is only sayable with the full list.
 *
 * The picker has no `accept` filter on purpose: real DICOM files very often have
 * no extension at all (`IM_0001`, `I10`), and an `accept` list would make them
 * unselectable. Filtering happens after the fact with `isLikelyDicomFilename`,
 * which only rejects things that are definitely not DICOM.
 */

import { useCallback, useRef, useState, type DragEvent, type InputHTMLAttributes } from 'react';

import { Card } from '@/components/Card';
import {
  DICOM_API,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_FORM_FIELD,
  apiDegraded,
  describeDicomReason,
  isLikelyDicomFilename,
  EMPTY_UPLOAD_SUMMARY,
  type UploadApiResult,
  type UploadSummary,
} from '@/lib/dicom/types';

interface DicomDropzoneProps {
  /** Hand the picked files straight to the viewer. No network. */
  onPreview: (files: readonly File[]) => void;
  /** Fired after a finished upload so the stored study list can refetch. */
  onUploaded: (summary: UploadSummary) => void;
  /** Bloom stagger order, same convention as the rest of the dashboard. */
  index?: number;
  /** Layout only — the shell decides how this card claims height in its column. */
  className?: string;
}

export function DicomDropzone({ onPreview, onUploaded, index, className }: DicomDropzoneProps) {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [clipped, setClipped] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [upload, setUpload] = useState<UploadApiResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  /**
   * Drag depth, not a boolean.
   *
   * `dragleave` fires on the drop zone every time the pointer crosses into one
   * of its children, so a plain flag makes the highlight strobe while the user
   * is still holding the folder over it. Counting enter/leave pairs is the only
   * reading that survives nested elements.
   */
  const dragDepth = useRef(0);

  const adopt = useCallback((picked: readonly File[]) => {
    const { kept, note } = clampSelection(picked);
    setFiles(kept);
    setClipped(note);
    // A new selection invalidates the previous verdict. Leaving the old result
    // on screen next to a different file list is how someone reads "12 stored"
    // about files that were never sent.
    setUpload(null);
  }, []);

  /* ---------------- drag and drop ---------------- */

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

  /* ---------------- upload ---------------- */

  async function startUpload() {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setUpload(null);

    try {
      const body = new FormData();
      for (const file of files) body.append(UPLOAD_FORM_FIELD, file, file.name);

      const response = await fetch(DICOM_API.upload, { method: 'POST', body });
      // The route contract is HTTP 200 + envelope, always. Anything else means
      // the request never reached the handler, so we build the envelope here
      // rather than letting an exception escape into a client error boundary.
      const result: UploadApiResult = response.ok
        ? ((await response.json()) as UploadApiResult)
        : apiDegraded(EMPTY_UPLOAD_SUMMARY, 'network', `HTTP ${response.status}`);

      setUpload(result);
      onUploaded(result.data);
    } catch (error) {
      setUpload(apiDegraded(EMPTY_UPLOAD_SUMMARY, 'network', messageOf(error)));
    } finally {
      setUploading(false);
    }
  }

  /* ---------------- render ---------------- */

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const busy = uploading || reading;
  const summary = upload?.data ?? null;

  return (
    <Card
      title="Intake"
      subtitle={files.length > 0 ? `${countLabel(files.length)} · ${formatBytes(totalBytes)}` : 'DICOM'}
      index={index}
      className={className}
      bodyClassName="flex min-h-0 flex-col gap-3 px-5 pb-5"
    >
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
        onDrop={onDrop}
        className="tile flex shrink-0 flex-col items-center justify-center gap-2 rounded-tile px-4 py-6 text-center transition-colors"
        style={
          dragging
            ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }
            : undefined
        }
      >
        <span
          aria-hidden
          className="h-px w-8 bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-60"
        />
        <p className="text-sm leading-snug text-ink-2">
          {reading ? 'Reading folder…' : 'Drop a .dcm file, a series, or a whole study folder'}
        </p>
        <div className="flex items-center gap-2 pt-1">
          <button type="button" className="ghostbtn" onClick={() => fileInputRef.current?.click()}>
            Choose files
          </button>
          <button type="button" className="ghostbtn" onClick={() => folderInputRef.current?.click()}>
            Choose folder
          </button>
        </div>
      </div>

      {/* Hidden pickers. No `accept`: extensionless DICOM must stay selectable. */}
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

      {/* ---------------- selection + actions ---------------- */}

      {files.length === 0 ? (
        <p className="shrink-0 text-2xs leading-snug text-ink-3">
          Nothing selected. Preview never leaves this machine; upload writes to Medplum.
        </p>
      ) : (
        <div className="flex shrink-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-xs text-ink-2">
              {countLabel(files.length)} ready · {formatBytes(totalBytes)}
            </span>
            <button
              type="button"
              className="shrink-0 text-2xs text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
              onClick={() => {
                setFiles([]);
                setClipped(null);
                setUpload(null);
              }}
              disabled={busy}
            >
              Clear
            </button>
          </div>

          {clipped ? <p className="text-2xs leading-snug text-warn">{clipped}</p> : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="ghostbtn flex-1"
              onClick={() => onPreview(files)}
              disabled={busy}
            >
              Preview locally
            </button>
            <button
              type="button"
              className="ghostbtn flex-1"
              data-on="true"
              onClick={startUpload}
              disabled={busy}
            >
              {uploading ? 'Uploading…' : 'Upload to Medplum'}
            </button>
          </div>
        </div>
      )}

      {/* ---------------- per-file verdict ---------------- */}

      {upload && summary ? (
        <div className="flex shrink-0 flex-col gap-2">
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {summary.okCount > 0 ? (
              <span className="pill pill-ok">{summary.okCount} stored</span>
            ) : null}
            {summary.failedCount > 0 ? (
              <span className="pill pill-danger">
                <span className="dot dot-alert" aria-hidden />
                {summary.failedCount} failed
              </span>
            ) : null}
            {summary.studyInstanceUids.length > 0 ? (
              <span className="pill pill-quiet">
                {summary.studyInstanceUids.length === 1
                  ? '1 study'
                  : `${summary.studyInstanceUids.length} studies`}
              </span>
            ) : null}
            {upload.source === 'none' && summary.results.length === 0 ? (
              <span className="pill pill-warn" title={upload.detail ?? undefined}>
                Upload rejected — {describeDicomReason(upload.reason)}
              </span>
            ) : null}
          </div>

          {summary.results.length > 0 ? (
            /* Capped instead of `flex-1`: this card sits above the study list in
               a fixed-height column, and a 400-file verdict must scroll inside
               itself rather than push the list off the screen. */
            <ul className="max-h-36 overflow-y-auto pr-1">
              {summary.results.map((result, position) => (
                <li
                  key={`${result.filename}-${position}`}
                  className="flex items-baseline gap-2 border-b border-hair py-1.5 last:border-b-0"
                >
                  <span
                    aria-hidden
                    className="dot mt-1 shrink-0"
                    style={{ background: result.ok ? 'var(--ok)' : 'var(--danger)' }}
                  />
                  <span className="min-w-0 flex-1 truncate text-2xs text-ink-2" title={result.filename}>
                    {result.filename}
                  </span>
                  <span
                    className={`shrink-0 text-2xs ${result.ok ? 'text-ink-3' : 'text-danger'}`}
                    title={result.ok ? result.sopInstanceUid : result.error}
                  >
                    {result.ok ? 'stored' : (result.error ?? 'failed')}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

/**
 * `webkitdirectory` is a real, load-bearing attribute — it is the only way to
 * let someone pick an entire study folder — but React's typings do not know it.
 * The cast is contained here so no component has to repeat it.
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
function clampSelection(picked: readonly File[]): { kept: readonly File[]; note: string | null } {
  const candidates = picked.filter((file) => isLikelyDicomFilename(file.name));
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

  const skipped = picked.length - candidates.length;
  if (skipped > 0) notes.push(`${skipped} non-DICOM file${skipped === 1 ? '' : 's'} ignored.`);

  return { kept: withinBudget, note: notes.length > 0 ? notes.join(' ') : null };
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
