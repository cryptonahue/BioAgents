/**
 * Spike: getOperatorList() on LEGACY build of pdfjs-dist@5.4.296.
 *
 * Gates PR #3 (local XObject image extraction path). PR #1 does NOT
 * depend on this; the spike result is informational for PR #1 and
 * is committed to the PR #1 description so the team has a single
 * decision point.
 *
 * Usage:
 *   bun run scripts/spike-pdfjs-xobject.ts <path/to/sample.pdf>
 *
 * Output: JSON to stdout with the shape:
 *   {
 *     "result": "GO" | "NO-GO",
 *     "xobject_count": number,
 *     "transform_usable": boolean,
 *     "filter_usable": boolean,
 *     "bytes_extractable": boolean,
 *     "reason": string
 *   }
 */

import { readFile } from "fs/promises";
import { loadPdfjsLegacy } from "../src/services/files/loaders/pdfjsLegacy";

type SpikeResult = {
  result: "GO" | "NO-GO";
  xobject_count: number;
  transform_usable: boolean;
  filter_usable: boolean;
  bytes_extractable: boolean;
  reason: string;
};

async function runSpike(pdfPath: string): Promise<SpikeResult> {
  const empty: SpikeResult = {
    result: "NO-GO",
    xobject_count: 0,
    transform_usable: false,
    filter_usable: false,
    bytes_extractable: false,
    reason: "spike did not complete",
  };

  let pdfBytes: Uint8Array;
  try {
    const buf = await readFile(pdfPath);
    pdfBytes = new Uint8Array(buf);
  } catch (err) {
    return { ...empty, reason: `failed to read PDF: ${(err as Error).message}` };
  }

  let pdfjs: Awaited<ReturnType<typeof loadPdfjsLegacy>>;
  try {
    pdfjs = await loadPdfjsLegacy();
  } catch (err) {
    return {
      ...empty,
      reason: `pdfjs legacy build failed to load: ${(err as Error).message}`,
    };
  }

  let doc: any;
  try {
    const loadingTask = pdfjs.getDocument({
      data: pdfBytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    return {
      ...empty,
      reason: `getDocument failed: ${(err as Error).message}`,
    };
  }

  let xobjectCount = 0;
  let transformUsable = false;
  let filterUsable = false;
  let bytesExtractable = false;
  const reasons: string[] = [];

  // Try forcing a render pass on page 1 to see if .data materializes.
  // This is a representative check — if page 1 XObjects are NOT
  // extractable after a render, the same is likely true for the rest.
  try {
    const numPages: number = doc.numPages;
    const firstPage = await doc.getPage(1);
    try {
      // Render at 0.1× to a virtual canvas — we don't care about the
      // pixels, just whether the XObjects resolve. canvas-factory via
      // the project's existing polyfill (if available).
      let canvas: any = null;
      try {
        const canvasMod = await import("canvas");
        canvas = canvasMod.createCanvas(100, 100);
      } catch {
        // canvas not loadable; legacy pdfjs can also render to a
        // null canvas factory — not all builds support it.
      }
      const ctx = canvas?.getContext?.("2d");
      if (ctx) {
        await firstPage.render({
          canvasContext: ctx,
          viewport: firstPage.getViewport({ scale: 0.1 }),
        }).promise;
        reasons.push("page 1 render-with-canvas: ok");
      } else {
        // No canvas; legacy build still requires one for render.
        // Walk the OPS without a render pass.
        reasons.push("page 1 render skipped: canvas not available");
      }
    } catch (err) {
      reasons.push(`page 1 render: ${(err as Error).message}`);
    } finally {
      try {
        firstPage.cleanup();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    reasons.push(`render-pass setup failed: ${(err as Error).message}`);
  }

  try {
    const numPages: number = doc.numPages;
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      let page: any;
      try {
        page = await doc.getPage(pageNum);
      } catch (err) {
        reasons.push(`page ${pageNum} getPage failed: ${(err as Error).message}`);
        continue;
      }

      let opList: any;
      try {
        opList = await page.getOperatorList();
      } catch (err) {
        reasons.push(`page ${pageNum} getOperatorList failed: ${(err as Error).message}`);
        try {
          page.cleanup();
        } catch {
          // ignore
        }
        continue;
      }

      const OPS = (pdfjs as any).OPS ?? {};
      const paintImageXObject = OPS.paintImageXObject;
      const paintInlineImageXObject = OPS.paintInlineImageXObject;

      const fnArray: number[] = opList.fnArray || [];
      const argsArray: any[] = opList.argsArray || [];

      for (let i = 0; i < fnArray.length; i++) {
        const op = fnArray[i];
        if (op !== paintImageXObject && op !== paintInlineImageXObject) {
          continue;
        }
        xobjectCount++;

        const args = argsArray[i] || [];
        if (!Array.isArray(args) || args.length < 1) {
          reasons.push(`op ${i} (${op}): missing args`);
          continue;
        }
        const objName = args[0];
        if (typeof objName !== "string") {
          reasons.push(`op ${i}: objName not a string (${typeof objName})`);
        }

        // Probe the objs hash for the XObject. Some pdfjs builds
        // require the XObject to be resolved (via .has() check + render
        // pass) before .get() returns real data. We capture the raw
        // probe result AND the has-check signal — both are useful for
        // the GO/NO-GO verdict.
        let xobj: any = null;
        let hasXobj = false;
        try {
          if (page.objs) {
            // .has() reports whether the key is registered.
            if (typeof page.objs.has === "function") {
              hasXobj = page.objs.has(objName);
            }
            if (typeof page.objs.get === "function") {
              xobj = page.objs.get(objName);
            }
          }
        } catch (err) {
          // Expected on unresolved XObjects ("...isn't resolved yet").
          // Treat as `xobj = null` and report in reasons.
          reasons.push(`page.objs.get(${objName}) threw: ${(err as Error).message}`);
        }

        if (xobj) {
          // Transform: legacy pdfjs stores the paint transform on the
          // OPS args (args[1] for paintImageXObject, typically a
          // 6-element matrix [a,b,c,d,e,f]). Probe args first, then
          // the xobj dict as a fallback.
          if (Array.isArray(args[1]) && args[1].length === 6) {
            transformUsable = true;
          } else if (Array.isArray(xobj.transform) && xobj.transform.length === 6) {
            transformUsable = true;
          }
          // Filter chain: pdfjs exposes `filter` (string) or
          // `dict.get('Filter')` depending on build.
          if (typeof xobj.filter === "string" || Array.isArray(xobj.filter)) {
            filterUsable = true;
          }
          // Bytes: pdfjs stores the raw stream in `data` (Uint8Array).
          // `.dataLen` is the length companion. `bitmap` is the
          // already-rendered ImageData fallback.
          if (xobj.data instanceof Uint8Array && xobj.data.length > 0) {
            bytesExtractable = true;
          } else if (typeof xobj.dataLen === "number" && xobj.dataLen > 0) {
            // .dataLen populated but .data not — partially resolved.
            // NOT extractable without a render pass; report.
            reasons.push(
              `xobj ${objName}: dataLen=${xobj.dataLen} but .data not yet a Uint8Array`,
            );
          } else if (xobj.bitmap) {
            reasons.push(
              `xobj ${objName}: only bitmap available (canvas-reencode fallback required)`,
            );
          } else {
            reasons.push(
              `xobj ${objName}: no extractable bytes (keys: ${Object.keys(xobj).join(",")})`,
            );
          }
        } else if (!hasXobj) {
          reasons.push(`op ${i}: xobj not registered in page.objs`);
        } else {
          // hasXobj=true but get() returned null — the XObject is
          // registered but not yet resolved. Treat as a positive
          // "could be resolved on demand" signal for PR #3.
          if (!bytesExtractable) {
            reasons.push(
              `op ${i}: xobj ${objName} registered but unresolved (needs render pass)`,
            );
          }
        }
      }

      try {
        page.cleanup();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    reasons.push(`walk failed: ${(err as Error).message}`);
  } finally {
    try {
      await doc.destroy();
    } catch {
      // ignore
    }
  }

  const go =
    xobjectCount > 0 && transformUsable && filterUsable && bytesExtractable;
  return {
    result: go ? "GO" : "NO-GO",
    xobject_count: xobjectCount,
    transform_usable: transformUsable,
    filter_usable: filterUsable,
    bytes_extractable: bytesExtractable,
    reason: go
      ? `walked ${xobjectCount} image operators with usable transform, filter, and bytes`
      : reasons.length > 0
        ? reasons.slice(0, 3).join("; ")
        : "no image XObject operators found on any page",
  };
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error("Usage: bun run scripts/spike-pdfjs-xobject.ts <path/to/sample.pdf>");
    process.exit(2);
  }

  const result = await runSpike(pdfPath);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.result === "GO" ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({
    result: "NO-GO",
    xobject_count: 0,
    transform_usable: false,
    filter_usable: false,
    bytes_extractable: false,
    reason: `spike threw: ${(err as Error).message}`,
  }, null, 2));
  process.exit(1);
});
