/**
 * DICOM against Medplum — SERVER ONLY.
 *
 * ENGLISH ON PURPOSE — see the header of `./types.ts`.
 *
 * `server-only` is the barrier that keeps `MEDPLUM_CLIENT_SECRET` and the bearer
 * token out of the browser bundle. Every function here runs behind a route
 * handler under `app/api/dicom/`; the client never gets a token, only bytes and
 * JSON envelopes.
 *
 * Two upstream surfaces, on purpose:
 *
 *  - WRITE goes through DICOMweb STOW-RS (`POST /dicomweb/studies`). That is the
 *    only endpoint that knows how to parse a `.dcm`, store the raw bytes as a
 *    `Binary` and create the `DicomStudy` -> `DicomSeries` -> `DicomInstance`
 *    chain. Re-uploading the same study is idempotent.
 *  - READ goes through plain FHIR REST against those same resources, NOT through
 *    QIDO/WADO. Several `/dicomweb/` read routes in Medplum are stubs that answer
 *    HTTP 200 with an EMPTY body instead of 501, so a 200 there proves nothing.
 *    A `Bundle` from `/fhir/R4/DicomInstance?study=...` is unambiguous, and it
 *    carries `raw` — the `Binary` reference to the complete original file, which
 *    is what the viewer actually needs.
 *
 * Reads never throw: they return an `ApiResult` with `source: 'none'` and a
 * reason, exactly like `medplumRead` in `../medplum/server`. The upload may
 * throw, but only when it could not start at all — a per-file failure comes back
 * inside the results array so the UI can say "3 of 12 failed".
 */

import 'server-only';

import { medplumConfigured, medplumWriteClient } from '../medplum/server';
import {
  buildDicomMultipart,
  parseStowResponse,
  readDicomJsonScalar,
  type ByteArray,
  type DicomInstancePart,
} from './multipart';
import {
  apiDegraded,
  apiOk,
  DICOM_CONTENT_TYPE,
  DICOM_TAG,
  dicomDateToIso,
  humanizeDicomPersonName,
  toDicomJsonTag,
  type ApiResult,
  type DicomFallbackReason,
  type InstancesResult,
  type StoredInstance,
  type StoredStudy,
  type StudiesResult,
  type UploadResult,
} from './types';

/* ================================================================== */
/* Budgets                                                             */
/* ================================================================== */

/**
 * Listing budget. Deliberately longer than the 4 s the rest of the chart uses:
 * the study list fans out into a few small enrichment calls, and a study list
 * that gives up at 4 s would show "Medplum did not respond" while the data was
 * a few hundred milliseconds away.
 */
export const DICOM_READ_TIMEOUT_MS = 8_000;

/** One `.dcm` is megabytes, not kilobytes; a full series is worth waiting for. */
export const DICOM_BINARY_TIMEOUT_MS = 20_000;

/** Per upload batch, not per upload. A 25-file batch on hotel wifi is slow. */
export const DICOM_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Upload batching. STOW-RS accepts any number of instances per request, but one
 * 500 MB request is one point of failure: a single malformed file rejects the
 * whole thing and the user is told nothing uploaded. Batches keep failures local
 * and give the server something to acknowledge along the way.
 */
const UPLOAD_BATCH_FILES = 25;
const UPLOAD_BATCH_BYTES = 32 * 1024 * 1024;

/** Studies listed at once. This project holds a handful; the cap is a guard. */
const STUDY_PAGE_SIZE = 50;

/** Series per study, used to resolve each instance's SeriesInstanceUID. */
const SERIES_PAGE_SIZE = 200;

/** Instances per study. A long CT series is ~300; this leaves plenty of room. */
const INSTANCE_PAGE_SIZE = 1_000;

/** Enrichment requests in flight at once, so a long list cannot stampede Medplum. */
const ENRICH_CONCURRENCY = 6;

/** Upstream error bodies are quoted back to the UI; keep them to one line. */
const MAX_DETAIL_CHARS = 240;

/* ================================================================== */
/* Upstream plumbing                                                   */
/* ================================================================== */

/** An error that already knows how it should degrade on screen. */
class DicomUpstreamError extends Error {
  readonly reason: Exclude<DicomFallbackReason, null>;

  constructor(reason: Exclude<DicomFallbackReason, null>, message: string) {
    super(message);
    this.name = 'DicomUpstreamError';
    this.reason = reason;
  }
}

interface UpstreamContext {
  /** Base URL with no trailing slash, e.g. `https://api.medplum.com`. */
  readonly baseUrl: string;
  readonly token: string;
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_DETAIL_CHARS ? flat : `${flat.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Authenticated client plus a raw bearer token.
 *
 * `medplumWriteClient()` is reused for reads too: the "write" in its name is
 * about its contract (it throws instead of degrading), not about the HTTP verb,
 * and it is the only exported way to get an authenticated client. The throw is
 * caught by `dicomRead` below and turned into a visible degradation.
 *
 * The token never leaves this module — it is only ever attached to an outgoing
 * `Authorization` header and is never logged, returned or embedded in an error.
 */
async function upstream(): Promise<UpstreamContext> {
  if (!medplumConfigured) {
    throw new DicomUpstreamError('not-configured', 'MEDPLUM_CLIENT_ID or MEDPLUM_CLIENT_SECRET is missing.');
  }

  let medplum;
  try {
    medplum = await medplumWriteClient();
  } catch (error) {
    throw new DicomUpstreamError('auth-failed', truncate(messageOf(error)));
  }

  const token = medplum.getAccessToken();
  if (!token) {
    throw new DicomUpstreamError('auth-failed', 'Medplum returned no access token.');
  }

  // `MedplumClient` normalizes its base URL with a trailing slash; strip it so
  // path concatenation never produces `//dicomweb`, which does not route.
  return { baseUrl: medplum.getBaseUrl().replace(/\/+$/, ''), token };
}

/**
 * Maps any thrown value onto the degradation vocabulary of the envelope.
 *
 * Exported for the upload route: uploads throw instead of degrading, so the
 * route needs the same translation the read path gets for free. Without this it
 * would have to sniff the message text to tell "no credentials" from
 * "authentication refused", and those two need different copy on screen.
 */
export function classifyDicomError(error: unknown): {
  reason: Exclude<DicomFallbackReason, null>;
  detail: string;
} {
  if (error instanceof DicomUpstreamError) {
    return { reason: error.reason, detail: error.message };
  }
  // `AbortSignal.timeout` rejects with a DOMException named 'TimeoutError'.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { reason: 'timeout', detail: 'Medplum did not respond in time.' };
  }
  return { reason: 'network', detail: truncate(messageOf(error)) };
}

/** HTTP status -> degradation reason. 404 is "nothing there", not "broken". */
function reasonForStatus(status: number): Exclude<DicomFallbackReason, null> {
  if (status === 401 || status === 403) return 'auth-failed';
  if (status === 404) return 'empty';
  if (status >= 400 && status < 500) return 'bad-request';
  return 'network';
}

async function upstreamFetch(
  ctx: UpstreamContext,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit },
  timeoutMs: number,
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${ctx.token}`, ...init.headers },
    body: init.body,
    // Route handlers are already dynamic; this makes it explicit that a study
    // list must never be served from a build-time cache.
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Reads an OperationOutcome (or anything else) into one quotable sentence.
 * Never throws — this runs on the error path, where a second failure would
 * replace a useful message with a stack trace.
 */
async function describeErrorBody(response: Response): Promise<string> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const outcome = parsed as { issue?: { details?: { text?: string }; diagnostics?: string }[] };
      const issue = Array.isArray(outcome.issue) ? outcome.issue[0] : undefined;
      const message = issue?.details?.text ?? issue?.diagnostics;
      if (message) return truncate(`HTTP ${response.status}: ${message}`);
    }
  } catch {
    // Not JSON. Fall through to the raw text, which is still better than nothing.
  }

  return truncate(text === '' ? `HTTP ${response.status}` : `HTTP ${response.status}: ${text}`);
}

/** Authenticated FHIR GET returning parsed JSON, or a `DicomUpstreamError`. */
async function fetchFhirJson<T>(ctx: UpstreamContext, path: string): Promise<T> {
  const response = await upstreamFetch(
    ctx,
    path,
    { headers: { Accept: 'application/fhir+json' } },
    DICOM_READ_TIMEOUT_MS,
  );

  if (!response.ok) {
    throw new DicomUpstreamError(reasonForStatus(response.status), await describeErrorBody(response));
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new DicomUpstreamError('network', `Medplum returned a malformed response: ${truncate(messageOf(error))}`);
  }
}

/**
 * Degradable read wrapper. Same invariant as `medplumRead`: **never throws**.
 *
 * `empty` is passed by value rather than built lazily so the failure path itself
 * cannot fail.
 */
async function dicomRead<T>(empty: T, read: (ctx: UpstreamContext) => Promise<T>): Promise<ApiResult<T>> {
  try {
    return apiOk(await read(await upstream()));
  } catch (error) {
    const { reason, detail } = classifyDicomError(error);
    return apiDegraded(empty, reason, detail);
  }
}

/** Runs `task` over `items` with a bounded number of requests in flight. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const chunk = items.slice(start, start + limit);
    out.push(...(await Promise.all(chunk.map(task))));
  }
  return out;
}

/* ================================================================== */
/* Shapes of the Medplum DICOM resources                               */
/* ================================================================== */

/**
 * `DicomStudy` / `DicomSeries` / `DicomInstance` are Medplum extensions, absent
 * from `@medplum/fhirtypes`, so they are described here.
 *
 * The field names below are not guesses: they were read off this server's own
 * GraphQL schema (`POST /fhir/R4/$graphql` with an `__type` introspection
 * query), which is the authoritative list. Two of those findings shaped the code:
 *
 *  - `DicomStudy` has NO study-description field. The description on screen has
 *    to come from an instance's `metadata`, which is why the study list pulls one
 *    sample instance per study instead of trusting the study resource alone.
 *  - `DicomStudy` DOES carry `modalitiesInStudy` and the two
 *    `numberOfStudyRelated*` counts, so none of those need a fan-out query.
 *
 * Every field stays optional: the server can legitimately omit any of them when
 * the DICOM header did not contain the tag.
 */
interface FhirReference {
  reference?: string;
}

interface FhirBundle<T> {
  resourceType?: string;
  /** Present only when the query asked for `_total=accurate`. */
  total?: number;
  entry?: { resource?: T }[];
}

/** Common shape, kept indexable so the tolerant readers below can be reused. */
type DicomResource = Record<string, unknown> & { id?: string };

interface DicomStudyResource extends DicomResource {
  studyInstanceUid?: string;
  /** DICOM `DA`, e.g. `20240131`. */
  studyDate?: string;
  /** DICOM `PN`, e.g. `DOE^JANE`. */
  patientName?: string;
  modalitiesInStudy?: unknown;
  numberOfStudyRelatedSeries?: number;
  numberOfStudyRelatedInstances?: number;
}

interface DicomSeriesResource extends DicomResource {
  seriesInstanceUid?: string;
  modality?: string;
}

interface DicomInstanceResource extends DicomResource {
  sopInstanceUid?: string;
  /** Typed as a string in the schema (DICOM `IS`), so it is read tolerantly. */
  instanceNumber?: unknown;
  rows?: number;
  columns?: number;
  numberOfFrames?: number;
  series?: FhirReference;
  study?: FhirReference;
  /** Points at the complete original `.dcm` file. */
  raw?: FhirReference;
  /** DICOM JSON as a string. */
  metadata?: unknown;
}

function bundleResources<T>(bundle: FhirBundle<T> | null | undefined): T[] {
  if (!bundle || !Array.isArray(bundle.entry)) return [];
  const out: T[] = [];
  for (const entry of bundle.entry) {
    if (entry && entry.resource) out.push(entry.resource);
  }
  return out;
}

/** Trimmed string field, or `null` for absent-or-blank. Never returns `''`. */
function pickString(resource: DicomResource | null | undefined, ...keys: string[]): string | null {
  if (!resource) return null;
  for (const key of keys) {
    const value = resource[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Numeric field, accepting the string form too.
 *
 * Not defensive padding: `DicomInstance.instanceNumber` is declared as a string
 * in the schema because DICOM `IS` is a string VR, while `rows` and
 * `numberOfFrames` are declared numeric. Reading both shapes with one function
 * means the slice order does not silently collapse if a value arrives quoted.
 */
function pickNumber(resource: DicomResource | null | undefined, ...keys: string[]): number | null {
  if (!resource) return null;
  for (const key of keys) {
    const value = resource[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/** `Binary/abc-123` -> `abc-123`. Also tolerates a bare id. */
function referenceId(reference: FhirReference | undefined, resourceType: string): string | null {
  const raw = reference?.reference;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  const prefix = `${resourceType}/`;
  const id = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return id === '' ? null : id;
}

/* ------------------------------------------------------------------ */
/* DICOM JSON metadata                                                 */
/* ------------------------------------------------------------------ */

type DicomMetadata = Record<string, unknown>;

/** `DicomInstance.metadata` is documented as a JSON string; objects are tolerated. */
function parseMetadata(raw: unknown): DicomMetadata | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as DicomMetadata;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as DicomMetadata) : null;
  } catch {
    // A metadata blob we cannot read costs a column, not the screen.
    return null;
  }
}

/**
 * Reads one tag out of the metadata, trying the denaturalized key (`'00080020'`)
 * first and the naturalized name (`'StudyDate'`) second. Which one Medplum
 * stores depends on how dcmjs was invoked, and guessing wrong would blank every
 * study description on the list.
 */
function metadataTag(meta: DicomMetadata | null, tag: string, naturalName: string): string | null {
  if (!meta) return null;
  const byTag = readDicomJsonScalar(meta[toDicomJsonTag(tag)]);
  if (byTag !== null) return byTag;
  return readDicomJsonScalar(meta[naturalName]);
}

/**
 * Study dates arrive either as DICOM `DA` (`20240131`) from a header or as an
 * ISO date/dateTime if Medplum already normalized the field. Both collapse to
 * `YYYY-MM-DD`; anything else becomes `null` rather than a guess.
 */
function normalizeStudyDate(raw: string | null): string | null {
  if (!raw) return null;
  const iso = dicomDateToIso(raw);
  if (iso) return iso;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return match ? match[1] : null;
}

/* ================================================================== */
/* Upload — STOW-RS                                                    */
/* ================================================================== */

/** One file handed to the upload, already read into memory by the route. */
export interface DicomUploadFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** Splits by file count AND accumulated bytes, whichever ceiling comes first. */
function batchFiles(files: readonly DicomUploadFile[]): DicomUploadFile[][] {
  const batches: DicomUploadFile[][] = [];
  let current: DicomUploadFile[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const wouldOverflow =
      current.length >= UPLOAD_BATCH_FILES ||
      (current.length > 0 && currentBytes + file.bytes.length > UPLOAD_BATCH_BYTES);

    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(file);
    currentBytes += file.bytes.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

interface BatchOutcome {
  readonly results: UploadResult[];
  /**
   * True when the batch failed as a unit for a reason a single file could be
   * responsible for. Retrying those files one by one turns "25 failed" into the
   * truth, which is usually "1 failed".
   */
  readonly isolatable: boolean;
}

async function postBatch(ctx: UpstreamContext, batch: readonly DicomUploadFile[]): Promise<BatchOutcome> {
  const parts: DicomInstancePart[] = batch.map((file) => ({ filename: file.filename, bytes: file.bytes }));

  let payload;
  try {
    payload = buildDicomMultipart(parts);
  } catch (error) {
    return {
      results: batch.map((file) => ({ filename: file.filename, ok: false, error: truncate(messageOf(error)) })),
      isolatable: false,
    };
  }

  let response: Response;
  try {
    response = await upstreamFetch(
      ctx,
      '/dicomweb/studies',
      {
        method: 'POST',
        headers: { 'Content-Type': payload.contentType, Accept: 'application/dicom+json' },
        body: payload.body,
      },
      DICOM_UPLOAD_TIMEOUT_MS,
    );
  } catch (error) {
    const { detail } = classifyDicomError(error);
    return {
      results: batch.map((file) => ({ filename: file.filename, ok: false, error: `Upload failed: ${detail}` })),
      // The transport failed, not this particular file. Retrying one at a time
      // would just multiply the same failure by the batch size.
      isolatable: false,
    };
  }

  if (!response.ok) {
    const detail = await describeErrorBody(response);
    return {
      results: batch.map((file) => ({ filename: file.filename, ok: false, error: `Medplum rejected the upload. ${detail}` })),
      // A 4xx is the server saying "this content is wrong", which one bad file
      // in the batch is enough to cause. A 5xx is not the file's fault.
      isolatable: response.status >= 400 && response.status < 500 && batch.length > 1,
    };
  }

  // 2xx means Medplum stored the study. Whatever the body looks like from here
  // on, the files are uploaded; the parser degrades to "UID unknown", never to
  // a false failure.
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { results: parseStowResponse(body, parts), isolatable: false };
}

/**
 * Uploads instances to Medplum over STOW-RS and reports a verdict per file.
 *
 * Throws only when the upload could not start (no credentials, authentication
 * refused). Everything after that is reported per file: the route wraps the
 * array in a summary and the UI can say exactly which files did not make it.
 */
export async function uploadInstances(files: readonly DicomUploadFile[]): Promise<UploadResult[]> {
  if (files.length === 0) return [];

  const ctx = await upstream(); // throws — the route degrades it into an envelope
  const results: UploadResult[] = [];

  // Sequential on purpose: batches are large, the server is shared with the rest
  // of the demo, and ordered results make the per-file list read in drop order.
  for (const batch of batchFiles(files)) {
    const outcome = await postBatch(ctx, batch);

    if (!outcome.isolatable) {
      results.push(...outcome.results);
      continue;
    }

    // Re-send one file at a time to find the actual culprit.
    for (const file of batch) {
      const single = await postBatch(ctx, [file]);
      results.push(...single.results);
    }
  }

  return results;
}

/* ================================================================== */
/* Read — study list                                                   */
/* ================================================================== */

function fhirSearchPath(resourceType: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `/fhir/R4/${resourceType}?${query}`;
}

/** `modalitiesInStudy` is a repeating element; normalize it to uppercase strings. */
function readModalities(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const modality = item.trim().toUpperCase();
    if (modality !== '' && !out.includes(modality)) out.push(modality);
  }
  return out;
}

/**
 * Enriches one study row with the facts the study resource cannot supply.
 *
 * Exactly ONE extra request per study, and only because `DicomStudy` has no
 * description field: a one-instance page carries a `metadata` blob with
 * StudyDescription in it. Asking for it with `_total=accurate` makes that same
 * request double as a backstop for the instance count.
 *
 * Counts and modalities come straight off `DicomStudy`
 * (`numberOfStudyRelatedSeries`, `numberOfStudyRelatedInstances`,
 * `modalitiesInStudy`), so no series query is needed at all.
 *
 * Never throws: a study whose sample instance cannot be read is still listed,
 * with `null` where a fact is unknown. `null` renders as "—", which is honest;
 * a `0` would be a lie about a study that has slices.
 */
async function enrichStudy(ctx: UpstreamContext, resource: DicomStudyResource): Promise<StoredStudy | null> {
  const id = typeof resource.id === 'string' ? resource.id : null;
  const studyInstanceUid = pickString(resource, 'studyInstanceUid');

  // Both halves are the identity of the row: the id addresses the sub-resources,
  // the UID addresses the study everywhere else. Without either it is unusable.
  if (!id || !studyInstanceUid) return null;

  const sampleBundle = await fetchFhirJson<FhirBundle<DicomInstanceResource>>(
    ctx,
    fhirSearchPath('DicomInstance', { study: `DicomStudy/${id}`, _count: '1', _total: 'accurate' }),
  ).catch(() => null);

  const sample = bundleResources(sampleBundle)[0] ?? null;
  const meta = parseMetadata(sample?.metadata);

  const modalities = readModalities(resource.modalitiesInStudy);
  if (modalities.length === 0) {
    // Only reachable when the header omitted (0008,0061) at upload time.
    const fromMeta = metadataTag(meta, DICOM_TAG.modality, 'Modality');
    if (fromMeta) modalities.push(fromMeta.toUpperCase());
  }

  const instanceCount =
    pickNumber(resource, 'numberOfStudyRelatedInstances') ??
    (sampleBundle && typeof sampleBundle.total === 'number' ? sampleBundle.total : null);

  return {
    id,
    studyInstanceUid,
    studyDate: normalizeStudyDate(
      pickString(resource, 'studyDate') ?? metadataTag(meta, DICOM_TAG.studyDate, 'StudyDate'),
    ),
    // No study-level field exists for this; the instance metadata is the source.
    studyDescription: metadataTag(meta, DICOM_TAG.studyDescription, 'StudyDescription'),
    patientName: humanizeDicomPersonName(
      pickString(resource, 'patientName') ?? metadataTag(meta, DICOM_TAG.patientName, 'PatientName'),
    ),
    modalities,
    seriesCount: pickNumber(resource, 'numberOfStudyRelatedSeries'),
    instanceCount,
  };
}

/** Newest first; studies without a date sink to the bottom rather than to 1970. */
function byStudyDateDesc(a: StoredStudy, b: StoredStudy): number {
  if (a.studyDate && b.studyDate && a.studyDate !== b.studyDate) return a.studyDate < b.studyDate ? 1 : -1;
  if (a.studyDate && !b.studyDate) return -1;
  if (!a.studyDate && b.studyDate) return 1;
  return a.studyInstanceUid.localeCompare(b.studyInstanceUid);
}

/**
 * Every stored study, newest first.
 *
 * An empty project is a healthy answer, not a degradation: it comes back as
 * `apiOk([])` so the badge still says the connection is live and the UI shows
 * its own "nothing uploaded yet" state. `source: 'none'` is reserved for
 * "we could not ask".
 */
export async function listStudies(): Promise<StudiesResult> {
  return dicomRead<readonly StoredStudy[]>([], async (ctx) => {
    const bundle = await fetchFhirJson<FhirBundle<DicomStudyResource>>(
      ctx,
      fhirSearchPath('DicomStudy', { _count: String(STUDY_PAGE_SIZE), _total: 'accurate' }),
    );

    const enriched = await mapBounded(bundleResources(bundle), ENRICH_CONCURRENCY, (resource) =>
      enrichStudy(ctx, resource),
    );

    const studies: StoredStudy[] = [];
    for (const study of enriched) {
      if (study) studies.push(study);
    }

    return studies.sort(byStudyDateDesc);
  });
}

/* ================================================================== */
/* Read — instances of one study                                       */
/* ================================================================== */

/** Sorted by instance number; unnumbered instances go last, then by UID. */
function byInstanceNumber(a: StoredInstance, b: StoredInstance): number {
  if (a.instanceNumber !== null && b.instanceNumber !== null && a.instanceNumber !== b.instanceNumber) {
    return a.instanceNumber - b.instanceNumber;
  }
  if (a.instanceNumber !== null && b.instanceNumber === null) return -1;
  if (a.instanceNumber === null && b.instanceNumber !== null) return 1;
  return a.sopInstanceUid.localeCompare(b.sopInstanceUid);
}

/**
 * Every instance of a study, addressed by StudyInstanceUID.
 *
 * The UID is resolved to a `DicomStudy` id first because the instance search
 * parameter is `study` (a reference), not the UID. Three requests, all plain
 * FHIR — no QIDO, no WADO, nothing that can answer 200 with an empty body.
 *
 * The series UID of each instance comes from one `DicomSeries` lookup rather
 * than from JSON-parsing 300 metadata blobs, with the metadata as the fallback
 * when an instance carries no series reference.
 */
export async function listInstances(studyInstanceUid: string): Promise<InstancesResult> {
  const uid = studyInstanceUid.trim();
  if (uid === '') {
    return apiDegraded<readonly StoredInstance[]>([], 'bad-request', 'A study instance UID is required.');
  }

  return dicomRead<readonly StoredInstance[]>([], async (ctx) => {
    const studyBundle = await fetchFhirJson<FhirBundle<DicomStudyResource>>(
      ctx,
      fhirSearchPath('DicomStudy', { 'study-instance-uid': uid, _count: '1' }),
    );

    const study = bundleResources(studyBundle)[0];
    const studyId = study && typeof study.id === 'string' ? study.id : null;
    if (!studyId) {
      throw new DicomUpstreamError('empty', 'No stored study matches this UID.');
    }

    const studyReference = `DicomStudy/${studyId}`;

    const [instanceBundle, seriesBundle] = await Promise.all([
      fetchFhirJson<FhirBundle<DicomInstanceResource>>(
        ctx,
        fhirSearchPath('DicomInstance', { study: studyReference, _count: String(INSTANCE_PAGE_SIZE) }),
      ),
      fetchFhirJson<FhirBundle<DicomSeriesResource>>(
        ctx,
        fhirSearchPath('DicomSeries', { study: studyReference, _count: String(SERIES_PAGE_SIZE) }),
      ).catch(() => null),
    ]);

    // `DicomSeries/{id}` -> SeriesInstanceUID.
    const seriesUidById = new Map<string, string>();
    for (const series of bundleResources(seriesBundle)) {
      const seriesId = typeof series.id === 'string' ? series.id : null;
      const seriesUid = pickString(series, 'seriesInstanceUid');
      if (seriesId && seriesUid) seriesUidById.set(seriesId, seriesUid);
    }

    const instances: StoredInstance[] = [];
    for (const resource of bundleResources(instanceBundle)) {
      const id = typeof resource.id === 'string' ? resource.id : null;
      const sopInstanceUid = pickString(resource, 'sopInstanceUid');
      if (!id || !sopInstanceUid) continue;

      const seriesId = referenceId(resource.series, 'DicomSeries');
      const seriesFromMap = seriesId ? seriesUidById.get(seriesId) ?? null : null;
      const seriesInstanceUid =
        seriesFromMap ??
        metadataTag(parseMetadata(resource.metadata), DICOM_TAG.seriesInstanceUid, 'SeriesInstanceUID');

      const frames = pickNumber(resource, 'numberOfFrames');

      instances.push({
        id,
        sopInstanceUid,
        instanceNumber: pickNumber(resource, 'instanceNumber'),
        binaryId: referenceId(resource.raw, 'Binary'),
        rows: pickNumber(resource, 'rows'),
        columns: pickNumber(resource, 'columns'),
        // A single-frame instance is one frame, never zero.
        numberOfFrames: frames !== null && frames > 0 ? Math.trunc(frames) : 1,
        seriesInstanceUid,
      });
    }

    return instances.sort(byInstanceNumber);
  });
}

/* ================================================================== */
/* Read — raw instance bytes                                           */
/* ================================================================== */

export interface BinaryPayload {
  /** `ByteArray`, not `Uint8Array`: this goes straight into a `Response` body. */
  readonly bytes: ByteArray;
  /**
   * The `DicomInstance` id these bytes belong to, already normalized and
   * validated. The route builds its filename from THIS string and never from the
   * raw path segment: validating one string and interpolating another into a
   * header is how a trailing `%0A` turns into an invalid-header crash.
   */
  readonly instanceId: string;
}

/** FHIR id grammar. Also the guard that stops a crafted id from walking the API. */
const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * `DicomInstance` id -> `Binary` id, memoized.
 *
 * The mapping is immutable: an instance's `raw` reference is written once at
 * STOW time and re-uploading the same study is idempotent. Caching it means the
 * ownership check below costs one extra request per instance per process, not
 * one per slice fetch, which matters when a 300-slice CT is opened twice.
 *
 * Bounded so a long demo cannot grow it without limit; eviction is oldest-first,
 * which `Map` gives us for free through its insertion order.
 */
const RAW_BINARY_CACHE = new Map<string, string>();
const RAW_BINARY_CACHE_MAX = 2_000;

function rememberRawBinary(instanceId: string, binaryId: string): void {
  if (RAW_BINARY_CACHE.size >= RAW_BINARY_CACHE_MAX) {
    const oldest = RAW_BINARY_CACHE.keys().next();
    if (!oldest.done) RAW_BINARY_CACHE.delete(oldest.value);
  }
  RAW_BINARY_CACHE.set(instanceId, binaryId);
}

/**
 * Resolves the `Binary` that holds the original file of ONE `DicomInstance`.
 *
 * This is the authorization step, not a convenience. Our client credentials can
 * read every `Binary` in the project — lab PDFs, `DocumentReference`
 * attachments, anything another service stores — so a route that accepted a
 * `Binary` id straight from the URL would lend that credential out as a
 * read-any-blob capability to anyone who can reach the dashboard. Going through
 * `DicomInstance.raw` means the only bytes reachable from the browser are bytes
 * that belong to a DICOM instance this section put there.
 */
async function resolveRawBinaryId(ctx: UpstreamContext, instanceId: string): Promise<string> {
  const cached = RAW_BINARY_CACHE.get(instanceId);
  if (cached) return cached;

  const instance = await fetchFhirJson<DicomInstanceResource>(
    ctx,
    `/fhir/R4/DicomInstance/${encodeURIComponent(instanceId)}`,
  );

  const binaryId = referenceId(instance?.raw, 'Binary');
  if (!binaryId || !FHIR_ID_PATTERN.test(binaryId)) {
    // The instance exists but carries no retrievable file. That is a real state
    // — the UI already knows how to say "this instance has no bytes".
    throw new DicomUpstreamError('empty', 'This instance has no stored file.');
  }

  rememberRawBinary(instanceId, binaryId);
  return binaryId;
}

/**
 * Fetches the complete original `.dcm` bytes of one stored instance.
 *
 * Addressed by `DicomInstance` id, NOT by `Binary` id — see
 * `resolveRawBinaryId` above for why that indirection is the whole point.
 *
 * This is what makes one rendering path possible: the browser receives the same
 * bytes it would have read from a local file, so a stored study and a dropped
 * folder go through the identical cornerstone `wadouri` file path. The bearer
 * token stays here — the browser only ever talks to `/api/dicom/binary/{id}`.
 */
export async function fetchInstanceBytes(instanceId: string): Promise<ApiResult<BinaryPayload | null>> {
  const id = instanceId.trim();
  if (!FHIR_ID_PATTERN.test(id)) {
    return apiDegraded<BinaryPayload | null>(null, 'bad-request', 'That is not a valid instance id.');
  }

  return dicomRead<BinaryPayload | null>(null, async (ctx) => {
    const binaryId = await resolveRawBinaryId(ctx, id);

    const response = await upstreamFetch(
      ctx,
      `/fhir/R4/Binary/${encodeURIComponent(binaryId)}`,
      // Ask for the bytes, not the FHIR wrapper. The `q=` weights matter: with a
      // bare `*/*` some servers happily answer `application/fhir+json`.
      { headers: { Accept: `${DICOM_CONTENT_TYPE}, application/octet-stream;q=0.9, */*;q=0.1` } },
      DICOM_BINARY_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new DicomUpstreamError(reasonForStatus(response.status), await describeErrorBody(response));
    }

    // Read only to pick the decoding branch. The upstream content type is NEVER
    // echoed to the browser: the route serves `application/dicom` and nothing
    // else, so a `Binary` that somehow claimed `text/html` could not become
    // active content on our own origin.
    const contentType = response.headers.get('content-type') ?? DICOM_CONTENT_TYPE;

    // Defensive branch: if the server answered with the FHIR `Binary` resource
    // instead of the raw stream, the bytes are still in there as base64. Failing
    // here would leave the viewer with a study it can list but cannot open.
    if (contentType.includes('json')) {
      const text = await response.text();
      let data: unknown = null;
      try {
        data = (JSON.parse(text) as { data?: unknown }).data;
      } catch {
        data = null;
      }
      if (typeof data !== 'string' || data === '') {
        throw new DicomUpstreamError('network', 'Medplum returned JSON instead of DICOM bytes.');
      }
      const decoded = Buffer.from(data, 'base64');
      return { bytes: new Uint8Array(decoded), instanceId: id };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new DicomUpstreamError('empty', 'Medplum returned an empty file.');
    }

    return { bytes, instanceId: id };
  });
}
