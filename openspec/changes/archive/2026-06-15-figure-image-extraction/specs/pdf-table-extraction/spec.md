# Delta for pdf-table-extraction

## ADDED Requirements

### Requirement: Figure Image Extraction Pass

The system MUST run a separate `figureImageExtractor` pass (see
the `figure-image-extraction` capability, `Figure Image Extractor
Service` requirement) AFTER the local table extraction pass, so
the figure image columns on `research_evidence_figures` are
populated in the same run that extracts the figure bboxes.

**Behavior contract:**

- The orchestrator (`extractPDFTables` in
  `src/services/files/pdfTableExtractor.ts`) MUST invoke
  `figureImageExtractor.extractFigureImages(sourceId, pdf,
  { runId, jobId })` after `persistExtractedFigures` writes the
  bbox rows.
- The image extraction pass MUST run in the same transaction
  boundary as the table pass for accounting purposes, but the
  image updates are NOT coupled to the table persistence: a
  failure in the image pass MUST NOT roll back the table rows
  (graceful degradation).
- The orchestrator's return value (`ExtractedTables`) is
  unchanged in shape; the image-extraction return is logged
  separately for observability.
- The orchestrator MUST log a structured event
  `pdf_figure_image_extraction_complete` with
  `{ sourceId, figureCount, imageCount, byteTotal, originCounts: { mistral, render_crop, bbox_only } }`
  after the pass finishes (success or partial success).

#### Scenario: Image pass runs after table pass

- GIVEN a source S with 3 figures
- WHEN `extractPDFTables(S, pdf)` is called
- THEN the local table extraction runs
- AND `persistExtractedFigures` writes 3 rows to
  `research_evidence_figures` (one per figure)
- AND `figureImageExtractor.extractFigureImages(S, pdf, ctx)`
  runs immediately after
- AND a log event
  `pdf_figure_image_extraction_complete{ sourceId=S,
  figureCount=3, imageCount=2, byteTotal=20480,
  originCounts: { mistral: 1, render_crop: 1, bbox_only: 1 } }`
  is emitted

#### Scenario: Image pass failure does not roll back tables

- GIVEN the image pass throws on its first figure (e.g., S3
  unreachable)
- WHEN `extractPDFTables(S, pdf)` is called
- THEN the 3 figure rows are still persisted with bbox + caption
- AND the table rows are still persisted
- AND the orchestrator catches the image-pass exception, logs
  it at WARN, and returns the table result as if the image pass
  did not run
- AND no exception propagates to the caller

### Requirement: ExtractedFigure Carries Image Bytes

The system MUST extend the per-figure return value from the
local provider (`localPdfTableProvider.ts`) so the figure
extraction consumer can thread the image bytes through
persistence. The shape is additive — existing fields
(`bbox`, `caption`) are unchanged.

**New shape:**

```typescript
interface ExtractedFigure {
  page: number;            // 1-indexed
  figureIndex: number;     // 0-based ordinal on page
  bbox: BBox;              // { x, y, w, h, page, units: "pt" }
  caption: string | null;
  // New (additive):
  bytes: Uint8Array | null;
  format: 'png' | 'jpeg' | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
}
```

- All four new image fields default to `null` in the local
  provider's return. The provider is a bbox-only detector in
  v1; the `figureImageExtractor` orchestrator (see the
  `figure-image-extraction` capability) populates the image
  fields downstream.
- The local provider MUST NOT change its detection contract
  (what counts as a figure) because of this delta. The new
  fields are a structural placeholder; the data flows in from
  the figure-image-extraction pass.
- `loadFiguresForSource` and the `evidence` endpoint MUST
  return the five image columns (`storage_path`, `mime_type`,
  `width`, `height`, `byte_size`) alongside the existing
  fields, in the same shape the `figure-image-extraction`
  capability's `Figure Image Storage Layout` requirement
  defines.

#### Scenario: ExtractedFigure has the new image fields

- GIVEN the local provider detects a figure on page 2 with
  bbox (100, 200, 300, 220)
- WHEN the provider returns the figure
- THEN the returned object has `bytes: null`, `format: null`,
  `width: null`, `height: null`, `byteSize: null` (local
  provider does not extract images)
- AND the existing `bbox` and `caption` fields are unchanged

#### Scenario: evidence endpoint exposes the five image columns

- GIVEN a row in `research_evidence_figures` with
  `storage_path = 'figures/{S}/0.png'`, `mime_type =
  'image/png'`, `width = 450`, `height = 330`, `byte_size =
  48721`
- WHEN `loadFiguresForSource(S)` runs
- THEN the returned figure object includes
  `imageUrl: "/api/research-brain/figures/{id}/image"`,
  `width: 450`, `height: 330`, `mimeType: "image/png"`
- AND the five columns are passed through to the
  `evidence` endpoint response unchanged

## MODIFIED Requirements

### Requirement: Foreign Keys From research_bioprospecting_facts

The system MUST add two nullable foreign keys to
`research_bioprospecting_facts` so a fact can point at the
table or figure it was extracted from. The figure foreign key
MUST remain valid when the figure row gains the five new image
columns from the `figure-image-extraction` capability — the
FK is to the row, not to a column, so adding columns on
`research_evidence_figures` does not break the FK.

(Previously: the FK contract was unchanged when the
`figure-image-extraction` capability was introduced. The
delta adds nothing to the FK shape itself; this note records
that the new image columns are transparent to the FK.)

#### Scenario: Adding image columns does not break the figure FK

- GIVEN a fact F with `evidence_figure_id = R` and R gains
  the five new image columns
- WHEN the migration runs
- THEN F's `evidence_figure_id` is unchanged
- AND F still resolves to R via the FK
- AND `ON DELETE SET NULL` still fires when R is deleted

### Requirement: Provider Abstraction And Selection

The provider interface `extractPDFTables(sourceId, pdfBuffer,
runId?)` is unchanged in signature. The orchestrator gains
additional responsibilities (running the figure image
extraction pass after the table extraction pass), but the
provider's per-document contract — return
`ExtractedTable[]` — is unchanged. The image pass is an
orchestrator concern, not a provider concern.

(Previously: the orchestrator ran the table pass and stopped.
The delta extends the orchestrator to chain the figure-image
extraction pass on the same `sourceId` after the table
persistence.)

#### Scenario: Provider signature is unchanged

- GIVEN a provider that implements
  `TableExtractionProvider.extract(pdf, ctx)`
- WHEN the orchestrator runs
- THEN the provider's return type is `ExtractedTable[]` (no
  figure fields)
- AND the figure image pass is invoked by the orchestrator
  separately, on the same `sourceId`, NOT by the provider

### Requirement: Local Provider (pdf-table-extractor)

The local provider's per-page loop, render scale, and
confidence formula are unchanged. The provider's return type
gains the additive image fields (`bytes`, `format`, `width`,
`height`, `byteSize` — all `null` in the local provider's
output) so the orchestrator can thread the figure objects to
the image-extraction pass without rebuilding the
`ExtractedFigure` shape. The local provider does NOT extract
images; it only sets the placeholders.

(Previously: the local provider returned figures with `bbox`
and `caption` only. The delta extends the return type
additively with the four new image fields, all defaulted to
`null`.)

#### Scenario: Local provider return type gains image fields

- GIVEN the local provider detects a figure on page 2
- WHEN the provider returns
- THEN the figure object has `bytes: null`, `format: null`,
  `width: null`, `height: null`, `byteSize: null`
- AND the `bbox` and `caption` fields are unchanged from
  the pre-delta contract

### Requirement: Mistral Provider (Fallback)

The Mistral provider's call to Mistral OCR gains
`include_image_base64: true` (configurable via env var
`MISTRAL_OCR_INCLUDE_IMAGE_BASE64`, default `true`). The
provider MUST parse `pages[i].images[j].image_base64` from
the response and surface the decoded bytes on the same
figure-level structure the local provider uses. The
`recordApiCall` invocation gains metadata
`image_bytes_total` and `image_count` but the `units` and
`costUsd` fields are unchanged.

(Previously: the Mistral provider called OCR without
`include_image_base64` and returned figures with `bbox` and
`caption` only. The delta flips the flag and parses the
base64 payloads.)

#### Scenario: Mistral provider returns image bytes on figures

- GIVEN `MISTRAL_OCR_INCLUDE_IMAGE_BASE64=true` and a
  Mistral call that returns 1 image on page 1
- WHEN the provider parses the response
- THEN the figure on page 1 has `bytes: <decoded>`,
  `format: 'png'` (or `'jpeg'`), `width: ...`, `height: ...`,
  `byteSize: <byte length>`
- AND `recordApiCall` is called with
  `metadata: { image_bytes_total, image_count, ... }` in
  addition to the existing fields
- AND the `units` and `costUsd` fields of `recordApiCall`
  are unchanged from the pre-delta contract

#### Scenario: Flag off returns figures without bytes

- GIVEN `MISTRAL_OCR_INCLUDE_IMAGE_BASE64=false`
- WHEN the Mistral provider runs
- THEN the parsed figures have `bytes: null`, `format: null`,
  `width: null`, `height: null`, `byteSize: null`
- AND the response is identical to the pre-delta contract
  (no regression)

### Requirement: Idempotent Extraction And Cache Source

The cache-source rule for `research_evidence_figures` is
UNCHANGED: a re-extraction that finds an existing figure row
with the same `(source_id, page, figure_index)` returns the
cached row verbatim, including the five image columns. The
figure-image-extraction pass is a write-once path: it
populates the columns if and only if the row's
`storage_path IS NULL`. A re-extraction MUST NOT overwrite
a non-null `storage_path` from a prior successful extraction
unless the operator explicitly forces a re-extraction (same
admin escape hatch that already exists for tables).

(Previously: figure rows were cached by `(source_id, page,
figure_index)` and re-extraction was a no-op. The delta
preserves the cache contract; it adds a write-once guard on
the five new columns.)

#### Scenario: Cached figure row keeps its image columns

- GIVEN a figure row R with `storage_path = 'figures/{S}/0.png'`
  from a prior run
- WHEN a re-extraction runs for source S
- THEN the cached row is returned verbatim
- AND the figure-image-extraction pass sees
  `storage_path IS NOT NULL` for R and skips the write
- AND the S3 object at `figures/{S}/0.png` is NOT touched

#### Scenario: Forced re-extraction overwrites the image

- GIVEN an admin invokes the forced re-extraction path for
  source S, and figure R has `storage_path` populated
- WHEN the forced re-extraction runs
- THEN R's row is deleted first (same path as the table
  forced re-extraction)
- AND the figure-image-extraction pass writes a fresh row
  with the new image columns
- AND the S3 object at `figures/{S}/0.png` is overwritten
  (the layout's "overwrite" decision — last write wins)

### Requirement: Prompt Injection Of Extracted Tables

`buildTablesPromptSection` is unchanged in this delta. The
figure images are NOT injected into the LLM prompt in v1;
the v1 contract is bbox-and-caption only at the prompt
level. A follow-up change MAY add figure crops to the prompt,
but that is out of scope here.

(Previously: tables were injected, figures were not. The
delta preserves this asymmetry.)

#### Scenario: Figure images are not in the LLM prompt

- GIVEN a source S with 3 figures, all with extracted
  images
- WHEN `buildTablesPromptSection(tables)` is called
- THEN the output contains a `tables:` block (per the
  pre-delta contract)
- AND the output does NOT contain a `figures:` block, an
  `image:` block, or any base64 image data
- AND the LLM prompt size is unaffected by the new image
  columns on the figure rows
