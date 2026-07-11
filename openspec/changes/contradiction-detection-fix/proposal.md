# Proposal: contradiction-detection-fix — PR1

> The design for this change is `exploration.md` in this directory. It carries the
> file:line evidence for every defect referenced below. This proposal records the PR1
> slice only.

## Why

The bioprospecting contradiction feature has an LLM tier that has produced **zero rows
in its entire lifetime** — and nobody noticed, because a dead run logged itself as a
success. PR1 makes the tier correct, observable and switchable, fixes the review UI it
feeds, and removes the class of test that let the defect ship.

PR1 is **cost-neutral ($0)**: the LLM call already fires today (`contradictionLlM.ts`
L130) and the result is thrown away. This stops the waste; it does not add spend. The
new LLM flag defaults to **OFF**, so the deployed cost after PR1 is strictly ≤ today's.

## What ships in PR1

1. **The id bug.** `buildFactsJson` now includes each fact's stable `id` in the payload.
   The prompt always demanded `sourceFactId` / `conflictingFactId` UUIDs — the model was
   never shown them, so every proposal failed the `facts.find(f => f.id === ...)` join.

2. **Join-rate assertion (the lesson).** The insert path's `if (!factA || !factB)
   continue;` was a silent drop. `runLLMDetection` now returns
   `{ proposed, resolved, dropped, inserted }`, and when the join rate falls below 50%
   (or `resolved === 0` while `proposed > 0`) it logs a structured
   `runLLMDetection_join_rate_failure` at **ERROR** with the unknown-id sample. The
   success log no longer reports a dead run as `{ llmInserted: 0 }` — it surfaces
   proposed / resolved / dropped / inserted.

3. **Cost tracking.** `recordLlmCall` + `calculateCost` are wired in, attributed to the
   ingestion `runId` (threaded from the detector). The call is recorded even when every
   proposal is dropped — the spend was already incurred. A hard cost **cap** is out of
   scope (`costService.ApiProvider` covers only `mistral_ocr | pubchem`; extending it is
   PR3).

4. **Separate LLM flag.** `BIOPROSPECTING_CONTRADICTION_LLM` (default **false**) now
   gates the LLM tier alone; `BIOPROSPECTING_CONTRADICTION_DETECTION` keeps gating the
   feature. The free, deterministic rule-based tier can now run without spending.

5. **The admin review UI (Bug 3).** The review gate was fiction: the client declared the
   stale spec schema, so `row.source_fact_id.slice(0, 8)` threw a TypeError on every
   real row and `row.resolution_status === "unresolved"` was never true (the DB says
   `open`), so Resolve/Dismiss never rendered. The hook types, the table and the status
   predicate now match the real schema.

6. **Real tests.** The old suite never imported the module — it copy-pasted
   `extractJsonArray` and the validator and tested the copies. That is precisely why the
   contract mismatch shipped and survived. The suite now imports the real module and
   asserts the real contract.

7. **Migration/spec drift (Bug 4).** Reconciled — see below.

## Migration / spec reconciliation

Findings:

- No migration in the repo produces the live schema. `20260610000000` creates the
  **old** columns (`source_fact_id`, `contradiction_type`, `evidence_pack`,
  `resolution_status`, `created_at`); the rename to `fact_a_id`, `fact_b_id`,
  `conflict_type`, `severity`, `status`, `detected_at`, `metadata` happened
  out-of-band. `20260617000000` only *documents* it.
- Consequence: a from-scratch `supabase db reset` **fails at `20260617000000`**.
  Postgres validates a `LANGUAGE sql` function body at CREATE time, and that body
  references `status` / `detected_at`, which the chain has not produced.

Decision: the reconciliation is a guarded, idempotent `DO $$` block prepended to
`20260617000000` (renames when the old columns exist; adds the missing columns,
constraints and indexes; maps `unresolved` → `open`).

Why it is safe:

- **Live DB: strict no-op.** `20260617000000` is already in the migration history, so it
  is never re-executed there.
- **Fresh rebuild: fixed.** Ordering forces the placement — a *new* migration would sort
  after `20260617000000`, and the chain dies before reaching it.
- **Already-applied migrations are not rewritten.** `20260610000000` and
  `20260616000200` are untouched. This is a forward-only rename, not a rewrite of what
  the DB was built from.
- Every statement is guarded against `information_schema` / `pg_constraint`, so it is
  also a no-op against any database that already has the live shape.

The `bioprospecting-contradiction-detection` spec is amended to the live schema, with
the divergence called out inline.

## Environment flags

`.env.example` could not be edited — the sandbox denies read and write on that path.
**Follow-up (one-line manual step):** append

```bash
# Bioprospecting contradiction detection
BIOPROSPECTING_CONTRADICTION_DETECTION=false  # rule-based + (optionally) LLM tier
BIOPROSPECTING_CONTRADICTION_LLM=false        # LLM tier only. Costs money. Default OFF.
```

---

# PR2 — Cross-source rule-based detection (LLM-free, deterministic)

## Why

`runContradictionDetection` loads facts with
`getBioprospectingFactsForSource(sourceId)` — one paper at a time. A disagreement
BETWEEN papers, the scientifically interesting case, was structurally
undetectable. PR2 adds a corpus-wide sweep. It is 100% deterministic: **zero LLM
calls, zero spend** (asserted by a test that walks the module's transitive import
graph). The LLM tier stays OFF.

## What ships in PR2

1. **Cross-source detection** (`contradictionCrossSource.ts`, new). Groups facts
   corpus-wide by (`compound_canonical_id`, `normalizeForMatch(bioactivity)`) —
   the canonical id is the compound half because across papers the same molecule
   is spelled a dozen ways. Only groups spanning **≥ 2 distinct sources** are
   candidates, and a conflict counts only when the two opposite sides are
   asserted by **different** sources (an opposition confined to one paper is the
   intra-source tier's row). The intra-source path is untouched — PR2 is
   additive.

2. **Group-level rows, not pairwise.** N agonist facts vs M antagonist facts
   would be N×M rows. Instead: **ONE row per (group, conflict axis)**. A
   deterministic representative pair (lowest-id fact on each side, cross-source)
   goes in `fact_a_id` / `fact_b_id`, so the pair-shaped schema is preserved; the
   full picture — every conflicting fact id, every source id/title, the per-side
   values, the axis — goes in `metadata`, tagged
   `metadata.detection = 'cross_source_rule_based'`. That is also what an
   operator wants to read: *"Lupinacidin A / antitumor: opposite directions
   across papers X, Y, Z"*.

3. **Bounds (future-proofing, not a present emergency).** Measured on the live
   corpus: 145 groups, only **3** span >1 source, max group size **9**. There is
   no combinatorial bomb today; there will be as papers land.
   `BIOPROSPECTING_CONTRADICTION_MAX_GROUP_SIZE` (default **200**) and
   `BIOPROSPECTING_CONTRADICTION_MAX_ROWS_PER_RUN` (default **500**). An
   oversized group is **skipped and logged at ERROR** — never silently
   truncated. A run that hits the row cap stops and reports `truncated: true`,
   also at ERROR.

4. **Unique index + idempotent upsert.** The table had **no unique index** and
   the writer did SELECT-then-INSERT, so a re-run (or a race) duplicated rows.
   Migration `20260711030000_add_contradiction_unique_key.sql` collapses any
   pre-existing duplicates (keeping the oldest row, so an operator's decision
   survives) and adds `uniq_contradictions_fact_pair_type` on
   `(fact_a_id, fact_b_id, conflict_type)`. `upsertBioprospectingContradictionRow`
   now does a real `ON CONFLICT DO UPDATE` against it. `status` is deliberately
   **omitted from the payload**: on insert the column default `'open'` applies;
   on conflict a `resolved` / `dismissed` decision is preserved. A re-detection
   must never resurrect a dismissed contradiction. `metadata` / `severity` /
   `explanation` ARE refreshed, so a growing group updates its own row.

5. **Manual/scheduled trigger.** `scripts/detect-contradictions.ts
   --cross-source [--dry-run] [--limit N] [--max-group-size N] [--max-rows N]`.
   Deliberately **not** wired into the per-source ingest path — a corpus-wide
   pass on every ingest would be quadratic in the corpus size.

6. **Flag.** Reuses `BIOPROSPECTING_CONTRADICTION_DETECTION`.
   `BIOPROSPECTING_CONTRADICTION_LLM` stays OFF and is irrelevant to this path.

7. **Tests that import the real module.** `contradictionCrossSource.test.ts`
   drives the real `runCrossSourceContradictionDetection` and injects only the IO
   boundary (`deps`) — no `mock.module`, so nothing leaks into other suites.

## Notes on `conflict_type`

The live table constrains `conflict_type` to
`compound_mismatch | bioactivity_mismatch | organism_mismatch |
measurement_mismatch`, so PR2 reuses values from that set rather than inventing
`cross_source_*` labels a CHECK constraint would reject mid-sweep. The direction
axis uses the honest `measurement_mismatch` (the intra tier's `compound_mismatch`
for the same axis remains a tracked follow-up). Cross-source rows are identified
by `metadata.detection`.

## Environment flags (PR2)

```bash
BIOPROSPECTING_CONTRADICTION_MAX_GROUP_SIZE=200   # skip (loudly) groups above N facts
BIOPROSPECTING_CONTRADICTION_MAX_ROWS_PER_RUN=500 # stop a sweep after N rows
```

## Out of scope (tracked follow-ups)

- The **LLM tier** stays OFF; an LLM cost **cap** / extending
  `costService.ApiProvider` → **PR3**.
- Mislabeled `conflict_type` on the intra-source tier.
- `ContradictionDetectionOptions.force` — destructured, never read.
- `listContradictionsGlobal` accepts `sourceId` but never filters on it.
- The admin UI does not yet surface `metadata.detection` / the cross-source
  source list, so a group-level row currently reads as a plain pair in the
  review queue.
- `contradictionDetector.test.ts` is still the copy-paste kind (it re-implements
  the detector and asserts against the copy). PR2 did not rewrite it.
- Facts with no `compound_canonical_id` are invisible to the cross-source sweep
  (reported as `factsWithoutCanonicalId`); run `scripts/normalize-compounds.ts`
  first to maximize coverage.

---

## PR1 — Out of scope (tracked follow-ups)

- Cross-source detection → **PR2** (shipped above).
- LLM cost **cap** / extending `costService.ApiProvider` → **PR3**.
- Mislabeled `conflict_type` values (a `measurement_direction` conflict is stored as
  `compound_mismatch`; a `relation_type` conflict as `bioactivity_mismatch`).
- `ContradictionDetectionOptions.force` is destructured and never read — admin
  re-detect cannot force.
- `listContradictionsGlobal` accepts `sourceId` but never applies the filter (the
  client sends it).
