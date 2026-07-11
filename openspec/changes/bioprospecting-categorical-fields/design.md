# Design: bioprospecting-categorical-fields

> SDD design phase. Artifact store: openspec. Date: 2026-07-11.
> Implements **Approach E** (proposal.md). Architectural HOW for making
> `bioactivity` / `applicationArea` / `assayModel` emit SHORT CATEGORICAL
> labels via a prompt-only extraction change, then re-extracting the corpus
> and re-running the compound backfill as one atomic operation.

## Scope & boundaries

- **Single seam touched**: the LLM extraction prompt inside
  `llmFactsForChunkBatch` (`src/services/researchBrain/bioprospectingExtractor.ts:246-287`).
  No code is added; only prompt text is edited.
- **Output contract unchanged**: the JSON-array shape, the field list
  (line 248-254), and the `normalizeFacts` → `asString` mapping
  (lines 91-94) all stay exactly as-is. We only add *value-shape
  constraints* on three existing fields plus an overflow rule pointing
  verbose text at `resultSummary`.
- **No schema / graph / API change.** The graph consumes the same
  `bioactivity`, `application_area`, `assay_model` columns and densifies
  for free once the values are short.

## Component & data flow (unchanged topology)

```
extract-bioprospecting.ts  --all
   └─> extractBioprospectingFactsForSource(sourceId)
         ├─ load chunks + tables
         ├─ llmFactsForChunkBatch  ← *** PROMPT EDIT HERE (only change) ***
         │     └─ normalizeFacts → asString(bioactivity|applicationArea|assayModel)  [unchanged]
         ├─ heuristicFactsFromChunks  [fallback — already short tokens, unchanged]
         ├─ attachCompoundAuthority  [stamps compound_canonical_id on new facts]
         └─ replaceBioprospectingFactsForSource
               ├─ DELETE facts WHERE source_id = …   (db.ts:484-488)
               └─ INSERT new payload  → *** NEW fact ids ***  → drops old compound links
```

The write path is why the compound backfill must re-run: `replace…`
DELETEs then re-INSERTs (db.ts:484-488, 500-582). New fact rows get
`compound_authority_status = 'pending'` and `compound_canonical_id`
only from the freshly-loaded `aliasMap` — so the deeper `local`/fuzzy
links produced by `compound-canonicalization-recovery` are wiped and
must be regenerated.

---

## Decision 1 — Prompt edit shape (categorical constraint on 3 fields)

**What**: Add one categorical rule line per targeted field to the
`Strict rules:` block, add a guiding-examples sub-block, and add a
single overflow rule pushing verbose mechanism/description to
`resultSummary`. Do NOT alter the field list or JSON contract.

**Rationale**: The model emits sentence-like values only because the
prompt places no shape constraint on these three fields. A per-field
rule + guiding examples (not a closed vocabulary) is the minimal,
reversible lever. `resultSummary` already exists as the overflow home,
so no information is lost.

**Rejected alternatives**:
- *Closed/controlled vocabulary in the prompt* — rejected (proposal
  out-of-scope): would drop novel marine activities.
- *Post-hoc normalization in `normalizeFacts`* — rejected: deterministic
  truncation cannot decide *which* short label a sentence maps to; that
  is exactly the LLM's job and would silently mangle values.
- *Schema/enum column* — rejected: write-path + migration scope creep,
  and kills the free-label requirement.

### Before (bioprospectingExtractor.ts, current rule block excerpt)

```
Strict rules:
- Extract only facts explicitly supported by the chunks or the tables block.
- Use "supported" only when the quote directly supports the fact.
- Use "hypothesis" only for explicit speculation in the source text.
- quote must be a short verbatim snippet from the chunk (table cell text also counts).
- chunkIndex must match the supporting chunk_index; set sourceTableRef when the
  supporting evidence is a cell in the tables block instead.
- Only fill measurementValue, measurementUnit, measurementDirection, measurementMin,
  measurementMax, timepoint, condition, pValue, sampleSize, or statisticalTest when
  the quote or immediately adjacent text (or a table cell) explicitly supports them.
- measurementDirection must be one of: increase, decrease, no_change, mixed.
- measurementUnit should preserve the paper unit, for example %, fold-change, cells/mL.
- If the number is ambiguous, leave numeric fields out and keep it in resultSummary.
- Do not infer species-compound-activity links unless they are in the same local context.
- Prefer facts useful for: anticancer, anti-inflammatory, antimicrobial, antioxidant,
  cosmetic, biomaterials, thermal resistance, coral reef/anemone/cnidarian bioprospecting.
- Skip generic background with no organism, molecule, activity, application, or assay.
- Prefer 0-8 high-signal facts per batch.
- Prefer facts grounded in the tables block over facts grounded only in prose when both
  are available — tables are higher-signal for measurements, conditions, and species-compound
  pairings.
```

### After (insert the four rule lines + examples block; keep everything else)

Insert immediately AFTER the `measurementUnit should preserve…` line and
BEFORE the `Do not infer species-compound-activity links…` line (i.e.
grouped with the value-shape rules), and REPLACE the existing
`Prefer facts useful for:` category-hint line (lines 275-276) with the
per-field examples block so the hint is reused, not duplicated:

```
- bioactivity must be a SHORT CATEGORICAL label (one to three words, lowercase),
  NOT a sentence or mechanism. Put any mechanism, pathway, or verbose description
  in resultSummary instead. Example labels (guiding, not exhaustive — coin a new
  short label when none fits): antifungal, antibacterial, antimicrobial, anticancer,
  cytotoxic, anti-inflammatory, antioxidant, antiviral, wound healing, photoprotective,
  thermal tolerance, anti-biofouling.
- applicationArea must be a SHORT CATEGORICAL label (one to three words, lowercase),
  NOT a sentence. Put detail in resultSummary. Example labels (guiding, not exhaustive):
  anticancer, anti-inflammatory, antimicrobial, antioxidant, cosmetic, nutraceutical,
  biomaterials, agriculture, aquaculture, thermal resistance, coral reef restoration.
- assayModel must be a SHORT CATEGORICAL label (assay type, cell line, or model
  organism; one to four words), NOT a sentence describing the protocol. Put protocol
  detail in resultSummary. Example labels (guiding, not exhaustive): MIC assay,
  DPPH assay, MTT assay, HeLa cells, zebrafish, coral fragment, in vitro, in vivo.
- For bioactivity, applicationArea, and assayModel: whenever the source phrasing is
  long or descriptive, emit the short label in the field and move the full sentence
  into resultSummary. resultSummary is the home for all verbose overflow.
- Skip generic background with no organism, molecule, activity, application, or assay.
```

Notes on the edit:
- The old lines 275-276 (`Prefer facts useful for: anticancer …`) are
  **folded into** the per-field example lists above — those exact seed
  categories (anticancer, anti-inflammatory, antimicrobial, antioxidant,
  cosmetic, biomaterials, thermal resistance, coral/anemone/cnidarian)
  are preserved so recall bias toward the target domain is retained.
- `measurementDirection must be one of: …` stays a CLOSED set (it is a
  real enum). The three new rules are deliberately phrased as
  "SHORT CATEGORICAL label … guiding, not exhaustive" — an OPEN set.
  This linguistic distinction is load-bearing: it is the difference
  between the rejected closed vocabulary and the chosen free-label design.
- Output contract is untouched: same 32-ish keys, same JSON array,
  same `maxTokens: 2500, temperature: 0`.

---

## Decision 2 — Regex fallback path stays as-is (already consistent)

**What**: No change to `heuristicFactsFromChunks` (lines 183-226).

**Rationale**: The fallback's `bioactivityPattern` (line 187-188) already
emits single short tokens — `antifungal`, `cytotoxic`, `anticancer`,
`antioxidant`, `cosmetic`, `photoprotective`, etc. — via
`sentence.match(bioactivityPattern)?.[0]` (line 213), and dumps the full
sentence into `resultSummary` (line 214). This is EXACTLY the new
categorical contract (short label in field, verbose in `resultSummary`).
It sets no `applicationArea`/`assayModel`, which is acceptable (absence,
not a verbose value). Touching it would add risk for zero benefit — the
fallback only fires when the LLM returns zero facts across all batches.

**Conclusion**: Confirmed consistent. Leave untouched.

---

## Decision 3 — Atomic re-extraction + compound backfill runbook

Re-extraction and the compound backfill are **one atomic operational
sequence**. Ordering is mandatory: re-extraction WIPES compound links
(new fact ids), so canonicalization MUST run *after*, never before or
interleaved.

**Rationale for ordering**: `replaceBioprospectingFactsForSource` DELETEs
+ re-INSERTs (db.ts:484-488). Any `compound_canonical_id` set before
re-extraction is discarded. Running the fuzzy pass before the accept-local
pass mirrors the shipped `compound-canonicalization-recovery` sequence:
fuzzy variants first resolve against the authority, then accept-local
promotes the residual misses to `status='local'`.

### Step 0 — Baseline capture (BEFORE anything; see Decision 5)

Run the baseline SQL + sample export from Decision 5 and archive the
output. Re-extraction is NOT reversible.

### Step 1 — Re-extract the corpus

```bash
# Dry-run first to confirm the candidate set and knobs.
bun scripts/extract-bioprospecting.ts --all --source-kind paper --dry-run

# Full re-extraction of every paper source. --all sets status="all"
# so already-extracted sources are re-processed (extract-bioprospecting.ts:33).
# --limit caps the candidate query; raise it above the corpus size or
# batch through the corpus in chunks.
bun scripts/extract-bioprospecting.ts --all --source-kind paper --limit 10000
```

- Each source goes through `extractBioprospectingFactsForSource` →
  `replaceBioprospectingFactsForSource`, which **REPLACES** all facts for
  that source (confirmed db.ts:479-488). New fact ids; old
  `compound_canonical_id` links dropped.
- The extractor already stamps compound authority from the current
  `aliasMap` during the run (bioprospectingExtractor.ts:464-475), so some
  links exist immediately — but the fuzzy/local recovery links do NOT and
  must be regenerated in Step 2.
- Optional tuning flags (extract-bioprospecting.ts:27-30):
  `--max-chunks`, `--batch-chunks`, `--timeout-ms`, `--retries`.

### Step 2 — Re-run the compound backfill (2-command sequence)

```bash
# Phase 1 — fuzzy variant pass (deterministic authority resolution).
bun scripts/normalize-compounds.ts --all --try-fuzzy-variants --limit 10000

# Phase 2 — accept-local promotion (two-gate: CLI flag + env master-arm).
COMPOUND_AUTHORITY_ACCEPT_LOCAL=true \
  bun scripts/normalize-compounds.ts --all --try-fuzzy-variants --accept-local --limit 10000
```

- `--all` widens the candidate set beyond `pending`-only
  (normalize-compounds.ts:21) so the freshly-inserted facts are all
  considered.
- `--accept-local` (`promoteLocalOnMiss`, normalize-compounds.ts:42)
  ONLY takes effect when `COMPOUND_AUTHORITY_ACCEPT_LOCAL=true` is also
  set — the driver resolves the two-gate flag internally
  (normalize-compounds.ts:39-42). Both are required in Phase 2.
- Phase 2 benefits from the hardened variant builder shipped in
  `compound-canonicalization-recovery` (proposal.md:63).

**Atomicity note**: treat Steps 1+2 as a single operation. Do NOT expose
the corpus to consumers between them — between Step 1 and Step 2 the
compound graph is under-linked (only same-run `aliasMap` hits present).

---

## Decision 4 — Eval / guardrail (fact-count delta + label spot-check)

**Goal**: catch recall regression (the stricter prompt suppressing facts)
and confirm the categorical contract is actually being honored.

### Acceptance thresholds (defaults)

- **Fact-count delta**: total `research_bioprospecting_facts` count AFTER
  is within **±15%** of the BEFORE baseline. A drop below −15% is a
  FAIL (possible recall regression); an increase is acceptable (denser,
  more granular facts) but note if > +30% (possible over-splitting).
- **Label spot-check**: sample **30** facts that have a non-null
  `bioactivity`. At least **90%** must have (a) a short label —
  heuristic `word_count(bioactivity) <= 4` — AND (b) a non-empty
  `result_summary` when the source phrasing was descriptive. Verbose
  values (full sentences) in `bioactivity` are the regression signal.

### Runnable checks

Baseline vs. after — total and per-field non-null counts:

```sql
-- Run BEFORE (baseline) and AFTER; compare.
SELECT
  count(*)                                             AS total_facts,
  count(*) FILTER (WHERE bioactivity     IS NOT NULL)  AS with_bioactivity,
  count(*) FILTER (WHERE application_area IS NOT NULL)  AS with_application_area,
  count(*) FILTER (WHERE assay_model      IS NOT NULL)  AS with_assay_model,
  count(*) FILTER (WHERE result_summary   IS NOT NULL)  AS with_result_summary,
  count(DISTINCT source_id)                            AS sources
FROM research_bioprospecting_facts;
```

Categorical-shape check (short-label ratio on the target field):

```sql
-- AFTER: fraction of bioactivity values that are short (<= 4 words).
SELECT
  count(*)                                                       AS n,
  round(avg( (array_length(regexp_split_to_array(btrim(bioactivity), '\s+'), 1) <= 4)::int )::numeric, 3)
                                                                 AS short_label_ratio
FROM research_bioprospecting_facts
WHERE bioactivity IS NOT NULL;
```

Sampling query for manual spot-check (30 rows):

```sql
SELECT source_id, bioactivity, application_area, assay_model,
       left(result_summary, 160) AS result_summary_head
FROM research_bioprospecting_facts
WHERE bioactivity IS NOT NULL
ORDER BY random()
LIMIT 30;
```

Densification sanity (the actual goal — avg facts/node should rise):
compare the graph's avg facts/node before/after; expected to move up
from ~1.5 as verbose values collapse into shared short labels.

**Decision rule**: if fact-count delta < −15% OR short-label ratio < 0.90,
STOP and inspect. The prompt change is revertable (Decision 5).

---

## Decision 5 — Risk / rollback

| Risk | Reversible? | Mitigation |
|------|-------------|------------|
| Prompt change degrades quality | **Yes** | Revert the prompt edit — pure text, no schema/data coupling. |
| Re-extraction regenerates ALL facts (non-deterministic; new ids) | **No** | Capture baseline BEFORE (counts + sample export); eval guardrail (Decision 4) gates acceptance. |
| Compound links wiped (new fact ids) | Regenerable | Mandatory Step 2 backfill; treat Steps 1+2 as atomic. |
| Recall regression (stricter prompt suppresses facts) | via revert | Guiding examples (open set) + `resultSummary` overflow keep coverage; ±15% count guardrail. |
| Write-path touched (unlike the read-only graph change) | — | Only the prompt string changes; `replace…`/`asString`/schema untouched. |

### Baseline capture (run in Step 0, BEFORE re-extraction)

```sql
-- 1. Counts baseline (same query as Decision 4) — archive the output.
-- 2. Full sample export for diffing (archive as CSV/JSON):
SELECT id, source_id, species, compound, bioactivity, application_area,
       assay_model, result_summary, compound_canonical_id
FROM research_bioprospecting_facts
ORDER BY source_id, id;
```

Because re-extraction is not reversible, this export is the only way to
diff post-run quality against the shipped corpus. Archive it before Step 1.

---

## Out of scope (restated from proposal)

- Synonym registry (Approach A), ontology backing (B), LLM/embedding
  clustering (C/D) — deferred; this change is their prerequisite.
- Any change to `bioprospecting-entity-graph` or its API — it consumes the
  same three columns and simply densifies.
- A controlled/closed vocabulary — explicitly rejected in favor of free
  short labels with guiding examples.
- Application code changes beyond the prompt string — none.
</content>
</invoke>
