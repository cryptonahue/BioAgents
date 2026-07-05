# Spec: figure-image-extraction

## Purpose

`pdf-provenance-viewer` records figure *positions* (page, bbox, caption)
but never the image file. The lightbox overlays a purple bbox on the
PDF page — the user sees the figure *region* but cannot preview a clean
crop, send the figure to a vision LLM, download it, or cache it
offline. This capability extracts image bytes per figure, persists them
to S3, exposes an auth-gated proxy, and renders the crop in the
lightbox so figure citations are verifiable and reusable.

The capability ships a two-track v1 pipeline that runs after table
extraction:

1. **Mistral raster path** — flip `include_image_base64: true` on the
   existing Mistral OCR call, parse the per-image base64 payloads,
   decode to bytes, and map back to figure rows by `(page,
   figureIndex)`.
2. **Render-crop vector path** — render the PDF page via the
   `pdfjs-dist@5.4.296` legacy build at 1.5× scale, crop the bbox
   region, encode to PNG/JPEG, and persist.

v1 ships BOTH paths. Render-crop is OBLIGATORY in PR #1 because
vector figures are the dominant case in bioprospecting PDFs and the
Mistral raster path alone would leave most figures without an image
("figure without image" badge is acceptable, but it must be a
minority case). A future PR #3 adds an additional local XObject
extraction path gated on a 5-10 min spike.

Figure bytes are persisted to S3 at
`figures/{sourceId}/{figureIndex}.{format}`. A new auth-gated
proxy route streams bytes back to the viewer. All five new columns
on `research_evidence_figures` are nullable so existing rows
(`storage_path = NULL`) keep working — the viewer degrades to
bbox-only (pre-change behavior) for any row that has no extracted
image.

## Requirements

### Requirement: research_evidence_figures Image Columns

The system MUST add five new nullable columns to
`research_evidence_figures` so an extracted image file can be
persisted alongside its bbox and caption.

**Schema delta:**

```sql
ALTER TABLE public.research_evidence_figures
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS width INT,
  ADD COLUMN IF NOT EXISTS height INT,
  ADD COLUMN IF NOT EXISTS byte_size BIGINT;
```

**Column semantics:**

- `storage_path` — S3 object key, formatted as
  `figures/{sourceId}/{figureIndex}.{format}` where `{format}` is
  the lowercase MIME suffix (`png` for `image/png`, `jpg` for
  `image/jpeg`). The path is the S3 key only — no bucket, no
  `s3://` prefix, no presigned URL.
- `mime_type` — the canonical IANA MIME type (`image/png` or
  `image/jpeg`). Drives the proxy's `Content-Type` response header.
- `width` — pixel width of the encoded image.
- `height` — pixel height of the encoded image.
- `byte_size` — total bytes of the encoded image (`bytes.length`).

**Nullability rules:**

- All five columns are nullable. Rows with `storage_path = NULL`
  are the "bbox-only" case — the figure was detected but no image
  was extracted. The viewer MUST continue to render a bbox overlay
  for these rows (pre-change behavior).
- The existing `(source_id, page, figure_index)` uniqueness, the
  `bbox` shape, and the `caption` column are unchanged. Adding
  image persistence MUST NOT modify any of these contracts.
- The new columns are purely additive; the migration is
  backward-compatible and existing rows keep `NULL` on all five.

#### Scenario: Migration adds five nullable columns

- GIVEN a populated `research_evidence_figures` table with N rows,
  none of which have the new columns
- WHEN the migration runs
- THEN every existing row has `storage_path = NULL`, `mime_type =
  NULL`, `width = NULL`, `height = NULL`, `byte_size = NULL`
- AND the application layer continues to function unchanged

#### Scenario: New image extraction updates the five columns atomically

- GIVEN a fresh figure row R with `storage_path = NULL`
- WHEN the image extraction pipeline writes image bytes for R
- THEN the same UPDATE sets all five columns:
  `storage_path = 'figures/{S}/0.png'`, `mime_type = 'image/png'`,
  `width = 540`, `height = 360`, `byte_size = 48721`
- AND no partial-update state is observable (a SELECT between the
  write and the read sees either all-NULL or all-populated, never
  a mix)

#### Scenario: Re-extraction overwrites the previous image

- GIVEN a row R with `storage_path = 'figures/{S}/0.png'` from a
  prior run
- WHEN the source is re-extracted and the new image bytes have the
  same format
- THEN the S3 object at that key is overwritten
- AND the row's `storage_path` is unchanged (same key, same
  format) but `width` / `height` / `byte_size` reflect the new
  bytes

### Requirement: Figure Image Storage Layout

The system MUST persist figure image bytes to S3 at the
deterministic key `figures/{sourceId}/{figureIndex}.{format}` and
MUST expose a `figureStorage` helper module that owns key
construction and upload/download.

**Storage layout:**

- Bucket: the same bucket the rest of the system uses for
  `research_sources.file_path` and `research_evidence_figures.*`
  (no new bucket; the existing S3 storage provider is reused).
- Key shape: `figures/{sourceId}/{figureIndex}.{format}` where:
  - `{sourceId}` is the lowercase UUID (no dashes preserved or
    stripped — match the rest of the S3 layout).
  - `{figureIndex}` is the 0-based ordinal on the page.
  - `{format}` is the lowercase extension matching the MIME
    type (`png` for `image/png`, `jpg` for `image/jpeg`).

**Helper module (`src/storage/figureStorage.ts`):**

```typescript
// Pure key construction
getFigureStoragePath(
  sourceId: string,
  figureIndex: number,
  format: 'png' | 'jpeg'
): string  // e.g. "figures/abc.../0.png"

// Async upload (reuses existing S3 provider; no new SDK)
uploadFigure(
  key: string,
  bytes: Uint8Array,
  mimeType: 'image/png' | 'image/jpeg'
): Promise<{ byteSize: number }>

// Async download for the proxy route
downloadFigure(
  key: string
): Promise<Uint8Array>
```

**Behavior:**

- The helper module MUST NOT introduce a new S3 client or
  credentials path. It MUST delegate to the existing
  storage provider used by `src/storage/index.ts` for
  `research_sources.file_path`.
- `getFigureStoragePath` is pure (no I/O). It is safe to call
  in unit tests without a storage backend.
- `uploadFigure` returns `{ byteSize: bytes.byteLength }`. The
  caller persists this value to `byte_size`.
- `downloadFigure` throws a typed `FigureNotFoundError` when the
  key is missing in S3; the proxy route translates that to HTTP
  404.
- The helper MUST follow the project's TDZ-safe pattern (no
  module-level state, all cached singletons on `globalThis`) when
  it touches a backend client. This matches the existing
  `src/storage/index.ts` convention.

#### Scenario: getFigureStoragePath returns the canonical key

- GIVEN `sourceId = "550e8400-e29b-41d4-a716-446655440000"`,
  `figureIndex = 2`, `format = 'png'`
- WHEN `getFigureStoragePath(...)` is called
- THEN the returned key is
  `'figures/550e8400-e29b-41d4-a716-446655440000/2.png'`

#### Scenario: uploadFigure writes bytes and returns the size

- GIVEN 48,721 bytes of PNG image data
- WHEN `uploadFigure(key, bytes, 'image/png')` runs
- THEN the S3 object at `key` exists with the same bytes
- AND the returned `{ byteSize }` is `48721`

#### Scenario: downloadFigure throws when the key is missing

- GIVEN no S3 object exists at `figures/{S}/0.png`
- WHEN `downloadFigure('figures/{S}/0.png')` runs
- THEN it throws `FigureNotFoundError({ key })`
- AND the proxy route catches and returns HTTP 404

### Requirement: Figure Image Extractor Service

The system MUST expose a `figureImageExtractor` orchestrator at
`src/services/files/figureImageExtractor.ts` that runs the
v1 image-extraction pipeline for one source. The orchestrator is
called from `pdfTableExtractor` after the table-extraction pass
completes; it is a separate, standalone pass (it MUST NOT mutate
the table-extraction return shape).

**Public API:**

```typescript
// Run the v1 pipeline for a source. Returns one entry per detected
// figure; entries may have `bytes: null` when neither path produced
// an image (the "bbox-only" case).
extractFigureImages(
  sourceId: string,
  pdf: Uint8Array,
  ctx: { runId?: string; jobId?: string }
): Promise<ExtractedFigureImage[]>

interface ExtractedFigureImage {
  page: number;            // 1-indexed
  figureIndex: number;     // 0-based ordinal on page
  bbox: BBox;              // same shape as research_evidence_figures.bbox
  bytes: Uint8Array | null;
  format: 'png' | 'jpeg' | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  origin: 'mistral' | 'render-crop' | null;
}
```

**Pipeline contract:**

1. The orchestrator MUST first run the existing table extraction
   to obtain the list of detected figure rows
   (`(source_id, page, figure_index, bbox)` triples). This is a
   read against `research_evidence_figures` after
   `persistExtractedFigures` has run.
2. For each detected figure, the orchestrator MUST try the Mistral
   raster path first. If Mistral returned a base64 image for
   `(page, figureIndex)`, decode it and use those bytes.
3. If the Mistral path did not produce bytes for that figure, the
   orchestrator MUST fall back to the render-crop path. The
   render-crop helper renders the page via the `pdfjs-dist@5.4.296`
   legacy build at 1.5× scale and crops the bbox region.
4. If both paths fail, the figure is recorded as
   `bytes: null` and `origin: null` — this is the bbox-only case
   the viewer already handles.
5. For figures with `bytes !== null`, the orchestrator MUST call
   `uploadFigure(...)` and then UPDATE the corresponding
   `research_evidence_figures` row with the five image columns
   (atomic; see the schema requirement above).
6. The orchestrator MUST track the per-source byte total and call
   `costService.recordApiCall({ provider: 'mistral_ocr',
   units: totalImageBytes, costUsd: 0, sourceId, runId, metadata:
   { kind: 'figure_image_bytes' } })` once per source. `costUsd: 0`
   is intentional: the Mistral page price already covers the
   include_image_base64 surcharge; we are tracking bytes for
   observability, not adding a new cost line.

**Failure handling:**

- A single figure's image-extraction failure MUST NOT abort the
  source's other figures. Each figure is independently
  try/catch'd inside the loop.
- A S3 upload failure for one figure MUST log
  `event=figure_image_upload_failed, sourceId, figureIndex` at
  WARN and leave the row's image columns NULL (graceful
  degradation; the viewer still shows the bbox).
- The orchestrator MUST respect the cost-guard-rails flag
  `MISTRAL_OCR_ENABLED`. When `false`, the Mistral path is
  skipped entirely and only render-crop runs.

#### Scenario: Mistral path returns bytes for a raster figure

- GIVEN a PDF where the Mistral OCR response contains
  `pages[1].images[0].image_base64` for a figure on page 2
- AND the figure is already persisted in
  `research_evidence_figures` with `(page=2, figure_index=0)`
- WHEN the orchestrator runs
- THEN the figure's `bytes` are the base64-decoded payload
- AND `origin = 'mistral'`
- AND the row's `storage_path`, `mime_type`, `width`, `height`,
  `byte_size` are populated
- AND the render-crop path is NOT invoked for that figure

#### Scenario: Render-crop path fills a vector figure

- GIVEN a vector-only figure (no Mistral base64 returned) on
  page 4 of the source
- WHEN the orchestrator runs
- THEN the render-crop helper produces a PNG crop of the bbox
- AND `origin = 'render-crop'`
- AND the row's five image columns are populated
- AND the S3 object at `figures/{S}/{figureIndex}.png` is
  written

#### Scenario: Both paths fail → bbox-only persisted

- GIVEN a figure where Mistral returns no base64 and the
  render-crop helper throws on canvas read
- WHEN the orchestrator runs
- THEN the row keeps `storage_path = NULL` and the other four
  columns `NULL`
- AND the figure is still listed in the orchestrator's return
  value with `bytes: null`, `origin: null`
- AND no exception propagates out of the orchestrator (the
  source is recorded as "partial extraction")

#### Scenario: Per-image-byte cost tracking fires once per source

- GIVEN a source with 3 figures, all extracted successfully
  (Mistral: 12 KB, render-crop: 8 KB, render-crop: 5 KB)
- WHEN the orchestrator's `recordApiCall` call fires
- THEN it is called exactly ONCE for the source
- AND `units = 25600` (sum of the three byte counts)
- AND `costUsd = 0`
- AND `metadata.kind = 'figure_image_bytes'`

#### Scenario: S3 upload failure degrades gracefully

- GIVEN `uploadFigure` throws on the second figure
- WHEN the orchestrator runs
- THEN the first figure's row is updated with the five image
  columns
- AND the second figure's row keeps `storage_path = NULL`
- AND the third figure is still attempted
- AND a WARN log is emitted with
  `event=figure_image_upload_failed, figureIndex=1`

### Requirement: Mistral Raster Path

The system MUST flip `include_image_base64: true` in the existing
Mistral OCR call and MUST parse the per-image base64 payloads from
the response.

**Behavior:**

- The flag flip is a single boolean toggle in
  `src/services/files/providers/mistralOcrProvider.ts`. The flag
  MUST be configurable via the env var
  `MISTRAL_OCR_INCLUDE_IMAGE_BASE64` (default `true` in this
  change; the value `false` reverts to pre-change behavior for
  emergency rollback).
- The provider MUST parse
  `response.pages[i].images[j].image_base64` for each returned
  image. The parsing path is additive — the existing table
  extraction logic is unchanged.
- The provider MUST thread the image bytes into the
  `recordApiCall` metadata on the same call that records the
  table-extraction units. The metadata key is
  `image_bytes_total: number` (sum of decoded byte lengths) and
  `image_count: number`. The `units` field stays as
  `pages.length` (pre-change contract); the image bytes are
  observational metadata, not a new cost line.
- The base64 decode MUST tolerate either standard or URL-safe
  alphabets (Mistral docs vary). Decode failures are logged at
  WARN and treated as "no image for this figure" (the
  render-crop path gets a chance).

**Cost guard (informational only):**

- This change introduces NO new hard cost cap. The existing
  `MISTRAL_OCR_DAILY_COST_CAP_USD` /
  `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD` caps in
  `api-cost-guard-rails` still apply.
- The per-image-byte `recordApiCall` on the orchestrator side
  (separate from the table-extraction call) is the
  *informational* tracker for the 30-day review. It MUST NOT
  add to `daily_api_usage.cost_usd` and MUST NOT change the
  cap math.
- The 30-day review is a project-level commitment, not a
  spec-level contract. This spec is reviewed at 30 days; if
  the byte volume surprises, a follow-up change may introduce
  a hard cap on bytes.

#### Scenario: Flag flip surfaces per-page image base64

- GIVEN `MISTRAL_OCR_INCLUDE_IMAGE_BASE64=true` and a Mistral
  call that returns 2 pages with 1 image on page 1
- WHEN the provider parses the response
- THEN the page-1 image's base64 string is available
  alongside the existing table data
- AND the existing table-extraction return shape is unchanged

#### Scenario: Flag off restores pre-change behavior

- GIVEN `MISTRAL_OCR_INCLUDE_IMAGE_BASE64=false`
- WHEN the provider runs
- THEN the response does NOT include image base64
- AND the provider does NOT attempt to parse
  `pages[i].images[j].image_base64`
- AND the orchestrator's Mistral path returns no bytes
  (render-crop is the only path that can produce an image)

### Requirement: Render-Crop Helper

The system MUST expose a `renderCroppedFigure` helper at
`src/services/files/renderCrop.ts` that renders a single PDF page
to a canvas, crops the bbox region, and encodes the crop to PNG
or JPEG.

**Public API:**

```typescript
renderCroppedFigure(
  pdf: Uint8Array,
  page: number,         // 1-indexed
  bbox: BBox,           // { x, y, w, h, page, units: "pt" }
  format: 'png' | 'jpeg' // default 'png'
): Promise<{
  bytes: Uint8Array;
  width: number;
  height: number;
  format: 'png' | 'jpeg';
}>
```

**Render contract:**

- The helper MUST render the page at the fixed `1.5×` scale (the
  same scale the local table provider and the viewer use; see
  `pdf-table-extraction` `Bbox Coordinate Space` requirement).
- The helper MUST map the PDF-point bbox to canvas pixel coords
  by multiplying `x`, `y`, `w`, `h` by 1.5.
- The helper MUST use `@napi-rs/canvas` (the project's
  Bun-compatible canvas implementation) when available in the
  runtime.
- When `@napi-rs/canvas` fails to load in Bun (a known issue in
  some builds), the helper MUST fall back to
  `Bun.spawn(['pdftoppm', ...])` (poppler-utils) with
  `--x`/`--y`/`--W`/`--H` flags. This is the spike's "Plan B"
  path; the helper abstracts the difference behind the same
  `renderCroppedFigure` signature.
- The 5-10 min spike on `pdfjs-dist@5.4.296` legacy build
  `getOperatorList()` is a separate investigation (gates PR #3's
  XObject path); it is NOT a runtime dependency of this
  requirement.

**Format choice:**

- Default format is `png` (lossless, smaller for line art). The
  helper MAY accept `jpeg` for photographic figures where PNG
  byte size is excessive; the orchestrator currently does not
  switch formats, so v1 is PNG-only.

#### Scenario: Render-crop produces a PNG of the bbox region

- GIVEN a page where the bbox spans (100, 200, 300, 220) in
  points
- AND `@napi-rs/canvas` loads successfully in Bun
- WHEN `renderCroppedFigure(pdf, 2, bbox, 'png')` runs
- THEN the returned `bytes` are a valid PNG
- AND `width = 450` (300 * 1.5), `height = 330` (220 * 1.5)
- AND `format = 'png'`

#### Scenario: pdftoppm fallback when @napi-rs/canvas fails to load

- GIVEN `@napi-rs/canvas` import throws
- AND `pdftoppm` is on `$PATH` (poppler-utils installed in the
  Docker image)
- WHEN `renderCroppedFigure(...)` runs
- THEN the helper spawns `pdftoppm` with the bbox region
  flags and reads the cropped PNG
- AND the returned shape is identical to the
  `@napi-rs/canvas` path
- AND the source PDF is loaded from a temp file written to
  `Bun.writeTempFile()` (the helper MUST clean up the temp
  file in a `finally` block)

#### Scenario: Render-crop fails on an unreadable page

- GIVEN a corrupted PDF where the page object throws on
  render
- WHEN `renderCroppedFigure(...)` runs
- THEN the helper throws a typed
  `FigureRenderCropError({ page, reason })`
- AND the orchestrator catches and falls through to the
  bbox-only case for that figure

### Requirement: Figure Image Proxy Endpoint

The system MUST expose
`GET /api/research-brain/figures/:figureId/image` that streams
the extracted image bytes back to the viewer. The route MUST be
auth-gated; the same `authResolver({ required: true })` pattern
as the existing PDF proxy applies.

**Endpoint contract:**

```http
GET /api/research-brain/figures/{figureId}/image
Authorization: <user JWT or session>

200 OK
Content-Type: image/png | image/jpeg
Content-Length: <byte_size>
Content-Disposition: inline; filename="figure-{figureIndex}.{ext}"
Cache-Control: private, max-age=300

<binary image bytes>
```

**Behavior:**

- The route MUST run through
  `authResolver({ required: true })` (same security pattern as
  `GET /api/research-brain/sources/:sourceId/pdf` in
  `pdf-provenance-viewer`). Unauthenticated requests return
  HTTP 401.
- The route MUST look up the figure row by `figureId` and
  read `storage_path`, `mime_type`, `byte_size`. When
  `storage_path IS NULL`, the route returns HTTP 404 with
  `{ "error": "Figure has no extracted image" }`. The viewer
  treats this as the bbox-only case.
- The route MUST fetch the S3 object via
  `figureStorage.downloadFigure(storage_path)` and stream the
  bytes back. When S3 returns 404, the route returns HTTP 404
  (storage layer is the source of truth).
- The route MUST enforce a 50 MB byte cap on the response
  body. When the S3 object exceeds 50 MB, the route returns
  HTTP 413 with `{ "error": "Image exceeds 50 MB cap" }`. The
  cap matches the existing PDF proxy's `MAX_PDF_BYTES` policy
  in `pdf-provenance-viewer`.
- The route MUST set `Cache-Control: private, max-age=300`
  (5 minutes). The `private` directive prevents shared caches
  from caching the image; `max-age=300` lets the browser
  dedupe rapid re-opens of the same lightbox.
- The route MUST set `Content-Disposition: inline` (not
  `attachment`) so the browser renders the image directly when
  navigated to. The filename is `figure-{figureIndex}.{ext}`
  where `ext` is `png` or `jpg` derived from `mime_type`.
- The route MUST return HTTP 502 with
  `{ "error": "Storage not configured" }` when the storage
  provider is missing required env vars. This matches the
  same failure mode as the PDF proxy.

#### Scenario: Authenticated request returns the image bytes

- GIVEN a valid user session and a figure row with
  `storage_path = 'figures/{S}/0.png'`, `mime_type =
  'image/png'`, `byte_size = 48721`
- AND the S3 object exists at that key
- WHEN `GET /api/research-brain/figures/{id}/image` is called
  with a valid session cookie
- THEN the response is HTTP 200 with `Content-Type:
  image/png`, `Content-Disposition: inline;
  filename="figure-0.png"`, `Cache-Control: private,
  max-age=300`
- AND the body is the 48,721 PNG bytes

#### Scenario: Unauthenticated request is rejected

- GIVEN no `Authorization` header and no session cookie
- WHEN the route is called
- THEN the response is HTTP 401 with
  `{ "error": "Authentication required" }`
- AND the S3 fetch is NOT performed (no bytes leak)

#### Scenario: Figure has no image → 404

- GIVEN a figure row with `storage_path = NULL`
- WHEN the route is called
- THEN the response is HTTP 404 with
  `{ "error": "Figure has no extracted image" }`

#### Scenario: Image exceeds the 50 MB cap

- GIVEN a figure row with `byte_size = 62914560` (60 MB)
- AND the S3 object is readable
- WHEN the route is called
- THEN the response is HTTP 413 with
  `{ "error": "Image exceeds 50 MB cap" }`
- AND no partial body is streamed

#### Scenario: Storage unconfigured → 502

- GIVEN the storage provider's required env vars are missing
- WHEN the route is called
- THEN the response is HTTP 502 with
  `{ "error": "Storage not configured" }`

### Requirement: Evidence Endpoint Image URL

The system MUST extend the existing
`GET /api/research-brain/sources/:sourceId/evidence` endpoint
(see `pdf-provenance-viewer` `Provenance API Endpoints`) to
include `imageUrl` on each figure entry when an image was
extracted.

**Response delta:**

```json
{
  "figures": [
    {
      "id": "uuid",
      "page": 2,
      "figureIndex": 0,
      "bbox": { "x": 100, "y": 200, "w": 300, "h": 220, "page": 2, "units": "pt" },
      "caption": "Figure 3. Cell viability assay results.",
      "imageUrl": "/api/research-brain/figures/{id}/image",
      "width": 450,
      "height": 330,
      "mimeType": "image/png"
    }
  ]
}
```

- `imageUrl` is the relative path to the proxy route. It is
  always relative — never a presigned S3 URL, never an
  absolute URL. This keeps auth in the proxy path.
- `imageUrl` is present ONLY when `storage_path IS NOT NULL`.
  When the figure is bbox-only, the field is omitted (not
  `null`).
- `width` / `height` / `mimeType` are likewise present only
  when an image exists. They are the same values the viewer
  needs to size the `<img>` element before bytes load.
- The figure's order in the response is unchanged: ascending
  `(page, figureIndex)`. The `imageUrl` field is purely
  additive.

#### Scenario: Figure with image exposes imageUrl

- GIVEN a figure row with `storage_path = 'figures/{S}/0.png'`
- AND a valid user session
- WHEN the evidence endpoint is called for source S
- THEN the figure entry contains
  `imageUrl: "/api/research-brain/figures/{id}/image"`,
  `width: 450`, `height: 330`, `mimeType: "image/png"`
- AND the viewer can fetch `imageUrl` with the same session
  cookie and receive the bytes

#### Scenario: Figure without image omits imageUrl

- GIVEN a figure row with `storage_path = NULL`
- WHEN the evidence endpoint is called
- THEN the figure entry has NO `imageUrl`, NO `width`, NO
  `height`, NO `mimeType`
- AND the bbox and caption are still present (pre-change
  contract preserved)

### Requirement: Cost Tracking — Informational Only

The system MUST record per-image-byte counts in the existing
`costService` so the 30-day review can see actual volume, but
MUST NOT introduce a new hard cost cap or change existing cap
math. The byte count is metadata on the per-source
`recordApiCall` issued by the orchestrator (see
`Figure Image Extractor Service` above).

**Behavior:**

- The orchestrator's `recordApiCall` carries
  `metadata: { kind: 'figure_image_bytes', image_count, image_bytes_total }`
  in addition to the standard fields. The RPC persists this
  metadata in `daily_api_usage.metadata` (or the equivalent
  `ext_api_calls` JSONB on `research_ingestion_runs`).
- `costUsd = 0` and `units` is the total byte count. The cap
  check in `costService.checkCap` compares `units` against
  the relevant cap. Since no cap is configured against image
  bytes, the check is a no-op for this metadata; the bytes
  are observational.
- No new env var is introduced. No new cap is registered.
- The `api-cost-guard-rails` spec is unchanged; this
  requirement only documents the orchestrator's use of the
  existing service.

#### Scenario: Per-source byte count is recorded

- GIVEN a source S with 25,600 bytes of extracted figure
  images (3 figures)
- WHEN the orchestrator's `recordApiCall` runs
- THEN the `daily_api_usage` row for `(day, 'mistral_ocr')` is
  NOT incremented for `cost_usd` (the table-extraction call's
  `costUsd` is the only cost line)
- AND `metadata.image_bytes_total = 25600` and
  `metadata.image_count = 3` are persisted alongside
- AND the existing soft-threshold WARN behavior in
  `api-cost-guard-rails` is NOT triggered by image bytes
  alone

### Requirement: Local XObject Spike (PR #3 Gate)

The system MUST run a 5-10 minute spike test of
`getOperatorList()` on the LEGACY build of
`pdfjs-dist@5.4.296` to determine whether a third image-
extraction path (local XObject walk) is feasible. The spike is
NOT part of v1 runtime behavior — it is a gate for PR #3.

**Spike contract:**

- The spike script lives at
  `scripts/spike-pdfjs-xobject.ts` and runs via
  `bun run scripts/spike-pdfjs-xobject.ts <sample.pdf>`.
- The script loads the legacy build, opens the sample PDF,
  walks `getOperatorList()` for the first page's image
  XObjects, and prints a JSON summary: which image operators
  were found, whether the XObject's transform + filter info is
  usable, and whether the bytes can be extracted to disk.
- The spike's outcome is documented in the PR #3 description
  as either "GO" (XObject path is feasible) or "NO-GO"
  (XObject path is not feasible; PR #3 closes with a
  documented v1 limitation).
- The spike is run BEFORE PR #1 merges. The result is shared
  in the PR #1 description. If the spike is "GO", PR #3 is
  scheduled. If "NO-GO", PR #3 is closed as
  `wontfix: documented-v1-limitation`.

**Multi-page limitation (v1):**

- v1 does NOT support figures that span multiple PDF pages.
  Multi-page figures are stored as two separate figure rows
  (one per page) and each gets its own bbox and (when
  possible) its own image crop. This is documented as a
  known v1 limitation in the project README and the
  `figures/{sourceId}/{figureIndex}.{format}` S3 layout
  assumes a single page per figure.
- The limitation is intentional. A follow-up change MAY add
  cross-page stitching, but the v1 layout does not reserve
  space for it.

#### Scenario: Spike returns GO

- GIVEN the legacy `getOperatorList()` returns image XObject
  data with usable transform + filter info
- WHEN the spike script runs against a sample MDPI paper
- THEN the printed summary includes
  `result: "GO", xobject_count: N, transform_usable: true,
  filter_usable: true, bytes_extractable: true`
- AND PR #3 is unblocked

#### Scenario: Spike returns NO-GO

- GIVEN the legacy `getOperatorList()` throws on XObject
  access or returns opaque data
- WHEN the spike script runs
- THEN the printed summary includes
  `result: "NO-GO", reason: <parser error or null transform>`
- AND PR #3 closes with a `wontfix: documented-v1-limitation`
  label and the multi-page limitation note

## ADDED Requirements (delta-internal cross-references)

The following requirements are documented here for completeness;
the delta does not modify any existing spec beyond what is
listed in the `MODIFIED Requirements` section.

### Requirement: PR Split — 3 Chained PRs

The implementation MUST ship as 3 chained PRs, each under the
400-line review budget. PR #1 is the foundation; PR #2 is the
viewer rendering; PR #3 is the optional XObject path.

| PR  | Scope                                                                                          | ~LOC  |
| --- | ---------------------------------------------------------------------------------------------- | ----- |
| #1  | Spike + Mistral flag flip + schema + persistence + image proxy + evidence `imageUrl` + render-crop helper | ~350  |
| #2  | Lightbox `<img>` + "Open image" / "Download" buttons + bbox color split + tests                | ~200  |
| #3  | Local XObject `extractImages()` on `localPdfTableProvider.ts` + edge cases + tests             | ~250  |

Each PR has a clear start, finish, autonomous scope,
verification, and rollback. The PR split is a project-level
delivery contract; it does not bind future changes to a
specific number of PRs.

#### Scenario: Each PR lands under 400 changed lines

- GIVEN a PR's diff (`additions + deletions`)
- WHEN the PR is opened
- THEN the diff is `≤ 400` lines
- AND the PR description names the scope from the table above
