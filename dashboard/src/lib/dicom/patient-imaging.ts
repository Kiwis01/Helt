/**
 * Per-patient DICOM imaging — SERVER ONLY.
 *
 * ENGLISH ON PURPOSE. The rest of the chart page is written in Spanish; this
 * module, like everything else under `lib/dicom/`, is English by explicit
 * request. Do not translate it in an i18n pass.
 *
 * ------------------------------------------------------------------
 * Why this file exists at all
 * ------------------------------------------------------------------
 *
 * Medplum's `DicomStudy` resource has NO reference to a `Patient`. It carries
 * the DICOM tag TEXT — `patientName`, `patientId`, `patientBirthDate`,
 * `patientSex` — and its search parameters (`patient-id`, `patient-name`) match
 * that text, not a `Patient/{id}` reference. So an uploaded study belongs to
 * nobody: a panel built straight on `DicomStudy` would show EVERY study in the
 * project inside EVERY patient's chart.
 *
 * The link is therefore modelled with the standard FHIR `ImagingStudy`, whose
 * `subject` IS a `Reference<Patient>`:
 *
 *   write:  STOW the bytes  ->  upsert `ImagingStudy` { subject, identifier }
 *   read:   `ImagingStudy?subject=Patient/{id}`
 *             -> StudyInstanceUID out of the identifier
 *             -> `DicomStudy?study-instance-uid={uid}`
 *             -> `DicomInstance?study=DicomStudy/{id}` (via `listInstances`)
 *             -> bytes via `/api/dicom/binary/{instanceId}`
 *
 * The `.dcm` bytes are never rewritten to carry a Loop patient id. Editing a
 * PatientID tag in place corrupts file integrity and breaks the study's own
 * identity; the linkage lives beside the file, not inside it.
 *
 * ------------------------------------------------------------------
 * The invariant this module is responsible for
 * ------------------------------------------------------------------
 *
 * A caller-supplied StudyInstanceUID is NEVER resolved to instances without
 * first proving an `ImagingStudy` exists with BOTH that subject AND that
 * identifier. Without that check the route would be a way to read any study in
 * the project by guessing UIDs, which is exactly the leak this file prevents.
 *
 * And there is deliberately NO fallback to `listStudies()`: that returns every
 * study in the project, so a "helpful" fallback for a patient with nothing
 * linked would put every patient's imaging into every chart. Zero linked
 * studies is a healthy answer — `apiOk([])`, and the panel shows its empty state.
 */

import 'server-only';

import { getStatus, normalizeErrorString, OperationOutcomeError, type MedplumClient } from '@medplum/core';
import type { Coding, ImagingStudy } from '@medplum/fhirtypes';
import { parseDicom, type DataSet } from 'dicom-parser';

import { medplumConfigured, medplumWriteClient } from '../medplum/server';
import {
  classifyDicomError,
  listInstances,
  uploadInstances,
  DICOM_READ_TIMEOUT_MS,
  type DicomUploadFile,
} from './medplum-dicom';
import {
  apiDegraded,
  apiOk,
  DICOM_TAG,
  dicomDateToIso,
  EMPTY_UPLOAD_SUMMARY,
  humanizeDicomPersonName,
  summarizeUpload,
  type ApiResult,
  type DicomFallbackReason,
  type InstancesResult,
  type StoredInstance,
  type StoredStudy,
  type StudiesResult,
  type UploadResult,
  type UploadSummary,
} from './types';

/* ================================================================== */
/* Conventions                                                         */
/* ================================================================== */

/**
 * Identifier system for the StudyInstanceUID carried on `ImagingStudy`.
 *
 * Both halves are always used together in searches (`system|value`): a bare
 * value matches ANY system, so a stray identifier written by some other tool
 * could otherwise collide with — and silently re-point — a patient's study.
 */
export const DICOM_UID_IDENTIFIER_SYSTEM = 'urn:dicom:uid';

/** DICOM UIDs are OIDs; FHIR spells an OID identifier value this way. */
const OID_PREFIX = 'urn:oid:';

/** DICOM controlled terminology, for `ImagingStudy.modality` codings. */
const DCM_SYSTEM = 'http://dicom.nema.org/resources/ontology/DCM';

/**
 * FHIR id grammar. This is a security guard, not a formality: the id ends up in
 * a search parameter value, and an unvalidated one is how a crafted string
 * walks out of the query it was meant to stay inside.
 */
const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * StudyInstanceUID grammar.
 *
 * The DICOM standard allows only digits and dots, but real files from small
 * vendors sometimes deviate, and being too strict here would silently make a
 * legitimate study unlinkable. What matters for safety is excluding the
 * characters that mean something inside a FHIR token search — `|` (system
 * separator), `,` (OR), `$`, backslash and whitespace — so those are what the
 * pattern leaves out.
 */
const STUDY_UID_PATTERN = /^[A-Za-z0-9._-]{1,72}$/;

/** Linked studies pulled per patient. A chart holds a handful; the cap is a guard. */
const PATIENT_STUDY_PAGE_SIZE = 50;

/** Resolution requests in flight at once, so a long list cannot stampede Medplum. */
const RESOLVE_CONCURRENCY = 6;

/** Budget for the conditional write. Longer than a read: it is a transaction. */
const LINK_TIMEOUT_MS = 12_000;

export function isValidPatientId(value: string): boolean {
  return FHIR_ID_PATTERN.test(value);
}

export function isValidStudyInstanceUid(value: string): boolean {
  return STUDY_UID_PATTERN.test(value);
}

/** StudyInstanceUID -> the identifier value stored on `ImagingStudy`. */
export function identifierValueForUid(studyInstanceUid: string): string {
  return `${OID_PREFIX}${studyInstanceUid}`;
}

/** The `system|value` token used for both the read and the conditional key. */
function identifierTokenForUid(studyInstanceUid: string): string {
  return `${DICOM_UID_IDENTIFIER_SYSTEM}|${identifierValueForUid(studyInstanceUid)}`;
}

/** Inverse of `identifierValueForUid`. Tolerates a value stored without the prefix. */
function uidFromIdentifierValue(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const uid = trimmed.startsWith(OID_PREFIX) ? trimmed.slice(OID_PREFIX.length) : trimmed;
  return uid !== '' && STUDY_UID_PATTERN.test(uid) ? uid : null;
}

/* ================================================================== */
/* Degradation                                                         */
/* ================================================================== */

/** An error that already knows how it should degrade on screen. */
class PatientImagingError extends Error {
  readonly reason: Exclude<DicomFallbackReason, null>;

  constructor(reason: Exclude<DicomFallbackReason, null>, message: string) {
    super(message);
    this.name = 'PatientImagingError';
    this.reason = reason;
  }
}

/** HTTP status -> degradation reason. 404 is "nothing there", not "broken". */
function reasonForStatus(status: number): Exclude<DicomFallbackReason, null> {
  if (status === 401 || status === 403) return 'auth-failed';
  if (status === 404) return 'empty';
  if (status >= 400 && status < 500) return 'bad-request';
  return 'network';
}

function classify(error: unknown): { reason: Exclude<DicomFallbackReason, null>; detail: string } {
  if (error instanceof PatientImagingError) {
    return { reason: error.reason, detail: error.message };
  }
  if (error instanceof OperationOutcomeError) {
    return { reason: reasonForStatus(getStatus(error.outcome)), detail: normalizeErrorString(error) };
  }
  // Covers the DICOM upstream errors and `AbortSignal.timeout` rejections.
  return classifyDicomError(error);
}

/**
 * The only text this module ever hands back to the browser for an upstream
 * failure.
 *
 * Medplum's own error bodies are never echoed verbatim: an `OperationOutcome`
 * can quote internal resource ids, search parameters or SQL-ish diagnostics, and
 * this dashboard has no authentication in front of it. The upstream text goes to
 * the server log instead, where it is still one grep away when something breaks.
 */
function publicDetail(reason: Exclude<DicomFallbackReason, null>): string {
  switch (reason) {
    case 'not-configured':
      return 'Medplum credentials are not configured on the server.';
    case 'auth-failed':
      return 'The server could not authenticate with Medplum.';
    case 'timeout':
      return 'Medplum did not respond in time.';
    case 'network':
      return 'Medplum is unreachable right now.';
    case 'empty':
      return 'Medplum has nothing stored for this request.';
    case 'bad-request':
      return 'Medplum rejected the request.';
    default:
      return 'Medplum could not answer.';
  }
}

/** Server-side breadcrumb. Never carries a token — `classify` only sees messages. */
function logUpstream(scope: string, reason: string, detail: string): void {
  console.warn(`[patient-imaging] ${scope} degraded (${reason}): ${detail}`);
}

/** Turns a thrown value into a degraded envelope with a sanitized detail. */
function degrade<T>(empty: T, error: unknown, scope: string): ApiResult<T> {
  const { reason, detail } = classify(error);
  logUpstream(scope, reason, detail);
  return apiDegraded(empty, reason, publicDetail(reason));
}

/**
 * Replaces the detail of an envelope produced elsewhere.
 *
 * `listInstances` is reused wholesale, and its degraded details quote Medplum's
 * `OperationOutcome` directly. That is fine for the project-wide route, which
 * predates this rule, but everything a patient chart returns goes through here
 * first so the same sanitization applies to borrowed results.
 */
function sanitize<T>(result: ApiResult<T>, scope: string): ApiResult<T> {
  if (result.source === 'medplum' || result.reason === null) return result;
  if (result.detail) logUpstream(scope, result.reason, result.detail);
  return { ...result, detail: publicDetail(result.reason) };
}

/* ================================================================== */
/* Authenticated client                                                */
/* ================================================================== */

/**
 * Authenticated Medplum client, with the two failure modes kept apart.
 *
 * "No credentials" is fixed in `.env`; "authentication refused" is fixed in
 * Medplum. Collapsing both into a generic network error would send whoever is
 * debugging the demo to the wrong place.
 */
async function client(): Promise<MedplumClient> {
  if (!medplumConfigured) {
    throw new PatientImagingError('not-configured', 'MEDPLUM_CLIENT_ID or MEDPLUM_CLIENT_SECRET is missing.');
  }
  try {
    return await medplumWriteClient();
  } catch (error) {
    throw new PatientImagingError('auth-failed', normalizeErrorString(error));
  }
}

/** Runs `task` over `items` with a bounded number of requests in flight. */
async function mapBounded<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    out.push(...(await Promise.all(items.slice(start, start + limit).map(task))));
  }
  return out;
}

/* ================================================================== */
/* Write — linking a study to a patient                                */
/* ================================================================== */

/**
 * What we know about a study at link time, all of it read out of the `.dcm`
 * headers before the upload left the server.
 *
 * Note what is NOT here: series and instance COUNTS. `ImagingStudy` has fields
 * for them, but an upsert replaces the whole resource, so a second upload that
 * adds ten slices to an existing study would overwrite the total with its own
 * contribution and the chart would understate the study forever. `DicomStudy`
 * already carries authoritative `numberOfStudyRelated*` counts maintained by the
 * server, and the read path below prefers those. A number that can silently
 * become wrong is worse than no number.
 */
export interface LinkedStudyMeta {
  /** ISO `YYYY-MM-DD` — a valid FHIR `dateTime`, and what `_sort=-started` orders on. */
  readonly started?: string | null;
  readonly description?: string | null;
  /** Distinct modalities seen in the uploaded files, uppercase. */
  readonly modalities?: readonly string[];
}

export type LinkOutcome =
  | { readonly ok: true; readonly studyInstanceUid: string; readonly imagingStudyId: string }
  | {
      readonly ok: false;
      readonly studyInstanceUid: string;
      readonly reason: Exclude<DicomFallbackReason, null>;
      /** Already sanitized; safe to render. */
      readonly detail: string;
    };

/**
 * Attaches one stored study to one patient, idempotently.
 *
 * The conditional key is `identifier` AND `subject` TOGETHER. Keying on the
 * identifier alone would mean a re-upload of patient A's study while viewing
 * patient B's chart silently re-points the existing row at B — the study would
 * vanish from A's chart with no trace. With the subject in the key, the worst
 * case is a second `ImagingStudy` row for a genuinely shared study, which is
 * both correct FHIR and harmless.
 *
 * Idempotency: STOW is idempotent server-side, so re-uploading the same files
 * must not produce a second link either. The conditional update handles that —
 * 0 matches creates, 1 match updates in place.
 *
 * Never throws. A failed link is not a failed upload, and the caller has to be
 * able to report "stored, but not linked" rather than an all-or-nothing verdict.
 */
export async function linkStudyToPatient(
  patientId: string,
  studyInstanceUid: string,
  meta: LinkedStudyMeta = {},
): Promise<LinkOutcome> {
  const uid = studyInstanceUid.trim();

  if (!isValidPatientId(patientId)) {
    return { ok: false, studyInstanceUid: uid, reason: 'bad-request', detail: 'That is not a valid patient id.' };
  }
  if (!isValidStudyInstanceUid(uid)) {
    return {
      ok: false,
      studyInstanceUid: uid,
      reason: 'bad-request',
      detail: 'That is not a usable study instance UID.',
    };
  }

  const resource: ImagingStudy = {
    resourceType: 'ImagingStudy',
    // Required by FHIR. The bytes are in Medplum by the time this runs, so
    // 'available' is the truth; 'registered' would mean "expected, not here yet".
    status: 'available',
    subject: { reference: `Patient/${patientId}` },
    identifier: [{ system: DICOM_UID_IDENTIFIER_SYSTEM, value: identifierValueForUid(uid) }],
  };

  if (meta.started) resource.started = meta.started;
  if (meta.description) resource.description = meta.description;

  const modalities = (meta.modalities ?? []).filter((code) => code !== '');
  if (modalities.length > 0) {
    resource.modality = modalities.map((code): Coding => ({ system: DCM_SYSTEM, code }));
  }

  // `series` is deliberately omitted. `ImagingStudySeries` requires both `uid`
  // and `modality`, and `ImagingStudyInstance` requires `uid` and `sopClass`;
  // half-populating them produces an invalid resource, and the read path goes
  // through `DicomStudy`/`DicomInstance` anyway and never looks at it.

  const query = new URLSearchParams();
  query.set('identifier', identifierTokenForUid(uid));
  query.set('subject', `Patient/${patientId}`);

  try {
    const medplum = await client();

    // `upsertResource` issues a FHIR conditional update, and an update REPLACES
    // the matched resource rather than merging into it. So a second upload into
    // an already-linked study whose files happen not to carry (0008,1030) would
    // erase the description the first upload recorded — and `DicomStudy` has no
    // description field at all, so this link row is the only server-side copy.
    // The card title would silently fall back from "TC de tórax" to "Study".
    // Read the current link first and carry forward whatever this batch lacks.
    // Costs one extra GET per study per upload; only re-uploads ever use it.
    const existing = await findExistingLink(medplum, uid, patientId);
    if (existing) {
      if (!resource.started && existing.started) resource.started = existing.started;
      if (!resource.description && existing.description) resource.description = existing.description;

      const merged = mergeModalities(resource.modality, existing.modality);
      if (merged) resource.modality = merged;
    }

    const saved = await medplum.upsertResource(resource, query, {
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    });
    return { ok: true, studyInstanceUid: uid, imagingStudyId: saved.id };
  } catch (error) {
    const { reason, detail } = classify(error);
    logUpstream('linkStudyToPatient', reason, detail);
    return { ok: false, studyInstanceUid: uid, reason, detail: publicDetail(reason) };
  }
}

/**
 * The link row already stored for this (study, patient) pair, or `null`.
 *
 * Only used to preserve fields a re-upload cannot supply. A failure here must
 * not fail the link, so it degrades to `null` and the upsert proceeds with
 * whatever this batch knows — the same outcome as before this read existed.
 */
async function findExistingLink(
  medplum: MedplumClient,
  uid: string,
  patientId: string,
): Promise<ImagingStudy | null> {
  try {
    const found = await medplum.searchResources(
      'ImagingStudy',
      { identifier: identifierTokenForUid(uid), subject: `Patient/${patientId}`, _count: 1 },
      { signal: AbortSignal.timeout(LINK_TIMEOUT_MS) },
    );
    return found[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Union of both modality lists, keyed on code.
 *
 * A PT/CT study uploaded one series at a time must not have its list narrowed to
 * whichever series went last.
 */
function mergeModalities(next: Coding[] | undefined, previous: Coding[] | undefined): Coding[] | undefined {
  const byCode = new Map<string, Coding>();
  for (const coding of [...(previous ?? []), ...(next ?? [])]) {
    const code = coding.code?.trim().toUpperCase();
    if (code) byCode.set(code, { system: DCM_SYSTEM, code });
  }
  return byCode.size > 0 ? [...byCode.values()] : undefined;
}

/* ================================================================== */
/* Read — the patient's studies                                        */
/* ================================================================== */

/* Minimal shapes for the Medplum DICOM extension resources. They are absent
 * from `@medplum/fhirtypes`, and the readers in `medplum-dicom.ts` are private
 * to that module, so the few fields this file needs are described here. Every
 * field is optional: the server omits any tag the header did not carry. */

interface FhirBundle<T> {
  entry?: { resource?: T }[];
}

type DicomResource = Record<string, unknown> & { id?: string };

interface DicomStudyResource extends DicomResource {
  studyInstanceUid?: string;
  studyDate?: string;
  patientName?: string;
  modalitiesInStudy?: unknown;
  numberOfStudyRelatedSeries?: number;
  numberOfStudyRelatedInstances?: number;
}

function bundleResources<T>(bundle: FhirBundle<T> | null | undefined): T[] {
  if (!bundle || !Array.isArray(bundle.entry)) return [];
  const out: T[] = [];
  for (const entry of bundle.entry) {
    if (entry?.resource) out.push(entry.resource);
  }
  return out;
}

/** Trimmed string field, or `null` for absent-or-blank. Never returns `''`. */
function pickString(resource: DicomResource | null | undefined, key: string): string | null {
  const value = resource?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Numeric field, accepting the string form too — DICOM `IS` is a string VR. */
function pickNumber(resource: DicomResource | null | undefined, key: string): number | null {
  const value = resource?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** `modalitiesInStudy` is a repeating element; normalize to distinct uppercase. */
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
 * Study dates arrive either as DICOM `DA` (`20240131`) or as an ISO date if
 * Medplum normalized the field. Both collapse to `YYYY-MM-DD`; anything else
 * becomes `null` rather than a guess — a wrong date is worse than a dash.
 */
function normalizeStudyDate(raw: string | null): string | null {
  if (!raw) return null;
  const iso = dicomDateToIso(raw);
  if (iso) return iso;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return match ? match[1] : null;
}

/** The StudyInstanceUID an `ImagingStudy` points at, or `null` if it carries none. */
function studyUidOf(imaging: ImagingStudy): string | null {
  for (const identifier of imaging.identifier ?? []) {
    if (identifier.system !== DICOM_UID_IDENTIFIER_SYSTEM) continue;
    const uid = uidFromIdentifierValue(identifier.value);
    if (uid) return uid;
  }
  return null;
}

/** Fetches the `DicomStudy` behind one UID. `null` when there is none stored. */
async function findDicomStudy(medplum: MedplumClient, uid: string): Promise<DicomStudyResource | null> {
  // `DicomStudy` is a Medplum extension, absent from the SDK's `ResourceType`
  // union, so the typed `searchResources` cannot express it. `fhirUrl` still
  // gives the correctly-built base URL, and the UID goes in as a search
  // parameter VALUE — never interpolated into a path segment.
  const url = medplum.fhirUrl('DicomStudy');
  url.searchParams.set('study-instance-uid', uid);
  url.searchParams.set('_count', '1');

  const bundle = await medplum.get<FhirBundle<DicomStudyResource>>(url, {
    signal: AbortSignal.timeout(DICOM_READ_TIMEOUT_MS),
  });

  return bundleResources(bundle)[0] ?? null;
}

/**
 * Merges the link (`ImagingStudy`) with the stored study (`DicomStudy`) into the
 * row shape the DICOM UI already speaks.
 *
 * Returns `null` when no `DicomStudy` matches. That happens when a link outlived
 * its bytes — someone deleted the study, or STOW reported a UID that never
 * materialized. Such a row has no instances and nothing to open, so listing it
 * would only offer a viewer that can never load.
 */
type ResolveOutcome =
  | { readonly kind: 'ok'; readonly study: StoredStudy }
  /** The link outlived its bytes. Nothing to open, so it is dropped — silently,
   *  because the list is still a complete answer about what is actually stored. */
  | { readonly kind: 'missing' }
  /** The lookup itself failed. The list is INCOMPLETE and must say so. */
  | { readonly kind: 'failed'; readonly reason: Exclude<DicomFallbackReason, null>; readonly detail: string };

async function resolveStoredStudy(
  medplum: MedplumClient,
  uid: string,
  imaging: ImagingStudy,
): Promise<ResolveOutcome> {
  let study: DicomStudyResource | null;
  try {
    study = await findDicomStudy(medplum, uid);
  } catch (error) {
    // A failed lookup is NOT the same as "no such study". Collapsing both into
    // `null` dropped the row from the list while the envelope still claimed a
    // complete live read — the chart would show three of a patient's five
    // studies under a badge saying the data came straight from Medplum.
    const { reason, detail } = classify(error);
    logUpstream('resolveStoredStudy', reason, detail);
    return { kind: 'failed', reason, detail: publicDetail(reason) };
  }

  const id = typeof study?.id === 'string' ? study.id : null;
  if (!study || !id) return { kind: 'missing' };

  const modalities = readModalities(study.modalitiesInStudy);
  if (modalities.length === 0) {
    // Only reachable when (0008,0061) was absent at upload time; the link row
    // kept whatever the file headers said.
    for (const coding of imaging.modality ?? []) {
      const code = coding.code?.trim().toUpperCase();
      if (code && !modalities.includes(code)) modalities.push(code);
    }
  }

  const resolved: StoredStudy = {
    id,
    studyInstanceUid: uid,
    studyDate: normalizeStudyDate(pickString(study, 'studyDate')) ?? normalizeStudyDate(imaging.started ?? null),
    // `DicomStudy` has no description field at all — the value written onto the
    // link at upload time is the only server-side copy of it.
    studyDescription: imaging.description?.trim() || null,
    patientName: humanizeDicomPersonName(pickString(study, 'patientName')),
    modalities,
    seriesCount: pickNumber(study, 'numberOfStudyRelatedSeries'),
    instanceCount: pickNumber(study, 'numberOfStudyRelatedInstances'),
  };

  return { kind: 'ok', study: resolved };
}

/** Newest first; studies without a date sink to the bottom rather than to 1970. */
function byStudyDateDesc(a: StoredStudy, b: StoredStudy): number {
  if (a.studyDate && b.studyDate && a.studyDate !== b.studyDate) return a.studyDate < b.studyDate ? 1 : -1;
  if (a.studyDate && !b.studyDate) return -1;
  if (!a.studyDate && b.studyDate) return 1;
  return a.studyInstanceUid.localeCompare(b.studyInstanceUid);
}

/**
 * The studies linked to ONE patient, newest first.
 *
 * Never throws, and never widens: the only studies it can return are the ones an
 * `ImagingStudy` names for this exact subject. A patient with nothing linked
 * comes back as `apiOk([])` — a healthy answer, not a degradation.
 */
export async function listPatientStudies(patientId: string): Promise<StudiesResult> {
  if (!isValidPatientId(patientId)) {
    return apiDegraded<readonly StoredStudy[]>([], 'bad-request', 'That is not a valid patient id.');
  }

  try {
    const medplum = await client();

    const linked = await medplum.searchResources(
      'ImagingStudy',
      {
        subject: `Patient/${patientId}`,
        _sort: '-started',
        _count: PATIENT_STUDY_PAGE_SIZE,
      },
      { signal: AbortSignal.timeout(DICOM_READ_TIMEOUT_MS) },
    );

    // One row per UID. Duplicates are possible in FHIR (two links, same study)
    // and would otherwise render as two identical cards pointing at one viewer.
    const byUid = new Map<string, ImagingStudy>();
    for (const imaging of linked) {
      const uid = studyUidOf(imaging);
      if (uid && !byUid.has(uid)) byUid.set(uid, imaging);
    }

    if (byUid.size === 0) return apiOk<readonly StoredStudy[]>([]);

    const resolved = await mapBounded([...byUid.entries()], RESOLVE_CONCURRENCY, ([uid, imaging]) =>
      resolveStoredStudy(medplum, uid, imaging),
    );

    const studies: StoredStudy[] = [];
    let failure: Extract<ResolveOutcome, { kind: 'failed' }> | null = null;
    for (const outcome of resolved) {
      if (outcome.kind === 'ok') studies.push(outcome.study);
      else if (outcome.kind === 'failed' && !failure) failure = outcome;
    }

    studies.sort(byStudyDateDesc);

    // Any resolution that FAILED means this list is missing rows that do exist.
    // Returning `apiOk` here would put a "live from Medplum" badge over a
    // partial chart — the one outcome the source badge exists to prevent.
    if (failure) {
      return apiDegraded<readonly StoredStudy[]>(studies, failure.reason, failure.detail);
    }

    return apiOk<readonly StoredStudy[]>(studies);
  } catch (error) {
    return degrade<readonly StoredStudy[]>([], error, 'listPatientStudies');
  }
}

/* ================================================================== */
/* Read — instances of one of the patient's studies                    */
/* ================================================================== */

/**
 * Does an `ImagingStudy` exist with BOTH this subject and this identifier?
 *
 * This is the authorization step of the whole feature. `listInstances` happily
 * resolves any UID in the project, so without this the per-patient route would
 * be a UID oracle. The query uses the `system|value` token form so an identifier
 * written by some other tool under a different system cannot satisfy it.
 */
async function patientOwnsStudy(medplum: MedplumClient, patientId: string, uid: string): Promise<boolean> {
  const matches = await medplum.searchResources(
    'ImagingStudy',
    {
      subject: `Patient/${patientId}`,
      identifier: identifierTokenForUid(uid),
      _count: 1,
    },
    { signal: AbortSignal.timeout(DICOM_READ_TIMEOUT_MS) },
  );
  return matches.length > 0;
}

/**
 * The instances of one study, but only if that study is linked to that patient.
 *
 * The ownership check runs FIRST and the UID never reaches `listInstances`
 * without it. A study that exists but belongs to someone else and a study that
 * does not exist return the same thing — an empty list — so the answer cannot be
 * used to probe what the project contains.
 */
export async function listPatientStudyInstances(
  patientId: string,
  studyInstanceUid: string,
): Promise<InstancesResult> {
  const uid = studyInstanceUid.trim();

  if (!isValidPatientId(patientId)) {
    return apiDegraded<readonly StoredInstance[]>([], 'bad-request', 'That is not a valid patient id.');
  }
  if (!isValidStudyInstanceUid(uid)) {
    return apiDegraded<readonly StoredInstance[]>([], 'bad-request', 'That is not a valid study instance UID.');
  }

  let owned: boolean;
  try {
    owned = await patientOwnsStudy(await client(), patientId, uid);
  } catch (error) {
    return degrade<readonly StoredInstance[]>([], error, 'listPatientStudyInstances');
  }

  if (!owned) {
    return apiDegraded<readonly StoredInstance[]>([], 'empty', 'No imaging is linked to this patient for that study.');
  }

  return sanitize(await listInstances(uid), 'listPatientStudyInstances');
}

/* ================================================================== */
/* Header parsing — where the StudyInstanceUID comes from              */
/* ================================================================== */

/**
 * Tags read out of one `.dcm` before it is uploaded.
 *
 * Parsing locally is the PRIMARY source of the StudyInstanceUID, not a backup.
 * The STOW response is the obvious alternative, but `parseStowResponse` reports
 * a file as `ok: true` WITH NO `studyInstanceUid` whenever Medplum answers 2xx
 * with a body shape it does not recognize — the bytes really are stored, so
 * claiming failure would be a lie. If the response were the only source, that
 * case would leave a study uploaded and permanently unlinked, and re-uploading
 * would not fix it: STOW is idempotent, so the retry returns the same
 * unhelpful body. Reading the header removes that failure mode entirely, and it
 * also lets the files be grouped by study before the request is even sent.
 */
interface ParsedFileTags {
  readonly studyInstanceUid: string | null;
  readonly modality: string | null;
  readonly studyDate: string | null;
  readonly studyDescription: string | null;
}

const NO_TAGS: ParsedFileTags = {
  studyInstanceUid: null,
  modality: null,
  studyDate: null,
  studyDescription: null,
};

function readTags(dataSet: DataSet): ParsedFileTags {
  const uid = dataSet.string(DICOM_TAG.studyInstanceUid)?.trim() ?? '';
  const modality = dataSet.string(DICOM_TAG.modality)?.trim().toUpperCase() ?? '';
  const description = dataSet.string(DICOM_TAG.studyDescription)?.trim() ?? '';

  return {
    studyInstanceUid: uid !== '' && STUDY_UID_PATTERN.test(uid) ? uid : null,
    modality: modality !== '' ? modality : null,
    studyDate: dicomDateToIso(dataSet.string(DICOM_TAG.studyDate) ?? null),
    studyDescription: description !== '' ? description : null,
  };
}

/**
 * Reads the study-level tags out of one file's bytes.
 *
 * Never throws: a file the parser rejects must still be uploadable. What
 * degrades is the LINKAGE, never the upload — and the caller reports that
 * degradation instead of hiding it.
 *
 * `untilTag` stops the walk at (0020,0013), which is past every tag read here
 * and before the pixel data, so a 400-file drop does not pay to index bytes
 * nobody looks at. Some non-conformant files trip that early stop, hence the
 * full-parse retry.
 */
function readStudyTags(bytes: Uint8Array): ParsedFileTags {
  try {
    return readTags(parseDicom(bytes, { untilTag: DICOM_TAG.instanceNumber }));
  } catch {
    // Fall through to a complete parse before giving up.
  }
  try {
    return readTags(parseDicom(bytes));
  } catch {
    return NO_TAGS;
  }
}

/* ================================================================== */
/* Upload for one patient                                              */
/* ================================================================== */

/**
 * What `POST /api/dicom/patients/{patientId}/studies` returns inside its
 * `ApiResult` envelope.
 *
 * It EXTENDS `UploadSummary` rather than replacing it, so a client typed against
 * the existing `UploadApiResult` still reads correctly — it just does not see
 * the linkage fields.
 *
 * Those extra fields exist because "stored" and "visible in this chart" are two
 * different outcomes here. A study that reaches Medplum but never gets linked is
 * invisible in the patient's chart forever, and reporting that as a clean
 * success would be the single most misleading thing this feature could do.
 */
export interface PatientUploadFileResult extends UploadResult {
  /**
   * Did THIS file's study end up linked to the patient?
   *
   * `undefined` on a file that never reached Medplum — there is no linkage
   * question to answer for it. `false` means the bytes are stored but the file
   * is invisible in this chart, which is the one outcome a per-file list has to
   * be able to say on its own row rather than only in the banner above it.
   */
  readonly linked?: boolean;
}

export interface PatientUploadSummary extends UploadSummary {
  /** Per-file verdicts, each also carrying whether its study got linked. */
  results: readonly PatientUploadFileResult[];
  /** Studies now attached to this patient. */
  readonly linkedStudyInstanceUids: readonly string[];
  /** Studies stored by Medplum whose link to this patient failed. */
  readonly unlinkedStudyInstanceUids: readonly string[];
  /** Uploaded files that are NOT visible in this patient's chart. `0` on a clean run. */
  readonly unlinkedFileCount: number;
  /** One English sentence when something did not link, `null` otherwise. Safe to render. */
  readonly linkError: string | null;
}

export const EMPTY_PATIENT_UPLOAD_SUMMARY: PatientUploadSummary = {
  ...EMPTY_UPLOAD_SUMMARY,
  linkedStudyInstanceUids: [],
  unlinkedStudyInstanceUids: [],
  unlinkedFileCount: 0,
  linkError: null,
};

/** Everything the link needs about one study, accumulated across its files. */
interface StudyAccumulator {
  started: string | null;
  description: string | null;
  modalities: string[];
  fileCount: number;
}

/** English agrees the noun, so the count and the word are formed in one place. */
function countOfFiles(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

function countOfStudies(count: number): string {
  return `${count} stud${count === 1 ? 'y' : 'ies'}`;
}

/**
 * Uploads files for one patient and links the resulting studies to them.
 *
 * Throws only when the upload could never start — missing credentials or a
 * refused authentication, i.e. exactly the conditions under which
 * `uploadInstances` throws. Everything after that comes back inside the summary,
 * per file and per study.
 *
 * Order matters: headers are parsed BEFORE the upload, so the study grouping is
 * known independently of whatever STOW answers.
 */
export async function uploadForPatient(
  patientId: string,
  files: readonly DicomUploadFile[],
): Promise<PatientUploadSummary> {
  if (!isValidPatientId(patientId)) {
    throw new PatientImagingError('bad-request', 'That is not a valid patient id.');
  }
  if (files.length === 0) {
    return EMPTY_PATIENT_UPLOAD_SUMMARY;
  }

  const parsed = files.map((file) => readStudyTags(file.bytes));

  // Throws only if it could never start; the route degrades that into an envelope.
  const results: UploadResult[] = await uploadInstances(files);

  // `uploadInstances` preserves input order (batches are sequential, and
  // `parseStowResponse` maps one result per part), so index `i` is file `i`.
  // The guard is here because a silent misalignment would attach one study's
  // metadata to another's link.
  const aligned = results.length === files.length;

  const accumulators = new Map<string, StudyAccumulator>();
  // Which study each stored file belongs to, so the per-file verdicts below can
  // be told apart once the links are known. `null` = stored, but no identity.
  const uidByIndex = new Array<string | null>(results.length).fill(null);
  let unlinkableFiles = 0;

  results.forEach((result, index) => {
    if (!result.ok) return;

    // Header first, STOW response second — see `ParsedFileTags` for why.
    const fromHeader = aligned ? parsed[index]?.studyInstanceUid ?? null : null;
    const fromResponse =
      result.studyInstanceUid && isValidStudyInstanceUid(result.studyInstanceUid.trim())
        ? result.studyInstanceUid.trim()
        : null;
    const uid = fromHeader ?? fromResponse;

    if (!uid) {
      // Stored, but there is no identity to hang a link on. Counted, never hidden.
      unlinkableFiles += 1;
      return;
    }

    uidByIndex[index] = uid;

    const tags = aligned ? parsed[index] ?? NO_TAGS : NO_TAGS;
    const accumulator = accumulators.get(uid) ?? {
      started: null,
      description: null,
      modalities: [],
      fileCount: 0,
    };

    accumulator.fileCount += 1;
    accumulator.started ??= tags.studyDate;
    accumulator.description ??= tags.studyDescription;
    if (tags.modality && !accumulator.modalities.includes(tags.modality)) {
      accumulator.modalities.push(tags.modality);
    }

    accumulators.set(uid, accumulator);
  });

  const linked: string[] = [];
  const unlinked: string[] = [];
  let unlinkedFileCount = unlinkableFiles;
  let failureDetail: string | null = null;

  // Sequential: a drop touches one or two studies, and a conditional upsert is a
  // transaction — there is nothing to gain from racing them.
  for (const [uid, accumulator] of accumulators) {
    const outcome = await linkStudyToPatient(patientId, uid, {
      started: accumulator.started,
      description: accumulator.description,
      modalities: accumulator.modalities,
    });

    if (outcome.ok) {
      linked.push(uid);
    } else {
      unlinked.push(uid);
      unlinkedFileCount += accumulator.fileCount;
      failureDetail ??= outcome.detail;
    }
  }

  const sentences: string[] = [];
  if (unlinked.length > 0) {
    sentences.push(
      `${countOfStudies(unlinked.length)} uploaded, but could not be linked to this patient. ${failureDetail ?? ''}`.trim(),
    );
  }
  if (unlinkableFiles > 0) {
    sentences.push(
      `${countOfFiles(unlinkableFiles)} uploaded without a readable study UID, so ${
        unlinkableFiles === 1 ? 'it is' : 'they are'
      } not linked to this patient.`,
    );
  }

  // Annotate each stored file with the fate of its study. A file that never
  // reached Medplum is left alone: `linked: false` on it would read as "stored
  // but invisible", which is the opposite of what happened to it.
  const linkedUids = new Set(linked);
  const annotated: PatientUploadFileResult[] = results.map((result, index) => {
    if (!result.ok) return result;
    const uid = uidByIndex[index];
    return { ...result, linked: uid !== null && linkedUids.has(uid) };
  });

  return {
    ...summarizeUpload(results),
    results: annotated,
    linkedStudyInstanceUids: linked,
    unlinkedStudyInstanceUids: unlinked,
    unlinkedFileCount,
    linkError: sentences.length > 0 ? sentences.join(' ') : null,
  };
}
