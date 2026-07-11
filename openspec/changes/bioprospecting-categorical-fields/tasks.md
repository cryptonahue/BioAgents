# Tasks: bioprospecting-categorical-fields

> SDD tasks phase. Artifact store: openspec. Date: 2026-07-11.
> Implements **Approach E** (proposal.md / design.md). CODE change is a
> prompt-text-only edit; the corpus backfill + eval are OPERATOR-run
> against the production DB/LLM runtime (the operator owns that runtime).

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~20 (prompt text: +5 rule lines, −2 old hint lines, net edit in one string block) |
| 400-line budget risk | None (well under budget) |
| Chained PRs recommended | No |
| Suggested split | Single PR — one file, prompt string only |
| Delivery strategy | ask-on-risk |
| Chain strategy | n/a (single PR) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending (n/a)
400-line budget risk: None

### Suggested Work Units

| Unit | Type | Goal | Likely PR | Notes |
|------|------|------|-----------|-------|
| 1 | CODE | Prompt edit: categorical rules on 3 fields + fold category hint into per-field examples | PR 1 | `bioprospectingExtractor.ts` only; string block, no logic |
| 2 | CODE | Verification: `bun tsc --noEmit` + read-through of output-shape invariants | PR 1 | Build check; contract untouched |
| 3 | OPERATOR | Baseline capture (irreversible-run prerequisite) | — (runtime) | SQL counts + full sample export archived BEFORE re-extraction |
| 4 | OPERATOR | Full corpus re-extraction | — (runtime) | `scripts/extract-bioprospecting.ts --all …` |
| 5 | OPERATOR | Compound backfill re-run (atomic with Unit 4) | — (runtime) | `scripts/normalize-compounds.ts` 2-command sequence |
| 6 | OPERATOR | Eval gate (PASS/FAIL) | — (runtime) | ±15% fact-count + 30-fact label spot-check |
| 7 | OPERATOR | Graph densification verification | — (runtime) | avg facts/node up + compounds still linked |

> Units 3–7 are OPERATOR-run runtime steps against the production DB/LLM.
> They are NOT part of the code diff and do not consume the PR line budget.
> The CODE PR (Units 1–2) can ship independently; the operator runs Units
> 3–7 afterward as one atomic backfill (4+5) followed by acceptance (6–7).

---

## Phase 1 — CODE: Prompt edit (single seam)

**Target file:** `src/services/researchBrain/bioprospectingExtractor.ts`
(prompt string in `llmFactsForChunkBatch`, lines 246–287)
**Satisfies spec requirements:** "Categorical Labels For bioactivity,
applicationArea, assayModel", "Novel Activity Is Emitted As A Short Label…",
"resultSummary Preserves All Verbose Detail…".

- [ ] 1.1 Insert the three per-field categorical rule lines into the
  `Strict rules:` block, immediately AFTER the `measurementUnit should
  preserve…` line (272) and BEFORE the `Do not infer species-compound-activity
  links…` line (274): one rule each for `bioactivity`, `applicationArea`,
  `assayModel`, each stating the value MUST be a SHORT CATEGORICAL label
  (1–4 words, lowercase, no sentence) with verbose mechanism/protocol/description
  pushed to `resultSummary`. Use the exact wording from design.md Decision 1
  "After" block. **Done:** the three `must be a SHORT CATEGORICAL label` rule
  lines are present with per-field GUIDING example lists (open set, "guiding,
  not exhaustive — coin a new short label when none fits"), not a closed
  "must be one of" enum. Depends on: none.
  Satisfies: "Categorical Labels" MODIFIED requirement + its
  "Guiding examples are not a closed vocabulary" scenario.

- [ ] 1.2 Add the single overflow rule line for all three fields: "whenever
  the source phrasing is long or descriptive, emit the short label in the field
  and move the full sentence into resultSummary. resultSummary is the home for
  all verbose overflow." **Done:** overflow rule present. Depends on: 1.1.
  Satisfies: "resultSummary Preserves All Verbose Detail" ADDED requirement.

- [ ] 1.3 Fold the old category-hint lines 275–276 (`Prefer facts useful for:
  anticancer, anti-inflammatory, antimicrobial, antioxidant, cosmetic,
  biomaterials, thermal resistance, coral reef/anemone/cnidarian bioprospecting.`)
  INTO the per-field GUIDING example lists so the seed categories are reused,
  not duplicated. Remove the standalone `Prefer facts useful for:` line.
  Preserve the `Skip generic background…` line (277). **Done:** lines 275–276
  no longer exist as a standalone hint; those exact seed categories appear in
  the per-field example lists; recall bias toward the target domain retained.
  Depends on: 1.1.

- [ ] 1.4 CONFIRM-ONLY (NO code change): the JSON contract is untouched —
  same 32-key field list (lines 248–254), same JSON-array output shape, same
  `maxTokens: 2500, temperature: 0`; the `asString` mapping (lines 91–94),
  `normalizeFacts`, the inline merge, and `replaceBioprospectingFactsForSource`
  are byte-for-byte unchanged. **Done:** verified only the `Strict rules:`
  text block changed; no field added/removed; `measurementDirection` closed
  enum untouched. Depends on: 1.1–1.3.
  Satisfies: "Entity Graph Densifies Additively With No Graph Or API Change".

- [ ] 1.5 CONFIRM-ONLY (NO code change): the regex-fallback path
  `heuristicFactsFromChunks` (lines 183–226) needs NO change — its
  `bioactivityPattern` already emits single short tokens and dumps the full
  sentence into `resultSummary`, matching the new categorical contract.
  **Done:** confirmed fallback left untouched (design Decision 2). Depends on: none.

## Phase 2 — CODE: Verification (repo tdd:false — no mandated runner)

- [ ] 2.1 `bun tsc --noEmit` passes clean with no NEW errors in
  `bioprospectingExtractor.ts` (pre-existing unrelated errors, e.g. in
  `scripts/ingest-marine-drugs.ts`, remain out of scope). **Done:** build check
  green for the changed file. Depends on: 1.1–1.3.

- [ ] 2.2 Read-through validation: because the change is prompt-text only, no
  runtime output-shape test is required — confirm by inspection that the edited
  prompt still asks for the same JSON array of the same keys and that the three
  new rules read as OPEN-set guidance (not a closed vocabulary). **Done:**
  prompt reads correctly; no contract drift. Depends on: 2.1.

---

## Phase 3 — OPERATOR: Baseline capture (runtime; BEFORE re-extraction — IRREVERSIBLE)

> OPERATOR-run against the production DB. Re-extraction is NOT reversible, so
> this baseline is the only way to diff post-run quality. MUST complete before
> Phase 4. Satisfies: "Extraction-Quality Guardrail Against Recall Regression"
> (before-half) + design Decision 5 rollback.

- [ ] 3.1 Run the baseline counts SQL (design Decision 4 / Decision 5 query 1)
  and ARCHIVE the output: `total_facts`, `with_bioactivity`,
  `with_application_area`, `with_assay_model`, `with_result_summary`, `sources`
  FROM `research_bioprospecting_facts`. **Done:** baseline count row saved.
  Depends on: none (but must precede Phase 4).

- [ ] 3.2 Run the full sample export SQL (design Decision 5 query 2) and archive
  as CSV/JSON: `id, source_id, species, compound, bioactivity, application_area,
  assay_model, result_summary, compound_canonical_id ORDER BY source_id, id`.
  **Done:** full export archived for diffing. Depends on: none (precede Phase 4).

## Phase 4 — OPERATOR: Full corpus re-extraction (runtime; atomic with Phase 5)

> OPERATOR-run. Goes through the EXISTING path only — no new code. REPLACES all
> facts per source (new ids), wiping `compound_canonical_id`.
> Satisfies: "Corpus Backfill Is Full Re-Extraction Plus Compound
> Re-Canonicalization As One Atomic Operation" (re-extraction half).

- [ ] 4.1 Dry-run to confirm candidate set + knobs:
  `bun scripts/extract-bioprospecting.ts --all --source-kind paper --dry-run`.
  **Done:** candidate count reviewed, matches expected corpus size.
  Depends on: Phase 1–2 shipped (prompt edit live), Phase 3 done.

- [ ] 4.2 Full re-extraction of every paper source:
  `bun scripts/extract-bioprospecting.ts --all --source-kind paper --limit 10000`
  (raise `--limit` above corpus size or batch through in chunks; optional tuning
  flags `--max-chunks`, `--batch-chunks`, `--timeout-ms`, `--retries`).
  **Done:** every paper source re-processed; facts replaced with new ids.
  Depends on: 4.1. NOTE: do NOT expose corpus to consumers until Phase 5 done.

## Phase 5 — OPERATOR: Compound backfill re-run (runtime; ATOMIC with Phase 4)

> OPERATOR-run. MUST run AFTER Phase 4 (re-extraction wiped links). Fuzzy pass
> first, then accept-local. Treat Phases 4+5 as ONE atomic operation.
> Satisfies: same atomic-backfill requirement (re-canonicalization half) + its
> two scenarios (links null after re-extraction / restored after backfill).

- [ ] 5.1 Phase 1 fuzzy variant pass (deterministic authority resolution):
  `bun scripts/normalize-compounds.ts --all --try-fuzzy-variants --limit 10000`.
  **Done:** fuzzy pass complete; surface-variant facts re-linked. Depends on: 4.2.

- [ ] 5.2 Phase 2 accept-local promotion (two-gate: CLI flag + env master-arm):
  `COMPOUND_AUTHORITY_ACCEPT_LOCAL=true bun scripts/normalize-compounds.ts --all
  --try-fuzzy-variants --accept-local --limit 10000`. **Done:** residual misses
  promoted to `status='local'`; `compound_canonical_id` restored on eligible
  facts. Depends on: 5.1. (Both env var AND `--accept-local` required.)

## Phase 6 — OPERATOR: Eval gate (runtime; PASS/FAIL decision)

> OPERATOR-run. Gates acceptance of the re-extracted corpus.
> Satisfies: "Extraction-Quality Guardrail Against Recall Regression"
> (after-half + decision rule).

- [ ] 6.1 Re-run the baseline counts SQL AFTER re-extraction; compute
  fact-count delta vs Phase 3.1. **PASS** if total is within **±15%** of
  baseline (a > −15% drop = suspected recall regression = FAIL; note if > +30%
  = possible over-splitting). **Done:** delta computed, tolerance decision
  recorded. Depends on: 5.2.

- [ ] 6.2 Categorical-shape + spot-check: run the short-label-ratio SQL
  (`short_label_ratio` over `bioactivity`, design Decision 4) AND the 30-row
  random sample SQL (`source_id, bioactivity, application_area, assay_model,
  left(result_summary,160)`). **PASS** if `short_label_ratio >= 0.90` AND the
  30-row manual review shows short labels with verbose detail preserved in
  `result_summary` (no information loss). **Done:** ratio + manual review
  recorded. Depends on: 5.2.

- [ ] 6.3 PASS/FAIL decision: guardrail PASSES only when BOTH 6.1 (±15%) AND
  6.2 (ratio ≥ 0.90, no info loss) hold. On FAIL → STOP, do not accept the
  backfill; the prompt change is revertable (design Decision 5). **Done:**
  explicit PASS or FAIL logged. Depends on: 6.1, 6.2.

## Phase 7 — OPERATOR: Graph densification verification (runtime)

> OPERATOR-run. Confirms the actual goal — the read-only entity graph densifies
> for free. Satisfies: "Entity Graph Densifies Additively With No Graph Or API
> Change" scenarios.

- [ ] 7.1 Compare avg facts/node before vs after; expected to rise from ~1.5 as
  verbose values collapse into shared short labels. Confirm via a graph query
  or `bioactivity/antifungal/expand` (or a search) showing denser nodes.
  **Done:** avg facts/node increase confirmed; denser nodes observed.
  Depends on: 6.3 (PASS).

- [ ] 7.2 Confirm compounds are still linked post-backfill: the same expand/
  search that previously showed compounds still returns non-zero
  `compounds` (links regenerated by Phase 5, not lost). **Done:** compound
  links present on densified nodes. Depends on: 6.3 (PASS).
