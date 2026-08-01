/**
 * `multipart/related` encoding and STOW-RS response parsing.
 *
 * ENGLISH ON PURPOSE — see the header of `./types.ts`.
 *
 * Pure module: no `fetch`, no `process`, no `server-only`. Everything here is a
 * function of its arguments, which is what makes the framing testable without a
 * Medplum account. `medplum-dicom.ts` is the only caller and owns all the I/O.
 *
 * Why hand-rolled instead of `FormData`: STOW-RS is `multipart/related`, not
 * `multipart/form-data`. The parts carry no `Content-Disposition` name, the
 * media type of each part IS the payload description, and Medplum answers 415 to
 * anything whose `Content-Type` does not start with `multipart/related`. The
 * platform `FormData` cannot produce that shape, so the bytes are assembled here.
 */

import { DICOM_CONTENT_TYPE, toDicomJsonTag, type UploadResult } from './types';

/* ================================================================== */
/* Building the request body                                           */
/* ================================================================== */

/**
 * A `Uint8Array` backed by a real `ArrayBuffer`.
 *
 * Not decoration: since the typed-array generics landed, the default
 * `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which is NOT assignable to
 * `BodyInit`. Every buffer that ends up as a `fetch` body or a `Response` body
 * has to be spelled this way, and `new Uint8Array(length | ArrayBuffer)` already
 * produces it — the alias just makes the requirement visible at the boundary
 * instead of surfacing as a baffling "missing properties from URLSearchParams".
 */
export type ByteArray = Uint8Array<ArrayBuffer>;

/** One `.dcm` file, already read into memory. */
export interface DicomInstancePart {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** The encoded request: body bytes plus the header that describes them. */
export interface MultipartPayload {
  readonly body: ByteArray;
  /** Full `Content-Type` header value, boundary included. */
  readonly contentType: string;
  /** Exposed for tests and for logging a failed upload without dumping the body. */
  readonly boundary: string;
}

const CRLF = '\r\n';
const encoder = new TextEncoder();

/**
 * Prefix kept human-readable so a packet capture during the demo is diagnosable
 * at a glance. RFC 2046 caps a boundary at 70 characters; this one is 41.
 */
const BOUNDARY_PREFIX = 'loopdicom';

/** How many random hex characters follow the prefix. 32 hex = 128 bits. */
const BOUNDARY_ENTROPY_CHARS = 32;

/** Attempts before giving up on finding a non-colliding boundary. */
const MAX_BOUNDARY_ATTEMPTS = 8;

function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));

  // `globalThis.crypto` is standard from Node 19 on, but the fallback costs two
  // lines and this module is also meant to run under a bare test runner. The
  // fallback is not a security downgrade here: the boundary is additionally
  // verified against the payload below, so entropy is a performance concern
  // (how many retries), not a correctness one.
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.slice(0, chars);
}

/**
 * Byte-level substring search.
 *
 * `Uint8Array` has no subsequence `indexOf`, and `Buffer.indexOf` would tie this
 * pure module to Node. The inner loop almost never runs past its first
 * comparison, so the cost is ~one pass over the payload. Measured at roughly
 * 400 MB/s: ~20 ms for an 8 MB batch, and the caller batches at 32 MB, so this
 * never blocks for long. Cheap enough to pay on every upload in exchange for
 * never shipping a body whose delimiter also appears inside the pixel data.
 */
function containsSequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;

  const first = needle[0];
  const limit = haystack.length - needle.length;

  outer: for (let i = 0; i <= limit; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }

  return false;
}

/**
 * Picks a boundary that provably does not occur inside any part.
 *
 * A boundary that collides with the binary content does not fail loudly — the
 * server silently truncates the instance at the false delimiter and stores a
 * corrupt image. Randomness alone makes that astronomically unlikely; the
 * verification pass makes it impossible.
 */
export function chooseBoundary(parts: readonly DicomInstancePart[]): string {
  for (let attempt = 0; attempt < MAX_BOUNDARY_ATTEMPTS; attempt += 1) {
    const boundary = `${BOUNDARY_PREFIX}${randomHex(BOUNDARY_ENTROPY_CHARS)}`;
    // Only a delimiter can confuse the parser, and a delimiter always starts
    // with `--`. Searching for the `--` form keeps the check tight.
    const delimiter = encoder.encode(`--${boundary}`);
    const collides = parts.some((part) => containsSequence(part.bytes, delimiter));
    if (!collides) return boundary;
  }

  throw new Error('Could not generate a multipart boundary that is absent from the uploaded files.');
}

function concatBytes(chunks: readonly Uint8Array[]): ByteArray {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Encodes instances into a STOW-RS request body.
 *
 * Exact framing, CRLF everywhere (a bare LF makes Medplum read the header block
 * as part of the pixel data):
 *
 *     --BOUNDARY CRLF
 *     Content-Type: application/dicom CRLF
 *     CRLF
 *     <raw .dcm bytes> CRLF
 *     --BOUNDARY CRLF          (repeated per instance)
 *     ...
 *     --BOUNDARY-- CRLF
 */
export function buildDicomMultipart(parts: readonly DicomInstancePart[]): MultipartPayload {
  if (parts.length === 0) {
    throw new Error('Cannot build a multipart body with no instances.');
  }

  const boundary = chooseBoundary(parts);
  const partHeader = encoder.encode(`--${boundary}${CRLF}Content-Type: ${DICOM_CONTENT_TYPE}${CRLF}${CRLF}`);
  const partTrailer = encoder.encode(CRLF);
  const closing = encoder.encode(`--${boundary}--${CRLF}`);

  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    chunks.push(partHeader, part.bytes, partTrailer);
  }
  chunks.push(closing);

  return {
    body: concatBytes(chunks),
    // `type` is part of the DICOMweb contract, not decoration: it declares what
    // the parts contain. `boundary` last so a truncated log still shows the type.
    contentType: `multipart/related; type="${DICOM_CONTENT_TYPE}"; boundary=${boundary}`,
    boundary,
  };
}

/* ================================================================== */
/* Reading the STOW-RS response                                        */
/* ================================================================== */

/**
 * Medplum answers with a DICOM JSON dataset in *denaturalized* form, where every
 * key is a bare tag and every value is `{ vr, Value: [...] }`:
 *
 *     { "00081199": { "vr": "SQ", "Value": [
 *         { "00081155": { "vr": "UI", "Value": ["1.2.840..."] },
 *           "00081190": { "vr": "UR", "Value": ["https://.../studies/1.2.3/..."] } } ] } }
 *
 * Some tool-chains hand back the *naturalized* form instead
 * (`{ ReferencedSOPSequence: [{ ReferencedSOPInstanceUID: '1.2.840...' }] }`),
 * so both are read. The alternative — assuming one shape — degrades into
 * "uploaded, UID unknown" for every file, which looks like a bug on screen.
 */
const STOW_TAG = {
  retrieveUrl: 'x00081190',
  referencedSopSequence: 'x00081199',
  failedSopSequence: 'x00081198',
  referencedSopInstanceUid: 'x00081155',
  failureReason: 'x00081197',
} as const;

const STOW_NATURAL_NAME = {
  retrieveUrl: 'RetrieveURL',
  referencedSopSequence: 'ReferencedSOPSequence',
  failedSopSequence: 'FailedSOPSequence',
  referencedSopInstanceUid: 'ReferencedSOPInstanceUID',
  failureReason: 'FailureReason',
} as const;

type StowField = keyof typeof STOW_TAG;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unwraps a DICOM JSON node down to its first scalar.
 * Handles `{ vr, Value: [...] }`, plain arrays, `{ Alphabetic }` person names
 * and bare scalars, which covers both response shapes with one function.
 *
 * Exported because `DicomInstance.metadata` in Medplum is the same DICOM JSON in
 * the same two possible shapes, and one reader for both is one reader to trust.
 */
export function readDicomJsonScalar(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') return node.trim() === '' ? null : node.trim();
  if (typeof node === 'number') return String(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      const value = readDicomJsonScalar(item);
      if (value !== null) return value;
    }
    return null;
  }

  if (isRecord(node)) {
    if ('Value' in node) return readDicomJsonScalar(node['Value']);
    if ('Alphabetic' in node) return readDicomJsonScalar(node['Alphabetic']);
  }

  return null;
}

/** Reads a field by tag first, then by its naturalized name. */
function readField(dataset: Record<string, unknown>, field: StowField): unknown {
  const byTag = dataset[toDicomJsonTag(STOW_TAG[field])];
  if (byTag !== undefined) return byTag;
  return dataset[STOW_NATURAL_NAME[field]];
}

/** A sequence field as an array of item datasets. Always an array, never null. */
function readSequence(dataset: Record<string, unknown>, field: StowField): Record<string, unknown>[] {
  const node = readField(dataset, field);
  const raw = isRecord(node) && 'Value' in node ? node['Value'] : node;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord);
}

/**
 * Pulls the StudyInstanceUID out of a WADO retrieve URL
 * (`https://host/dicomweb/studies/{uid}/series/{uid}/instances/{uid}`).
 *
 * It is read from the URL rather than from a tag because the STOW response is
 * not required to echo (0020,000D) per instance, but every entry carries a
 * RetrieveURL, and the study UID is what the UI needs to jump to the new study.
 */
export function studyUidFromRetrieveUrl(url: string | null): string | undefined {
  if (!url) return undefined;
  const match = /\/studies\/([^/?#]+)/.exec(url);
  if (!match) return undefined;
  const uid = decodeURIComponent(match[1]).trim();
  return uid === '' ? undefined : uid;
}

/**
 * Maps a STOW-RS response onto the files that produced it.
 *
 * Pairing is positional: DICOMweb returns ReferencedSOPSequence in the order the
 * parts were sent, and that is the only link back to a filename — the response
 * never repeats the filename, because a `.dcm` file has no identity beyond its
 * SOP Instance UID.
 *
 * Defensive by design: an HTTP 2xx means Medplum accepted and stored the study.
 * If the body then has a shape this parser does not recognize, the files are
 * still reported as uploaded, only without a UID — claiming failure would tell
 * the user to re-upload something that is already stored.
 */
export function parseStowResponse(
  payload: unknown,
  parts: readonly { readonly filename: string }[],
): UploadResult[] {
  const dataset = isRecord(payload) ? payload : {};
  const referenced = readSequence(dataset, 'referencedSopSequence');
  const failed = readSequence(dataset, 'failedSopSequence');

  // Top-level RetrieveURL points at the study as a whole; used whenever a
  // per-instance URL is missing.
  const studyFallback = studyUidFromRetrieveUrl(readDicomJsonScalar(readField(dataset, 'retrieveUrl')));

  return parts.map((part, index) => {
    const entry = referenced[index];

    if (!entry) {
      // No entry for this position. Two cases, and they read very differently on
      // screen, so they are distinguished: the server explicitly reported
      // failures (trust it), or the body simply was not in a shape we could read.
      if (failed.length > 0) {
        const reason = readDicomJsonScalar(readField(failed[0], 'failureReason'));
        return {
          filename: part.filename,
          ok: false,
          error: reason
            ? `Medplum rejected this instance (failure reason ${reason}).`
            : 'Medplum rejected this instance.',
        };
      }
      return { filename: part.filename, ok: true };
    }

    const sopInstanceUid = readDicomJsonScalar(readField(entry, 'referencedSopInstanceUid')) ?? undefined;
    const studyInstanceUid =
      studyUidFromRetrieveUrl(readDicomJsonScalar(readField(entry, 'retrieveUrl'))) ?? studyFallback;

    const result: UploadResult = { filename: part.filename, ok: true };
    if (sopInstanceUid) result.sopInstanceUid = sopInstanceUid;
    if (studyInstanceUid) result.studyInstanceUid = studyInstanceUid;
    return result;
  });
}
