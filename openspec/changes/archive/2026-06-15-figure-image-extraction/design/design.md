# Design: figure-image-extraction

## Technical Approach

Two-track v1 pipeline (`Mistral` raster + `render-crop` vector) wired
into the existing `extractPDFTables` orchestrator as a new
**standalone pass** after `persistExtractedFigures` writes the
bbox rows. Image bytes flow into S3 at
`figures/{sourceId}/{figureIndex}.{format}`; an auth-gated proxy
route streams them back to the viewer with the same 50 MB cap as the
PDF proxy. The lightbox gains a conditional `<img>` header, an
"Open image" / "Download" button pair, and a green/purple bbox
color split. v1 is gated on a 5–10 min spike that decides whether
`@napi-rs/canvas` (or its project-equivalent) is loadable in Bun;
fallback is `Bun.spawn(['pdftoppm', ...])` from `poppler-utils`.

This implements specs `figure-image-extraction/spec.md`,
`pdf-provenance-viewer/spec.md`, and `pdf-table-extraction/spec.md`
under the PR split called out in the proposal (`#1` backend ~350 LOC,
`#2` frontend ~200 LOC, `#3` local XObject ~250 LOC, the last
gated on the spike).

## Architecture Decisions

### Decision: Render-crop uses the project's `canvas` package, not `@napi-rs/canvas`

**Choice**: Reuse the `canvas@3.2.0` dep already in
`package.json:52`. The proposal/spec refer to `@napi-rs/canvas`,
but the project has standardized on `node-canvas` (see
`src/utils/canvas-polyfill.ts:51` — `await import("canvas")`). The
polyfill already installs `DOMMatrix` and `ImageData` on
`globalThis` when `canvas` loads.

**Alternatives considered**: Add `@napi-rs/canvas` as a new dep
(pinned version conflict with the existing `canvas`); fall back to
`pdftoppm` for v1 (defeats the purpose — the whole point of the
spike is to test a *fast* in-process path).

**Rationale**: The spike's job is to confirm that
`await import("canvas")` succeeds in Bun (which it does — see
`localPdfTableProvider.spike.test.ts:67` which already exercises
the same load path) AND that pdfjs-dist's `page.render(...)`
completes against a `canvas.Canvas` instance. If the spike passes,
`renderCrop.ts` uses the existing `canvas` package. If it fails,
we fall through to `Bun.spawn(['pdftoppm', ...])` in the same
helper (no caller changes).

### Decision: Render scale is fixed at 1.5×, matching the viewer

**Choice**: Hardcode the 1.5× scale in `renderCroppedFigure`. Same
constant as `EvidenceViewer.tsx:23` (`PDFJS_RENDER_SCALE`) and the
local provider's bbox math. The bbox is multiplied by 1.5 to land
in canvas pixel space; this is the same math the viewer uses to
display the PDF, so the rendered crop is pixel-aligned to the
on-screen highlight.

**Alternatives considered**: 2× (sharper, ~78% more bytes); 1.0×
(loses detail); per-figure dynamic scale (over-engineering for
v1).

**Rationale**: 1.5× is the project-wide constant for "what the
user sees in the lightbox". Aligning the crop with the displayed
page is the highest-value property — if the crop and the on-screen
PDF look identical at the same zoom, the user trusts the citation.
Sharpness at higher scales is a future v2 concern.

### Decision: PNG only for v1; JPEG is in the signature but unused

**Choice**: `renderCroppedFigure` accepts `format: 'png' | 'jpeg'`
but the orchestrator always passes `'png'`. PNG is lossless and
smaller for the dominant line-art case (chemical structures,
diagrams). Microscopy is rare enough in the bioprospecting corpus
that JPEG savings don't justify the format-juggling cost.

**Alternatives considered**: Auto-pick by image entropy (run a
quick Shannon-entropy estimator on the RGB pixels; PNG if low
entropy, JPEG if high). Per-figure `format` decision tree.

**Rationale**: The orchestrator decides; v1 has one path. The
signature stays open so a v2 auto-picker can drop in without
breaking the proxy or the schema.

### Decision: Multi-page figures are bbox-only, silently

**Choice**: When Mistral returns images whose `bbox` spans two
pages (rare; happens with some journal layouts), the
`figureImageExtractor` writes two separate figure rows (one per
page) at the table-extraction step, and each gets its own image
crop. No special multi-page stitching in v1.

**Rationale**: The detection is "one figure per page, one bbox
per figure" — same shape as the table pass. The multi-page
limitation is documented in
`figure-image-extraction/spec.md:709-721` and rolled forward as
known v1 debt.

### Decision: Idempotency is write-once, not overwrite

**Choice**: The orchestrator's per-figure UPDATE only fires when
`storage_path IS NULL` (the bbox-only case from a prior run).
A re-extraction that finds `storage_path` already populated skips
the S3 write and the column write — the existing S3 object is
untouched.

**Rationale**: Matches the existing figure-row cache contract in
`pdfTableExtractor.ts:481-507` and `pdf-table-extraction/spec.md`
(Idempotent Extraction). The S3 layout's overwrite decision is
the **storage layer's** default (same key → same object), not a
data-correctness decision; it only matters for the forced
re-extraction path, which deletes the figure row first (the same
admin escape hatch the spec preserves for tables).

### Decision: Per-image-byte cost tracking reuses `mistral_ocr` provider

**Choice**: The orchestrator's per-source
`costService.recordApiCall` uses
`provider: "mistral_ocr"` (the existing `ApiProvider` union is
`"mistral_ocr" | "pubchem"` per `costService.ts:36`; adding a
third value would touch the type, the RPC, and the cap math).
`costUsd: 0` and `units: totalImageBytes`. The metadata block
carries `kind: 'figure_image_bytes'`, `image_count`, and
`image_bytes_total` so the dashboard can slice the informational
view.

**Rationale**: The 30-day review is observational — no new cap
applies. Reusing the existing provider keeps the RPC contract
unchanged; the metadata block is the only way the cost dashboard
will surface "this was an image-byte observation, not a charge".

### Decision: Image proxy uses `authResolver({ required: true })` + 50 MB cap

**Choice**: New `GET /api/research-brain/figures/:figureId/image`
uses the same auth + size-cap pattern as
`/sources/:sourceId/pdf` (`research-brain.ts:1122-1221`): auth
required, 50 MB cap, 502 on storage unconfigured, 404 on
`storage_path IS NULL` or S3 miss.

**Rationale**: Same threat model as the PDF proxy (private bucket,
no presigned URLs, no client-side S3 access). 50 MB matches the
PDF cap — figures won't exceed it in practice (a 4500×4500 RGBA
crop is 81 MB at 1.5×, but typical figure crops at 1.5× are
under 200 KB). The cap is a defense-in-depth ceiling, not a
realistic limit.

### Decision: Frontend color split uses a CSS class on the bbox

**Choice**: `BboxOverlay` reads `imageUrl` (passed via a new
optional `imageUrl` prop) and toggles between
`provenance-bbox--figure-with-image` (green/emerald-500) and
`provenance-bbox--figure` (purple/a855f7, current). A
`data-provenance-figure-status="with-image|bbox-only"` attribute
ships for E2E selectors.

**Rationale**: CSS-class split is the smallest change to
`BboxOverlay.tsx` (it's currently a pure div renderer; see
`BboxOverlay.tsx:24-28` for the existing `TYPE_CLASS` map). No
state management, no conditional JSX, no new component.

## Data Flow

```
                                  ┌─────────────────────────────┐
                                  │ extractPDFTables            │
                                  │  (orchestrator)             │
                                  └─────┬───────────────────────┘
                                        │
        1. local.extract → tables (with chain merge)
        2. persistExtractedTables  (write tables)
        3. mistral.extractFigures → figures (Mistral path)
        4. persistExtractedFigures (write figure bbox rows)
                                        │
                                        ▼
                       ┌──────────────────────────────────┐
                       │ figureImageExtractor             │
                       │  .extractFigureImages            │
                       │  (NEW — separate pass)           │
                       └─────┬────────────────────────────┘
                             │
                             ▼
            ┌────────────────────────────────────────┐
            │ for each figure row R:                 │
            │  1. if storage_path IS NOT NULL → skip │
            │  2. try mistral path (parse            │
            │     response.pages[i].images[j]        │
            │     .image_base64)                     │
            │     → decode b64 → bytes               │
            │  3. else try render-crop path          │
            │     → renderCroppedFigure(             │
            │         pdf, page, bbox, 'png'         │
            │       ) → bytes                       │
            │  4. uploadFigure(                      │
            │       getFigureStoragePath(S, i, png), │
            │       bytes, 'image/png'               │
            │     )                                  │
            │  5. UPDATE research_evidence_figures   │
            │     SET storage_path, mime_type,       │
            │         width, height, byte_size      │
            │     WHERE id = R.id                    │
            │  6. accumulate bytes per source        │
            │ 7. recordApiCall({                     │
            │      provider: 'mistral_ocr',          │
            │      units: totalBytes,                │
            │      costUsd: 0,                       │
            │      metadata: { kind: 'figure_image_bytes' }
            │    })                                  │
            └────────────────┬───────────────────────┘
                             │
                             ▼
                ┌────────────────────────────────────┐
                │ storage/figureStorage.ts           │
                │   getFigureStoragePath (pure)      │
                │   uploadFigure (S3 PutObject)      │
                │   downloadFigure (S3 GetObject)     │
                │   + FigureNotFoundError (typed)    │
                └────────────────┬───────────────────┘
                                 │
                ┌────────────────┴───────────────────┐
                │                                    │
                ▼                                    ▼
   ┌────────────────────────┐         ┌──────────────────────────┐
   │ GET /sources/:id/      │         │ GET /figures/:id/image   │
   │   evidence (existing)  │         │  authResolver(req=true)  │
   │  → imageUrl?/width?/  │         │   max 50 MB              │
   │    height?/mimeType?   │         │   404 on storage_path=NUL│
   └────────────┬───────────┘         │   502 on storage unset   │
                │                     │   413 on > 50 MB         │
                ▼                     └─────────┬────────────────┘
   ┌────────────────────────┐                   │
   │ EvidenceLightbox       │◀──────────────────┘
   │  + <img src={imageUrl} │
   │     width={w} height={h}│
   │     role="img"          │
   │     aria-label={caption}│
   │  + "Open image" /      │
   │    "Download" buttons   │
   │  + BboxOverlay class:   │
   │    emerald-500 (with)   │
   │    purple-500 (bbox-only)│
   └────────────────────────┘
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `supabase/migrations/20260615020000_add_figure_image_columns.sql` | Create | 5 nullable columns on `research_evidence_figures` (storage_path, mime_type, width, height, byte_size) |
| `src/storage/figureStorage.ts` | Create | `getFigureStoragePath` (pure), `uploadFigure`, `downloadFigure`, `FigureNotFoundError`. Reuses `getStorageProvider()` from `src/storage/index.ts:51`. No new S3 client. |
| `src/services/files/renderCrop.ts` | Create | `renderCroppedFigure(pdf, page, bbox, format)` — try `canvas.Canvas` first, fall back to `Bun.spawn(['pdftoppm', ...])`. Returns `{ bytes, width, height, format }`. Throws `FigureRenderCropError({ page, reason })` on hard failure. |
| `src/services/files/figureImageExtractor.ts` | Create | `extractFigureImages(sourceId, pdf, ctx)` orchestrator. Reads persisted figure rows, dispatches Mistral vs render-crop, calls `uploadFigure`, UPDATEs the row, accumulates bytes, calls `recordApiCall` once per source. |
| `src/services/files/figureImageExtractor.errors.ts` | Create | Typed errors: `FigureRenderCropError`, `FigureNotFoundError` (re-exported from `figureStorage`). |
| `src/services/files/pdfTableExtractor.ts` | Modify | After `persistExtractedFigures`, call `figureImageExtractor.extractFigureImages(...)` in a try/catch. On failure: log WARN, return table result. Add 5 fields to `ResearchEvidenceFigureRow` type. Add 5 fields to `ExtractedFigure` type (additive, all `null` default). Update `rowToExtractedFigure` to pass the new fields. |
| `src/services/files/providers/mistralOcrProvider.ts` | Modify | Flip `include_image_base64: true` (gated by `MISTRAL_OCR_INCLUDE_IMAGE_BASE64` env var, default `true`). Extend `MistralResponsePage.images[].image_base64` to the type. Decode both standard and URL-safe b64. Surface `image_bytes_total` and `image_count` in `recordApiCall` metadata. Thread the decoded bytes into a new optional `figureImageBytes` field on `ExtractedFigure`. |
| `src/services/files/providers/localPdfTableProvider.ts` | Modify (PR #3 only) | Add `extractImages()` XObject walk if the spike returns GO. |
| `src/services/researchBrain/costService.ts` | Modify | None for the spec — `metadata` already accepts arbitrary `Record<string, unknown>` (`costService.ts:46`). The change is just a new `metadata.kind = 'figure_image_bytes'` consumer. |
| `src/routes/research-brain.ts` | Modify | Extend `figures` map in `/sources/:id/evidence` to emit `imageUrl?/width?/height?/mimeType?` when `storage_path` is non-null. Add `GET /figures/:figureId/image` route (~90 LOC). |
| `client/src/hooks/useProvenance.ts` | Modify | Add `imageUrl?: string`, `width?: number`, `height?: number`, `mimeType?: string` to `ProvenanceFigure`. |
| `client/src/components/EvidenceLightbox.tsx` | Modify | Render `<img>` header before the PDF viewer when `imageUrl` is present. Render "Open image" / "Download" buttons. Show `Figure {N} (page {P})` text in the header. |
| `client/src/components/BboxOverlay.tsx` | Modify | Read new `imageUrl` prop. Switch `provenance-bbox--figure` (purple) ↔ `provenance-bbox--figure-with-image` (emerald) class. Add `data-provenance-figure-status` attribute. |
| `client/src/hooks/useProvenance.ts` (export) | Modify | `ProvenanceFigure` adds 4 optional fields. |
| `scripts/spike-pdfjs-xobject.ts` | Create (PR #1) | 5-10 min spike. Walks `getOperatorList()` on LEGACY `pdfjs-dist@5.4.296`; prints JSON `{ result, xobject_count, transform_usable, filter_usable, bytes_extractable, reason }`. |
| `src/services/files/__tests__/renderCrop.test.ts` | Create (PR #1) | Unit tests for the pure helpers (bbox math, format selection, error path). |
| `src/services/files/__tests__/figureImageExtractor.test.ts` | Create (PR #1) | Orchestrator tests: Mistral-first dispatch, render-crop fallback, per-figure independence, S3 failure isolation, cost tracking. |
| `client/src/components/__tests__/BboxOverlay.figure.test.tsx` | Create (PR #2) | Snapshot test: green/purple split based on `imageUrl`. |
| `client/src/components/__tests__/EvidenceLightbox.figure.test.tsx` | Create (PR #2) | Snapshot test: image header + buttons render iff `imageUrl` present. |

## Interfaces / Contracts

```typescript
// src/storage/figureStorage.ts
export class FigureNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`S3 object not found: ${key}`);
    this.name = "FigureNotFoundError";
  }
}

export function getFigureStoragePath(
  sourceId: string,
  figureIndex: number,
  format: "png" | "jpeg",
): string; // → "figures/{sourceId}/{figureIndex}.{format}"

export async function uploadFigure(
  key: string,
  bytes: Uint8Array,
  mimeType: "image/png" | "image/jpeg",
): Promise<{ byteSize: number }>;

export async function downloadFigure(key: string): Promise<Uint8Array>;
// throws FigureNotFoundError on S3 404

// src/services/files/figureImageExtractor.ts
export interface ExtractedFigureImage {
  page: number;            // 1-indexed
  figureIndex: number;     // 0-based on page
  bbox: BBox;
  bytes: Uint8Array | null;
  format: "png" | "jpeg" | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  origin: "mistral" | "render-crop" | null;
}

export async function extractFigureImages(
  sourceId: string,
  pdf: Uint8Array,
  ctx: { runId?: string; jobId?: string },
): Promise<ExtractedFigureImage[]>;

// src/services/files/renderCrop.ts
export class FigureRenderCropError extends Error {
  constructor(public readonly page: number, public readonly reason: string) {
    super(`render-crop failed on page ${page}: ${reason}`);
    this.name = "FigureRenderCropError";
  }
}

export async function renderCroppedFigure(
  pdf: Uint8Array,
  page: number,
  bbox: BBox,
  format: "png" | "jpeg", // v1 always "png" at the call site
): Promise<{ bytes: Uint8Array; width: number; height: number; format: "png" | "jpeg" }>;
```

Schema delta:

```sql
-- 20260615020000_add_figure_image_columns.sql
ALTER TABLE public.research_evidence_figures
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS mime_type    TEXT,
  ADD COLUMN IF NOT EXISTS width        INT,
  ADD COLUMN IF NOT EXISTS height       INT,
  ADD COLUMN IF NOT EXISTS byte_size    BIGINT;

COMMENT ON COLUMN public.research_evidence_figures.storage_path IS
  'S3 object key: figures/{sourceId}/{figureIndex}.{format}. NULL = bbox-only (no image extracted).';
COMMENT ON COLUMN public.research_evidence_figures.mime_type IS
  'IANA MIME type for the extracted image (image/png or image/jpeg). Drives proxy Content-Type.';
COMMENT ON COLUMN public.research_evidence_figures.width IS
  'Pixel width of the encoded image (PNG width tag).';
COMMENT ON COLUMN public.research_evidence_figures.height IS
  'Pixel height of the encoded image (PNG height tag).';
COMMENT ON COLUMN public.research_evidence_figures.byte_size IS
  'Total bytes of the encoded image (=length(storage_path) on S3, written by the extractor).';
```

API contract (new route):

```http
GET /api/research-brain/figures/{figureId}/image
Authorization: <user JWT or session>

200 OK
Content-Type: image/png | image/jpeg
Content-Length: <byte_size>
Content-Disposition: inline; filename="figure-{figureIndex}.{ext}"
Cache-Control: private, max-age=300

401 Unauthorized       no/invalid auth
404 Not Found          storage_path IS NULL OR S3 404
413 Payload Too Large  byte_size > 50 MB
502 Bad Gateway        storage provider unconfigured
```

API contract (extended `/evidence`):

```jsonc
{
  "figures": [
    {
      "id": "uuid",
      "page": 2,
      "figureIndex": 0,
      "bbox": { "x": 100, "y": 200, "w": 300, "h": 220, "page": 2, "units": "pt" },
      "caption": "Figure 3. Cell viability assay results.",
      // ↓ NEW (all optional; present only when storage_path IS NOT NULL)
      "imageUrl": "/api/research-brain/figures/{id}/image",
      "width": 450,
      "height": 330,
      "mimeType": "image/png"
    }
  ]
}
```

## Spike Gate Plan (PR #1 prerequisite, 5–10 min)

`scripts/spike-pdfjs-xobject.ts` runs BEFORE PR #1 merges. The
spike is informational for PR #1 (the spec gates **PR #3** on
it) but the run is committed to the PR #1 description so the
team has a single decision point.

```bash
bun run scripts/spike-pdfjs-xobject.ts ./docs/sample-mdpi.pdf
# prints JSON to stdout:
# { "result": "GO"|"NO-GO",
#   "xobject_count": N,
#   "transform_usable": true|false,
#   "filter_usable":   true|false,
#   "bytes_extractable": true|false,
#   "reason": "..." }
```

The spike script:

1. Loads `loadPdfjsLegacy()` (reuses the same loader as
   `localPdfTableProvider`).
2. Opens the sample PDF, iterates page 1's
   `page.getOperatorList()`.
3. Walks the operator list for `OPS.paintImageXObject` and
   `OPS.paintInlineImageXObject` operators.
4. For each, reads the XObject's `transform` and `filter` chain
   and tries to extract the raw bytes.
5. Prints the JSON verdict above.

Decision tree:

- `result: "GO"` (xobject_count > 0, transform + filter usable,
  bytes extractable) → PR #3 unblocked, XObject path added to
  `localPdfTableProvider`.
- `result: "NO-GO"` (any of the three signals false) → PR #3
  closes as `wontfix: documented-v1-limitation`. The
  `figure-image-extraction` capability ships with the
  Mistral + render-crop two-track pipeline.

The `renderCroppedFigure` helper's `@napi-rs/canvas` (actually
`canvas` per Decision 1) load is exercised separately during
PR #1 implementation — a 30-line smoke test in
`renderCrop.test.ts` confirms `import("canvas")` resolves and
`canvas.createCanvas(100, 100)` works under Bun. If the smoke
test fails, the helper's fallback path (`Bun.spawn` +
`pdftoppm`) is wired in for v1 — the public API is unchanged.

## PR-Split Mapping

| PR | Scope | LOC budget | Files touched |
|----|-------|------------|---------------|
| **#1** Backend foundation | Schema migration, `figureStorage`, `renderCrop`, `figureImageExtractor`, `pdfTableExtractor` orchestrator hook, Mistral flag flip, `imageUrl` in `/evidence`, image proxy route, spike script, spike report | ~350 | new: migration, `figureStorage.ts`, `renderCrop.ts`, `figureImageExtractor.ts`, `spike-pdfjs-xobject.ts`, `renderCrop.test.ts`, `figureImageExtractor.test.ts`. modified: `pdfTableExtractor.ts`, `mistralOcrProvider.ts`, `research-brain.ts` |
| **#2** Frontend | Lightbox `<img>`, "Open image" / "Download" buttons, `BboxOverlay` color split, `Figure {N} (page {P})` header, hook type extension, tests | ~200 | modified: `EvidenceLightbox.tsx`, `BboxOverlay.tsx`, `useProvenance.ts`. new: `BboxOverlay.figure.test.tsx`, `EvidenceLightbox.figure.test.tsx` |
| **#3** Local XObject (gated) | `extractImages()` on `localPdfTableProvider`, edge cases, tests | ~250 | modified: `localPdfTableProvider.ts`. new: `localPdfTableProvider.images.test.ts` |

Each PR is under the 400-line review budget. `sdd-tasks` will
re-forecast before apply; the design's forecast is `Low` for #1
and #2, `Low` for #3.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `getFigureStoragePath` key construction (idempotent + format-derived extension) | Pure function tests; no storage mock |
| Unit | `renderCroppedFigure` bbox math: width = bbox.w × 1.5; height = bbox.h × 1.5; canvas readback is a valid PNG (header bytes `89 50 4E 47`) | In-memory PDF fixture (mirror `localPdfTableProvider.spike.test.ts:27-64`); require `canvas` to load in Bun (skip with a clear "needs canvas" error otherwise) |
| Unit | `extractFigureImages` orchestration: per-figure independence, S3-failure isolation, cost `recordApiCall` once per source with correct byte sum | Mock `uploadFigure` and `recordApiCall`; assert call shape and `metadata` |
| Unit | Mistral provider: b64 decode tolerates standard + URL-safe alphabets; `image_bytes_total` and `image_count` thread into `recordApiCall` metadata; `MISTRAL_OCR_INCLUDE_IMAGE_BASE64=false` skips the path | Inject a fake `fetch` that returns a fixed Mistral response |
| Integration | Schema migration: 5 new columns exist as nullable, all NULL on existing rows | Supabase test suite (mirror the test in `pdf-table-extractor`) |
| Integration | `/evidence` response includes `imageUrl` when `storage_path` is set; omits when null | Supabase test + Express handler test |
| Integration | `/figures/:id/image` 401 / 404 / 413 / 502 paths | Elysia handler test with mocked storage provider |
| E2E (lightbox) | `<img>` renders for `imageUrl` figures; buttons render and trigger `window.open` / `Blob` download; `BboxOverlay` switches class based on `imageUrl` | Bun:test snapshot test on the Preact vnode tree (mirror `CompoundAuthorityBadge.test.tsx:46-80`) |
| Spike | `getOperatorList()` returns image XObject data with usable transform + filter | `bun run scripts/spike-pdfjs-xobject.ts <pdf>`; commit JSON output to PR #1 description |

## Migration / Rollout

**Schema migration** is the only DB change. The 5 new columns
are nullable; existing rows keep `NULL` on all of them. The
`research_evidence_figures` write path is unchanged for the
bbox/caption fields — only the new image fields get populated
by the new orchestrator pass.

**Feature rollout**:

- The Mistral flag ships default `true` (per
  `MISTRAL_OCR_INCLUDE_IMAGE_BASE64`). Operators flip to `false`
  for emergency rollback (single env var).
- The image proxy route is always mounted. The route is
  no-op for bbox-only figures (returns 404).
- Re-extraction of a source triggers the orchestrator pass for
  figures whose `storage_path` is NULL; rows with
  `storage_path` already populated are skipped. No data
  mutation for already-extracted figures.

**Rollback** (per the proposal):

1. `MISTRAL_OCR_INCLUDE_IMAGE_BASE64=false` (one env var).
2. Disable the image proxy route in code (one PR revert).
3. `DOWN` migration drops the 5 columns; viewer degrades to
   bbox-only. Existing rows keep `NULL` (read-only-safe).
4. S3 objects under `figures/{sourceId}/` are orphaned but
   harmless; cleanup is a separate job.

## Open Questions

- [ ] The render-crop helper's `Bun.writeTempFile()` lifecycle:
      confirm the Bun runtime exposes `writeTempFile` (vs.
      `Bun.write` with a `tmpdir()` join). Trivial; resolved
      during PR #1 implementation.
- [ ] The `api/research-brain/facts/:id/provenance` endpoint
      also surfaces figure data. Should the v1 imageUrl field
      also be added there, or only on `/evidence`? The proposal
      does not enumerate this; the spec is explicit on
      `/evidence` only. **Default**: add to `/evidence` only
      in PR #1. `/facts/:id/provenance` can be extended in
      PR #2 or later without contract risk.
- [ ] `corpus-ingestion-dashboard` integration
      (`figure-extraction-status` per source) is listed in
      `figure-image-extraction/spec.md` capability impacts but
      no concrete requirement body exists. The status is
      derivable from `loadFiguresForSource` (count of rows
      with `storage_path IS NOT NULL` vs total). The
      dashboard hookup can land in PR #2 or be a follow-up;
      it does not block the backend image pipeline.
- [ ] The `research_evidence_figures.bbox` column is JSONB
      (per the existing migration line 61). `renderCroppedFigure`
      assumes the bbox is in PDF points (consistent with the
      viewer). If a future provider returns bbox in pixels,
      a `units` field is needed; v1 trusts the current
      `units: "pt"` invariant.
