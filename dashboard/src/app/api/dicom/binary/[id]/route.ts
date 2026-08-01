/**
 * `GET /api/dicom/binary/{id}` — the raw bytes of one stored instance.
 *
 * ENGLISH ON PURPOSE — see the header of `lib/dicom/types.ts`.
 *
 * `{id}` is a `DicomInstance` id, NOT a `Binary` id. The server resolves
 * `DicomInstance.raw` itself, so the only bytes this route can ever hand out are
 * the bytes of a DICOM instance. Accepting a `Binary` id here would turn our
 * project-wide client credentials into a read-any-blob capability for anyone who
 * can reach the dashboard — `DocumentReference` attachments included.
 *
 * The one route in this section that does NOT return an `ApiResult`: the body is
 * the `.dcm` file itself. The client fetches it, calls `res.blob()`, wraps it in
 * a `File` and hands it to the same cornerstone `wadouri` file manager it uses
 * for locally picked files — one decode path for both sources.
 *
 * Because the body is bytes and not an envelope, this route DOES use status
 * codes: a caller feeding the response to a decoder needs `res.ok` to mean
 * "these are real DICOM bytes". Silently returning a 200 with an error message
 * in the body would hand the parser garbage.
 *
 * Security: the Medplum bearer token stays on the server. The browser only ever
 * sees this same-origin URL, which is also why the bytes can be fetched at all
 * without exposing a credential.
 */

import { NextResponse } from 'next/server';

import { fetchInstanceBytes } from '@/lib/dicom/medplum-dicom';
import { DICOM_CONTENT_TYPE, type DicomFallbackReason } from '@/lib/dicom/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** In Next 15 the dynamic segments arrive as a promise and must be awaited. */
interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Degradation reason -> HTTP status. Distinguishes "not there" from "broken". */
function statusFor(reason: DicomFallbackReason): number {
  switch (reason) {
    case 'bad-request':
      return 400;
    case 'empty':
      return 404;
    case 'not-configured':
      return 503;
    case 'timeout':
      return 504;
    case 'auth-failed':
    case 'network':
      return 502;
    default:
      return 500;
  }
}

/** Plain-text errors: the caller is a decoder, not a renderer. */
function failure(reason: DicomFallbackReason, detail: string | null): NextResponse {
  return new NextResponse(detail ?? 'The instance could not be retrieved.', {
    status: statusFor(reason),
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;

  const result = await fetchInstanceBytes(typeof id === 'string' ? id : '');
  if (!result.data) {
    return failure(result.reason, result.detail);
  }

  // `instanceId` is the normalized, already-validated id — never the raw path
  // segment. `id` can still carry a trailing `%0A` that survives `.trim()`
  // validation and then makes header construction throw.
  const { bytes, instanceId } = result.data;

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      // Pinned, never echoed from upstream: this route only ever serves DICOM,
      // and a content type taken from the stored resource would let a non-DICOM
      // blob execute as markup on our own origin.
      'Content-Type': DICOM_CONTENT_TYPE,
      'Content-Length': String(bytes.length),
      // A stored instance is immutable — its `Binary` id changes if the bytes
      // change — so the browser may reuse it while scrolling a series. `private`
      // keeps it out of any shared cache: these bytes are patient data, even
      // though this dataset is synthetic.
      'Cache-Control': 'private, max-age=300, no-transform',
      // `attachment`, not `inline`: the client reads this with `res.blob()` and
      // never needs the browser to render it, so nothing here is ever displayed.
      'Content-Disposition': `attachment; filename="${instanceId}.dcm"`,
      // The bytes are decoded by cornerstone, never interpreted as a document.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
