/**
 * `POST /api/dicom/upload` — sends dropped `.dcm` files to Medplum over STOW-RS.
 *
 * ENGLISH ON PURPOSE — see the header of `lib/dicom/types.ts`.
 *
 * The browser posts `multipart/form-data` (what a file input produces); this
 * handler re-encodes it as the `multipart/related` body DICOMweb requires. The
 * two are not interchangeable, which is why the re-encode exists at all.
 *
 * Contract: **always HTTP 200 with an `ApiResult` envelope**, including for bad
 * input and for upstream failures. A status code the client has to branch on
 * would mean the error copy lives in two places and they would drift; here the
 * envelope's `reason` and `detail` are the single source of what went wrong.
 */

import { NextResponse } from 'next/server';

import { classifyDicomError, uploadInstances, type DicomUploadFile } from '@/lib/dicom/medplum-dicom';
import {
  apiDegraded,
  apiOk,
  EMPTY_UPLOAD_SUMMARY,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  summarizeUpload,
  UPLOAD_FORM_FIELD,
  type UploadApiResult,
  type UploadResult,
} from '@/lib/dicom/types';

// Node runtime: the upload path uses `Buffer` and holds whole files in memory.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(result: UploadApiResult): NextResponse {
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}

function rejected(detail: string): NextResponse {
  return json(apiDegraded(EMPTY_UPLOAD_SUMMARY, 'bad-request', detail));
}

/** Sizes for humans, since these numbers end up in an error sentence. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return rejected('The upload could not be read. Please try again.');
  }

  // In `FormData`, anything that is not a string is a file.
  const files = form.getAll(UPLOAD_FORM_FIELD).filter((entry): entry is File => typeof entry !== 'string');

  if (files.length === 0) {
    return rejected('No files were attached to the upload.');
  }
  if (files.length > MAX_UPLOAD_FILES) {
    return rejected(`Too many files: ${files.length}. Upload at most ${MAX_UPLOAD_FILES} at a time.`);
  }

  // Checked from the file handles, before a single byte is read into memory —
  // that is the whole point of the cap.
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return rejected(
      `The upload is ${formatBytes(totalBytes)}, over the ${formatBytes(MAX_UPLOAD_BYTES)} limit. Upload fewer files at a time.`,
    );
  }

  const rejectedFiles: UploadResult[] = [];
  const accepted: DicomUploadFile[] = [];

  await Promise.all(
    files.map(async (file, index) => {
      // A file input can hand over a nameless blob; the name is only used for
      // reporting, so a positional stand-in is better than an empty label.
      const filename = file.name && file.name.trim() !== '' ? file.name : `instance-${index + 1}.dcm`;

      if (file.size === 0) {
        rejectedFiles.push({ filename, ok: false, error: 'The file is empty.' });
        return;
      }

      try {
        accepted.push({ filename, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch {
        rejectedFiles.push({ filename, ok: false, error: 'The file could not be read.' });
      }
    }),
  );

  if (accepted.length === 0) {
    // Nothing worth sending upstream. Still a well-formed answer: every file
    // carries its own reason, so the UI can list them instead of showing a
    // single opaque failure.
    return json(apiOk(summarizeUpload(rejectedFiles)));
  }

  try {
    const results = await uploadInstances(accepted);
    // Partial failure is still a live answer from Medplum: the summary counts
    // say how many made it, and the badge should not claim the link is down.
    return json(apiOk(summarizeUpload([...results, ...rejectedFiles])));
  } catch (error) {
    // `uploadInstances` only throws when it could never start — missing
    // credentials or a refused authentication. Nothing reached Medplum, so the
    // envelope degrades as a whole instead of reporting per-file verdicts.
    const { reason, detail } = classifyDicomError(error);
    return json(apiDegraded(EMPTY_UPLOAD_SUMMARY, reason, detail));
  }
}
