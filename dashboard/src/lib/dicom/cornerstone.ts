/**
 * Cornerstone bootstrap — browser only.
 *
 * ENGLISH ON PURPOSE, like the rest of `lib/dicom/`. See `types.ts`.
 *
 * Three untyped/UMD packages have to be wired together before a single pixel
 * can be decoded:
 *
 *   - `cornerstone-core`             the renderer (canvas + viewport state)
 *   - `cornerstone-wado-image-loader` the `dicomfile:` / `wadouri:` image loader
 *   - `dicom-parser`                  the tag parser both of them lean on
 *
 * Everything here touches `window`, so this module must never be imported by a
 * server component. `DicomViewer.tsx` is the only importer and it is mounted
 * with `dynamic(..., { ssr: false })`. `initDicomRuntime()` still guards on
 * `typeof window` and rejects with a readable message rather than throwing a
 * `ReferenceError` deep inside a vendored bundle.
 *
 * ------------------------------------------------------------------------
 * NO NETWORK — not at runtime, not at build time
 * ------------------------------------------------------------------------
 * The donor project initialized the loader's web workers from unpkg.com:
 *
 *     webWorkerPath: 'https://unpkg.com/cornerstone-wado-image-loader@.../...'
 *     taskConfiguration: { decodeTask: { codecsPath: 'https://unpkg.com/...' } }
 *
 * That is banned here. This dashboard is projected in front of judges over
 * hackathon wifi that may not exist, and the repo rule is zero external assets.
 * So `webWorkerManager.initialize()` is never called and no path is ever
 * configured — see `bootstrap()` below for what the loader does instead.
 *
 * If decode ever becomes the bottleneck (heavy JPEG2000 studies are the case
 * that would trigger it — plain uncompressed CT/MR is fine), the ONLY
 * acceptable fix is a same-origin path: a prebuild script that copies
 * `node_modules/cornerstone-wado-image-loader/dist/*.worker.js` and the codec
 * bundle into `dashboard/public/cornerstone/`, then
 * `webWorkerPath: '/cornerstone/...'`. Never a URL with a host in it.
 */

import type { DataSet } from 'dicom-parser';

/* ================================================================== */
/* Minimal structural types for the untyped packages                   */
/* ================================================================== */

/**
 * These are hand-written on purpose. `cornerstone-core@2.6.1` and
 * `cornerstone-wado-image-loader@4.13.2` ship no `.d.ts` and there is no
 * `@types/*` for either, so the alternative is `any` leaking through the whole
 * viewer. Only the members actually used are declared — a narrow surface is
 * also documentation of how much of cornerstone this feature depends on.
 */

/** Value-of-interest: brightness (`windowCenter`) and contrast (`windowWidth`). */
export interface CornerstoneVoi {
  windowWidth?: number;
  windowCenter?: number;
}

export interface CornerstoneViewport {
  voi?: CornerstoneVoi;
  /** Vertical flip. Coronal and sagittal stacks usually need it. */
  vflip?: boolean;
  hflip?: boolean;
  scale?: number;
  invert?: boolean;
}

export interface CornerstoneImage {
  imageId: string;
  /** May be a single value or a multi-valued DICOM element. */
  windowCenter?: number | number[];
  windowWidth?: number | number[];
  voi?: CornerstoneVoi;
  rows?: number;
  columns?: number;
}

export interface CornerstoneEnabledElement {
  element?: HTMLElement;
}

export interface CornerstoneImageCache {
  setMaximumSizeBytes(bytes: number): void;
  purgeCache(): void;
}

export interface CornerstoneApi {
  enable(element: HTMLElement): void;
  disable(element: HTMLElement): void;
  getEnabledElements(): CornerstoneEnabledElement[];
  loadImage(imageId: string): Promise<CornerstoneImage>;
  displayImage(element: HTMLElement, image: CornerstoneImage, viewport?: CornerstoneViewport): void;
  getViewport(element: HTMLElement): CornerstoneViewport | undefined;
  setViewport(element: HTMLElement, viewport: CornerstoneViewport): void;
  getDefaultViewportForImage(element: HTMLElement, image: CornerstoneImage): CornerstoneViewport;
  resize(element: HTMLElement, forcedResize?: boolean): void;
  reset(element: HTMLElement): void;
  imageCache: CornerstoneImageCache;
}

/**
 * `wadouri.fileManager`.
 *
 * `add(file)` pushes the `File` into a module-level array and returns
 * `dicomfile:<index>`. Note the asymmetry, verified against the shipped bundle:
 * `remove()` and `get()` take the numeric INDEX, not the image id. Passing the
 * string would silently write a junk key on the array and leak the `File`
 * forever, which is why `releaseImageIds()` in `parse.ts` parses the index out.
 */
export interface WadoFileManager {
  add(file: File): string;
  get?(index: number): File | undefined;
  remove?(index: number): void;
  purge?(): void;
}

/** Everything the viewer and the parser need, resolved once. */
export interface DicomRuntime {
  cornerstone: CornerstoneApi;
  fileManager: WadoFileManager;
  /** `dicomParser.parseDicom`, pre-bound so callers never import the package. */
  parseDicom(bytes: Uint8Array): DataSet;
}

/* ================================================================== */
/* Bootstrap                                                           */
/* ================================================================== */

/**
 * Decoded-image cache ceiling. A 300-slice CT is comfortably over a gigabyte
 * decoded; without a cap, opening three studies in one demo session grows the
 * heap until the tab dies. 256 MB still holds a whole series comfortably.
 */
export const IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Shape of the WADO loader module, as far as we use it. */
interface WadoImageLoaderModule {
  external?: {
    cornerstone?: unknown;
    dicomParser?: unknown;
  };
  wadouri?: {
    fileManager?: WadoFileManager;
  };
}

interface DicomParserModule {
  parseDicom(bytes: Uint8Array): DataSet;
}

/** CommonJS/UMD interop: some bundlers hand back `{ default: mod }`, some don't. */
function unwrapDefault(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && 'default' in mod) {
    const inner = (mod as { default?: unknown }).default;
    if (inner) return inner;
  }
  return mod;
}

/**
 * One-shot, shared across every caller.
 *
 * React 19 StrictMode runs effects twice and the viewer can be mounted more
 * than once, so this MUST be idempotent: everyone awaits the same promise and
 * the loaders get registered exactly once. On failure the slot is cleared so a
 * retry is possible — a transient chunk-load error should not poison the page
 * for the rest of the session.
 */
let ready: Promise<DicomRuntime> | null = null;

export function initDicomRuntime(): Promise<DicomRuntime> {
  if (typeof window === 'undefined') {
    return Promise.reject(
      new Error('The DICOM runtime is browser-only. Mount the viewer with dynamic(..., { ssr: false }).'),
    );
  }

  if (!ready) {
    ready = bootstrap().catch((error: unknown) => {
      ready = null;
      throw error;
    });
  }

  return ready;
}

async function bootstrap(): Promise<DicomRuntime> {
  // The imports are dynamic (and inside the promise, not at module scope) so
  // the ~1.4 MB decoder bundle never enters the first render graph and never
  // reaches the server build.
  //
  // Neither cornerstone package ships type declarations. They are declared as
  // `unknown` in `src/types/cornerstone.d.ts` rather than suppressed with
  // `@ts-ignore`, so nothing here is silenced — every value taken out of these
  // modules is narrowed through the interfaces above and runtime-checked below.
  const [coreModule, wadoModule, parserModule] = await Promise.all([
    import('cornerstone-core') as Promise<unknown>,
    import('cornerstone-wado-image-loader') as Promise<unknown>,
    import('dicom-parser') as Promise<unknown>,
  ]);

  const cornerstone = unwrapDefault(coreModule) as CornerstoneApi;
  const wado = unwrapDefault(wadoModule) as WadoImageLoaderModule;
  const dicomParser = unwrapDefault(parserModule) as DicomParserModule;

  if (typeof cornerstone?.enable !== 'function') {
    throw new Error('cornerstone-core loaded but looks wrong (no enable()).');
  }
  if (typeof dicomParser?.parseDicom !== 'function') {
    throw new Error('dicom-parser loaded but looks wrong (no parseDicom()).');
  }

  // The loader is UMD and reads `window.cornerstone` as a last resort, so the
  // global goes up first. `||=` semantics on purpose: if something else on the
  // page already published a cornerstone, we do not stomp it.
  const globals = window as unknown as { cornerstone?: unknown };
  if (!globals.cornerstone) globals.cornerstone = cornerstone;

  if (!wado.external) {
    throw new Error('cornerstone-wado-image-loader loaded without its `external` bridge.');
  }

  // ORDER MATTERS. Setting `external.cornerstone` is not a plain assignment:
  // the setter calls registerLoaders(), which is what makes `dicomfile:` and
  // `wadouri:` resolvable. The parser must already be in place when that runs.
  //
  // The donor unwrapped `.default` for the parser at the parse call site but
  // NOT here, which meant the loader could be handed a module namespace object
  // instead of the parser. Unwrapped in both places here.
  wado.external.dicomParser = dicomParser;
  wado.external.cornerstone = cornerstone;

  // --- decode path: no workers configured, no host ever contacted ----------
  //
  // `webWorkerManager.initialize()` is deliberately NOT called. That is the
  // whole donor block, deleted: no `webWorkerPath`, no `codecsPath`, no CDN.
  //
  // What v4.13.2 actually does without it (verified against the shipped
  // bundle): the decode task falls back to the loader's own inlined worker
  // source, instantiated from a Blob URL — self-contained, same document, no
  // fetch to any origin. Uncompressed CT/MR, which is what STOW round-trips
  // here, decodes fine this way.
  //
  // The point of the rule is satisfied either way: nothing in this code path
  // can 404 because the wifi died. See the header for the same-origin escape
  // hatch if compressed transfer syntaxes ever need real worker tuning.

  cornerstone.imageCache?.setMaximumSizeBytes?.(IMAGE_CACHE_MAX_BYTES);

  const fileManager = wado.wadouri?.fileManager;
  if (!fileManager || typeof fileManager.add !== 'function') {
    throw new Error('cornerstone-wado-image-loader has no wadouri.fileManager — cannot read local files.');
  }

  return {
    cornerstone,
    fileManager,
    parseDicom: (bytes: Uint8Array) => dicomParser.parseDicom(bytes),
  };
}

/* ================================================================== */
/* Window level helpers                                                */
/* ================================================================== */

/**
 * DICOM allows multi-valued window center/width (one pair per VOI LUT). The
 * first pair is the one the modality intended as default, so that is what is
 * shown; the rest would need a LUT picker this screen does not have.
 */
export function firstWindowValue(value: number | number[] | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const first = value.find((candidate) => Number.isFinite(candidate));
    return first === undefined ? null : first;
  }
  return null;
}
