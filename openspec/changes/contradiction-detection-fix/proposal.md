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

## Out of scope (tracked follow-ups)

- Cross-source detection → **PR2** (rule-based, group-level rows, bounded).
- LLM cost **cap** / extending `costService.ApiProvider` → **PR3**.
- Mislabeled `conflict_type` values (a `measurement_direction` conflict is stored as
  `compound_mismatch`; a `relation_type` conflict as `bioactivity_mismatch`).
- `ContradictionDetectionOptions.force` is destructured and never read — admin
  re-detect cannot force.
- `listContradictionsGlobal` accepts `sourceId` but never applies the filter (the
  client sends it).
