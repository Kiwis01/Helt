/**
 * `GET /api/dicom/studies` — every DICOM study stored in this Medplum project.
 *
 * ENGLISH ON PURPOSE — see the header of `lib/dicom/types.ts`.
 *
 * Always HTTP 200 with a `StudiesResult` envelope, upstream failures included:
 * the caller renders `data` and `reason`, never a status code. An empty project
 * comes back as a healthy `source: 'medplum'` with an empty array — "nothing
 * uploaded yet" is an answer, not an outage.
 */

import { NextResponse } from 'next/server';

import { listStudies } from '@/lib/dicom/medplum-dicom';

export const runtime = 'nodejs';
// The study list changes the moment someone uploads. Nothing here may be
// prerendered or reused across requests.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // `listStudies` never throws; there is deliberately no try/catch to add.
  const result = await listStudies();
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
