# Design: Bioprospecting PDF Provenance Viewer

> Companion to the `proposal.md` and the three `specs/*/spec.md` files in this
> change. This document captures the technical design — module structure,
> interfaces, data flow, and tradeoffs — that the implementer needs to ship
> the change in three chained PRs.
>
> **Revision v2 (2026-06-13):** the original design used `pdf-table-extractor@1.0.3`
> for the local provider. That package failed spike testing — it pins
> `pdfjs-dist@1.10.100` (2016, v1 API) which calls `canvas.getContext` at load
> time, and Bun in this environment has no working `canvas` runtime. v2 swaps
> that single package for a custom detector built on `pdfjs-dist@5` legacy
> build, which runs in pure JS, no canvas, no worker. The schema, provider
> interface, quality gate, prompt builder, persistence path, extractor
> integration, and PR boundaries are unchanged. See §2.1 for the new dep
> story and §3.2 for the new local provider design. The original design is
> preserved as `design.original.md` for the audit trail.

## 1. Goals & Constraints (Recap)

- Make every bioprospecting fact auditable in one click.
- Persist extracted tables in a source-of-truth table
  (`research_evidence_tables`) and use it as the read cache; no re-extraction
  on subsequent calls.
- Ship a strict quality gate: `auto` mode runs the local provider, falls
  back to Mistral OCR only when the local result is "too thin to be
  useful" (`< 3` tables OR `avg row confidence < 0.5`).
- Render the source PDF in two surfaces — a Preact lightbox (inline) and
  a dedicated route (`/viewer/:sourceId` and the library form
  `/library/:docId/viewer`) — both backed by PDF.js at a fixed 1.5×
  scale.
- Multi-level headers preserved, empty cells encoded as `"-"`.
- v1 is read-only (selection + copy; no inline editing).

## 2. Dependency Decisions

### 2.1 New npm dependencies

| Package | Purpose | Why |
|---|---|---|
| `pdfjs-dist@5` | **Both** backend table detection (PR #1) and frontend PDF rendering (PR #2) | The original design split this into two packages: `pdf-table-extractor` (PR #1, local provider) and `pdfjs-dist` (PR #2, frontend viewer). v2 collapses them: a single dep, `pdfjs-dist@5`, serves both roles. It is **already** installed transitively via `pdf-parse@2.4.5` at version `5.4.296` (verified by reading `node_modules/pdfjs-dist/package.json`). No new direct dep needs to be added to `package.json` for the backend — only the frontend import in `client/src/lib/pdfjs.ts` will pin it. The legacy build (`pdfjs-dist/legacy/build/pdf.mjs`) is the right server-side entry point (pure JS, no canvas, no worker). The standard build (`pdfjs-dist/build/pdf.mjs`) is the right frontend entry point (uses the worker). |
| `@mistralai/mistralai` (or `fetch` only) | Mistral OCR HTTP client (PR #1) | Same as before. Use plain `fetch` from Bun; no SDK. |

**Why we dropped `pdf-table-extractor` (v2 change):**

- That package's public API does not expose bboxes — only `{ page, tables, merges, width, height }`. Bbox would have to be re-derived from `getTextContent` per cell, defeating the wrapper's purpose.
- It pins `pdfjs-dist@1.10.100` (from 2016, v1 API). At load time it calls `canvas.getContext('2d')` to measure glyph widths. The bare `canvas@3.2.3` package fails to load in this Bun environment (`Cannot find module '../build/Release/canvas.node'`) and the canvas-polyfill in `src/utils/canvas-polyfill.ts` only patches `DOMMatrix` and `ImageData` — it does NOT expose `getContext`. So the package's table detection returns NaN viewports and the result is unusable.
- The custom detector on `pdfjs-dist@5` legacy build runs without canvas or worker, takes a few lines of pure-JS code, and gives us bboxes natively (text items already have `transform` matrices with x, y, width, height). Verified end-to-end with a hand-rolled test PDF containing 6 known text items at known coordinates — all 6 returned with correct positions (spike report in Engram: `sdd/bioprospecting-pdf-provenance-viewer/spike-v5-success`).

### 2.2 No new runtime dependencies

- The `marked` library is **already** a dependency (`marked@^16.4.1`). The
  prompt-injection helper `buildTablesPromptSection` in
  `src/services/files/pdfTableExtractor.ts` does **not** need `marked` —
  it emits the `tables:` block as a hand-rolled pipe-rendered string,
  matching the spec's exact format. `marked` stays out of the hot path.
- The Mistral OCR response is markdown. We do **not** parse it back into
  tables with `marked` — we store the markdown alongside the parsed
  table object so the LLM can use the structured rows OR fall back to
  the markdown. This avoids a parser and keeps the contract simple.
- The lightbox is a custom Preact component built on top of the
  existing `useResearchBrain` hook patterns. No third-party modal
  library.

### 2.3 `Bun.file()` and worker modules

The local PDF processor runs in-process on the API server. The
custom detector uses `pdfjs-dist@5/legacy/build/pdf.mjs`, which
runs on the main thread with no worker and no canvas. We do **not**
import `src/utils/canvas-polyfill` in the provider path because
text extraction (`getTextContent`) does not touch the canvas APIs
that the polyfill patches. The polyfill is still imported at the
top of `src/index.ts` and `src/worker.ts` (per `CLAUDE.md`'s
"Canvas Polyfill" note) so other parts of the codebase that need
it keep working — the new provider is independent.

## 3. Backend Module Structure

All new code lives under `src/services/files/` and `src/routes/`.
No new top-level package; the change stays under the existing files
namespace.

```
src/services/files/
├── pdfTableExtractor.ts          # NEW — provider abstraction + orchestrator
│                                 #   (TableExtractionProvider interface,
│                                 #    LocalTableExtractionProvider,
│                                 #    MistralTableExtractionProvider,
│                                 #    buildTablesPromptSection,
│                                 #    TableExtractionProviderError)
├── qualityGate.ts                # NEW — quality gate algorithm
├── providers/
│   ├── localPdfTableProvider.ts  # NEW — custom detector on pdfjs-dist@5 legacy
│   │                             #         (no canvas, no worker)
│   └── mistralOcrProvider.ts     # NEW — Mistral OCR HTTP client
├── pdfTablePromptBuilder.ts      # NEW — pure: ExtractedTable[] -> "tables:" string
├── description.ts                # UNCHANGED — already has extractPDFText / extractImageContent
├── index.ts                      # UNCHANGED
├── status.ts                     # UNCHANGED
└── queue.ts                      # UNCHANGED

src/routes/
├── research-brain.ts             # MODIFIED — add 3 new endpoints
└── viewer.ts                     # NEW — lightbox JSON shape (same as research-brain evidence endpoint)

src/services/researchBrain/
├── tables.ts                     # NEW — loadTablesForSource(sourceId) thin read wrapper
├── bioprospectingExtractor.ts    # MODIFIED — inject tables: section, populate evidence_table_id
├── db.ts                         # MODIFIED — accept evidence_table_id through replaceBioprospectingFactsForSource
└── index.ts                      # MODIFIED — export new symbols
```

### 3.1 `src/services/files/pdfTableExtractor.ts` (orchestrator)

Exports:

```ts
// Provider abstraction (logical, per spec)
export interface BBox {
  x: number; y: number; w: number; h: number; page: number; units: "pt";
}

export interface ExtractedTable {
  page: number;          // 1-indexed
  tableIndex: number;    // 0-based ordinal on page
  headers: string[];     // flattened per multi-level rule
  rows: string[][];      // empty cells as "-"
  bbox: BBox;
  confidence: number;    // [0, 1]
  markdown: string;      // derived from headers + rows
}

export interface ExtractedFigure {
  page: number;
  figureIndex: number;
  bbox: BBox;
  caption: string | null;
}

export interface TableExtractionProvider {
  readonly name: "local" | "mistral";
  extract(pdf: Uint8Array): Promise<ExtractedTable[]>;
  extractFigures?(pdf: Uint8Array): Promise<ExtractedFigure[]>;
}

export class TableExtractionProviderError extends Error {
  constructor(message: string, public readonly cause?: unknown) { super(message); }
}

// Public orchestrator: cache-aware + quality-gated.
export async function extractPDFTables(
  sourceId: string,
  pdf: Uint8Array,
): Promise<{ tables: ExtractedTable[]; figures: ExtractedFigure[]; provider: "local" | "mistral" | "cache"; }>;

// Provider selector — read TABLE_EXTRACTION_PROVIDER once at module load.
export function getTableExtractionProviderMode(): "auto" | "local" | "mistral";
export function getActiveProviderName(): "local" | "mistral" | "cache";

// Persistence helpers
export async function persistExtractedTables(
  sourceId: string,
  tables: ExtractedTable[],
  provider: "local" | "mistral",
): Promise<ResearchEvidenceTableRow[]>;

export async function persistExtractedFigures(
  sourceId: string,
  figures: ExtractedFigure[],
): Promise<ResearchEvidenceFigureRow[]>;

export async function loadTablesForSource(sourceId: string): Promise<ExtractedTable[]>;
export async function loadFiguresForSource(sourceId: string): Promise<ExtractedFigure[]>;
export async function clearExtractedTablesForSource(sourceId: string): Promise<void>;

// Prompt helper
export function buildTablesPromptSection(tables: ExtractedTable[]): string;
```

Module-private state lives behind `globalThis` to avoid Bun-worker
TDZ issues (see `CLAUDE.md`'s "TDZ in Worker Processes"). The active
mode is memoized:

```ts
function resolveMode(): "auto" | "local" | "mistral" {
  let cached = (globalThis as any).__tableExtractionMode;
  if (cached) return cached;
  const raw = (process.env.TABLE_EXTRACTION_PROVIDER || "auto").toLowerCase();
  const mode = (raw === "local" || raw === "mistral") ? raw : "auto";
  (globalThis as any).__tableExtractionMode = mode;
  return mode;
}
```

### 3.2 `src/services/files/providers/localPdfTableProvider.ts`

Custom detector built on `pdfjs-dist@5` legacy build. No
`pdf-table-extractor`, no canvas, no worker. The provider walks
the PDF's text content directly and infers table structure from
spatial clustering.

**Algorithm (per page, repeated for every page in the PDF):**

1. Load the page with `pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise`.
2. Call `page.getTextContent()` and walk every `TextItem`. Each item carries:
   - `str: string` — the visible text run (whitespace-only items are filtered out).
   - `transform: [a, b, c, d, e, f]` — 2D affine. For horizontal text the first four entries are `[fontSize, 0, 0, fontSize, x, y]` where `x, y` is the bottom-left corner of the run in PDF points.
   - `width: number`, `height: number` — measured glyph extents in PDF points.
3. **Row clustering:** bucket items by their `y` coordinate using a tolerance (`Y_TOLERANCE_PT = 2`). Items within `Y_TOLERANCE_PT` of each other are on the same row. The row anchor is the median `y` of its items. Rows are returned sorted top-to-bottom in canvas coordinates (highest `y` first → lowest `y` last).
4. **Cell segmentation within a row:** sort the row's items by `x`. For each item, if its `x` is within `X_TOLERANCE_PT = 4` of the previous item's `x + width`, it belongs to the same cell (text run continuation). Otherwise it starts a new cell. The cell text is the concatenation of its items, trimmed.
5. **Header detection:** a row is a header candidate when the row above it (if any) has fewer columns AND the same first cell's text is a category/group label rather than data. The simplest robust heuristic for v2: a row is a header if it sits in the top 1–2 rows of a page AND every cell is short (length ≤ `MAX_HEADER_CELL_CHARS = 40`). For multi-level headers, the first detected header row becomes "level 1" and any additional header row immediately below becomes "level 2". When the row index in the page is `> 2`, all rows below are body rows.
6. **Empty cells:** the segmenter naturally produces empty cells when a column has no text in a body row. They are normalized to `"-"` at output time, matching the spec.
7. **Multi-level headers (flattening):** when two header rows are detected, the final `headers` array interleaves them: `["L1 col1", "L1 col2", "L2 col1 of L1 col2", "L2 col2 of L1 col2", ...]`. This is the spec's "flattened per multi-level rule" output. If the lower row has fewer cells than the upper row (a "spans multiple columns" pattern), the upper cells are repeated for each lower cell within their span.
8. **Bbox computation:** for each detected table, the bbox is the union of every cell's `(x, y, width, height)` in PDF point space, computed in canvas coords: `minX = min(cell.x)`, `minY = min(cell.y)`, `maxX = max(cell.x + cell.width)`, `maxY = max(cell.y + cell.height)`. The bbox is then normalized to PDF native space (origin bottom-left): `pdfY = pageHeightPt - canvasMaxY`, `pdfHeight = canvasMaxY - canvasMinY`. This matches the coordinate system the viewer at 1.5× scale expects.
9. **Confidence:** per-row confidence is `min(1, totalChars / (numCells * 8))` (matches the design's existing formula, deterministic). The table's overall confidence is the mean of its row confidences. Tables with 0 body rows get confidence 0.

**Output contract:**

- `ExtractedTable[]` per the interface in §3.1. The Markdown is built from
  the flat headers and rows by a small local helper.
- `extractFigures` returns `[]` (figures are not detected by the
  heuristic). The spec explicitly defers figure extraction to Mistral.
- Throws `TableExtractionProviderError` on any `pdfjs` failure or
  page-load error.

**Why no canvas:** the legacy build of `pdfjs-dist@5` runs in pure
JS for text extraction — no `getContext` calls, no `Path2D`, no
`ImageData`. The polyfill at `src/utils/canvas-polyfill.ts` is
**not** imported by the provider; it is only needed by the parts of
`pdf-parse` that render glyph bitmaps. The provider file imports
`pdfjs-dist/legacy/build/pdf.mjs` only.

**Why no worker:** the legacy build is single-threaded by design
(it's a CommonJS-style fallback for environments without web
workers). Text extraction for a 50-page research PDF takes a few
hundred ms on a single thread — fast enough that the worker
optimization is not worth the bundling complexity on the server
side. The frontend viewer (PR #2) does use a worker because that
is where rendering performance matters.

**Why a custom detector and not a newer library:** every
off-the-shelf PDF table extractor (Tabula, Camelot, pdfplumber,
`pdf-table-extractor` v2+) either requires a JVM, a Python runtime,
or pulls in a `canvas` native binding. None of those are
acceptable for a Bun-only deployment. A 200-line custom detector
on the data `pdfjs` already gives us is the right tradeoff.

### 3.3 `src/services/files/providers/mistralOcrProvider.ts`

Pure `fetch` HTTP client. Endpoint:

```
POST https://api.mistral.ai/v1/ocr
Authorization: Bearer ${MISTRAL_API_KEY}
Content-Type: application/json
```

Request body shape (Mistral OCR v1, see
<https://docs.mistral.ai/capabilities/OCR/>):

```json
{
  "model": "mistral-ocr-latest",
  "document": {
    "type": "document_url",
    "document_url": "<data:application/pdf;base64,...>"  // or https url
  },
  "include_image_base64": false
}
```

Response shape (paraphrased):

```json
{
  "pages": [
    {
      "index": 0,
      "markdown": "# Page 1\n\n| Treatment | Control [mg/mL] | Dose [mg/mL] |\n| --- | --- | --- |\n| 0 | - | 1.2 |\n...",
      "tables": [ /* structured alt to markdown if Mistral returns them */ ],
      "images": [{ "bbox": { "x": 100, "y": 200, "w": 300, "h": 220 }, "caption": "Figure 3. ..." }]
    }
  ]
}
```

Parsing strategy (chosen to avoid a markdown-table parser):

- If Mistral returns the structured `pages[i].tables` array, use it
  directly and **also** derive the markdown by passing the rows
  through `renderTableToMarkdown` (a small local helper in this
  file).
- If Mistral only returns `pages[i].markdown`, we store the markdown
  mirror but **do not parse it back into rows**. The `rows` and
  `headers` arrays in `ExtractedTable` are best-effort empty in that
  case, and `confidence` defaults to `0.5` (per spec). The LLM prompt
  uses the markdown, not the row arrays, so this degrades gracefully.
- Bbox: Mistral returns bboxes in pixel coordinates relative to the
  rendered page (typically at the OCR rasterization resolution). The
  adapter divides by Mistral's `DPI / 72` to convert to PDF points.
  The viewer at 1.5× scale then multiplies by 1.5 — the chain is
  well-defined.
- Per-row confidence: averaged from Mistral's per-block confidence
  when available; defaults to `0.5` otherwise.

Throws `TableExtractionProviderError` with the original message when
`MISTRAL_API_KEY` is unset or the API returns non-2xx.

### 3.4 `src/services/files/qualityGate.ts`

Pure function. Decision matrix (per spec):

```ts
export type QualityGateDecision =
  | { action: "pass"; reason: "passed"; tables: number; avgConfidence: number }
  | { action: "fallback"; reason: "low_table_count"; tables: number; avgConfidence: number }
  | { action: "fallback"; reason: "low_row_confidence"; tables: number; avgConfidence: number };

export function evaluateQualityGate(tables: ExtractedTable[]): QualityGateDecision {
  const tableCount = tables.length;
  const allRows = tables.flatMap((t) => t.rows);
  const rowConfidences = tables.flatMap((t) =>
    t.rows.map((row) => rowConfidence(row)),
  );
  const avgConfidence =
    rowConfidences.length === 0
      ? 0
      : rowConfidences.reduce((a, b) => a + b, 0) / rowConfidences.length;

  if (tableCount < 3) {
    return { action: "fallback", reason: "low_table_count", tables: tableCount, avgConfidence };
  }
  if (avgConfidence < 0.5) {
    return { action: "fallback", reason: "low_row_confidence", tables: tableCount, avgConfidence };
  }
  return { action: "pass", reason: "passed", tables: tableCount, avgConfidence };
}

function rowConfidence(row: string[]): number {
  const totalChars = row.reduce((n, cell) => n + (cell === "-" ? 0 : cell.length), 0);
  return Math.min(1, totalChars / Math.max(1, row.length * 8));
}
```

The orchestrator wraps the call with a `pino` log event named
`pdf_table_extraction_quality_gate` carrying
`{ source_id, reason, tables, avgConfidence, provider }`.

### 3.5 `src/services/files/pdfTablePromptBuilder.ts`

Pure function. Emits the exact format from the spec:

```ts
export function buildTablesPromptSection(tables: ExtractedTable[]): string {
  if (tables.length === 0) return "";
  const grouped = groupByPageAsc(tables);  // (page asc, tableIndex asc)
  const lines: string[] = ["tables:"];
  for (const { page, tableIndex, headers, rows } of grouped) {
    lines.push(`  page=${page} table=${tableIndex}`);
    lines.push(renderHeaderRow(headers));
    lines.push(renderSeparator(headers.length));
    for (const row of rows) lines.push(renderDataRow(row));
  }
  return lines.join("\n");
}
```

- `renderHeaderRow(["**Treatment** | Control [mg/mL]", "**Treatment** | Dose [mg/mL]"])`
  → `| **Treatment** | Control [mg/mL] | **Treatment** | Dose [mg/mL] |`
  (each flattened header is one cell).
- `renderDataRow(["3.2", "-", "8.1"])` → `| 3.2 | - | 8.1 |`.
- `renderSeparator(n)` → `| --- | --- | ... |` with `n` separators.

### 3.6 `src/services/researchBrain/tables.ts`

Thin read wrapper. Centralizes the loader so the extractor, the
viewer endpoint, and any future caller share the same query shape:

```ts
export async function loadTablesForSource(sourceId: string): Promise<ExtractedTable[]>;
export async function loadFiguresForSource(sourceId: string): Promise<ExtractedFigure[]>;
```

Both return data shaped for `buildTablesPromptSection` and the viewer
endpoints; they map JSONB columns to TS shapes.

## 4. Schema Migrations

One new migration file, timestamped after the last existing migration
(`20260610000000_create_bioprospecting_contradictions.sql`):

```
supabase/migrations/20260612000000_create_research_evidence_tables.sql
```

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

CREATE INDEX IF NOT EXISTS idx_evidence_tables_source_page
  ON public.research_evidence_tables (source_id, page)
  WHERE table_index IS NOT NULL;

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

Forward-compatibility note: the unique constraint
`(source_id, page, table_index)` is the authoritative idempotency
guard. The upsert path catches PG error `23505` and treats it as a
cache hit (idempotent re-extraction, per the "Idempotent Extraction
And Cache Source" requirement).

## 5. Data Flow

### 5.1 Extraction (PR #1, server-side)

```
                                                                 ┌──────────────────┐
   ┌────────────────────────┐    extractPDFTables(S, pdf)         │ Local Provider   │
   │ ingest worker / admin  │ ──────────────────────────────────▶ │ pdf-table-       │
   │ re-extract trigger     │                                      │   extractor      │
   └────────────────────────┘                                      └────────┬─────────┘
                                                                            │ ExtractedTable[]
                                                                            ▼
                                                                 ┌──────────────────┐
                                                                 │ qualityGate.ts   │
                                                                 └────┬────────┬────┘
                                                pass (local) ◀────────┘        │
                                                                          fail  │
                                                                            ▼    ▼
                                                                 ┌──────────────────┐
                                                                 │ Mistral Provider │
                                                                 └────────┬─────────┘
                                                                          │ ExtractedTable[]
                                                                          ▼
                                                                 ┌──────────────────────────┐
                                                                 │ persistExtractedTables   │ ──▶ research_evidence_tables
                                                                 │                          │ ──▶ research_evidence_figures
                                                                 └──────────────────────────┘
```

Cache check runs first. If `loadTablesForSource(S)` returns N > 0 rows,
the orchestrator returns them tagged `provider: "cache"` and the
diagram collapses to a single DB read.

### 5.2 Bioprospecting LLM prompt (PR #1, `bioprospectingExtractor.ts`)

```
llmFactsForChunkBatch(title, doi, chunks)
  │
  ├─ loadTablesForSource(sourceId)         ←── new, from src/services/researchBrain/tables.ts
  │     │
  │     └─▶ buildTablesPromptSection(tables)  ←── new, from pdfTablePromptBuilder.ts
  │
  ├─ Inject "tables:" section into the prompt BEFORE the "Chunks:" section
  │     (when the section is non-empty)
  │
  ├─ Inject the "prefer tables over prose" rule into the "Strict rules" list
  │     (rule 6 in the numbered list — comes after measurementMin / measurementMax)
  │
  └─ LLM emits facts with optional sourceTableRef = { page, tableIndex, rowIndex }
        │
        └─▶ normalizeFacts
              │
              └─▶ resolve sourceTableRef → evidence_table_id (UUID lookup)
                    │ missing lookup → drop silently, log bioprospecting_table_ref_missing
                    └─▶ evidence_table_id lands on the persisted row
```

`replaceBioprospectingFactsForSource` already builds a payload
object; we add `evidence_table_id` to the payload and let the
existing inline merge carry it through. The merge's
`pickCanonicalIndex` and `insertCanonicalWithReroute` paths
**preserve** `evidence_table_id` end-to-end (per the "Merge
preserves evidence_table_id" scenario): a sibling with a different
`evidence_table_id` keeps its own; the canonical keeps its own.
No new merge logic is needed — the column is just another field.

### 5.3 Viewer (PR #2 / PR #3, client + server)

```
User clicks fact citation  ──▶  data-provenance-trigger fires
                                        │
                                        ▼
                              fetch GET /api/research-brain/facts/:factId/provenance
                                        │
                                        ▼
                              EvidenceLightbox mounts with provenance response
                                        │
                                        ▼
                              fetch GET /api/research-brain/sources/:sourceId/pdf  (binary)
                                        │
                                        ▼
                              PDF.js renders at scale 1.5
                                        │
                                        ▼
                              Overlay positions highlight divs:
                                  • table  → 1.5× bbox, blue border
                                  • figure → 1.5× bbox, purple border
                                  • chunk  → text-layer search hit, yellow
                                  • text-only → no overlay, badge only
                                        │
                              ┌─────────┴──────────┐
                              │                    │
                              ▼                    ▼
                  Esc → close lightbox    "Open in tab" button
                  (state ephemeral)        (new tab: /viewer/S#bbox=…&page=…&type=…)
```

The dedicated `/viewer/:sourceId` and `/library/:docId/viewer` routes
mount the same `<EvidenceViewer />` component (a shared child) — the
only difference is the URL form and which sourceId the route binds.

## 6. API Endpoints

All three endpoints are added to the existing
`src/routes/research-brain.ts` Elysia router under
`/api/research-brain`. They use the same `authResolver` middleware
pattern as the existing endpoints.

### 6.1 `GET /api/research-brain/sources/:sourceId/evidence`

```ts
// Auth: authResolver({ required: false })  // same as the other /sources reads
// Returns 404 if the source does not exist
{
  sourceId: string;
  tables: Array<{
    id: string;
    page: number;
    tableIndex: number;
    headers: string[];
    rows: string[][];
    markdown: string;
    bbox: BBox;
    extractionProvider: "local" | "mistral";
    extractionConfidence: number;
  }>;
  figures: Array<{
    id: string;
    page: number;
    figureIndex: number;
    bbox: BBox;
    caption: string | null;
  }>;
  chunks: Array<{
    id: string;
    page: number;
    chunkIndex: number;
    content: string;
    bbox: BBox | null;
  }>;
}
```

Ordering: tables `(page, tableIndex)` ascending, figures
`(page, figureIndex)` ascending, chunks `(chunkIndex)` ascending.
Chunks are read from `research_evidence_chunks` (already populated by
the existing pipeline); their bbox is currently always `null` until a
follow-up change adds per-chunk bboxes (out of scope here).

If the source has **no** `file_path`, the response still includes
`tables`/`figures`/`chunks` but the frontend hides the viewer CTA.
The PDF endpoint returns 404 in that case (see below).

### 6.2 `GET /api/research-brain/sources/:sourceId/pdf`

```ts
// Auth: authResolver({ required: true })  // gated — the file lives in a private bucket
// Headers:
//   Content-Type: application/pdf
//   Content-Disposition: inline; filename="<sanitized-title>.pdf"
//   Cache-Control: private, max-age=60
// Body: binary PDF
// 404 if source not found OR file_path is null/empty
// 502 if storage provider is unreachable
// 413 if the file exceeds 50 MB (size cap; research PDFs are well under)
```

The route reads the `file_path` column, downloads the buffer via
`getStorageProvider().download(filePath)`, and streams the bytes
inline. **No presigned URL is returned to the client** — the spec
explicitly says the caller must never receive credentials that grant
broader bucket access. This is also the safest default for private
S3 buckets.

The endpoint sets
`Content-Disposition: inline; filename="<sanitized>.pdf"` so the
browser can render the PDF directly in PDF.js without triggering a
download.

### 6.3 `GET /api/research-brain/facts/:factId/provenance`

```ts
// Auth: authResolver({ required: false })
// 404 if the fact does not exist
{
  factId: string;
  sourceId: string;
  sourceTitle: string;
  doi: string | null;
  provenance: {
    type: "table" | "figure" | "chunk" | "text-only";
    table: Table | null;     // populated when type === "table"
    figure: Figure | null;   // populated when type === "figure"
    chunk: Chunk | null;     // populated when type === "chunk" or fallback
    bbox: BBox | null;       // equal to table.bbox or figure.bbox, else null
  };
}
```

Resolution precedence (per spec):

1. `evidence_table_id` set AND row resolvable → `type: "table"`.
2. `evidence_figure_id` set AND row resolvable → `type: "figure"`.
3. `chunk_id` set (or chunkIndex resolvable via the legacy
   `chunk_index` column) → `type: "chunk"`, `bbox: null`.
4. Otherwise → `type: "text-only"`, both `bbox` and `chunk` null.

The implementation reads the fact row with its embedded
`evidence_table` and `evidence_figure` joins (using Supabase's
foreign-key embed syntax: `*, evidence_table:research_evidence_tables!evidence_table_id(*), evidence_figure:research_evidence_figures!evidence_figure_id(*)`),
then picks the first non-null branch.

### 6.4 Notes on auth and rate-limiting

The PDF endpoint is `required: true` (read auth) because the
underlying bucket may be private. The other two endpoints are
`required: false` to match the existing `/sources/:id/claims`
endpoints (the data is research metadata, not user PII). All
endpoints go through the existing `pino` logger with structured
events (`research_brain_evidence_failed`, `research_brain_pdf_failed`,
`research_brain_provenance_failed`) so the existing dashboards can
pick them up.

## 7. Frontend Module Structure

All new client code lives under `client/src/`. The Preact build
(`client/build.ts`) bundles dependencies with Bun's bundler, so any
new client dependency must be added to the root `package.json`
before it can be imported.

```
client/src/
├── pages/
│   ├── ViewerPage.tsx              # NEW — /viewer/:sourceId route component
│   ├── LibraryViewerPage.tsx       # NEW — /library/:docId/viewer route component
│   └── index.ts                    # MODIFIED — export the two new pages
├── components/
│   ├── EvidenceLightbox.tsx        # NEW — modal overlay
│   ├── EvidenceViewer.tsx          # NEW — shared PDF.js mount + bbox overlay
│   ├── BboxOverlay.tsx             # NEW — pure highlight div renderer
│   └── ProvenanceBadge.tsx         # NEW — text-only badge
├── hooks/
│   ├── useProvenance.ts            # NEW — fetches /facts/:id/provenance
│   ├── useSourceEvidence.ts        # NEW — fetches /sources/:id/evidence
│   └── usePdfDocument.ts           # NEW — loads + caches the PDF.js document
├── lib/
│   ├── pdfjs.ts                    # NEW — pdfjs-dist worker setup (one-time)
│   └── bbox.ts                     # NEW — bbox -> CSS pixel transform
└── index.jsx                       # MODIFIED — register the two new routes
```

### 7.1 `client/src/lib/pdfjs.ts`

Single-purpose module that:

1. Imports `pdfjs-dist/build/pdf.mjs` and
   `pdfjs-dist/build/pdf.worker.min.mjs` as URLs (Bun's bundler
   handles this via `import.meta.url`).
2. Calls `pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl`.
3. Exposes `getPdfjsLib()` so other components import the same
   configured instance.

This module is the only place that knows about `pdfjs-dist`. Tests
can mock it via `mock.module`.

### 7.2 `client/src/lib/bbox.ts`

```ts
export const PDFJS_RENDER_SCALE = 1.5;  // MUST match the server's local provider scale
export function bboxToPixels(bbox: BBox): { left: number; top: number; width: number; height: number } {
  return {
    left: bbox.x * PDFJS_RENDER_SCALE,
    top: bbox.y * PDFJS_RENDER_SCALE,
    width: bbox.w * PDFJS_RENDER_SCALE,
    height: bbox.h * PDFJS_RENDER_SCALE,
  };
}
```

The constant is exported so tests can import the same value. Per
spec, the scale is fixed at 1.5 — it is **not** parameterized per
document.

### 7.3 `client/src/hooks/useProvenance.ts`

```ts
export function useProvenance(factId: string | null) {
  // fetch GET /api/research-brain/facts/:factId/provenance
  // returns { data, isLoading, error, refetch }
  // standard authHeaders + X-User-Id (same pattern as useResearchBrain)
}
```

### 7.4 `client/src/hooks/useSourceEvidence.ts`

```ts
export function useSourceEvidence(sourceId: string | null) {
  // fetch GET /api/research-brain/sources/:sourceId/evidence
}
```

### 7.5 `client/src/hooks/usePdfDocument.ts`

Wraps `pdfjsLib.getDocument({ url: '/api/research-brain/sources/:id/pdf' })`
and exposes the loaded `PDFDocumentProxy` plus a `goToPage(n)` helper.
Reused by both the lightbox and the dedicated route.

### 7.6 `client/src/components/EvidenceViewer.tsx`

Renders the PDF on a canvas at scale 1.5. Tracks the current page
and the highlight divs via state. The highlight div is positioned
absolutely over the rendered page, so scroll follows naturally.
Reads `bbox` and `type` from the URL hash (when on the dedicated
route) or from the `provenance` prop (when used by the lightbox).

### 7.7 `client/src/components/EvidenceLightbox.tsx`

Modal overlay that mounts `<EvidenceViewer />` in a fixed-position
container with a backdrop. Esc closes (returns focus to the
triggering element). The "Open in tab" button computes the viewer
URL from the current provenance and opens it in a new tab via
`window.open`. Focus trap: a small `useEffect` listens for Tab and
cycles focus within the modal (no third-party focus-trap lib —
~20 lines of code is enough for a single-button modal).

### 7.8 `client/src/components/BboxOverlay.tsx`

Pure renderer. Props: `{ bboxes: BBox[]; type: ProvenanceType }`.
Renders one absolutely-positioned `<div>` per bbox with a class
corresponding to the type. Color scheme:

| Type | Border | Background | Use |
|---|---|---|---|
| `table` | 2px solid `#3b82f6` (blue) | `rgba(59,130,246,0.15)` | table highlight |
| `figure` | 2px solid `#a855f7` (purple) | `rgba(168,85,247,0.15)` | figure highlight |
| `chunk` | 2px solid `#eab308` (yellow) | `rgba(234,179,8,0.2)` | text-chunk match |
| `text-only` | none | none | no overlay |

The text-only case renders no div at all; the badge is the signal.

### 7.9 `client/src/components/ProvenanceBadge.tsx`

Small pill, keyboard-focusable, with `aria-label="Text-only
provenance — click to view source page"`. Clicking the badge is the
same as clicking the citation — it opens the lightbox. Neutral
styling (grey background, dark text) so it doesn't look like a
warning.

### 7.10 `client/src/pages/ViewerPage.tsx`

Top-level page for `/viewer/:sourceId`. Reads `params.sourceId` and
the URL hash, fetches the PDF + evidence, mounts the shared
`<EvidenceViewer />`. Full-screen layout, header with the source
title (fetched via `useResearchBrainSources()`) and a back button.

### 7.11 `client/src/pages/LibraryViewerPage.tsx`

Equivalent page for `/library/:docId/viewer`. Fetches the
`documents` row to resolve `docId → sourceId`, then delegates to
the same `EvidenceViewer` (with a different back-button target).

### 7.12 Routing changes (`client/src/index.jsx`)

Add two routes inside the existing `LegacyAppShell` and
`CoralAppShell` `<Router>` blocks:

```jsx
<ViewerPage path="/viewer/:sourceId" />
<LibraryViewerPage path="/library/:docId/viewer" />
```

These are passive additions — they do not change the auth flow
because the existing `handleRouteChange` already enforces auth
gating for non-public routes.

### 7.13 Citation click integration

The spec requires the citation click to open the lightbox by
default, with Ctrl/Cmd-click opening the dedicated route in a new
tab. We expose two small helpers in a new file
`client/src/utils/provenanceTrigger.ts`:

```ts
export function openProvenanceLightbox(factId: string) { /* dispatch a global event or use a context */ }
export function openProvenanceInTab(factId: string) { /* compute url and window.open */ }
```

A `ProvenanceProvider` context wraps the app and renders
`<EvidenceLightbox />` at the top level. Citations on
`LibraryPage` and `ResearchBrainPage` add
`role="button"`, `data-provenance-trigger`, and `data-fact-id` to
the citation element, and the click handler routes through the
context. Existing citation components (`InlineCitationText.jsx`)
can keep their current look-and-feel — we add a wrapper, not a
rewrite.

## 8. PR-by-PR Implementation Plan

This design ships across three chained PRs, matching the proposal.
Each is sized to stay under the 400-line review budget.

### 8.1 PR #1 — Extraction & Persistence

**Files added (≤ ~350 lines, includes the custom table detector):**

- `supabase/migrations/20260612000000_create_research_evidence_tables.sql`
- `src/services/files/pdfTableExtractor.ts` (orchestrator, ~120 lines)
- `src/services/files/pdfTablePromptBuilder.ts` (~60 lines)
- `src/services/files/qualityGate.ts` (~50 lines)
- `src/services/files/providers/localPdfTableProvider.ts` (~180 lines,
  includes the custom detector algorithm)
- `src/services/files/providers/mistralOcrProvider.ts` (~90 lines)
- `src/services/researchBrain/tables.ts` (~50 lines)
- `src/services/researchBrain/bioprospectingExtractor.ts` (modifications, ~40 net new lines)
- `src/services/researchBrain/db.ts` (small modification to accept
  `evidence_table_id` in the payload — ~5 lines)

**Unit tests (≤ ~250 lines):**

- `src/services/files/__tests__/localPdfTableProvider.test.ts` (spike
  test that asserts bbox.units === "pt" and that the custom detector
  recovers positions from a hand-rolled PDF — ~80 lines)
- `src/services/files/__tests__/qualityGate.test.ts` (~60 lines)
- `src/services/files/__tests__/pdfTablePromptBuilder.test.ts` (~60 lines)
- `src/services/researchBrain/__tests__/bioprospectingExtractor.tables.test.ts` (~50 lines:
  verify the `extractBioprospectingFactsForSource` flow calls
  `extractPDFTables` and threads `sourceTableRef` through correctly)

**No new direct dependencies.** `pdfjs-dist@5.4.296` is already
installed transitively (via `pdf-parse@2.4.5`); the local provider
imports it from `node_modules/pdfjs-dist/legacy/build/pdf.mjs`. The
frontend will add `pdfjs-dist` as a direct dep in PR #2 (it needs
the standard build + worker).

**Cache check:** before invoking any provider,
`loadTablesForSource(S)` returns N > 0 → return cached; otherwise run
the local provider, evaluate the gate, fall back to Mistral in
`auto` mode, persist, and return.

**Idempotency:** the unique constraint `(source_id, page, table_index)`
is the authoritative guard. PG `23505` is caught and treated as a
cache hit (no re-insert, no provider re-run).

**Manual re-extraction:** not in this PR. The proposal's
"forced re-extraction" path is a future admin endpoint. Forcing
today means deleting rows via SQL.

### 8.2 PR #2 — Viewer Route + Lightbox

**Files added (≤ ~300 lines):**

- `client/src/lib/pdfjs.ts` (~25 lines)
- `client/src/lib/bbox.ts` (~15 lines)
- `client/src/hooks/useProvenance.ts` (~30 lines)
- `client/src/hooks/useSourceEvidence.ts` (~30 lines)
- `client/src/hooks/usePdfDocument.ts` (~40 lines)
- `client/src/components/EvidenceViewer.tsx` (~80 lines)
- `client/src/components/EvidenceLightbox.tsx` (~70 lines)
- `client/src/components/BboxOverlay.tsx` (~30 lines)
- `client/src/pages/ViewerPage.tsx` (~50 lines)
- `client/src/pages/LibraryViewerPage.tsx` (~40 lines)
- `client/src/pages/index.ts` (export additions, ~3 lines)
- `client/src/index.jsx` (route registration, ~2 lines)
- `package.json` (add `pdfjs-dist`)
- `client/src/styles/provenance.css` (new stylesheet, ~30 lines)

The backend also gets the three new endpoints (~120 lines) in
`src/routes/research-brain.ts`.

**Focus trap:** custom, ~20 lines, no new dep.

**PDF.js worker setup:** the worker is bundled by Bun and served
from `client/dist/`. The single-source setup lives in
`client/src/lib/pdfjs.ts`.

### 8.3 PR #3 — Text-Chunk Fallback + Badges

**Files added (≤ ~200 lines):**

- `client/src/components/ProvenanceBadge.tsx` (~30 lines)
- `client/src/utils/provenanceTrigger.ts` (~30 lines)
- `client/src/contexts/ProvenanceContext.tsx` (~40 lines)
- `client/src/hooks/useTextChunkSearch.ts` (~30 lines)
- `client/src/components/InlineCitationText.jsx` modifications
  (~10 net new lines) — wire the trigger attributes
- `client/src/pages/LibraryPage.tsx` and `ResearchBrainPage.tsx`
  modifications — add the badge next to the source title (~5 net
  new lines each)
- `client/src/styles/provenance.css` (badge styles, ~15 lines)
- A test for the text-chunk fallback (text-layer search hit +
  graceful "not found" case).

The text-chunk fallback uses PDF.js's text-layer search API
(`PDFFindController`-equivalent via the raw `pdfjsLib` find API
exposed in v4+) to locate the first 80 chars of the chunk content
on the resolved page. If not found, the lightbox shows the page
with no highlight and surfaces the `text-only` badge.

## 9. Key Tradeoffs & Decisions

### 9.1 Mistral OCR response: parse tables or keep markdown?

**Decision:** prefer Mistral's structured `pages[i].tables` when
present; fall back to storing the raw markdown in the
`research_evidence_tables.markdown` column with empty
`rows`/`headers` arrays.

**Why:** parsing markdown back into rows is fragile (multi-line
cells, escaped pipes, alignment rows). The LLM can use the
markdown directly — that's what `buildTablesPromptSection` is for.
The structured rows are only needed by the *viewer* and the
`loadTablesForSource` cache; the viewer already gets enough from the
bbox + page to draw the highlight, and the cache mirrors are
populated from Mistral's structured response when available.

**Cost:** when Mistral returns markdown only, the row array is
empty and the viewer's "tables" list is empty for that source. The
highlight still works (bbox is in the JSON) but the user can't see
the parsed cells. This is a graceful degradation, not a regression
— the local provider's `rows` arrays are always populated.

### 9.2 Where does `extractPDFTables` get called from?

**Decision:** from `bioprospectingExtractor.ts` after the chunks
load and before the LLM batches run. The bioprospecting worker is
the right place because:

- The chunks are already loaded; the PDF is already on disk.
- Tables are persisted before the LLM runs, so the prompt sees them
  on the first batch (no race between table persistence and the LLM
  call).
- The orchestrator's cache check makes the call cheap on re-runs
  (one DB read).
- Putting the call in `description.ts` would couple the description
  pipeline (which serves chat uploads, not research brain) to the
  research-brain table cache. Wrong layer.

**Trigger:** add a one-line call near the top of
`extractBioprospectingFactsForSource`, after the `existingChunks`
load and before the batch loop. It runs inside the same
`setSourceBioprospectingStatus({ status: "running" })` block, so
the call is captured in the existing observability.

**Idempotency:** the call is a no-op when tables already exist for
the source — the cache check returns immediately.

### 9.3 Re-extraction strategy: when to call `extractPDFTables`?

**Decision:** call it once per source, lazily, the first time the
extractor runs on a new `sourceId`. The dedup is at the source
level: if `research_evidence_tables` has any row for `S`, the
provider is never called.

**Why not on every viewer mount?** Because the viewer is read-only
and the cache is the source of truth. Re-extraction on viewer mount
would re-cost the Mistral API on every page reload.

**Why not in a separate background job?** Because the spec says
tables are part of the bioprospecting extraction contract. The
worker pool already runs the extractor; piggybacking on that
keeps the operational surface small.

**Forced re-extraction:** the proposal marks this as a separate
admin-only endpoint. We do **not** ship it in this change — the
in-codebase path is the existing
`POST /api/research-brain/sources/:id/extract-bioprospecting` route,
which already triggers the extractor; a forced re-extraction is a
follow-up that adds a `force` flag and clears the cache first.

### 9.4 Lightbox library: build custom or use a dep?

**Decision:** build custom. The lightbox has a fixed set of
behaviors (Esc, focus trap, "open in tab", one button) and the
Preact ecosystem's modal libs (e.g. `react-modal` via the
preact/compat shim) are heavier than the ~80 lines of code we
need. Build-vs-buy here is clearly build.

### 9.5 `pdfjs-dist` worker setup

**Decision (frontend, PR #2):** use `pdfjs-dist`'s standard build
worker via `GlobalWorkerOptions.workerSrc = "<bundled-url>"`. The
worker file is bundled by Bun's bundler through `import.meta.url`
resolution.

**Why not disable the worker (`useWorkerFetch: false`)?** Because
the worker keeps the main thread responsive, which matters on large
research PDFs (50+ pages). The worker file is ~1 MB gzipped — a
one-time cost per page load.

**Decision (backend, PR #1):** use the `legacy` build of
`pdfjs-dist@5` (`pdfjs-dist/legacy/build/pdf.mjs`), which is a
single-threaded, no-canvas, no-worker fallback. It is the only
build that works in this Bun environment without a `canvas` native
binding. The text extraction is fast enough (~few hundred ms for
a 50-page PDF) that the worker is not needed server-side.

### 9.6 Bbox coordinate space

**Decision:** PDF point space (`units: "pt"`, 1pt = 1/72in), with
the PDF native origin (bottom-left). The local provider reads
`page.getViewport({ scale: 1.0 })` to get the page height in points
and converts every cell's `transform[5]` (y in PDF coords) into
canvas coords before bbox union. The stored bbox is in PDF point
space so the viewer at 1.5× scale can multiply directly.

**Why not canvas pixels?** Because pixels are resolution-dependent
(device pixel ratio, monitor DPI, etc.). PDF points are
device-independent and stable across re-renders. Storing in
canvas pixels would mean recomputing on every viewer mount; storing
in points makes the bbox immutable.

### 9.7 Source path for the PDF proxy

`research_sources.file_path` is the S3 key. The proxy downloads
through the existing `getStorageProvider()` singleton
(`src/storage/index.ts`) and streams the bytes back with
`Content-Type: application/pdf`. No new storage code is needed —
the proxy is just a thin route over the existing provider.

**Edge case:** if `STORAGE_PROVIDER` is unset (no S3), the proxy
returns 502 with a clear error message. The lightbox catches the
502 and shows a fallback "PDF not available" state. We do **not**
fall back to the local filesystem (`KNOWLEDGE_DOCS_PATH`) because
research sources always live in S3 — the local path is for the
ingestion worker, not the viewer.

### 9.8 Mistral cost guard

The cache is the cost guard. Re-extraction is gated by
`source_id`, so the same PDF is never sent to Mistral twice via
this code path. The fallback only fires when the local result fails
the quality gate — so Mistral is hit at most once per source for
the lifetime of the cache.

## 10. Observability

Three new structured pino events, all carrying `sourceId`:

| Event | When | Fields |
|---|---|---|
| `pdf_table_extraction_local_failed` | Local provider throws | `{ sourceId, error }` |
| `pdf_table_extraction_quality_gate` | Gate decision | `{ sourceId, reason, tables, avgConfidence, provider }` |
| `pdf_table_extraction_mistral_failed` | Mistral API error or missing key | `{ sourceId, error }` |
| `bioprospecting_table_ref_missing` | LLM emits a `sourceTableRef` with no matching row | `{ sourceId, ref }` |

These events are scraped by the existing pino setup
(`src/utils/logger.ts`); no new log shipping config needed.

## 11. Testing Strategy

- **Spike test** for the custom detector: a small unit test that
  hand-rolls a PDF buffer with 6 known text items at known
  coordinates, runs `localPdfTableProvider.extract()`, and asserts
  the resulting `ExtractedTable` has the expected `bbox.units === "pt"`
  and the expected `(x, y, w, h)` to within `1.0` pt. This is the
  acceptance criterion for "the local provider returns correct
  bboxes." This spike test lives in
  `src/services/files/__tests__/localPdfTableProvider.spike.test.ts`
  per tasks.md 1.1.
- **Unit tests** for the pure helpers:
  - `qualityGate.ts` — gate decisions across the boundary cases
    (`< 3` tables, `avg conf < 0.5`, both, neither).
  - `pdfTablePromptBuilder.ts` — deterministic output for empty
    input, single table, multi-level headers, empty-cell rendering.
  - `bbox.ts` (frontend, PR #2) — point-to-pixel transform with
    golden values (e.g. `(72, 144, 216, 180)` → `(108, 216, 324, 270)`).
- **Integration tests** for the orchestrator with a mocked
  `localPdfTableProvider` and a mocked `fetch` for Mistral. The
  provider mock returns a canned `ExtractedTable[]` so the
  orchestrator's gate/quality/persist logic is exercised
  end-to-end without hitting pdfjs.
- **Migration smoke test** — apply the migration to a fresh
  Supabase project, insert a row, assert FK cascade deletes work.
- **Frontend tests** (already in `__tests__` style elsewhere; if
  no test runner is wired for the client, skip and rely on
  manual smoke tests of the lightbox in the dev environment).

## 12. Out of Scope (Confirmed)

The following are explicitly out of scope per the proposal and the
specs and are **not** part of this design:

- Inline cell editing (follow-up).
- Char-level provenance offsets.
- Embedding-backed fact dedup (deferred in `bioprospecting-fact-dedup`).
- PDF annotation export (viewer is ephemeral; no write-back).
- Per-chunk bboxes (chunks currently have `bbox: null`).
- Forced re-extraction admin endpoint (follow-up).

## 13. Rollback Plan (per PR)

Each PR is independently revertible:

- **PR #1:** drop the migration; remove the `loadTablesForSource`
  call from `bioprospectingExtractor.ts`; the LLM prompt returns to
  the pre-delta shape. The provider modules become dead code that
  can be removed in a follow-up.
- **PR #2:** remove the three new routes from
  `src/routes/research-brain.ts`; remove the new components and
  pages; nothing breaks because no other code calls them yet.
- **PR #3:** revert the badge additions on `LibraryPage` and
  `ResearchBrainPage`; remove the `ProvenanceContext` provider.
  The lightbox stays but renders nothing.

No cross-PR schema coupling — the columns added in PR #1 are
nullable and have no impact on existing reads.
