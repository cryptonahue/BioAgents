# Exploration: multi-page table merging for bioprospecting PDFs

## Current state (what breaks today)

The local detector in `src/services/files/providers/localPdfTableProvider.ts`
runs the per-page algorithm independently for each page and concatenates the
results (lines 109-123). There is no cross-page awareness: when a table spans
pages 5-6, the detector emits 2 `ExtractedTable` rows with the same
`tableIndex=0` on consecutive pages, and the orchestrator persists both to
`research_evidence_tables` with distinct `(page, table_index)` keys.

What this breaks downstream:

1. **LLM context** — `buildTablesPromptSection` (in
   `pdfTablePromptBuilder.ts`) renders each fragment as a separate
   `page=N table=M` block. The LLM sees two unrelated tables; the
   second has a "(continued)" header that is not in the prompt schema.
2. **Dedup** — `identity_key` on `research_bioprospecting_facts` is
   derived from extracted text. A 50-row table split into two 25-row
   pieces can produce two `identity_key`s for facts that should
   cluster together (cf. `src/services/researchBrain/normalize.ts`).
3. **Provenance viewer** — `client/src/pages/ViewerPage.tsx` line 94
   shows "Page {t.page} · Table {t.tableIndex}". A split table shows
   two disjoint bboxes; there is no "this is a multi-page table"
   affordance and no way to navigate from part 1 to part 2.
4. **Quality gate** — a 50-row table counts as 2 tables for the
   `tables.length < 3` heuristic in `qualityGate.ts`, which can
   spuriously trigger a Mistral fallback.

The persisted shape is rigid:
`UNIQUE (source_id, page, table_index)` in the migration, and a
`bbox` JSONB is a single rectangle (`{x, y, w, h, page, units: "pt"}`).
A multi-page table needs a list of bboxes, one per page.

## Affected areas

- `src/services/files/providers/localPdfTableProvider.ts` — the
  per-page loop; ideal place to add a "post-pass" that emits merged
  fragments, or a new exported `mergeTablesAcrossPages` function.
- `src/services/files/pdfTableExtractor.ts` — orchestrator; lines
  388-433 currently pass `localTables` directly to the persistence
  step. A merging step slots in between extract and persist.
- `src/services/files/pdfTablePromptBuilder.ts` — renders the
  `tables:` block. Must support a `continuedFrom: {page, tableIndex}`
  marker so the LLM knows "this is part 2 of table on page N".
- `src/services/files/qualityGate.ts` — needs to consider merged
  counts, otherwise we regress the gate on split tables.
- `supabase/migrations/20260612000000_create_research_evidence_tables.sql` —
  schema delta for the new `continues_from_id` column and a widening
  of the unique constraint (because 2 fragments share the same logical
  table identity but keep distinct `(page, table_index)`).
- `openspec/specs/pdf-table-extraction/spec.md` — the
  `Bbox Coordinate Space` and `Provider Abstraction And Selection`
  requirements need a multi-page delta.
- `client/src/pages/ViewerPage.tsx` and
  `client/src/components/EvidenceLightbox.tsx` — viewer must render
  multi-part tables as a "virtual" highlight spanning the linked
  bboxes (or as a paginated list within the same panel).
- `client/src/components/BboxOverlay.tsx` — currently 1:1 with a
  single bbox. Needs to accept an array of bboxes for a continued
  table.

## Approaches

### Option A — Single merged row per logical table (1-N continuation)

Keep one row per page in `research_evidence_tables` (so the bbox list
maps 1:1 to a single page each, no schema change to the bbox
column), and add a self-referential `continues_from_id` column
(nullable, FK to same table). The first page of a continued table
has `continues_from_id = NULL`; every continuation page has it set
to the previous page's id. The viewer walks the chain to render
all parts.

**Pros:**
- Schema delta is tiny (one nullable FK).
- Idempotency is unchanged: `(source_id, page, table_index)` is still
  the unique guard.
- The LLM prompt can mark continuation blocks with
  `page=6 table=0 (continued from page=5)`.
- The viewer reuses the same list-of-tables UI; it just follows the
  chain when the user clicks a "Part 1 of 2" badge.

**Cons:**
- Two physical rows = two prompt blocks. The LLM still has to read
  "this is part 2" — we don't fully hide the split.
- The `identity_key` dedup issue is not solved (the text fragments
  are still separate rows in the LLM context, even if we mark them
  as related).
- Migration risk: adding a nullable self-FK to a table that is
  already populated by PR #1 of the previous change.

**Effort:** Low (one new column, ~50 LOC in detector + 30 LOC in
prompt builder + 20 LOC viewer change).

### Option B — Merge into one row, widen `bbox` to an array

Change the `bbox` column to JSONB array (or add a `bboxes` column).
When the detector detects a continuation, it concatenates the rows
into a single `ExtractedTable` with `bbox = [bbox_page5, bbox_page6]`
and a single `rows` array spanning both pages. The unique constraint
becomes `(source_id, first_page, table_index)` (or we add a
`logical_table_id` UUID and pivot the unique guard onto it).

**Pros:**
- One row per logical table = clean dedup, clean LLM context, clean
  identity_key signal.
- The viewer renders "this table has bboxes on pages 5, 6" as a
  single lightbox entry with a "page jump" sub-control.
- The quality gate counts a merged table as 1, not 2 — fixes the
  spurious fallback risk.

**Cons:**
- Schema delta is larger: change the uniqueness guard and the bbox
  shape. All read paths (`loadTablesForSource`, the viewer, the
  evidence pack) need to handle the new shape. The bbox is a
  contract with the frontend; widening it touches
  `EvidenceLightbox`, `BboxOverlay`, `EvidenceViewer`,
  `useProvenance`, the API response shape.
- Migration of already-persisted rows: split tables from the
  previous PR are now in a non-canonical shape. Either re-extract
  (breaks the "cache hit is a no-op" guarantee) or backfill in SQL.
- The Mistral provider already returns one table per
  `(page, table_index)`; we'd need a similar cross-page merging
  pass on its output to stay consistent.

**Effort:** High (~300 LOC across backend + frontend + migration +
  re-run on existing data).

### Option C — Merge at prompt-build time only, keep 2 rows

The detector continues to emit 2 rows. The prompt builder
(`pdfTablePromptBuilder.ts`) detects adjacent-page tables with
matching column count and matching/empty headers and renders them
as a single `tables:` block with the rows concatenated, plus a
`continues_from: page=N table=M` header line. The database rows
are unchanged; the LLM sees a unified table; the viewer still
shows 2 entries but with a "continuation" badge.

**Pros:**
- Zero schema delta, zero migration risk.
- Backend change is local to the prompt builder (~40 LOC).
- The Mistral provider benefits for free (same prompt builder).
- Re-extraction of existing data is unnecessary.

**Cons:**
- The dedup `identity_key` issue is partially addressed (the LLM
  sees one block) but the underlying 2 physical rows are still
  separate in the cache, so two `evidence_table_id`s on facts from
  the same logical table.
- The viewer still shows 2 bboxes with no "this is part of a
  multi-page table" link.
- The quality gate is unaffected (still counts as 2).

**Effort:** Low (one helper in `pdfTablePromptBuilder.ts`, ~50 LOC
plus tests).

### Option D — Hybrid (recommended)

Combine A and C: the detector emits continuation links (Option A,
self-FK column for the viewer's "Part 1/2" navigation), AND the
prompt builder merges continuation chains into a single block
(Option C, for the LLM context). The database stores 2 physical
rows with a self-FK; the LLM prompt and the viewer see a logical
unified table.

**Pros:**
- Clean LLM context (no "(continued)" header the LLM has to
  interpret).
- Clean viewer navigation (chain walk).
- The dedup identity_key works better because the LLM extracts
  against a unified block.
- Schema delta is still small (one nullable self-FK).
- Quality gate needs one new heuristic ("if a table is part of a
  chain, count the chain as 1").

**Cons:**
- More code than A alone, but still less than B.
- The prompt builder needs to handle the chain walk; this is
  non-trivial when chains are 3+ pages long.

**Effort:** Medium (~150 LOC backend, ~40 LOC viewer, one
migration, ~30 LOC test).

## Heuristics (ranked by confidence)

For detecting that table T₁ on page N and table T₂ on page N+1 are
the same logical table:

1. **Header match (highest confidence)**: T₂'s first 1-2 rows
   exactly match T₁'s headers (case-insensitive, whitespace-
   normalized). Covers case 3 (headers repeated on every page) and
   case 1 (continued with a "(continued)" header that we strip
   before matching).
2. **"Continued" marker on T₂**: T₂'s first row contains the
   literal strings `"continued"`, `"cont."`, `"cont'd"`, or
   `"(cont.)"` in any cell. After stripping, the remaining
   headers should match T₁.
3. **Column count + column anchor alignment**: T₂ has the same
   `headers.length` as T₁ AND the median x-coordinate of each
   column matches within `X_TOLERANCE_PT` (already exported as
   `X_TOLERANCE_PT = 4` in the detector). Catches case 1
   (continued table with no header repetition, common in older
   PMC PDFs).
4. **Body-row cell-value continuity**: the last non-empty cell
   value of T₁'s last body row is a prefix of T₂'s first body
   row's first cell. Extremely rare; not worth implementing
   unless we hit a real example (case 4 split).
5. **Page distance = 1 AND table_index matches**: a strong prior
   — multi-page tables are almost always split on consecutive
   pages, not skipping a page.

Negative signals (do NOT merge):
- T₂ starts with text like "Table 3." — that is a new table, not
  a continuation, even if the column count matches.
- T₁'s last row is a TOTAL/SUM/AVG row (no more data expected).
- T₂'s `bbox.y` is at the top of the page (a new table normally
  starts with margin space).

## Recommendation

**Option D (hybrid)**, scoped down to a v1 that ships only the
prompt-side merge + viewer chain link, with the schema delta
limited to a nullable `continues_from_id` self-FK.

Rationale:
- The LLM-side benefit is the highest-leverage fix: every downstream
  consumer (extractor, dedup, evidence pack) reads from the
  prompt. Fixing it there is one helper in
  `pdfTablePromptBuilder.ts`.
- The viewer benefit comes for free from the self-FK, with no
  schema change to the bbox contract.
- We do NOT change the unique constraint, the bbox shape, or the
  persistence path. This keeps the change small, reviewable, and
  reversible.
- Option B (full merge) is the "right" answer in a year, but it is
  not the right answer for a 1-week follow-up. We can ship D now
  and revisit B as a `v2` if the cache-of-splits becomes a real
  pain point.

Concretely, the change is:
1. New migration: add `continues_from_id UUID` (nullable, self-FK,
   ON DELETE SET NULL) to `research_evidence_tables`. Add an index
   on `(source_id, continues_from_id)` for the viewer's chain
   lookup.
2. New helper in `localPdfTableProvider.ts`:
   `mergeTablesAcrossPages(tables: ExtractedTable[]): ExtractedTable[]`.
   Pure function (no pdfjs). Runs after the per-page loop. Emits
   the same `ExtractedTable[]` shape but with `continues_from_id`
   patched (we extend the type to optionally carry the chain).
3. New helper in `pdfTablePromptBuilder.ts`:
   `buildTablesPromptSection` walks the chain and renders
   continuation fragments as a single block, prefixed with
   `page=6 table=0 (continued from page=5)`. The LLM gets a
   unified view; the LLM can still cite `page=N table=M` because
   we keep the per-fragment marker on each row.
4. New helper for the viewer endpoint: `loadTableChain(tableId)`
   returns the ordered list of fragments for a continued table.
5. Viewer: `EvidenceLightbox` shows a "Part 1 of 2" badge and a
   next/prev pager when the row has a chain.

## Schema impact (Option D)

```sql
ALTER TABLE public.research_evidence_tables
  ADD COLUMN IF NOT EXISTS continues_from_id UUID
    REFERENCES public.research_evidence_tables(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_tables_continues_from
  ON public.research_evidence_tables (source_id, continues_from_id)
  WHERE continues_from_id IS NOT NULL;
```

The existing `(source_id, page, table_index)` unique constraint
is unchanged. `bbox` is unchanged. `id` is unchanged (UUID PK).
No data backfill is required: existing rows have
`continues_from_id = NULL`, and the detector only writes the FK
on fresh extractions.

TypeScript delta:
```typescript
export interface ExtractedTable {
  // ... existing fields ...
  continuesFromId?: string | null; // NEW — null for first fragment
}
```

The `ResearchEvidenceTableRow` and the persist path gain the same
optional field.

## Integration point

Best place for the merge logic: **between the per-page loop and
the persistence call in `localPdfTableProvider.ts`**.

```typescript
// localPdfTableProvider.ts — extract() method, after the per-page loop
const tables: ExtractedTable[] = [];
for (let pageNum = 1; pageNum <= numPages; pageNum++) { /* ... */ }
return mergeTablesAcrossPages(tables); // NEW
```

The orchestrator (`pdfTableExtractor.ts`) is unchanged — it gets
back a flat list of `ExtractedTable` exactly as today. The merge
is a provider-local concern, which is the right boundary: the
Mistral provider would need its own equivalent pass, but that
lives inside `mistralOcrProvider.ts` and is out of scope for v1.

The prompt builder integration is independent: it does the chain
walk at LLM prompt construction time, which means it works
whether the merge happened at detection time or not. This is the
defensive layer that catches the case where the detector misses
a continuation.

## Estimated complexity

- **Overall: Medium**
- Schema migration: Low (~15 LOC SQL)
- Detector merge helper: Low–Medium (~80 LOC + 40 LOC tests)
- Prompt builder chain walk: Low (~40 LOC + 30 LOC tests)
- Viewer chain UI: Low (~30 LOC frontend, badge + pager)
- Total backend: ~150 LOC
- Total frontend: ~50 LOC
- Test coverage needed: detector merge (5 cases), prompt builder
  (4 cases), viewer chain (2 cases)

## Key files to modify

- `src/services/files/providers/localPdfTableProvider.ts` — new
  `mergeTablesAcrossPages` helper, called from `extract()`.
- `src/services/files/pdfTableExtractor.ts` — add `continuesFromId`
  to `ExtractedTable` and `ResearchEvidenceTableRow` types; pass it
  through `persistExtractedTables` and `rowToExtractedTable`.
- `src/services/files/pdfTablePromptBuilder.ts` — chain walk in
  `buildTablesPromptSection`.
- `supabase/migrations/<date>_add_continues_from_id.sql` — schema delta.
- `openspec/specs/pdf-table-extraction/spec.md` — add the
  `Multi-Page Table Continuation` requirement.
- `client/src/components/EvidenceLightbox.tsx` and
  `EvidenceViewer.tsx` — Part X of N badge + next/prev pager.
- `client/src/components/BboxOverlay.tsx` — accept a bbox array for
  multi-fragment highlights (deferred to v2; v1 keeps the per-page
  bbox and the pager jumps between them).

## Risks and open questions

- **False-positive merges**: tables on consecutive pages that share
  column count but are not continuations. The "Table 3." header
  prefix check is critical — without it we will mis-merge.
  Open question: do we want a confidence threshold on the merge
  (e.g., only merge when column anchors align within 4pt) or a
  hard rule?
- **Mistral consistency**: the Mistral provider does not run our
  merge pass. If Mistral returns 2 fragments of a continued table,
  the prompt builder's defensive chain walk still merges them, so
  the LLM is fine. But the `continues_from_id` chain on the
  database will be incomplete for Mistral rows until we add a
  Mistral-side merge pass. Defer to a follow-up.
- **Cache invalidation**: existing sources cached by the previous
  PR have split tables with no `continues_from_id`. The chain walk
  in the prompt builder must handle the no-FK case gracefully
  (fall back to header matching at prompt time). This is the
  defensive layer's whole reason to exist.
- **3+ page chains**: a table spanning pages 5-6-7 should merge
  into one logical entry. The detector's merge pass needs to
  chain-walk, not just pair-wise. Test fixture needed.
- **Header repetition on every page** (case 3): every page has
  full headers. Our header-match heuristic is fooled — the merge
  still works (T₂'s headers match T₁'s), but we lose the signal
  for "this is a continuation" vs "this is a new table with the
  same shape". The negative signal ("Table N." prefix) is what
  saves us.
- **Schema migration timing**: do we ship the migration in the
  same PR as the detector change, or split? Recommendation:
  same PR, because the detector writes the new column and we
  need it to exist on first run.

## Ready for proposal

Yes. The exploration is complete enough to write a `proposal.md`.
The orchestrator should propose Option D, framed as "v1 of
multi-page table support, leaving v2 (full merge) as a future
change if needed".
