/**
 * `GET /api/dicom/studies/{studyUid}/instances` — the instances of one study.
 *
 * ENGLISH ON PURPOSE — see the header of `lib/dicom/types.ts`.
 *
 * This is the list the viewer walks: each row carries an `id` the client turns
 * into `/api/dicom/binary/{id}` to pull the original `.dcm` bytes, plus
 * `binaryId` as the flag that says whether those bytes exist at all.
 *
 * Always HTTP 200 with an `InstancesResult` envelope. A study UID that matches
 * nothing degrades to `reason: 'empty'` rather than 404 — the UI shows the same
 * intentional empty state either way, and the client keeps one code path.
 */

import { NextResponse } from 'next/server';

import { listInstances } from '@/lib/dicom/medplum-dicom';
import { apiDegraded, type StoredInstance } from '@/lib/dicom/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** In Next 15 the dynamic segments arrive as a promise and must be awaited. */
interface RouteContext {
  params: Promise<{ studyUid: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { studyUid } = await context.params;

  // Next has already decoded the segment; the UID is used as a search parameter
  // value further down and is never interpolated into a path.
  const uid = typeof studyUid === 'string' ? studyUid.trim() : '';
  if (uid === '') {
    return NextResponse.json(
      apiDegraded<readonly StoredInstance[]>([], 'bad-request', 'A study instance UID is required.'),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const result = await listInstances(uid);
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
