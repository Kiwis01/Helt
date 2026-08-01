'use client';

/**
 * DICOM viewer — cornerstone, ported from the donor project.
 *
 * ENGLISH ON PURPOSE, like the rest of the DICOM section. See
 * `lib/dicom/types.ts` for why this one corner of a Spanish dashboard is in
 * English.
 *
 * One entry point: a `DicomSource`. Local files and stored Medplum studies
 * converge on the same cornerstone `dicomfile:` path — stored instances are
 * fetched as bytes through our own route and wrapped back into `File` objects,
 * so there is exactly ONE decode and render path to reason about, and the
 * Medplum bearer token never leaves the server.
 *
 * This module must never render on the server: mount it with
 * `dynamic(() => import('@/components/dicom/DicomViewer'), { ssr: false })`.
 * Nothing at module scope touches `window`, so importing it is harmless; only
 * the effects are browser-bound.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { EmptyState } from '@/components/Card';
import {
  firstWindowValue,
  initDicomRuntime,
  type CornerstoneApi,
  type CornerstoneViewport,
  type DicomRuntime,
} from '@/lib/dicom/cornerstone';
import { parseDicomFiles, releaseImageIds, type ParsedStudy } from '@/lib/dicom/parse';
import {
  DICOM_API,
  DICOM_CONTENT_TYPE,
  VIEWER_PLANES,
  clampIndex,
  countDicomSourceItems,
  describeDicomSource,
  initialIndex,
  isRenderableInstance,
  normalizeWheelDeltaPx,
  wheelSteps,
  type DicomSource,
  type SliceInfo,
  type StoredInstance,
  type ViewerPlane,
  type WindowLevel,
} from '@/lib/dicom/types';

/* ================================================================== */
/* Small local types                                                   */
/* ================================================================== */

/** A viewport slot. `single` is the non-volumetric fallback pane. */
type PaneKey = 'single' | ViewerPlane;

const PANE_KEYS: readonly PaneKey[] = ['single', 'axial', 'coronal', 'sagittal'];

const PLANE_LABEL: Record<ViewerPlane, string> = {
  axial: 'Axial',
  coronal: 'Coronal',
  sagittal: 'Sagittal',
};

type Phase = 'idle' | 'loading' | 'ready' | 'error';

type PaneRecord<T> = Record<PaneKey, T>;

const EMPTY_IDS: readonly string[] = [];

function emptyStacks(): PaneRecord<readonly string[]> {
  return { single: EMPTY_IDS, axial: EMPTY_IDS, coronal: EMPTY_IDS, sagittal: EMPTY_IDS };
}

function zeroPanes(): PaneRecord<number> {
  return { single: 0, axial: 0, coronal: 0, sagittal: 0 };
}

export interface DicomViewerProps {
  /** What to display. `null` renders the empty state, which is a valid screen. */
  source: DicomSource | null;
  /**
   * Provenance line for the header and the loading overlay.
   *
   * The viewer cannot derive this: a study downloaded from Medplum reaches it as
   * `File` objects, indistinguishable from a dropped folder, so deriving the
   * label from the source would print "240 local files" underneath a card whose
   * pill says "Medplum". Two provenance labels disagreeing on one panel is
   * exactly what this dashboard's source badges exist to prevent — so the shell,
   * which knows where the bytes came from, says it. Omitted for genuinely local
   * files, where the derived label is already the truth.
   */
  sourceLabel?: string;
  /** Optional readout for a surrounding panel (totals only, never indices). */
  onSliceInfo?: (info: SliceInfo) => void;
  className?: string;
}

/* ================================================================== */
/* Stored instances -> File[]                                          */
/* ================================================================== */

/**
 * Six at a time. A 300-instance CT fired off in one `Promise.all` opens 300
 * sockets, and the browser queues them anyway — but the server has to hold 300
 * Medplum reads in flight to answer them.
 */
const MAX_PARALLEL_DOWNLOADS = 6;

/** Instances with no `binaryId` have no bytes to fetch; they are reported, not hidden. */
function orderInstances(instances: readonly StoredInstance[]): StoredInstance[] {
  return [...instances].sort((a, b) => {
    const an = a.instanceNumber ?? Number.MAX_SAFE_INTEGER;
    const bn = b.instanceNumber ?? Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return a.sopInstanceUid.localeCompare(b.sopInstanceUid);
  });
}

async function downloadStoredInstances(
  instances: readonly StoredInstance[],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<{ files: File[]; failed: number }> {
  const renderable = orderInstances(instances.filter(isRenderableInstance));
  const slots: (File | null)[] = new Array<File | null>(renderable.length).fill(null);
  // Instances stored without retrievable bytes count as failures from the
  // first line: silently rendering 297 of 300 slices is a clinical lie.
  let failed = instances.length - renderable.length;
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= renderable.length) return;

      const instance = renderable[index];
      if (!instance.binaryId) {
        failed += 1;
        continue;
      }

      try {
        // Same-origin route, addressed by instance id — the server resolves the
        // `Binary` behind `raw`. The bearer token stays on the server.
        const response = await fetch(DICOM_API.instanceBytes(instance.id), { signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        slots[index] = new File([blob], `${instance.sopInstanceUid}.dcm`, {
          type: DICOM_CONTENT_TYPE,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failed += 1;
      }

      done += 1;
      onProgress(done, renderable.length);
    }
  };

  const lanes = Math.min(MAX_PARALLEL_DOWNLOADS, Math.max(1, renderable.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  return { files: slots.filter((file): file is File => file !== null), failed };
}

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

/**
 * Stable identity for a source.
 *
 * The load effect keys off this string instead of the object, because a parent
 * that builds `{ kind: 'local', files }` inline re-creates it on every render —
 * and re-decoding a 300-slice study on every keystroke somewhere else on the
 * page is the kind of bug that only shows up on stage.
 */
function sourceKeyOf(source: DicomSource | null): string {
  if (!source) return 'none';
  if (source.kind === 'local') {
    return `local:${source.files.map((file) => `${file.name}|${file.size}|${file.lastModified}`).join(',')}`;
  }
  return `stored:${source.study.id}:${source.instances.map((instance) => instance.id).join(',')}`;
}

function isElementEnabled(cornerstone: CornerstoneApi, element: HTMLElement): boolean {
  try {
    return cornerstone.getEnabledElements().some((entry) => entry?.element === element);
  } catch {
    return false;
  }
}

function applyWindow(viewport: CornerstoneViewport, level: WindowLevel): void {
  if (!viewport.voi) viewport.voi = {};
  // A width of 0 makes every pixel either black or white; clamp at 1.
  if (level.width !== null) viewport.voi.windowWidth = Math.max(1, level.width);
  if (level.center !== null) viewport.voi.windowCenter = level.center;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Unknown error';
}

function formatWindow(value: number | null): string {
  return value === null ? '—' : String(Math.round(value));
}

/* ================================================================== */
/* Component                                                           */
/* ================================================================== */

export function DicomViewer({
  source,
  sourceLabel: sourceLabelProp,
  onSliceInfo,
  className,
}: DicomViewerProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [study, setStudy] = useState<ParsedStudy | null>(null);
  const [plane, setPlane] = useState<ViewerPlane>('axial');
  const [indices, setIndices] = useState<PaneRecord<number>>(zeroPanes);
  const [windowLevel, setWindowLevel] = useState<WindowLevel>({ center: null, width: null });
  const [missingBytes, setMissingBytes] = useState(0);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const runtimeRef = useRef<DicomRuntime | null>(null);
  const mountedRef = useRef(true);
  const canvasAreaRef = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef<PaneRecord<HTMLDivElement | null>>({
    single: null,
    axial: null,
    coronal: null,
    sagittal: null,
  });

  /**
   * Every element we called `enable()` on. The teardown below walks this set;
   * see the comment there for why it is not optional.
   */
  const enabledElementsRef = useRef<Set<HTMLDivElement>>(new Set());
  /** Image ids owned by the study on screen, so the file manager can be drained. */
  const ownedImageIdsRef = useRef<readonly string[]>(EMPTY_IDS);

  /**
   * Per-pane monotonic counters. Bumped before each `loadImage`; if the counter
   * moved while the decode was in flight, the result is dropped instead of
   * displayed. Without this, a fast wheel spin paints slices out of order and
   * settles on whichever decode happened to finish last.
   */
  const sequenceRef = useRef<PaneRecord<number>>(zeroPanes());
  /** Leftover wheel pixels per pane, so a slow trackpad drag stays continuous. */
  const wheelAccumRef = useRef<PaneRecord<number>>(zeroPanes());

  // Mirrors of state that event handlers and async continuations read. Kept in
  // refs to dodge stale closures — the wheel listener is attached once and must
  // still see the current index.
  const indicesRef = useRef<PaneRecord<number>>(indices);
  const stacksRef = useRef<PaneRecord<readonly string[]>>(emptyStacks());
  const windowLevelRef = useRef<WindowLevel>(windowLevel);
  const seedWindowRef = useRef<WindowLevel>({ center: null, width: null });
  const studyRef = useRef<ParsedStudy | null>(null);
  const sourceRef = useRef<DicomSource | null>(source);
  const sliceInfoRef = useRef<DicomViewerProps['onSliceInfo']>(onSliceInfo);

  sourceRef.current = source;
  sliceInfoRef.current = onSliceInfo;
  windowLevelRef.current = windowLevel;
  studyRef.current = study;

  const sourceKey = useMemo(() => sourceKeyOf(source), [source]);

  /* ---------------- derived stacks ---------------- */

  const stacks = useMemo<PaneRecord<readonly string[]>>(() => {
    const layout = study?.layout;
    if (!layout) return emptyStacks();
    if (!layout.triPlane) {
      return { single: layout.imageIds, axial: EMPTY_IDS, coronal: EMPTY_IDS, sagittal: EMPTY_IDS };
    }
    return {
      single: EMPTY_IDS,
      axial: layout.planes.axial?.imageIds ?? EMPTY_IDS,
      coronal: layout.planes.coronal?.imageIds ?? EMPTY_IDS,
      sagittal: layout.planes.sagittal?.imageIds ?? EMPTY_IDS,
    };
  }, [study]);

  stacksRef.current = stacks;

  const triPlane = study?.layout.triPlane ?? false;
  const availablePlanes = useMemo(
    () => VIEWER_PLANES.filter((candidate) => stacks[candidate].length > 0),
    [stacks],
  );
  // A plane the current study does not have would render as an empty black
  // pane; fall back to the first one it does have.
  const effectivePlane: ViewerPlane = availablePlanes.includes(plane)
    ? plane
    : (availablePlanes[0] ?? 'axial');
  const activePane: PaneKey = triPlane ? effectivePlane : 'single';
  const activeStack = stacks[activePane];
  const activeIndex = clampIndex(indices[activePane], activeStack.length);

  /* ---------------- index plumbing ---------------- */

  const setPaneIndex = useCallback((pane: PaneKey, next: number) => {
    const total = stacksRef.current[pane].length;
    if (total === 0) return;
    const clamped = clampIndex(next, total);
    if (indicesRef.current[pane] === clamped) return;
    indicesRef.current = { ...indicesRef.current, [pane]: clamped };
    setIndices(indicesRef.current);
  }, []);

  /* ---------------- cornerstone element lifecycle ---------------- */

  const enableElement = useCallback((cornerstone: CornerstoneApi, element: HTMLDivElement) => {
    try {
      if (!isElementEnabled(cornerstone, element)) cornerstone.enable(element);
      enabledElementsRef.current.add(element);
    } catch (error) {
      console.error('[dicom] cornerstone.enable failed', error);
    }
  }, []);

  /**
   * Teardown. NOT optional.
   *
   * Every enabled element holds a canvas plus a WebGL context registered in
   * cornerstone's global state; leaving them behind leaks roughly 50-200 MB of
   * GPU/CPU memory per study. Next navigates away from this route on the client
   * without a page reload, so the leak accumulates for the whole session —
   * exactly the demo where someone opens four studies in a row.
   *
   * The cache is purged only when no other viewer is still enabled, and the
   * file manager entries are handed back so the raw `File` objects can be
   * collected too.
   */
  useEffect(() => {
    const enabled = enabledElementsRef.current;
    const owned = ownedImageIdsRef;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const cornerstone = runtime.cornerstone;

      for (const element of enabled) {
        try {
          if (isElementEnabled(cornerstone, element)) cornerstone.disable(element);
        } catch (error) {
          console.error('[dicom] cornerstone.disable failed', error);
        }
      }
      enabled.clear();

      try {
        if (cornerstone.getEnabledElements().length === 0) cornerstone.imageCache?.purgeCache?.();
      } catch (error) {
        console.error('[dicom] purgeCache failed', error);
      }

      releaseImageIds(runtime, owned.current);
      owned.current = EMPTY_IDS;
    };
  }, []);

  /* ---------------- display ---------------- */

  const showSlice = useCallback(
    async (pane: PaneKey): Promise<void> => {
      const runtime = runtimeRef.current;
      const element = elementsRef.current[pane];
      const ids = stacksRef.current[pane];
      if (!runtime || !element || ids.length === 0) return;

      const cornerstone = runtime.cornerstone;
      enableElement(cornerstone, element);

      const imageId = ids[clampIndex(indicesRef.current[pane], ids.length)];
      const sequence = sequenceRef.current[pane] + 1;
      sequenceRef.current[pane] = sequence;

      try {
        const image = await cornerstone.loadImage(imageId);
        // The wheel moved while this frame was decoding, or the viewer went
        // away entirely: drop it rather than painting a stale slice.
        if (!mountedRef.current || sequenceRef.current[pane] !== sequence) return;

        // Preserve the live viewport (zoom, pan, window) instead of rebuilding
        // it from the image default. The donor rebuilt it on the single-pane
        // path only, which is why brightness reset every time you scrolled a
        // plain X-ray but not a CT.
        const viewport =
          cornerstone.getViewport(element) ?? cornerstone.getDefaultViewportForImage(element, image);

        const layout = studyRef.current?.layout;
        let verticalFlip = false;
        if (pane !== 'single' && layout && layout.triPlane) {
          verticalFlip = layout.planes[pane]?.verticalFlip ?? false;
        }
        viewport.vflip = verticalFlip;
        applyWindow(viewport, windowLevelRef.current);

        cornerstone.displayImage(element, image, viewport);
        setDecodeError(null);
      } catch (error) {
        if (sequenceRef.current[pane] !== sequence) return;
        setDecodeError(messageOf(error));
      }
    },
    [enableElement],
  );

  /* ---------------- load ---------------- */

  useEffect(() => {
    const current = sourceRef.current;

    setDecodeError(null);
    setErrorText(null);
    setMissingBytes(0);
    setStudy(null);
    studyRef.current = null;
    indicesRef.current = zeroPanes();
    setIndices(indicesRef.current);
    wheelAccumRef.current = zeroPanes();

    if (!current) {
      setPhase('idle');
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    setPhase('loading');
    setStatusText('Starting the imaging engine');

    void (async () => {
      try {
        const runtime = await initDicomRuntime();
        if (cancelled) return;
        runtimeRef.current = runtime;

        let files: readonly File[];
        let failedDownloads = 0;

        if (current.kind === 'local') {
          files = current.files;
        } else {
          const total = countDicomSourceItems(current);
          setStatusText(`Downloading 0 / ${total} instances`);
          const outcome = await downloadStoredInstances(
            current.instances,
            controller.signal,
            (done, count) => {
              if (!cancelled) setStatusText(`Downloading ${done} / ${count} instances`);
            },
          );
          if (cancelled) return;
          files = outcome.files;
          failedDownloads = outcome.failed;
        }

        if (files.length === 0) {
          throw new Error(
            current.kind === 'local'
              ? 'No files to read.'
              : 'None of the stored instances could be downloaded.',
          );
        }

        setStatusText(`Decoding ${files.length} ${files.length === 1 ? 'file' : 'files'}`);
        const parsed = await parseDicomFiles(files, runtime);
        // Parsing already registered every file with the cornerstone file
        // manager, so an abort from here on must hand them back — otherwise
        // StrictMode's double-invoked effect pins two copies of every study.
        if (cancelled) {
          releaseImageIds(runtime, parsed.layout.imageIds);
          return;
        }

        if (parsed.layout.imageIds.length === 0) {
          throw new Error('No readable DICOM images in this selection.');
        }

        // Seed window level from the middle image, where the anatomy is. Doing
        // it before the first paint means the readout is right from frame one.
        const primary = parsed.layout.triPlane
          ? (parsed.layout.planes.axial?.imageIds ??
            parsed.layout.planes.coronal?.imageIds ??
            parsed.layout.planes.sagittal?.imageIds ??
            EMPTY_IDS)
          : parsed.layout.imageIds;

        let seeded: WindowLevel = { center: null, width: null };
        const seedId = primary[initialIndex(primary.length)];
        if (seedId) {
          try {
            const image = await runtime.cornerstone.loadImage(seedId);
            seeded = {
              center: firstWindowValue(image.windowCenter) ?? firstWindowValue(image.voi?.windowCenter),
              width: firstWindowValue(image.windowWidth) ?? firstWindowValue(image.voi?.windowWidth),
            };
          } catch {
            // A failed seed is cosmetic: cornerstone still has the image's own
            // default window, and the readout shows a dash instead of a lie.
          }
        }
        if (cancelled) {
          releaseImageIds(runtime, parsed.layout.imageIds);
          return;
        }

        // Hand back the previous study's files before adopting the new ones.
        releaseImageIds(runtime, ownedImageIdsRef.current);
        ownedImageIdsRef.current = parsed.layout.imageIds;

        const nextIndices = zeroPanes();
        if (parsed.layout.triPlane) {
          for (const candidate of VIEWER_PLANES) {
            const length = parsed.layout.planes[candidate]?.imageIds.length ?? 0;
            nextIndices[candidate] = initialIndex(length);
          }
          const firstPlane = VIEWER_PLANES.find(
            (candidate) => (parsed.layout.planes[candidate]?.imageIds.length ?? 0) > 0,
          );
          setPlane(firstPlane ?? 'axial');
        } else {
          nextIndices.single = initialIndex(parsed.layout.imageIds.length);
        }

        indicesRef.current = nextIndices;
        seedWindowRef.current = seeded;
        windowLevelRef.current = seeded;

        setIndices(nextIndices);
        setWindowLevel(seeded);
        setMissingBytes(failedDownloads);
        studyRef.current = parsed;
        setStudy(parsed);
        setPhase('ready');
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setErrorText(messageOf(error));
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sourceKey, retryTick]);

  /* ---------------- paint on index / study change ---------------- */

  useEffect(() => {
    if (!study) return;
    const panes: PaneKey[] = study.layout.triPlane ? [...VIEWER_PLANES] : ['single'];
    for (const pane of panes) {
      void showSlice(pane);
    }
    // Hidden panes are painted too: switching plane then has nothing to decode,
    // and a cached slice costs nothing to re-display.
  }, [study, indices, showSlice]);

  /* ---------------- window level ---------------- */

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !study) return;

    for (const pane of PANE_KEYS) {
      const element = elementsRef.current[pane];
      if (!element) continue;
      try {
        const viewport = runtime.cornerstone.getViewport(element);
        if (!viewport) continue;
        applyWindow(viewport, windowLevel);
        runtime.cornerstone.setViewport(element, viewport);
      } catch {
        // A pane with no image yet has no viewport. Nothing to do.
      }
    }
  }, [windowLevel, study]);

  /* ---------------- resize ---------------- */

  useEffect(() => {
    const container = canvasAreaRef.current;
    if (!container || !study || typeof ResizeObserver === 'undefined') return;

    const runtime = runtimeRef.current;
    if (!runtime) return;

    const resizeAll = () => {
      const panes: PaneKey[] = study.layout.triPlane ? [...VIEWER_PLANES] : ['single'];
      for (const pane of panes) {
        const element = elementsRef.current[pane];
        if (!element || stacksRef.current[pane].length === 0) continue;
        try {
          runtime.cornerstone.resize(element, true);
        } catch {
          // Not enabled yet; the paint effect will size it.
        }
        void showSlice(pane);
      }
    };

    // Trailing debounce: resizing re-decodes and re-displays up to three panes,
    // so running it per resize event while a panel animates open caused layout
    // thrash and one decode per frame.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        resizeAll();
      }, 120);
    });

    observer.observe(container);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [study, showSlice]);

  /* ---------------- wheel ---------------- */

  useEffect(() => {
    if (!study) return;

    const cleanups: (() => void)[] = [];

    for (const pane of PANE_KEYS) {
      const element = elementsRef.current[pane];
      if (!element) continue;

      // Native, non-passive, on purpose. React attaches its synthetic `wheel`
      // handler passively at the root, so `preventDefault()` inside `onWheel`
      // is silently ignored (the donor's call is a no-op plus a console
      // warning) and the page scrolls away under the pointer while you page
      // through slices.
      const onWheel = (event: WheelEvent) => {
        const total = stacksRef.current[pane].length;
        if (total <= 1) return;
        event.preventDefault();

        const pixels = normalizeWheelDeltaPx(event.deltaY, event.deltaMode, window.innerHeight);
        const { steps, remainderPx } = wheelSteps(wheelAccumRef.current[pane] + pixels);
        wheelAccumRef.current[pane] = remainderPx;
        if (steps !== 0) setPaneIndex(pane, indicesRef.current[pane] + steps);
      };

      element.addEventListener('wheel', onWheel, { passive: false });
      cleanups.push(() => element.removeEventListener('wheel', onWheel));
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [study, setPaneIndex]);

  /* ---------------- slice info out ---------------- */

  useEffect(() => {
    if (!study) return;
    const layout = study.layout;
    sliceInfoRef.current?.({
      triPlane: layout.triPlane,
      singleTotal: layout.triPlane ? undefined : layout.imageIds.length,
      axialTotal: layout.planes.axial?.imageIds.length,
      coronalTotal: layout.planes.coronal?.imageIds.length,
      sagittalTotal: layout.planes.sagittal?.imageIds.length,
    });
  }, [study]);

  /* ---------------- window level by drag ---------------- */

  const dragRef = useRef<{ pointerId: number; x: number; y: number; center: number; width: number } | null>(
    null,
  );

  const handlePointerDown = useCallback(
    (pane: PaneKey) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const runtime = runtimeRef.current;
      const element = elementsRef.current[pane];
      if (!runtime || !element) return;

      let center = windowLevelRef.current.center;
      let width = windowLevelRef.current.width;
      if (center === null || width === null) {
        // Fall back to whatever cornerstone is actually showing, so dragging a
        // study whose header omitted the window values still starts from the
        // image on screen instead of an invented number.
        const viewport = runtime.cornerstone.getViewport(element);
        center = center ?? viewport?.voi?.windowCenter ?? 40;
        width = width ?? viewport?.voi?.windowWidth ?? 400;
      }

      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, center, width };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // The PACS convention: horizontal is contrast, vertical is brightness.
    setWindowLevel({
      width: Math.max(1, drag.width + (event.clientX - drag.x) * 2),
      center: drag.center + (event.clientY - drag.y) * 2,
    });
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer can be gone already (window blur); nothing to release.
    }
  }, []);

  /* ---------------- keyboard ---------------- */

  const handleKeyDown = useCallback(
    (pane: PaneKey) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const total = stacksRef.current[pane].length;
      if (total <= 1) return;
      const current = indicesRef.current[pane];

      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          setPaneIndex(pane, current - 1);
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          setPaneIndex(pane, current + 1);
          break;
        case 'PageUp':
          setPaneIndex(pane, current - 10);
          break;
        case 'PageDown':
          setPaneIndex(pane, current + 10);
          break;
        case 'Home':
          setPaneIndex(pane, 0);
          break;
        case 'End':
          setPaneIndex(pane, total - 1);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [setPaneIndex],
  );

  /* ---------------- reset ---------------- */

  const handleReset = useCallback(() => {
    const runtime = runtimeRef.current;
    setWindowLevel(seedWindowRef.current);
    windowLevelRef.current = seedWindowRef.current;

    if (!runtime) return;
    const element = elementsRef.current[activePane];
    if (element) {
      try {
        runtime.cornerstone.reset(element);
      } catch {
        // Nothing displayed yet.
      }
    }
    void showSlice(activePane);
  }, [activePane, showSlice]);

  /* ---------------- stable ref setters ---------------- */

  const refSetters = useMemo(
    () => ({
      single: (element: HTMLDivElement | null) => {
        elementsRef.current.single = element;
      },
      axial: (element: HTMLDivElement | null) => {
        elementsRef.current.axial = element;
      },
      coronal: (element: HTMLDivElement | null) => {
        elementsRef.current.coronal = element;
      },
      sagittal: (element: HTMLDivElement | null) => {
        elementsRef.current.sagittal = element;
      },
    }),
    [],
  );

  /* ================================================================ */
  /* Render                                                            */
  /* ================================================================ */

  // The shell wins when it supplies a label: it knows the provenance, the
  // derived one only knows the shape of the bytes.
  const sourceLabel = sourceLabelProp ?? describeDicomSource(source);
  const failedDecodes = study?.failedCount ?? 0;
  const panesToRender: PaneKey[] = triPlane ? availablePlanes : ['single'];

  return (
    <div className={`flex h-full min-h-0 w-full flex-col gap-2 ${className ?? ''}`}>
      {/* ---- header: plane toggle + window readout ---- */}
      <header className="flex shrink-0 items-center gap-3">
        {triPlane && availablePlanes.length > 1 ? (
          <div className="tile flex items-center gap-0.5 p-0.5" role="group" aria-label="Imaging plane">
            {availablePlanes.map((candidate) => {
              const on = candidate === effectivePlane;
              return (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPlane(candidate)}
                  className={`rounded-[11px] px-3 py-1 text-2xs font-semibold transition-colors ${
                    on ? 'bg-glass-2 text-ink' : 'text-ink-3 hover:text-ink-2'
                  }`}
                >
                  {PLANE_LABEL[candidate]}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="min-w-0 truncate text-2xs text-ink-3">{sourceLabel}</p>
        )}

        <span className="flex-1" />

        <p className="shrink-0 text-2xs tabular-nums text-ink-3" title="Window width · window center">
          W {formatWindow(windowLevel.width)} · L {formatWindow(windowLevel.center)}
        </p>
        <button
          type="button"
          className="ghostbtn shrink-0 px-2.5 py-1 text-2xs"
          onClick={handleReset}
          disabled={phase !== 'ready'}
        >
          Reset
        </button>
      </header>

      {/* ---- canvas ----
          True black on purpose. The dashboard's rule is "never #000" because a
          projector renders it as dirty grey, but a radiology viewport is the
          one place where the surround has to be black: window level is judged
          against it, and a tinted background shifts how the greys read. */}
      <div
        ref={canvasAreaRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-tile border border-hair bg-black"
      >
        {study
          ? panesToRender.map((pane) => {
              const visible = pane === activePane;
              return (
                <div
                  key={pane}
                  className="absolute inset-0"
                  style={{
                    // `visibility` and not `display`: a hidden pane must keep
                    // its box, or cornerstone measures a 0x0 canvas and the
                    // image comes back stretched when you switch to it.
                    visibility: visible ? 'visible' : 'hidden',
                    pointerEvents: visible ? 'auto' : 'none',
                  }}
                >
                  <div
                    ref={refSetters[pane]}
                    tabIndex={visible ? 0 : -1}
                    role="img"
                    aria-label={`${pane === 'single' ? 'Study' : PLANE_LABEL[pane]} viewport, slice ${
                      clampIndex(indices[pane], stacks[pane].length) + 1
                    } of ${stacks[pane].length}`}
                    className="h-full w-full cursor-crosshair outline-none"
                    onPointerDown={handlePointerDown(pane)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onKeyDown={handleKeyDown(pane)}
                  />
                </div>
              );
            })
          : null}

        {phase === 'idle' ? (
          <div className="absolute inset-0">
            <EmptyState>No study selected. Drop DICOM files or pick a stored study.</EmptyState>
          </div>
        ) : null}

        {phase === 'loading' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span aria-hidden className="relative h-px w-24 overflow-hidden bg-[var(--hair)]">
              <span className="absolute inset-y-0 left-0 w-1/3 animate-pulse bg-[var(--accent)]" />
            </span>
            <p className="text-sm text-ink-2">{statusText}</p>
            <p className="text-2xs text-ink-3">{sourceLabel}</p>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="pill pill-danger">Could not open this study</span>
            <p className="max-w-[42ch] text-2xs leading-snug text-ink-3">{errorText}</p>
            <button type="button" className="ghostbtn" onClick={() => setRetryTick((tick) => tick + 1)}>
              Try again
            </button>
          </div>
        ) : null}

        {phase === 'ready' && decodeError ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
            <span className="pill pill-warn" title={decodeError}>
              This slice could not be decoded
            </span>
          </div>
        ) : null}
      </div>

      {/* ---- footer: slice slider, counter, honesty about dropped files ---- */}
      <footer className="flex shrink-0 items-center gap-3">
        <input
          type="range"
          min={0}
          max={Math.max(0, activeStack.length - 1)}
          value={activeIndex}
          disabled={activeStack.length <= 1}
          onChange={(event) => setPaneIndex(activePane, Number(event.target.value))}
          aria-label="Slice"
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent)] disabled:cursor-default disabled:opacity-40"
        />

        <p className="shrink-0 text-sm font-semibold tabular-nums text-ink-2">
          {activeStack.length === 0 ? '—' : `${activeIndex + 1} / ${activeStack.length}`}
        </p>

        {failedDecodes > 0 ? (
          <span className="pill pill-warn shrink-0" title="These files were skipped, not rendered.">
            {failedDecodes} unreadable
          </span>
        ) : null}

        {missingBytes > 0 ? (
          <span className="pill pill-warn shrink-0" title="Stored instances whose bytes could not be fetched.">
            {missingBytes} missing
          </span>
        ) : null}
      </footer>
    </div>
  );
}

export default DicomViewer;
