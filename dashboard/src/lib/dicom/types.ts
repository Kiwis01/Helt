/**
 * DICOM section — shared contract.
 *
 * ENGLISH ON PURPOSE. The rest of the dashboard is written in Spanish; this
 * module and everything under `lib/dicom/` + `components/dicom/` is English by
 * explicit request. Do not translate, and do not let the Spanish convention
 * leak back in here.
 *
 * This file is the seam between three independent pieces:
 *
 *   - the server routes under `app/api/dicom/*` (they own Medplum and the token),
 *   - the cornerstone viewer (browser only, never touches Medplum),
 *   - the UI shell (dropzone, study list, section layout).
 *
 * Hard rule that shapes everything below: **this module has zero imports.** It
 * is pulled in by both server and client code, so a single `import 'server-only'`
 * or a cornerstone import anywhere in its dependency graph would either poison
 * the client bundle or break the server build. Types, constants and pure
 * functions only — nothing that reads `process`, `window`, or the network.
 */

/* ================================================================== */
/* Degradable envelope                                                 */
/* ================================================================== */

/**
 * Where the data on screen came from.
 *
 * Mirrors `ChartSource` in `lib/medplum/server.ts`, with one deliberate
 * difference: there is no `'fixture'`. There are no synthetic DICOM studies to
 * fall back to — a study either exists in Medplum or it does not. So the
 * degraded state is `'none'`, meaning "we have nothing to show and here is why",
 * and the UI renders an intentional empty state instead of a fake study.
 */
export type DicomApiSource = 'medplum' | 'none';

/** Why a read degraded. `null` means it did not. */
export type DicomFallbackReason =
  | 'not-configured'
  | 'auth-failed'
  | 'timeout'
  | 'network'
  | 'empty'
  | 'bad-request'
  | null;

/**
 * The envelope every JSON route under `/api/dicom/` returns.
 *
 * Same contract as `ChartResult<T>`: the caller never needs a try/catch, and the
 * badge in the corner always has something honest to say. Routes must return
 * HTTP 200 with `source: 'none'` for an upstream failure rather than a 500 —
 * a 500 makes the client invent its own error copy, and then two places disagree
 * about what went wrong.
 */
export interface ApiResult<T> {
  data: T;
  source: DicomApiSource;
  reason: DicomFallbackReason;
  /** Short technical detail, for the badge tooltip and the console. Never shown alone. */
  detail: string | null;
}

/** Concrete envelopes, so route handlers and callers cannot drift apart. */
export type StudiesResult = ApiResult<readonly StoredStudy[]>;
export type InstancesResult = ApiResult<readonly StoredInstance[]>;
export type UploadApiResult = ApiResult<UploadSummary>;

/** Successful read. */
export function apiOk<T>(data: T): ApiResult<T> {
  return { data, source: 'medplum', reason: null, detail: null };
}

/**
 * Degraded read. `empty` is passed explicitly (an empty array, an empty summary)
 * so there is no code path in the failure branch that can itself fail.
 */
export function apiDegraded<T>(
  empty: T,
  reason: Exclude<DicomFallbackReason, null>,
  detail?: string | null,
): ApiResult<T> {
  return { data: empty, source: 'none', reason, detail: detail ?? null };
}

export function isApiOk<T>(result: ApiResult<T>): boolean {
  return result.source === 'medplum';
}

/** English copy for the source badge. Keep it short — it sits in a pill. */
export function describeDicomReason(reason: DicomFallbackReason): string {
  switch (reason) {
    case 'not-configured':
      return 'Medplum credentials missing';
    case 'auth-failed':
      return 'could not authenticate with Medplum';
    case 'timeout':
      return 'Medplum did not respond in time';
    case 'network':
      return 'Medplum is unreachable';
    case 'empty':
      return 'nothing stored yet';
    case 'bad-request':
      return 'the request was rejected';
    default:
      return 'live from Medplum';
  }
}

/* ================================================================== */
/* Stored studies (the FHIR read path)                                 */
/* ================================================================== */

/**
 * One row of `GET /api/dicom/studies`.
 *
 * Built from the Medplum `DicomStudy` resource plus counts. Every field that can
 * genuinely be absent in a DICOM header is `null` rather than `''` or `0`:
 * "no study description" and "the description is empty" are different facts, and
 * a `0` where the count is unknown would be a lie on a projected screen.
 */
export interface StoredStudy {
  /** Medplum resource id of the `DicomStudy`. Used to query series/instances. */
  id: string;
  /** (0020,000D). The stable identity of the study across re-uploads. */
  studyInstanceUid: string;
  /** ISO `YYYY-MM-DD`, converted from the DICOM `DA` format. `null` if absent or unparseable. */
  studyDate: string | null;
  /** (0008,1030). */
  studyDescription: string | null;
  /** (0010,0010), already humanized from `FAMILY^GIVEN` form. */
  patientName: string | null;
  /** Distinct modalities across the study's series, uppercase, e.g. `['CT']`. May be empty. */
  modalities: readonly string[];
  /** `-1` is not allowed; use `null` when the count could not be determined. */
  seriesCount: number | null;
  instanceCount: number | null;
}

/**
 * One row of `GET /api/dicom/studies/{studyUid}/instances`.
 *
 * The instance list is what the viewer actually renders. The client pulls each
 * instance's original `.dcm` bytes through `DICOM_API.instanceBytes(id)` and
 * feeds them to the same cornerstone file path used for locally picked files.
 * One rendering code path, two sources.
 */
export interface StoredInstance {
  /** Medplum resource id of the `DicomInstance`. */
  id: string;
  /** (0008,0018). */
  sopInstanceUid: string;
  /** (0020,0013). `null` when the header omits it — do not default to 0, sorting depends on it. */
  instanceNumber: number | null;
  /**
   * Medplum `Binary` id extracted from `DicomInstance.raw`.
   *
   * Read as a retrievability flag, NOT as an address: the bytes are fetched by
   * `id` (the `DicomInstance`), and the server resolves `raw` on its side.
   * `null` means the instance exists but its bytes are not retrievable, which is
   * a real state the UI must show rather than silently skip.
   */
  binaryId: string | null;
  /** (0028,0010) / (0028,0011). `null` when not reported. */
  rows: number | null;
  columns: number | null;
  /** (0028,0008). Always at least 1 — a single-frame instance is one frame, not zero. */
  numberOfFrames: number;
  /** (0020,000E). `null` only if the resource has no series reference at all. */
  seriesInstanceUid: string | null;
}

/** An instance whose bytes can actually be fetched and decoded. */
export type RenderableInstance = StoredInstance & { binaryId: string };

export function isRenderableInstance(instance: StoredInstance): instance is RenderableInstance {
  return typeof instance.binaryId === 'string' && instance.binaryId.length > 0;
}

/* ================================================================== */
/* Upload (STOW-RS)                                                    */
/* ================================================================== */

/**
 * Per-file outcome of a STOW upload.
 *
 * Per FILE, not per request: a multi-file drop is one HTTP call but the user
 * thinks in files, and "3 of 12 failed" is only sayable if each file carries its
 * own verdict. `error` is short and human — the stack trace stays in the server log.
 */
export interface UploadResult {
  filename: string;
  ok: boolean;
  /** Present on success, read back from the server's `ReferencedSOPSequence`. */
  sopInstanceUid?: string;
  /** Present on success when the response let us resolve it. Lets the UI jump to the new study. */
  studyInstanceUid?: string;
  /** Present on failure. One sentence, English, safe to render. */
  error?: string;
}

/** What `POST /api/dicom/upload` wraps in an `ApiResult`. */
export interface UploadSummary {
  results: readonly UploadResult[];
  okCount: number;
  failedCount: number;
  /** Distinct studies touched by this upload, in first-seen order. */
  studyInstanceUids: readonly string[];
}

/** The zero value, for the degraded branch of the upload route. */
export const EMPTY_UPLOAD_SUMMARY: UploadSummary = {
  results: [],
  okCount: 0,
  failedCount: 0,
  studyInstanceUids: [],
};

/** Derives the counts so the route and the UI can never disagree about them. */
export function summarizeUpload(results: readonly UploadResult[]): UploadSummary {
  const studyInstanceUids: string[] = [];
  let okCount = 0;
  let failedCount = 0;

  for (const result of results) {
    if (result.ok) okCount += 1;
    else failedCount += 1;

    const uid = result.studyInstanceUid;
    if (uid && !studyInstanceUids.includes(uid)) studyInstanceUids.push(uid);
  }

  return { results, okCount, failedCount, studyInstanceUids };
}

/* ================================================================== */
/* Viewer source                                                       */
/* ================================================================== */

/**
 * What the viewer is being asked to display.
 *
 * The discriminated union exists so the viewer has exactly one entry point.
 * `local` is a just-dropped file list that has not been uploaded (or has been,
 * but we already hold the bytes); `stored` is a study that lives in Medplum and
 * whose bytes arrive over `/api/dicom/binary/{id}`. Both converge on the same
 * cornerstone `wadouri` file path — the difference stops at this boundary.
 *
 * `File` is a type-only reference here (lib.dom), so this stays import-free and
 * safe to pull into a server module.
 */
export type DicomSource =
  | {
      readonly kind: 'local';
      readonly files: readonly File[];
    }
  | {
      readonly kind: 'stored';
      readonly study: StoredStudy;
      readonly instances: readonly StoredInstance[];
    };

/** Short English label for the viewer header. Never returns an empty string. */
export function describeDicomSource(source: DicomSource | null): string {
  if (!source) return 'No study selected';
  if (source.kind === 'local') {
    const n = source.files.length;
    return n === 1 ? '1 local file' : `${n} local files`;
  }
  return source.study.studyDescription ?? source.study.studyInstanceUid;
}

/** How many decodable items the source offers. Drives the empty/loading states. */
export function countDicomSourceItems(source: DicomSource | null): number {
  if (!source) return 0;
  if (source.kind === 'local') return source.files.length;
  return source.instances.filter(isRenderableInstance).length;
}

/* ================================================================== */
/* Viewer geometry and state                                           */
/* ================================================================== */

/** A unit vector in patient coordinates. */
export type Vec3 = readonly [number, number, number];

/** Plane a series lies in, derived from the slice normal. */
export type DicomOrientation = 'axial' | 'coronal' | 'sagittal' | 'unknown';

/** The three panes the viewer can show. `unknown` is never a pane. */
export type ViewerPlane = 'axial' | 'coronal' | 'sagittal';

export const VIEWER_PLANES: readonly ViewerPlane[] = ['axial', 'coronal', 'sagittal'];

/** Window center / width, i.e. brightness and contrast. `null` = use the image default. */
export interface WindowLevel {
  center: number | null;
  width: number | null;
}

/**
 * One parsed slice, ready to be grouped and sorted.
 *
 * This is the donor viewer's internal `DicomMeta` with the `File` handle dropped:
 * by the time this exists, the bytes are already registered with cornerstone's
 * file manager and `imageId` is the only handle anyone needs. `parse.ts` produces
 * these; nothing else should construct one.
 */
export interface DicomSliceMeta {
  /** Cornerstone image id, e.g. `dicomfile:3`. Frames are appended later. */
  imageId: string;
  /** (0020,000E). `null` collapses into a single synthetic group. */
  seriesInstanceUid: string | null;
  /** (0020,0013). */
  instanceNumber: number | null;
  /** (0020,0037), six numbers: row cosines then column cosines. */
  imageOrientationPatient: readonly number[] | null;
  /** (0020,0032), three numbers. Used to sort slices along the normal. */
  imagePositionPatient: readonly number[] | null;
  /** Cross product of the two direction cosines, normalized. `null` when IOP is absent. */
  normal: Vec3 | null;
  /** (0008,0060), uppercase. */
  modality: string | null;
  /** (0028,0008). At least 1. */
  numberOfFrames: number;
}

/** A series after grouping, orientation scoring and sorting. */
export interface DicomSeriesGroup {
  seriesInstanceUid: string;
  orientation: DicomOrientation;
  /** Sorted along the normal, falling back to instance number. */
  slices: readonly DicomSliceMeta[];
  /** Expanded image ids, one per frame. This is what the viewer indexes into. */
  imageIds: readonly string[];
  /**
   * Whether this plane should be displayed vertically flipped.
   * Coronal and sagittal series usually need it; axial never does.
   */
  verticalFlip: boolean;
}

/** What the viewer resolved a source into. Drives single-pane vs tri-plane. */
export interface DicomLayout {
  /** True when at least two planes have enough slices and the modality is volumetric. */
  triPlane: boolean;
  /** Present in tri-plane mode. A missing plane means that orientation was not found. */
  planes: Partial<Record<ViewerPlane, DicomSeriesGroup>>;
  /** Present in single-pane mode: every image id, in order. */
  imageIds: readonly string[];
}

/** Slice counts the surrounding UI needs (sliders, "12 / 240" readouts). */
export interface SliceInfo {
  triPlane: boolean;
  singleTotal?: number;
  axialTotal?: number;
  coronalTotal?: number;
  sagittalTotal?: number;
}

/* ------------------------------------------------------------------ */
/* Tri-plane policy                                                    */
/* ------------------------------------------------------------------ */

/**
 * Tri-plane is only offered for genuine 3D acquisitions. A two-image X-ray study
 * that happens to have two orientations must NOT open in a three-pane volumetric
 * layout — it looks broken and it misrepresents the data. The three thresholds
 * below are the donor's, kept verbatim because they were tuned against real studies.
 */
export const MIN_SLICES_PER_PLANE_FOR_3D = 5;
export const MIN_TOTAL_SLICES_FOR_3D = 10;
export const MIN_PLANES_FOR_3D = 2;

/** Modalities that can produce a volume. Anything else stays single-pane. */
export const VOLUMETRIC_MODALITIES: readonly string[] = ['CT', 'MR', 'PT', 'NM', 'CBCT'];

export function isVolumetricModality(modality: string | null | undefined): boolean {
  if (!modality) return false;
  return VOLUMETRIC_MODALITIES.includes(modality.trim().toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Scroll behaviour                                                    */
/* ------------------------------------------------------------------ */

/** Accumulated wheel pixels required to advance one slice. */
export const WHEEL_PIXELS_PER_SLICE = 100;

/**
 * Normalizes a wheel event delta to pixels.
 *
 * Browsers report `deltaMode` as pixels (0), lines (1) or pages (2), and a
 * trackpad in line mode moves ~30x faster per unit than in pixel mode. Without
 * this, the same gesture skips 30 slices in Firefox and 1 in Chrome.
 *
 * `pageHeight` is injected instead of read from `window` so this stays pure and
 * testable; pass `window.innerHeight` at the call site.
 */
export function normalizeWheelDeltaPx(deltaY: number, deltaMode: number, pageHeight: number): number {
  const scale = deltaMode === 1 ? 30 : deltaMode === 2 ? pageHeight : 1;
  return deltaY * scale;
}

/**
 * Turns accumulated wheel pixels into whole slice steps, returning the steps and
 * the remainder to carry over. Keeping the remainder is what makes a slow
 * trackpad drag feel continuous instead of dead until it suddenly jumps.
 */
export function wheelSteps(accumulatedPx: number): { steps: number; remainderPx: number } {
  const steps = Math.trunc(accumulatedPx / WHEEL_PIXELS_PER_SLICE);
  return { steps, remainderPx: accumulatedPx - steps * WHEEL_PIXELS_PER_SLICE };
}

/** Clamps an index into `[0, length - 1]`. Returns 0 for an empty collection. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}

/** Opening slice: the middle of the stack, which is where the anatomy usually is. */
export function initialIndex(length: number): number {
  return length > 1 ? Math.floor(length / 2) : 0;
}

/* ================================================================== */
/* DICOM tags                                                          */
/* ================================================================== */

/**
 * Tag keys in `dicom-parser` form: lowercase `x` + group + element.
 *
 * Centralized because the same tag is read in two places — the browser parses
 * dropped files, the server parses what Medplum stored — and a typo'd tag is
 * invisible: it just returns `undefined` and the study silently loses its
 * orientation. One spelling, one place.
 */
export const DICOM_TAG = {
  studyInstanceUid: 'x0020000d',
  seriesInstanceUid: 'x0020000e',
  sopInstanceUid: 'x00080018',
  sopClassUid: 'x00080016',
  instanceNumber: 'x00200013',
  seriesNumber: 'x00200011',
  imageOrientationPatient: 'x00200037',
  imagePositionPatient: 'x00200032',
  modality: 'x00080060',
  numberOfFrames: 'x00280008',
  rows: 'x00280010',
  columns: 'x00280011',
  bitsAllocated: 'x00280100',
  windowCenter: 'x00281050',
  windowWidth: 'x00281051',
  studyDate: 'x00080020',
  studyDescription: 'x00081030',
  seriesDescription: 'x0008103e',
  patientName: 'x00100010',
  patientId: 'x00100020',
} as const;

export type DicomTagKey = keyof typeof DICOM_TAG;

/**
 * Converts a `dicom-parser` tag to the DICOM JSON key used by
 * `DicomInstance.metadata` (uppercase, no `x`), e.g. `x0020000e` -> `0020000E`.
 * The two representations exist because two different libraries parsed the file.
 */
export function toDicomJsonTag(tag: string): string {
  return tag.replace(/^x/i, '').toUpperCase();
}

/** Separator for DICOM multi-valued strings (VR `DS`, `IS`, `UI`). */
export const DICOM_VALUE_SEPARATOR = '\\';

/**
 * Parses a DICOM decimal-string into numbers, dropping anything unparseable.
 * `'1\\0\\0\\0\\1\\0'` -> `[1, 0, 0, 0, 1, 0]`. Returns `[]` for absent input,
 * never `null`, so callers can check `.length === 6` and move on.
 */
export function parseDicomNumbers(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(DICOM_VALUE_SEPARATOR)
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

/**
 * DICOM `DA` (`YYYYMMDD`) to ISO `YYYY-MM-DD`.
 * Returns `null` rather than a guess when the value is not 8 digits — a wrong
 * date on a study list is worse than a dash.
 */
export function dicomDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.trim();
  if (!/^\d{8}$/.test(digits)) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * DICOM `PN` (`FAMILY^GIVEN^MIDDLE^PREFIX^SUFFIX`) to something readable.
 * Empty components are dropped and the order is left as-is: reordering to
 * "Given Family" guesses at a cultural convention the header does not state.
 */
export function humanizeDicomPersonName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw
    .split('^')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join(' ');
}

/* ================================================================== */
/* Frames                                                              */
/* ================================================================== */

/**
 * Builds the cornerstone image id for one frame of a multi-frame instance.
 *
 * `cornerstone-wado-image-loader` addresses frames with a `?frame=N` suffix on
 * the base image id, zero-based. A single-frame instance keeps the bare id —
 * appending `?frame=0` also works but makes ids inconsistent between the two
 * cases, which then leaks into every cache key and log line.
 */
export function frameImageId(baseImageId: string, frameIndex: number): string {
  return frameIndex <= 0 ? baseImageId : `${baseImageId}?frame=${frameIndex}`;
}

/** Expands one instance into one image id per frame, in order. */
export function expandFrames(baseImageId: string, numberOfFrames: number): string[] {
  const count = Number.isFinite(numberOfFrames) && numberOfFrames > 0 ? Math.trunc(numberOfFrames) : 1;
  if (count === 1) return [baseImageId];
  return Array.from({ length: count }, (_, index) => `${baseImageId}?frame=${index}`);
}

/* ================================================================== */
/* Files                                                               */
/* ================================================================== */

/** The only content type Medplum's STOW-RS endpoint accepts for an instance part. */
export const DICOM_CONTENT_TYPE = 'application/dicom';

/**
 * A DICOM file often has no extension at all (`IM_0001`, `I10`), so this is a
 * hint for filtering a dropped folder, never a gate. The real check is whether
 * the parser accepts the bytes.
 */
export const DICOM_FILE_EXTENSIONS: readonly string[] = ['.dcm', '.dic', '.dicom', '.ima'];

export function hasDicomExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return DICOM_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Files that are definitely not DICOM and would only produce parse noise. */
const NON_DICOM_HINTS: readonly string[] = ['.ds_store', '.txt', '.pdf', '.zip', '.jpg', '.jpeg', '.png', '.json'];

export function isLikelyDicomFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.startsWith('.')) return false;
  if (NON_DICOM_HINTS.some((ext) => lower.endsWith(ext))) return false;
  return true;
}

/**
 * Upload ceiling. A CT series is easily 300 files; the cap exists so a stray
 * folder drop cannot build a 2 GB multipart body in memory on the server.
 */
export const MAX_UPLOAD_FILES = 400;
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/* ================================================================== */
/* Route paths                                                         */
/* ================================================================== */

/**
 * The client never builds these by hand. Agent A owns the handlers, agent C owns
 * the callers, and a mistyped path between them fails at runtime with an
 * unhelpful 404 — so the strings live once, here.
 */
export const DICOM_API = {
  upload: '/api/dicom/upload',
  studies: '/api/dicom/studies',
  instances: (studyInstanceUid: string): string =>
    `/api/dicom/studies/${encodeURIComponent(studyInstanceUid)}/instances`,
  /**
   * Raw `application/dicom` bytes of one stored instance, NOT an `ApiResult`.
   *
   * Addressed by `DicomInstance.id`, never by `StoredInstance.binaryId`: the
   * server resolves `raw` itself so that this route cannot be used to pull an
   * arbitrary `Binary` out of the Medplum project.
   */
  instanceBytes: (instanceId: string): string => `/api/dicom/binary/${encodeURIComponent(instanceId)}`,
} as const;

/** Form field name the upload route reads from the incoming `FormData`. */
export const UPLOAD_FORM_FIELD = 'files';
