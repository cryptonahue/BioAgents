# Delta for pdf-table-extraction

## ADDED Requirements

### Requirement: Multi-Page Table Continuation

The system MUST treat a table that physically spans multiple PDF pages
as a single logical entity end-to-end: persisted as a single
`continues_from_id` chain, exposed to the LLM as a single `tables:`
block, and navigable in the viewer as "Part X of N".

**Schema delta on `research_evidence_tables`:**

```sql
ALTER TABLE public.research_evidence_tables
  ADD COLUMN IF NOT EXISTS continues_from_id UUID
    REFERENCES public.research_evidence_tables(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_tables_chain
  ON public.research_evidence_tables (continues_from_id)
  WHERE continues_from_id IS NOT NULL;
```

The head of a chain is `NULL`; every tail fragment points to the
previous fragment's `id`. The existing `(source_id, page, table_index)`
uniqueness and `bbox` shape are unchanged. Read-time chain walk is an
application concern.

**New table `research_evidence_table_merges_override` (v1 per-pair only):**

```sql
CREATE TABLE IF NOT EXISTS public.research_evidence_table_merges_override (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES public.research_evidence_tables(id) ON DELETE CASCADE,
  other_table_id UUID NOT NULL REFERENCES public.research_evidence_tables(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('force_merge', 'force_unmerge')),
  confidence_score NUMERIC(4,3) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  reason TEXT NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_tables_override_pair
  ON public.research_evidence_table_merges_override (table_id, other_table_id);
```

The override table takes precedence over detector output: when a row
exists for the `(table_id, other_table_id)` pair, the detector MUST NOT
be consulted for that pair. Per-source mode pin is deferred to v2
(YAGNI).

**Detector helper (`localPdfTableProvider.ts`):**

The provider MUST export `mergeTablesAcrossPages(tables, mode)` and
`scoreMergeCandidate(t1, t2)` as pure post-pass functions running
after the per-page loop. The orchestrator signature is unchanged.

`mode` is one of three values, controlled by env var
`TABLE_MERGE_MODE` (default `hard-confidence`):

| Mode              | Behavior                                                                    |
| ----------------- | --------------------------------------------------------------------------- |
| `hard`            | Merge iff (no `Table N.` prefix on T₂) AND headers match (case/whitespace). |
| `hard-confidence` | Score 0-1 from 4 weighted signals; merge iff score > `TABLE_MERGE_THRESHOLD`. |
| `manual`          | Detector never merges. Only admin overrides create FK links.               |

`TABLE_MERGE_THRESHOLD` env var, default `0.7`. `hard-confidence`
weights: header match `0.4`, column count match `0.2`, X-anchor
alignment ≤ 4pt (`X_TOLERANCE_PT`) `0.2`, page distance = 1 with same
`tableIndex` `0.2`. **Negative signal**: if T₂'s first row matches
`/^Table\s+\d+\.?/i`, the score is forced to `0`.

**Defensive prompt chain walk (`buildTablesPromptSection`):**

The helper MUST walk `continues_from_id` chains at prompt-construction
time and emit a single `tables:` block per chain with per-fragment
sub-markers (`page=N table=M` per fragment, fragment ordering by
`page` ascending). The defensive merge MUST also fire when
`continues_from_id` is `NULL` but adjacent fragments match the `hard`
heuristic — the LLM MUST see a unified view even for cached rows that
pre-date the FK.

**Viewer (`EvidenceLightbox`, `ViewerPage`):**

The viewer MUST render a "Part X of N" badge and a next/prev pager
for chain members. Auto-follow scroll between chain fragments MUST be
opt-in (default **OFF**) with a clear toggle on the badge.

**Backfill script (`scripts/merge-multipage-tables.ts`):**

The script MUST be idempotent and incremental: it MUST skip sources
that already have ≥1 chain (`SELECT DISTINCT source_id FROM
research_evidence_tables WHERE continues_from_id IS NOT NULL`).
Dry-run is the default; `--apply` writes FK + override rows. The
script MUST respect `TABLE_MERGE_MODE`.

**Admin API routes (all guarded by
`authResolver({ required: true, role: 'admin' })`):**

- `POST /api/research-brain/tables/:tableId/merge-with/:otherTableId`
  — body `{ reason, confidence_score? }`. Writes `force_merge`
  override and updates the FK. Idempotent.
- `DELETE /api/research-brain/tables/:tableId/merge-override` — removes
  any override involving the table and clears the FK on the chain
  tail.
- `GET /api/research-brain/tables/:tableId/merges` — returns ranked
  candidate merges for the source (used by the future admin UI).

#### Scenario: Auto-merge spans pages 5-6-7 in hard-confidence mode

- GIVEN `TABLE_MERGE_MODE=hard-confidence`, `TABLE_MERGE_THRESHOLD=0.7`,
  a PDF with a 50-row table on pages 5, 6, 7, headers identical,
  column count equal, X-anchors within 4pt, `tableIndex` equal,
  page distance 1 between each consecutive pair
- WHEN the local provider runs and the detector post-pass executes
- THEN three rows in `research_evidence_tables` exist with
  `continues_from_id` linking 5→6→7 (head `NULL`, tail points to
  previous, middle points to previous)
- AND the persisted `extraction_provider` and `extraction_confidence`
  are unchanged

#### Scenario: Negative signal forces score to 0

- GIVEN a fragment T₂ whose first row text is `"Table 3. Continued"`
- WHEN `scoreMergeCandidate(T₁, T₂)` runs
- THEN the returned score is `0`
- AND no merge is proposed regardless of other signal values

#### Scenario: Admin force-merge is respected on re-extraction

- GIVEN an admin calls
  `POST /api/research-brain/tables/A/merge-with/B` with `reason="ok"`
  and the detector would otherwise score A↔B below threshold
- WHEN the override row is persisted
- THEN a re-extraction of the source writes the FK for A→B
  regardless of detector score
- AND the override row is consulted before `scoreMergeCandidate` for
  that pair

#### Scenario: Defensive prompt walk unifies fragments without FK

- GIVEN two cached `research_evidence_tables` rows for source S on
  pages 4 and 5, no `continues_from_id` set, headers match
- WHEN `buildTablesPromptSection(tables)` is called
- THEN the output contains a single `tables:` block for the chain
  with per-fragment `page=4 table=M` and `page=5 table=M` sub-markers
- AND the LLM sees the two fragments as one logical table

#### Scenario: Viewer badge is opt-in for auto-scroll

- GIVEN a chain of 3 fragments
- WHEN the viewer renders the chain
- THEN the "Part 2 of 3" badge and a next/prev pager are visible
- AND auto-follow scroll to the next fragment is **off** by default
  with a toggle on the badge

#### Scenario: Backfill is incremental and dry-run by default

- GIVEN source S already has ≥1 chain in
  `research_evidence_tables`
- WHEN `bun run scripts/merge-multipage-tables.ts` runs without flags
- THEN S is skipped
- AND no `continues_from_id` writes occur
- AND the script exits with a non-zero status ONLY on actual error
  (skipping is not an error)

#### Scenario: TABLE_MERGE_MODE=manual disables auto-merge

- GIVEN `TABLE_MERGE_MODE=manual`
- WHEN the local provider runs on a PDF with a clear multi-page table
- THEN the detector writes zero `continues_from_id` links
- AND only admin `force_merge` overrides create FK rows

## MODIFIED Requirements

### Requirement: Quality Gate And Fallback

The quality gate MUST count chain heads (rows where
`continues_from_id IS NULL`) as 1 toward `low_table_count`, not the
raw number of persisted rows. A 50-row table that spans 3 pages is 1
chain head, not 3 tables.

(Previously: total returned tables was the raw count across the whole
document.)

#### Scenario: Multi-page table counts as 1 toward table count

- GIVEN the local provider returns 3 fragments of one logical table
  on pages 5, 6, 7, all linked via `continues_from_id`
- WHEN the quality gate runs
- THEN the gate sees 1 chain head
- AND `low_table_count` is not triggered for this source
- AND the gate log records `tables=1` (chain heads), not `tables=3`

### Requirement: Prompt Injection Of Extracted Tables

`buildTablesPromptSection` MUST walk `continues_from_id` chains and
emit a single `tables:` block per chain. Fragments in a chain are
ordered by `page` ascending, and each fragment retains its own
`page=N table=M` sub-marker. Empty cells still render as `-`. The
defensive merge MUST also fire on cached rows where
`continues_from_id` is `NULL` but the `hard` heuristic matches — the
LLM view is unified even when the DB FK is absent.

(Previously: each persisted table was rendered as its own
`page=N table=M` block with no chain awareness.)

#### Scenario: Chain head collapses to one block

- GIVEN three persisted fragments linked 5→6→7 via
  `continues_from_id`
- WHEN `buildTablesPromptSection(tables)` is called
- THEN the output contains one `tables:` block for the chain
- AND the block contains three `page=N table=M` sub-markers in
  page-ascending order
- AND the block's body is the concatenation of fragment bodies in
  chain order
