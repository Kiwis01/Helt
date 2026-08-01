/**
 * `/api/dicom/patients/{patientId}/studies` — imaging scoped to ONE patient.
 *
 * ENGLISH ON PURPOSE — see the header of `lib/dicom/types.ts`.
 *
 *   GET  ?                      -> `StudiesResult`   the patient's linked studies
 *   GET  ?studyUid={uid}        -> `InstancesResult` the instances of one of them
 *   POST multipart/form-data    -> `ApiResult<PatientUploadSummary>`
 *
 * One route, two GET shapes, discriminated by the presence of `studyUid`. The
 * alternative — a nested `/studies/{uid}/instances` folder — reads nicer but
 * gives the ownership check a second door to be forgotten at; keeping both reads
 * behind one handler means `patientId` is validated once, in one place, and
 * every path out of here goes through `lib/dicom/patient-imaging`. Both shapes
 * are `ApiResult<readonly T[]>`, so the client's envelope handling is unchanged.
 *
 * Contract, identical to the rest of the DICOM section: **always HTTP 200 with
 * an `ApiResult`**, upstream failures included. A status code the client has to
 * branch on would put the error copy in two places, and they would drift.
 *
 * What this route must never become: a way to read imaging that does not belong
 * to the patient it names. `patientId` is checked against the FHIR id grammar
 * before it reaches any search parameter, and the study reads go through
 * `listPatientStudies` / `listPatientStudyInstances`, which resolve nothing
 * without an `ImagingStudy` naming this exact subject. There is deliberately no
 * fallback to the project-wide `listStudies()`.
 */

import { NextResponse } from 'next/server';

import { classifyDicomError, type DicomUploadFile } from '@/lib/dicom/medplum-dicom';
import {
  EMPTY_PATIENT_UPLOAD_SUMMARY,
  isValidPatientId,
  listPatientStudies,
  listPatientStudyInstances,
  uploadForPatient,
  type PatientUploadSummary,
} from '@/lib/dicom/patient-imaging';
import {
  apiDegraded,
  apiOk,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_FORM_FIELD,
  type ApiResult,
  type StoredInstance,
  type StoredStudy,
  type UploadResult,
} from '@/lib/dicom/types';

// Node runtime: the upload path holds whole files in memory and parses DICOM
// headers with `dicom-parser`, which pulls in `zlib`.
export const runtime = 'nodejs';
// A chart panel must never show a study list cached from another render.
export const dynamic = 'force-dynamic';

interface RouteContext {
  /** In Next 15 the dynamic segments arrive as a promise and must be awaited. */
  params: Promise<{ patientId: string }>;
}

function json<T>(result: ApiResult<T>): NextResponse {
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}

/** Sizes for humans, since these numbers end up in an error sentence. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/**
 * The patient id, or `null` if it is not one.
 *
 * Next has already decoded the segment. The pattern is the FHIR id grammar and
 * it runs before the value reaches a search parameter — that ordering is the
 * point, not the pattern.
 */
async function readPatientId(context: RouteContext): Promise<string | null> {
  const { patientId } = await context.params;
  const id = typeof patientId === 'string' ? patientId.trim() : '';
  return id !== '' && isValidPatientId(id) ? id : null;
}

/* ================================================================== */
/* GET                                                                 */
/* ================================================================== */

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const patientId = await readPatientId(context);
  if (!patientId) {
    return json(apiDegraded<readonly StoredStudy[]>([], 'bad-request', 'That is not a valid patient id.'));
  }

  const studyUid = new URL(request.url).searchParams.get('studyUid');

  if (studyUid !== null) {
    // Instances of one study. `listPatientStudyInstances` proves the study is
    // linked to this patient BEFORE it resolves anything.
    const trimmed = studyUid.trim();
    if (trimmed === '') {
      return json(
        apiDegraded<readonly StoredInstance[]>([], 'bad-request', 'A study instance UID is required.'),
      );
    }
    return json(await listPatientStudyInstances(patientId, trimmed));
  }

  // Neither function throws; there is deliberately no try/catch to add.
  return json(await listPatientStudies(patientId));
}

/* ================================================================== */
/* POST                                                                */
/* ================================================================== */

function rejected(detail: string): NextResponse {
  return json(apiDegraded<PatientUploadSummary>(EMPTY_PATIENT_UPLOAD_SUMMARY, 'bad-request', detail));
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const patientId = await readPatientId(context);
  if (!patientId) {
    return rejected('That is not a valid patient id.');
  }

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
    // Nothing worth sending upstream, but still a well-formed answer: every file
    // carries its own reason, so the panel lists them instead of showing one
    // opaque failure.
    return json(
      apiOk<PatientUploadSummary>({
        ...EMPTY_PATIENT_UPLOAD_SUMMARY,
        results: rejectedFiles,
        failedCount: rejectedFiles.length,
      }),
    );
  }

  try {
    const summary = await uploadForPatient(patientId, accepted);

    // Partial failure is still a live answer from Medplum. The counts say how
    // many files made it and `linkError` says what did not reach this chart, so
    // the badge must not claim the link is down.
    return json(
      apiOk<PatientUploadSummary>({
        ...summary,
        results: [...summary.results, ...rejectedFiles],
        failedCount: summary.failedCount + rejectedFiles.length,
      }),
    );
  } catch (error) {
    // `uploadForPatient` only throws when the upload could never start — missing
    // credentials or a refused authentication. Nothing reached Medplum, so the
    // envelope degrades as a whole instead of reporting per-file verdicts.
    // `classifyDicomError` yields a short message; Medplum's own error body is
    // never echoed to the browser.
    const { reason, detail } = classifyDicomError(error);
    console.warn(`[dicom/patients] upload degraded (${reason}): ${detail}`);
    return json(
      apiDegraded<PatientUploadSummary>(
        EMPTY_PATIENT_UPLOAD_SUMMARY,
        reason,
        reason === 'not-configured'
          ? 'Medplum credentials are not configured on the server.'
          : 'The upload could not be sent to Medplum.',
      ),
    );
  }
}
