/**
 * DICOM parsing, grouping and geometry — ported from the donor viewer.
 *
 * ENGLISH ON PURPOSE, like the rest of `lib/dicom/`. See `types.ts`.
 *
 * Everything here is pure except `parseDicomFiles()`, which needs the runtime
 * (the tag parser and the cornerstone file manager) — and even that takes it as
 * an argument rather than importing it, so this module never touches `window`
 * and every decision below can be reasoned about, and tested, on its own.
 *
 * The pipeline, in order:
 *
 *   files -> parallel ArrayBuffer read -> parse tags -> register with the file
 *   manager -> group by SeriesInstanceUID -> score each series' orientation
 *   from the slice normal -> sort slices along that normal -> pick one winning
 *   series per plane -> decide tri-plane vs single viewport.
 */

import type { DataSet } from 'dicom-parser';

import type { DicomRuntime } from '@/lib/dicom/cornerstone';
import {
  DICOM_TAG,
  MIN_PLANES_FOR_3D,
  MIN_SLICES_PER_PLANE_FOR_3D,
  MIN_TOTAL_SLICES_FOR_3D,
  VIEWER_PLANES,
  expandFrames,
  isVolumetricModality,
  parseDicomNumbers,
  type DicomLayout,
  type DicomOrientation,
  type DicomSeriesGroup,
  type DicomSliceMeta,
  type Vec3,
  type ViewerPlane,
} from '@/lib/dicom/types';

/* ================================================================== */
/* Tag reading                                                         */
/* ================================================================== */

/** Series key used when the header has no SeriesInstanceUID at all. */
export const NO_SERIES_UID = 'no-uid';

/**
 * NumberOfFrames (0028,0008).
 *
 * Read twice on purpose: the VR varies between encoders (`IS` in most files,
 * but some write it as a plain string), so `intString` returns `undefined` on
 * perfectly valid data. The donor's `intString(...) || string(...) || '1'`
 * chain is kept, with `0` and negatives folded into 1 — an instance always has
 * at least one frame.
 */
function readFrameCount(dataSet: DataSet): number {
  const asInt = dataSet.intString(DICOM_TAG.numberOfFrames);
  const raw = asInt !== undefined ? asInt : Number(dataSet.string(DICOM_TAG.numberOfFrames) ?? '1');
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1;
}

/**
 * The slice normal: the cross product of the two direction cosines in
 * ImageOrientationPatient (0020,0037).
 *
 * IOP is six numbers — the first three are the direction of the image rows in
 * patient space, the next three the direction of the columns. Their cross
 * product points along the stacking axis, which is what both the orientation
 * scoring and the slice sorting are built on. Anything other than exactly six
 * values is not usable geometry, so it yields `null` rather than a guess.
 */
export function computeSliceNormal(iop: readonly number[] | null | undefined): Vec3 | null {
  if (!iop || iop.length !== 6) return null;

  const [r0, r1, r2, c0, c1, c2] = iop;
  const nx = r1 * c2 - r2 * c1;
  const ny = r2 * c0 - r0 * c2;
  const nz = r0 * c1 - r1 * c0;

  // A degenerate IOP (parallel cosines) would divide by zero; `|| 1` leaves the
  // raw zero vector instead of NaN, which the scoring below simply ignores.
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

/** One parsed slice. `imageId` must already be registered with the file manager. */
export function readSliceMeta(dataSet: DataSet, imageId: string): DicomSliceMeta {
  const iop = parseDicomNumbers(dataSet.string(DICOM_TAG.imageOrientationPatient));
  const ipp = parseDicomNumbers(dataSet.string(DICOM_TAG.imagePositionPatient));
  const instanceRaw = dataSet.intString(DICOM_TAG.instanceNumber);
  const modality = (dataSet.string(DICOM_TAG.modality) ?? '').trim().toUpperCase();

  return {
    imageId,
    seriesInstanceUid: dataSet.string(DICOM_TAG.seriesInstanceUid) ?? null,
    // `null`, not 0: "no instance number" and "instance number 0" sort
    // differently, and the fallback comparator depends on knowing which is which.
    instanceNumber: instanceRaw !== undefined && Number.isFinite(instanceRaw) ? instanceRaw : null,
    imageOrientationPatient: iop.length === 6 ? iop : null,
    imagePositionPatient: ipp.length === 3 ? ipp : null,
    normal: computeSliceNormal(iop),
    modality: modality === '' ? null : modality,
    numberOfFrames: readFrameCount(dataSet),
  };
}

/* ================================================================== */
/* Orientation                                                         */
/* ================================================================== */

/**
 * Which anatomical plane a series lies in.
 *
 * Average the per-slice normals, then let the largest absolute component win:
 * a normal pointing mostly along z means the slices are stacked head-to-foot,
 * i.e. axial. Averaging rather than reading slice 0 makes it robust to a single
 * malformed header in a 300-slice series.
 *
 * The `>=` comparisons and their order are the donor's, kept verbatim: ties
 * fall to axial, then coronal. Axial is the right tie-break — it is by far the
 * most common acquisition, so a coin-flip that lands there is wrong least often.
 */
export function scoreOrientation(slices: readonly DicomSliceMeta[]): DicomOrientation {
  const normals = slices.map((slice) => slice.normal).filter((normal): normal is Vec3 => normal !== null);
  if (normals.length === 0) return 'unknown';

  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const [x, y, z] of normals) {
    sx += x;
    sy += y;
    sz += z;
  }

  const ax = Math.abs(sx / normals.length);
  const ay = Math.abs(sy / normals.length);
  const az = Math.abs(sz / normals.length);

  if (az >= ax && az >= ay) return 'axial';
  if (ay >= ax && ay >= az) return 'coronal';
  if (ax >= ay && ax >= az) return 'sagittal';
  return 'unknown';
}

/**
 * Whether a plane should be rendered vertically flipped.
 *
 * Heuristic from the donor: average the z component of the column cosine
 * (`iop[5]`) across the series. When it is positive the image rows run
 * foot-to-head, which puts the patient upside down on screen. Default `true`
 * when there is no IOP at all — an unflipped coronal is the more common defect.
 *
 * Axial is never flipped, and neither is `unknown`: with no reliable geometry,
 * showing the pixels exactly as stored is the honest choice.
 */
export function computeVerticalFlip(
  slices: readonly DicomSliceMeta[],
  orientation: DicomOrientation,
): boolean {
  if (orientation === 'axial' || orientation === 'unknown') return false;

  let sum = 0;
  let count = 0;
  for (const slice of slices) {
    const iop = slice.imageOrientationPatient;
    if (iop && iop.length === 6) {
      sum += iop[5];
      count += 1;
    }
  }

  if (count === 0) return true;
  return sum / count > 0;
}

/* ================================================================== */
/* Sorting                                                             */
/* ================================================================== */

/** Fallback stacking axis when a series carries no orientation at all. */
const DEFAULT_NORMAL: Vec3 = [0, 0, 1];

/**
 * Sort a series into anatomical order.
 *
 * Project each slice's ImagePositionPatient (0020,0032) onto the series normal
 * and sort by that scalar — that is the slice's real position along the
 * stacking axis, and it is the only ordering that survives a scanner writing
 * InstanceNumber backwards or restarting it mid-series. InstanceNumber is the
 * fallback for the pair being compared when either lacks a position.
 *
 * Deviation from the donor (deliberate): the donor took `arr[0].normal`, so a
 * series whose FIRST slice happened to lack IOP fell back to [0,0,1] even when
 * every other slice had a perfectly good normal. Here the first available
 * normal in the series wins.
 */
export function sortSlices(slices: readonly DicomSliceMeta[]): DicomSliceMeta[] {
  const normal = slices.find((slice) => slice.normal !== null)?.normal ?? DEFAULT_NORMAL;

  const project = (slice: DicomSliceMeta): number => {
    const ipp = slice.imagePositionPatient;
    if (!ipp) return 0;
    return (ipp[0] ?? 0) * normal[0] + (ipp[1] ?? 0) * normal[1] + (ipp[2] ?? 0) * normal[2];
  };

  // Array.prototype.sort is stable, so slices that tie keep their arrival order
  // instead of shuffling between renders.
  return [...slices].sort((a, b) => {
    if (a.imagePositionPatient && b.imagePositionPatient) {
      return project(a) - project(b);
    }
    return (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0);
  });
}

/* ================================================================== */
/* Grouping                                                            */
/* ================================================================== */

/**
 * Group slices into series, sorted and scored.
 *
 * Insertion order of the map is preserved, so the resulting series list follows
 * the order the files arrived in — which for a directory drop is the order on
 * disk, and for a stored study is the order Medplum returned. Predictable
 * beats clever here: the single-viewport stack is built by concatenating these.
 */
export function groupBySeries(slices: readonly DicomSliceMeta[]): DicomSeriesGroup[] {
  const bySeries = new Map<string, DicomSliceMeta[]>();

  for (const slice of slices) {
    const key = slice.seriesInstanceUid ?? NO_SERIES_UID;
    const bucket = bySeries.get(key);
    if (bucket) bucket.push(slice);
    else bySeries.set(key, [slice]);
  }

  const groups: DicomSeriesGroup[] = [];
  for (const [seriesInstanceUid, bucket] of bySeries) {
    const sorted = sortSlices(bucket);
    const orientation = scoreOrientation(sorted);

    groups.push({
      seriesInstanceUid,
      orientation,
      slices: sorted,
      // Multi-frame instances become one image id per frame, in frame order,
      // spliced into the slice order. A single-frame instance keeps its bare id.
      imageIds: sorted.flatMap((slice) => expandFrames(slice.imageId, slice.numberOfFrames)),
      verticalFlip: computeVerticalFlip(sorted, orientation),
    });
  }

  return groups;
}

/* ================================================================== */
/* Layout: tri-plane or single viewport                                */
/* ================================================================== */

/**
 * Winner-takes-all per plane: when two series share an orientation, only the
 * one with the most slices is shown.
 *
 * This is why a study with a 300-slice axial CT and a 3-slice axial scout opens
 * on the CT. Strictly greater, so the first series encountered wins a tie —
 * again, predictable over clever.
 */
function pickWinners(groups: readonly DicomSeriesGroup[]): Partial<Record<ViewerPlane, DicomSeriesGroup>> {
  const winners: Partial<Record<ViewerPlane, DicomSeriesGroup>> = {};

  for (const group of groups) {
    if (group.orientation === 'unknown') continue;
    const plane: ViewerPlane = group.orientation;
    const current = winners[plane];
    if (!current || group.slices.length > current.slices.length) {
      winners[plane] = group;
    }
  }

  return winners;
}

/**
 * Tri-plane or single viewport.
 *
 * The gate is load-bearing, not cosmetic. Without it a two-image X-ray study
 * that happens to produce two orientations opens in a three-pane volumetric
 * layout with one slice per pane — it looks broken, and worse, it implies a 3D
 * acquisition that never happened. All three conditions must hold:
 *
 *   - at least 2 planes with at least 5 slices each,
 *   - a volumetric modality somewhere in the study (CT/MR/PT/NM/CBCT),
 *   - at least 10 slices across the winning planes.
 *
 * Thresholds live in `types.ts` and come from the donor, tuned on real studies.
 */
export function buildLayout(
  groups: readonly DicomSeriesGroup[],
  modalities: readonly string[],
): DicomLayout {
  const winners = pickWinners(groups);

  // Every image id in series order. In single-viewport mode this IS the stack;
  // in tri-plane mode it is only used for bookkeeping (cache release), because
  // each pane indexes into its own plane.
  //
  // Donor bug NOT copied: the donor built its single-pane stack from the raw
  // unsorted, ungrouped meta array — it sorted inside the per-series loop and
  // then threw that ordering away. Sorting happens before this concatenation.
  const imageIds = groups.flatMap((group) => [...group.imageIds]);

  const qualifying = VIEWER_PLANES.filter(
    (plane) => (winners[plane]?.slices.length ?? 0) >= MIN_SLICES_PER_PLANE_FOR_3D,
  );

  const totalSlices = VIEWER_PLANES.reduce((sum, plane) => sum + (winners[plane]?.slices.length ?? 0), 0);
  const volumetric = modalities.some((modality) => isVolumetricModality(modality));

  const triPlane =
    qualifying.length >= MIN_PLANES_FOR_3D && volumetric && totalSlices >= MIN_TOTAL_SLICES_FOR_3D;

  if (!triPlane) {
    return { triPlane: false, planes: {}, imageIds };
  }

  // Only the planes that cleared the per-plane threshold get a pane. A plane
  // with 2 slices next to one with 300 is noise, not a view.
  const planes: Partial<Record<ViewerPlane, DicomSeriesGroup>> = {};
  for (const plane of qualifying) {
    const group = winners[plane];
    if (group) planes[plane] = group;
  }

  return { triPlane: true, planes, imageIds };
}

/* ================================================================== */
/* Entry point                                                         */
/* ================================================================== */

export interface ParsedStudy {
  layout: DicomLayout;
  groups: readonly DicomSeriesGroup[];
  /** Distinct modalities seen across the files, uppercase. */
  modalities: readonly string[];
  /** Files handed in. */
  fileCount: number;
  /** Files that could not be read or parsed. Shown, never swallowed. */
  failedCount: number;
}

/**
 * Files -> a renderable layout.
 *
 * The buffer reads are parallel and `dicom-parser` is resolved once, up front.
 * The donor's comment on this is worth preserving: it used to import the parser
 * per slice and read the files serially, which delayed the first frame by
 * seconds on a 100-300 slice series.
 *
 * A file that fails to read or parse is counted and skipped, never fatal — a
 * dropped folder routinely contains a DICOMDIR, a README or an OS metadata
 * file, and one bad byte range must not cost the other 299 slices. Only files
 * that parse get registered with the file manager, so junk never occupies a
 * `dicomfile:` slot.
 */
export async function parseDicomFiles(
  files: readonly File[],
  runtime: DicomRuntime,
): Promise<ParsedStudy> {
  const buffers = await Promise.all(
    files.map((file) =>
      file.arrayBuffer().then(
        (buffer) => ({ file, buffer }),
        () => null,
      ),
    ),
  );

  const slices: DicomSliceMeta[] = [];
  const modalities = new Set<string>();
  let failedCount = 0;

  for (const entry of buffers) {
    if (!entry) {
      failedCount += 1;
      continue;
    }

    try {
      const dataSet = runtime.parseDicom(new Uint8Array(entry.buffer));
      const imageId = runtime.fileManager.add(entry.file);
      const meta = readSliceMeta(dataSet, imageId);
      if (meta.modality) modalities.add(meta.modality);
      slices.push(meta);
    } catch {
      failedCount += 1;
    }
  }

  const groups = groupBySeries(slices);
  const modalityList = [...modalities];

  return {
    layout: buildLayout(groups, modalityList),
    groups,
    modalities: modalityList,
    fileCount: files.length,
    failedCount,
  };
}

/* ================================================================== */
/* Release                                                             */
/* ================================================================== */

/** `dicomfile:12?frame=3` -> `12`. Anything else -> `null`. */
export function fileManagerIndexOf(imageId: string): number | null {
  const match = /^dicomfile:(\d+)/.exec(imageId);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

/**
 * Hand the `File` objects back.
 *
 * `wadouri.fileManager` keeps every added file in a module-level array that
 * lives as long as the tab. Opening five studies in one demo session pins all
 * five in memory unless they are released.
 *
 * The API is asymmetric and easy to get wrong: `add()` returns
 * `dicomfile:<index>` but `remove()` takes the INDEX. Passing the image id
 * would write a junk string key on the array and leak the file anyway — which
 * is exactly the kind of silent leak this helper exists to prevent.
 */
export function releaseImageIds(runtime: DicomRuntime, imageIds: readonly string[]): void {
  const remove = runtime.fileManager.remove;
  if (typeof remove !== 'function') return;

  const seen = new Set<number>();
  for (const imageId of imageIds) {
    const index = fileManagerIndexOf(imageId);
    // Multi-frame ids all point at one file; remove it once.
    if (index === null || seen.has(index)) continue;
    seen.add(index);
    try {
      remove.call(runtime.fileManager, index);
    } catch {
      // Releasing is best effort. A loader version without remove() is a leak,
      // not a crash, and crashing the unmount path would be strictly worse.
    }
  }
}
