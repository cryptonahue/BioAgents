# Spec: pdf-table-extraction

## Purpose

Provide a deterministic, source-cached PDF table extraction pipeline that
turns tabular data inside research PDFs into structured rows the rest of
the Research Brain can reason about, and persist those rows so the
bioprospecting extractor, the viewer, and the evidence pack all see the
same table of record.

The capability ships a provider abstraction with two implementations: a
local, network-free `pdf-table-extractor` (npm) for digital PDFs and a
Mistral OCR fallback for scanned or low-quality inputs. A strict quality
gate decides when to fall back. Re-extracting the same `source_id` is a
no-op against external services — `research_evidence_tables` is the
authoritative cache.

## Requirements

### Requirement: research_evidence_tables Schema

The system MUST create a `research_evidence_tables` table that persists
extracted tables per `source_id`. The table is the single source of
truth for table provenance in the Research Brain; both the LLM
extractor and the viewer MUST read from it, never re-extract.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.research_evidence_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  table_index INTEGER NOT NULL,
  headers JSONB NOT NULL DEFAULT '[]',
  rows JSONB NOT NULL DEFAULT '[]',
  markdown TEXT NOT NULL,
  bbox JSONB NOT NULL,
  extraction_provider TEXT NOT NULL CHECK (extraction_provider IN ('local', 'mistral')),
  extraction_confidence NUMERIC(4,3) NOT NULL CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, page, table_index)
);
```

**Column semantics:**

- `id` — UUID primary key. Surfaced as `evidence_table_id` on
  `research_bioprospecting_facts` and consumed by the viewer.
- `source_id` — parent source. CASCADE on delete so source wipes free
  the table cache.
- `page` — 1-indexed PDF page where the table was found.
- `table_index` — ordinal position of this table on the page (0-based,
  per provider). Together with `(source_id, page)` forms the uniqueness
  guard.
- `headers` — JSONB array of normalized header strings. Multi-level
  headers are flattened using the rendering rule described in
  `Headers And Empty Cells` (see below).
- `rows` — JSONB array of row arrays. Each cell is a string; empty
  cells MUST be encoded as the literal string `"-"` and never as
  `null`.
- `markdown` — pipe-rendered markdown mirror of `headers` + `rows`,
  suitable for direct injection into LLM prompts.
- `bbox` — JSONB object `{ x: number, y: number, w: number, h: number,
  page: number, units: "pt" }` in PDF point space (1pt = 1/72in). The
  viewer transforms this to render-scale at display time.
- `extraction_provider` — `'local'` or `'mistral'`. The
  `TABLE_EXTRACTION_PROVIDER` env var selects the active mode, not
  this column — this column is the audit trail of which provider
  actually produced the row.
- `extraction_confidence` — per-table confidence in `[0, 1]`. Used by
  the quality gate (see `Quality Gate And Fallback`).
- `created_at` — server timestamp at insertion.

**Indexes (partial, for source-locality lookups):**

```sql
CREATE INDEX IF NOT EXISTS idx_evidence_tables_source_page
  ON public.research_evidence_tables (source_id, page)
  WHERE table_index IS NOT NULL;
```

The unique constraint `(source_id, page, table_index)` is the
authoritative idempotency guard — re-extracting the same source/page/
table will violate the constraint and the upsert MUST treat that as
"already cached, skip".

#### Scenario: Insert a freshly extracted table

- GIVEN a `source_id` S, page 4, table_index 1 with three rows and a
  detection confidence of 0.87 from the local provider
- WHEN `persistExtractedTables` runs
- THEN a row exists in `research_evidence_tables` with
  `(source_id=S, page=4, table_index=1, headers=[...], rows=[...],
  markdown=..., bbox=..., extraction_provider='local',
  extraction_confidence=0.870)`
- AND the row is reachable by joining on `source_id` and filtering by
  `page` using the partial index

#### Scenario: Cascade delete frees the cache

- GIVEN a `research_sources` row S with N rows in
  `research_evidence_tables`
- WHEN S is deleted
- THEN all N rows for that `source_id` are removed
- AND no orphaned rows remain

#### Scenario: Unique constraint prevents duplicate table writes

- GIVEN an existing row with
  `(source_id=S, page=4, table_index=1)`
- WHEN a second insert attempts the same triple
- THEN the insert MUST fail with a unique-constraint violation
- AND the upsert helper MUST treat the violation as success (cache hit)
  and MUST NOT call the extraction provider

### Requirement: research_evidence_figures Schema

The system MUST create a `research_evidence_figures` table that
persists figure (image) provenance per `source_id`. Phase 1 records
bbox coordinates and caption only — no image file is extracted.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.research_evidence_figures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  figure_index INTEGER NOT NULL,
  bbox JSONB NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, page, figure_index)
);

CREATE INDEX IF NOT EXISTS idx_evidence_figures_source_page
  ON public.research_evidence_figures (source_id, page);
```

**Column semantics:**

- `bbox` — JSONB object in the same shape as
  `research_evidence_tables.bbox`: `{ x, y, w, h, page, units: "pt" }`.
- `caption` — best-effort text from the figure caption line, MAY be
  null when the provider cannot locate one.
- All other columns mirror the `research_evidence_tables` shape
  (same uniqueness guard, same cascade behavior).

#### Scenario: Persist a figure with caption and bbox

- GIVEN the local provider finds one image on page 2 with caption
  "Figure 3. Cell viability assay results."
- WHEN `persistExtractedFigures` runs
- THEN a row exists in `research_evidence_figures` with
  `(source_id=S, page=2, figure_index=0, bbox=..., caption='Figure 3.
  Cell viability assay results.')`

#### Scenario: Figure row without caption is allowed

- GIVEN a detected image with no caption text nearby
- WHEN persisted
- THEN `caption` is `null`
- AND the row is still inserted (bbox provenance is the supported
  unit; missing caption does not block the row)

### Requirement: Foreign Keys From research_bioprospecting_facts

The system MUST add two nullable foreign keys to
`research_bioprospecting_facts` so a fact can point at the table or
figure it was extracted from.

**Schema delta:**

```sql
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS evidence_table_id UUID
    REFERENCES public.research_evidence_tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_figure_id UUID
    REFERENCES public.research_evidence_figures(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bioprospecting_facts_evidence_table
  ON public.research_bioprospecting_facts (evidence_table_id)
  WHERE evidence_table_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bioprospecting_facts_evidence_figure
  ON public.research_bioprospecting_facts (evidence_figure_id)
  WHERE evidence_figure_id IS NOT NULL;
```

Both columns are nullable. Existing facts (without table/figure
provenance) keep `NULL`. The partial indexes support reverse lookup
("which facts were extracted from this table?") without bloating the
main facts index.

#### Scenario: Backwards-compatible column add

- GIVEN an existing `research_bioprospecting_facts` table populated by
  the legacy extractor
- WHEN the migration runs
- THEN every existing row has `evidence_table_id = NULL` and
  `evidence_figure_id = NULL`
- AND the application layer continues to function unchanged

#### Scenario: Cascade set null on table/figure delete

- GIVEN a fact F with `evidence_table_id = T`
- WHEN T is deleted from `research_evidence_tables`
- THEN F's `evidence_table_id` becomes `NULL`
- AND F is NOT deleted from `research_bioprospecting_facts`

### Requirement: Provider Abstraction And Selection

The system MUST define a provider abstraction that hides the local
and Mistral implementations behind a single
`extractPDFTables(sourceId, pdfBuffer, runId?): Promise<ExtractedTables>`
function. The active provider is selected at startup from the
`TABLE_EXTRACTION_PROVIDER` environment variable and is one of:

- `auto` — run the local provider first, then evaluate the quality
  gate; fall back to Mistral OCR if the gate fails. Mistral is
  itself subject to the cost cap; on cap hit, fall back to
  `local`.
- `local` — run the local provider only; never call Mistral.
- `mistral` — skip the local provider entirely; run Mistral OCR.
  On cost cap hit, fall back to `local` and log the cap event.

The active mode is read once at process start and held in a
module-private `getTableExtractionProvider()` accessor. The accessor
MUST export the resolved provider name (`'auto' | 'local' | 'mistral'`)
so logs and the quality gate can record the decision context.

**Provider interface (logical):**

```typescript
interface TableExtractionProvider {
  readonly name: "local" | "mistral";
  extract(pdf: Uint8Array, ctx: { runId?: string; sourceId?: string }): Promise<ExtractedTable[]>;
}

interface ExtractedTable {
  page: number;            // 1-indexed
  tableIndex: number;      // 0-based ordinal on page
  headers: string[];       // flattened per multi-level rule
  rows: string[][];        // empty cells as "-"
  bbox: { x: number; y: number; w: number; h: number; page: number; units: "pt" };
  confidence: number;      // [0, 1]
  markdown: string;        // derived from headers + rows
}
```

The orchestrator (`extractPDFTables`) handles the cache check, the
quality gate, and the cost-cap fallback; providers only do the
per-document extraction (and the Mistral provider additionally
cooperates with `costService`).

#### Scenario: auto mode runs local first

- GIVEN `TABLE_EXTRACTION_PROVIDER=auto` and a digital PDF (no
  scanned pages)
- WHEN `extractPDFTables(S, pdf)` is called and no cached tables
  exist for S
- THEN the local provider runs
- AND if its output passes the quality gate, the result is persisted
  with `extraction_provider='local'`
- AND Mistral is NOT called

#### Scenario: auto mode falls back to mistral on low confidence

- GIVEN `TABLE_EXTRACTION_PROVIDER=auto` and the local provider
  returns 1 table with average row confidence 0.32
- AND `checkCap({ provider: 'mistral_ocr', ... })` returns
  `allowed=true`
- WHEN the quality gate runs
- THEN the local result is discarded
- AND the Mistral provider is called
- AND the persisted result has `extraction_provider='mistral'`

#### Scenario: Cost cap mid-fallback → second local pass

- GIVEN `TABLE_EXTRACTION_PROVIDER=auto` and the local result
  fails the quality gate
- AND `checkCap` returns `cap_hit='day'` (daily cap already
  exhausted)
- WHEN the orchestrator runs
- THEN the local result is re-evaluated and persisted as the
  final result
- AND `event=mistral_disabled_today, provider=local,
  reason=cost_cap` is logged
- AND no Mistral API call is made

#### Scenario: local mode never calls mistral

- GIVEN `TABLE_EXTRACTION_PROVIDER=local`
- WHEN the local provider returns a low-confidence result
- THEN the local result is persisted as-is
- AND Mistral is NOT called (the gate is bypassed in `local` mode)

#### Scenario: mistral mode skips local

- GIVEN `TABLE_EXTRACTION_PROVIDER=mistral`
- WHEN `extractPDFTables(S, pdf)` is called
- THEN the local provider is NOT invoked
- AND the Mistral provider is called directly
- AND the persisted result has `extraction_provider='mistral'`

#### Scenario: Cache hit short-circuits provider calls

- GIVEN `research_evidence_tables` already has rows for `source_id`
  S
- WHEN `extractPDFTables(S, pdf)` is called
- THEN no provider is called
- AND the cached rows are returned verbatim
- AND no new rows are inserted (idempotent)

### Requirement: Local Provider (pdf-table-extractor)

The system MUST implement a `local` provider that wraps the
`pdf-table-extractor` npm package. The local provider runs entirely
in-process, makes no network calls, and is the default extraction
path for digital PDFs.

**Behavior contract:**

- The provider MUST be implemented at
  `src/services/files/pdfTableExtractor.ts` and exported as
  `class LocalTableExtractionProvider implements TableExtractionProvider`
  with `readonly name = "local"`.
- The provider MUST render each page at 1.5× zoom to compute
  `bbox` in PDF point space (the viewer uses the same scale, so the
  bboxes are render-accurate).
- The provider MUST emit `confidence` as a deterministic function
  of the row's text density (chars per cell). Empty cells count
  as 0 chars; rows where every cell is empty have confidence 0.
- The provider MUST throw `TableExtractionProviderError` on parse
  failure; the orchestrator converts that into a quality-gate
  fallback (auto mode) or a logged skip (local mode).

#### Scenario: Local provider handles a digital research PDF

- GIVEN a PDF with 2 pages, page 1 has 2 tables and page 2 has 0
  tables
- WHEN the local provider runs
- THEN it returns 2 `ExtractedTable` objects with
  `page ∈ {1, 1}`, `tableIndex ∈ {0, 1}`
- AND each table's `bbox` is in `{ x, y, w, h, page, units: "pt" }`
  shape
- AND no network calls are made (the provider runs offline)

#### Scenario: Local provider fails gracefully

- GIVEN a corrupted PDF buffer
- WHEN the local provider runs
- THEN it throws `TableExtractionProviderError` with the parser
  error wrapped
- AND the orchestrator logs `pdf_table_extraction_local_failed` with
  the `source_id`
- AND in `auto` mode, the orchestrator proceeds to Mistral
- AND in `local` mode, the orchestrator returns an empty result
  and persists no rows

### Requirement: Mistral Provider (Fallback)

The system MUST implement a `mistral` provider that wraps the
Mistral OCR API. The Mistral provider is the fallback for scanned
or low-quality PDFs and is the primary path only when
`TABLE_EXTRACTION_PROVIDER=mistral`. The provider MUST cooperate
with the `api-cost-guard-rails` capability: every `callOcr`
invocation is wrapped with a cap check and a `recordApiCall`
increment via `costService`.

**Behavior contract:**

- The provider MUST be implemented at
  `src/services/files/pdfTableExtractor.ts` and exported as
  `class MistralTableExtractionProvider implements TableExtractionProvider`
  with `readonly name = "mistral"`.
- The provider MUST call Mistral's OCR endpoint with the PDF and
  parse the structured response into `ExtractedTable[]`.
- The provider MUST emit `confidence` from Mistral's per-block
  confidence (averaged per row). When the API does not return a
  confidence, the provider defaults to `0.5`.
- The provider MUST record `extraction_provider='mistral'` in
  every persisted row, regardless of who initiated the call (auto
  fallback or direct mode).
- The provider MUST accept `runId` and `sourceId` as part of
  its call context (in addition to the PDF buffer) so the
  orchestrator can thread them into `costService.checkCap` and
  `recordApiCall`.
- The provider MUST call `costService.checkCap` before the
  Mistral API call. When `checkCap.allowed === false`, the
  provider MUST throw `CostCapExceededError({ scope: cap_hit })`
  and the orchestrator catches and falls back to `local`.
- The provider MUST call `costService.recordApiCall` after a
  successful Mistral call, passing the actual
  `pages.length` as `units` and the actual computed USD cost.

#### Scenario: Mistral provider extracts from a scanned PDF

- GIVEN a scanned PDF (image-only, no text layer) and
  `MISTRAL_API_KEY` is set
- AND `checkCap` returns `allowed=true`
- WHEN the Mistral provider runs
- THEN it returns N `ExtractedTable` objects with per-block
  confidences
- AND the result is persisted with `extraction_provider='mistral'`
- AND `recordApiCall` is called with `units=N`

#### Scenario: Mistral API key missing

- GIVEN `MISTRAL_API_KEY` is unset and the Mistral provider is
  selected
- WHEN the provider runs
- THEN it throws `TableExtractionProviderError` with a clear
  "missing MISTRAL_API_KEY" message
- AND the orchestrator logs the failure and returns the local
  result (auto) or an empty result (mistral mode)

#### Scenario: Pre-call cap check rejects the call

- GIVEN the daily cap is already exhausted
- WHEN the orchestrator calls the Mistral provider
- THEN `checkCap` returns `allowed=false`
- AND the provider throws `CostCapExceededError({ scope:
  'day' })` without calling Mistral
- AND the orchestrator falls back to the local provider
- AND logs `event=mistral_disabled_today, provider=local,
  reason=cost_cap`

#### Scenario: Post-call cap crossed mid-call

- GIVEN daily cap is $49.95 and the next call adds $0.10
- WHEN the orchestrator calls the Mistral provider
- THEN Mistral returns the result successfully
- AND `recordApiCall` returns `cap_hit='day'`
- AND the orchestrator discards the Mistral result
- AND the local provider runs
- AND `event=mistral_disabled_today` is logged

### Requirement: Quality Gate And Fallback

The system MUST apply a strict quality gate on the local provider's
output when `TABLE_EXTRACTION_PROVIDER=auto`. The gate triggers a
Mistral fallback when the local result is "too thin to be useful".

**Quality gate rules** (any one triggers fallback):

- **Low table count**: total returned tables < 3 across the
  whole document. Reason code: `low_table_count`.
- **Low row confidence**: average of all per-row confidences <
  0.5. Reason code: `low_row_confidence`.

**Behavior:**

- The gate runs ONLY in `auto` mode. In `local` mode, the local
  result is persisted regardless of confidence. In `mistral` mode,
  the gate is bypassed entirely.
- The gate MUST log every decision with the structured event
  `pdf_table_extraction_quality_gate` carrying
  `{ source_id, reason: "low_table_count" | "low_row_confidence" |
  "passed", tables: number, avgConfidence: number, provider: "local"
  | "mistral" }`.
- When the gate fails, the local result is discarded (not
  persisted) and the Mistral provider runs. The persisted row's
  `extraction_provider` is `'mistral'`.
- When the gate passes, the local result is persisted with
  `extraction_provider='local'`.

#### Scenario: Gate passes on healthy local result

- GIVEN local provider returns 4 tables, average row confidence
  0.78
- WHEN the gate runs
- THEN the gate emits
  `pdf_table_extraction_quality_gate{reason:"passed",
  tables:4, avgConfidence:0.78, provider:"local"}`
- AND the result is persisted as `extraction_provider='local'`

#### Scenario: Gate fails on low table count

- GIVEN local provider returns 1 table, average row confidence 0.9
- WHEN the gate runs
- THEN the gate emits
  `pdf_table_extraction_quality_gate{reason:"low_table_count",
  tables:1, avgConfidence:0.9, provider:"local"}`
- AND the local result is discarded
- AND the Mistral provider runs
- AND the persisted result has `extraction_provider='mistral'`

#### Scenario: Gate fails on low row confidence

- GIVEN local provider returns 5 tables, average row confidence
  0.32
- WHEN the gate runs
- THEN the gate emits
  `pdf_table_extraction_quality_gate{reason:"low_row_confidence",
  tables:5, avgConfidence:0.32, provider:"local"}`
- AND the local result is discarded
- AND the Mistral provider runs

#### Scenario: Gate bypassed in local mode

- GIVEN `TABLE_EXTRACTION_PROVIDER=local` and the local result
  fails the gate
- WHEN the orchestrator runs
- THEN the local result is persisted as-is
- AND the gate decision is logged for observability but does NOT
  trigger a fallback

### Requirement: Headers And Empty Cells

The system MUST preserve multi-level headers (e.g., parent units
spanning child columns) and MUST render empty cells consistently
in the persisted row data, the markdown mirror, and the LLM-facing
prompt section.

**Multi-level header rendering rule:**

- When a parent span (e.g., "Treatment") covers N child columns
  (e.g., "Control [mg/mL]", "Dose [mg/mL]"), the flattened
  header for each child column is rendered as
  `**{parent}** | {child}` — the parent in bold, a single pipe
  separator, then the child text.
- When a column has no parent span, the flattened header is the
  raw child text (no leading `**|**` prefix).
- The flattened form is what lands in `headers` JSONB and in the
  `markdown` mirror.

**Empty cell rule:**

- Empty cells in `rows` JSONB MUST be encoded as the literal
  string `"-"` and never as `null` or empty string.
- The same rule applies to the markdown mirror: empty cells render
  as `-`.
- The rule is non-negotiable — downstream LLM prompts depend on
  every cell being a string so the LLM can `trim()` and pattern-
  match without null checks.

#### Scenario: Multi-level header flattened correctly

- GIVEN a header where "Treatment" spans two children
  "Control [mg/mL]" and "Dose [mg/mL]"
- WHEN the provider flattens headers
- THEN the resulting `headers` array is
  `["**Treatment** | Control [mg/mL]", "**Treatment** | Dose [mg/mL]"]`
- AND the markdown mirror renders those headers verbatim

#### Scenario: Empty cells become "-"

- GIVEN a row with three cells where the middle cell is empty
- WHEN the provider persists the row
- THEN the persisted `rows` entry is `["3.2", "-", "8.1"]`
- AND the markdown mirror renders that row as `| 3.2 | - | 8.1 |`

#### Scenario: Headers without parents keep raw child text

- GIVEN a column with no parent span and child text "IC50 [μM]"
- WHEN the provider flattens headers
- THEN the entry is `"IC50 [μM]"` (no leading `**|**`)

### Requirement: Bbox Coordinate Space

The system MUST store all bbox coordinates in PDF point space
(`units: "pt"`, 1pt = 1/72in) and MUST render the PDF at a fixed
1.5× scale in the viewer so the same coordinates can be transformed
to screen pixels without per-document scale drift.

**Bbox shape (canonical):**

```typescript
type BBox = {
  x: number;      // top-left x in PDF points
  y: number;      // top-left y in PDF points
  w: number;      // width in PDF points
  h: number;      // height in PDF points
  page: number;   // 1-indexed page number
  units: "pt";
};
```

**Render-time transform (viewer responsibility, not this spec):**

- The viewer renders the PDF page at 1.5× scale.
- To overlay a highlight, the viewer multiplies `x`, `y`, `w`, `h`
  by 1.5 to get pixel coordinates on its canvas.
- The transform is a constant; it MUST NOT be parameterized per
  document in this spec's scope.

#### Scenario: Bbox is stored in point space

- GIVEN a table whose top-left corner is at (72, 144) in PDF
  points and is 216 points wide
- WHEN the provider persists the table
- THEN the stored `bbox` is
  `{ x: 72, y: 144, w: 216, h: ..., page: N, units: "pt" }`
- AND `units` is the literal string `"pt"`

### Requirement: Idempotent Extraction And Cache Source

The system MUST treat `research_evidence_tables` as the source of
truth for table provenance and MUST guarantee idempotency on
re-extraction.

**Rules:**

- On `extractPDFTables(S, pdf)` for a `source_id` S that already
  has rows in `research_evidence_tables`, the function MUST:
  - Return the cached rows.
  - Make ZERO calls to any extraction provider.
  - Make ZERO calls to Mistral.
  - Make ZERO writes to `research_evidence_tables`.
- The cache check is by `source_id` (not by `(source_id, page)`)
  — if ANY row exists for S, the entire source is treated as
  cached. This is intentional: table extraction is a whole-
  document operation, not a per-page one, and partial re-
  extraction has no defined semantics in Phase 1.
- Forcing a re-extraction (e.g., a manual admin trigger) MUST
  delete all existing rows for the `source_id` first and then
  re-run the provider. The forced path is a separate admin-only
  endpoint, not a default code path.

#### Scenario: Repeated extraction is a cache hit

- GIVEN `research_evidence_tables` has 3 rows for `source_id` S
  from a previous local extraction
- WHEN `extractPDFTables(S, pdf)` is called
- THEN those 3 rows are returned as-is
- AND no provider call is logged
- AND no INSERT runs against `research_evidence_tables`

#### Scenario: Forced re-extraction clears the cache

- GIVEN an admin invokes the forced re-extraction endpoint for
  S, and S has 3 existing rows
- WHEN the endpoint runs
- THEN all 3 rows for S are deleted
- AND the provider runs
- AND the persisted count matches the provider's output count

### Requirement: Prompt Injection Of Extracted Tables

The system MUST expose a helper
`buildTablesPromptSection(tables: ExtractedTable[]): string` that
renders cached tables as a `tables:` block suitable for injection
into the bioprospecting LLM prompt. The helper MUST be exported
from `src/services/files/pdfTableExtractor.ts` and is the contract
that connects extraction output to the extractor in
`research-bioprospecting` (see that capability's modified
requirements).

**Format contract:**

```text
tables:
  page=4 table=0
  | **Treatment** | Control [mg/mL] | Dose [mg/mL] |
  | --- | --- | --- |
  | 0 | - | 1.2 |
  | 24 | 3.1 | 5.4 |
  page=5 table=0
  | Species | IC50 [μM] |
  | --- | --- |
  | A. vera | 12.4 |
```

- Tables are grouped by `page` in ascending order; within a page,
  ordered by `table_index` ascending.
- Each table is preceded by `page={N} table={M}` on its own line.
- Empty cells render as `-` (consistent with the persisted shape).
- The function is pure: it does not read from the database; it
  transforms already-loaded `ExtractedTable` objects. The caller
  is responsible for the load.

#### Scenario: buildTablesPromptSection renders deterministic output

- GIVEN two tables (page 4 table 0 and page 5 table 0) loaded from
  the cache
- WHEN `buildTablesPromptSection(tables)` is called
- THEN the output starts with the literal line `tables:`
- AND each table is preceded by `page=N table=M`
- AND empty cells render as `-`

#### Scenario: buildTablesPromptSection on empty input

- GIVEN an empty `tables` array (no cached tables for the source)
- WHEN `buildTablesPromptSection([])` is called
- THEN the result is the empty string
- AND callers can concatenate the result with the prose section
  without special-casing

## ADDED Requirements (cost-guard-rails delta)

This section is the delta introduced by the `cost-guard-rails`
change. The pre-delta contract above is preserved unchanged. The
delta is additive: the orchestrator gains a cost-cap fallback
path through `costService`; the existing `Provider Abstraction
And Selection` and `Mistral Provider (Fallback)` requirements are
amended to thread `runId`/`sourceId` through and to cooperate with
`costService.checkCap` and `recordApiCall`. The new requirement
below specifies the orchestrator's behavior when a cap is hit.

### Requirement: Orchestrator Handles CostCapExceededError

The `pdfTableExtractor` orchestrator MUST wrap every call to
`MistralTableExtractionProvider.callOcr` with the `costService`
cap check (`checkCap`) and increment (`recordApiCall`) calls
defined in the `api-cost-guard-rails` capability. When the cap
is hit, the orchestrator MUST catch the
`CostCapExceededError` and transparently fall back to the
`local` provider for the rest of the run. The fallback MUST
NOT raise an error to the caller; the run continues with the
local result.

**Behavior:**

- Before calling `mistralOcrProvider.callOcr`, the orchestrator
  MUST call `costService.checkCap({ provider: 'mistral_ocr',
  estimatedCostUsd: pdf.byteLength / 100_000 * costPerPage,
  sourceId, runId })`.
- If `checkCap.allowed === false` for ANY cap scope (run,
  source, day, month), the orchestrator MUST short-circuit to
  the local provider WITHOUT calling Mistral.
- If `checkCap.allowed === true`, the orchestrator calls
  Mistral. On the way out, it MUST call
  `costService.recordApiCall({ provider: 'mistral_ocr',
  units: pages.length, costUsd: actualCost, sourceId, runId })`.
- If `recordApiCall` returns `cap_hit !== null` (cap crossed
  mid-call), the orchestrator MUST discard the Mistral result
  and run the local provider, then log the cap-hit event.
- When the local provider runs as a cost-driven fallback (not
  a quality-gate fallback), the persisted rows MUST carry
  `extraction_provider='local'` and the reason MUST be
  `provider=local, reason=cost_cap` in the
  `pdf_table_extraction_quality_gate` log event.
- The orchestrator MUST respect the
  `globalThis.__mistralOcrDisabledToday__` and
  `__mistralOcrDisabledThisMonth__` flags set by
  `costService` after a cap hit, and MUST short-circuit to
  `local` without calling `checkCap` again until the flag
  resets.

#### Scenario: Per-day cap → transparent local fallback

- GIVEN daily Mistral cost has reached
  `MISTRAL_OCR_DAILY_COST_CAP_USD=50`
- WHEN the orchestrator processes the next source in the run
- THEN `checkCap.allowed` is `false`
- AND the orchestrator calls the local provider
- AND the local result is persisted with
  `extraction_provider='local'`
- AND a WARN log is emitted with
  `event=mistral_disabled_today, provider=local,
  reason=cost_cap`

#### Scenario: Pre-call estimate exceeds per-source cap

- GIVEN a 5 MB PDF (estimate 50 pages, $2.50) and
  `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD=2`
- WHEN the orchestrator runs `checkCap` for source S
- THEN `wouldHitPerSource=true` is returned
- AND the orchestrator skips Mistral and uses the local
  provider
- AND a WARN is logged with `event=mistral_cap_source_exceeded,
  sourceId=S`

#### Scenario: Monthly cap → ERROR log + local fallback

- GIVEN monthly Mistral cost has reached
  `MISTRAL_OCR_MONTHLY_COST_CAP_USD=1000`
- WHEN the orchestrator processes the next source
- THEN `checkCap.allowed` is `false`
- AND the local provider runs
- AND an ERROR is logged with
  `event=mistral_disabled_this_month, provider=local,
  reason=cost_cap`

#### Scenario: Provider-disabled flag short-circuits subsequent calls

- GIVEN `globalThis.__mistralOcrDisabledToday__ === true`
  (set earlier in the same process)
- WHEN the orchestrator processes a new source
- THEN it does NOT call `checkCap`
- AND it calls the local provider directly
- AND the `mistral_disabled_today` log is NOT re-emitted in
  the same day

## ADDED Requirements (figure-image-extraction delta)

This section is the delta introduced by the `figure-image-extraction`
change. The pre-delta contract above is preserved unchanged. The
delta is additive: the orchestrator chains a figure-image extraction
pass after the table-extraction pass; the figure persistence path
gains five nullable image columns; the local provider's return type
gains additive image fields (all `null` in the local provider); the
Mistral provider flips `include_image_base64: true`; and the
cache-source rule extends to the new image columns with a write-once
guard.

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

## MODIFIED Requirements (figure-image-extraction delta)

The following pre-existing requirements are amended by this delta.
The "(Previously: ...)" notes capture the pre-delta contract that
the delta preserves.

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
