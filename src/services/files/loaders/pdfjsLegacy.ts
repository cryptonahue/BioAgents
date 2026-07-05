/**
 * Lazy loader for `pdfjs-dist@5` legacy build.
 *
 * Why this file exists:
 *   The legacy build of pdfjs-dist runs in pure JS with no canvas
 *   and no web worker. It is the only build that works in this Bun
 *   environment (the standard build requires a `canvas` native
 *   binding for font rendering, which is not loadable here).
 *
 * Why it's a separate file:
 *   Module-load time. Importing `pdfjs-dist/legacy/build/pdf.mjs` at
 *   the top of `pdfTableExtractor.ts` would block module init on a
 *   ~2MB JS parse. The loader pattern keeps the parser-side path
 *   (cache check, persistence) cheap. Bun-specific TDZ avoidance
 *   (see CLAUDE.md) is also easier to reason about in a single
 *   thin module.
 *
 * Why we don't import the canvas-polyfill:
 *   Text extraction via `getTextContent` does not touch canvas APIs.
 *   The polyfill is still imported at the top of `src/index.ts`
 *   and `src/worker.ts` for the other code paths that need it.
 */

const PDFJS_KEY = "__bioprospectingPdfjsLegacy";

export type PdfjsLegacyModule =
  typeof import("pdfjs-dist/legacy/build/pdf.mjs");

export async function loadPdfjsLegacy(): Promise<PdfjsLegacyModule> {
  const cached = (globalThis as any)[PDFJS_KEY] as
    | PdfjsLegacyModule
    | undefined;
  if (cached) return cached;
  const mod = (await import(
    /* @vite-ignore */ "pdfjs-dist/legacy/build/pdf.mjs"
  )) as PdfjsLegacyModule;
  (globalThis as any)[PDFJS_KEY] = mod;
  return mod;
}
