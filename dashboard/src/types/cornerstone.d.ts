/**
 * Module declarations for the two cornerstone packages that ship no types.
 *
 * `cornerstone-core@2.6.1` and `cornerstone-wado-image-loader@4.13.2` have no
 * bundled `.d.ts` and no `@types/*` package on npm, so importing them raises
 * TS7016 under `strict`. These declarations replace the two `@ts-ignore`s that
 * used to sit on the dynamic imports in `src/lib/dicom/cornerstone.ts`.
 *
 * WHY `unknown` AND NOT `any`:
 *
 * The donor project's shim was a bare `declare module 'cornerstone-core';`,
 * which types the module as `any` and silently disables checking on every value
 * pulled out of it. That is worse than the `@ts-ignore` it replaces, because it
 * spreads: one `any` at the import leaks into every downstream expression.
 *
 * `unknown` says the honest thing — the module exists, its shape is not
 * described here — and forces the narrowing to stay where it already is.
 * `cornerstone.ts` declares its own `CornerstoneApi` / `WadoImageLoaderModule`
 * interfaces, casts to them once, and then *runtime-checks* the members it
 * depends on (`enable()`, `external`, `wadouri.fileManager`) before use. Those
 * checks are the real contract; keeping this file at `unknown` is what stops
 * someone from accidentally bypassing them.
 *
 * DELIBERATELY NOT DECLARED HERE: `dicom-parser`. That package DOES ship its own
 * `index.d.ts`, and `cornerstone.ts` / `parse.ts` both `import type { DataSet }`
 * from it. Adding a `declare module 'dicom-parser'` here would shadow the real
 * declarations and turn `DataSet` into `any`.
 */

declare module 'cornerstone-core' {
  const cornerstoneCore: unknown;
  export default cornerstoneCore;
}

declare module 'cornerstone-wado-image-loader' {
  const cornerstoneWadoImageLoader: unknown;
  export default cornerstoneWadoImageLoader;
}
