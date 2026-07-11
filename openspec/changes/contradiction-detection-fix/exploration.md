# Exploration: contradiction-detection-fix

> SDD explore. Date: 2026-07-11.
> Target: the bioprospecting contradiction detection — the LLM tier is dead code,
> and detection is intra-source only.

## The bugs — confirmed, plus TWO nobody knew about

### Bug 1 — LLM tier is dead code (CONFIRMED)
`src/services/researchBrain/contradictionLlM.ts`:
- `buildFactsJson` (L41-67) serializes 7 fields. **`id` is not one of them.**
- The prompt (L114-118) demands `"sourceFactId": "uuid of first fact"`.
- L154-156: `facts.find(f => f.id === c.sourceFactId)` → `if (!factA || !factB) continue;`

The model is asked for a UUID **it was never shown**. Every proposal is dropped.
**And the kicker — L182 logs `{ llmInserted: 0 }` as a SUCCESSFUL run. That is why
nobody noticed.**

### Bug 2 — Intra-source only (CONFIRMED)
`contradictionDetector.ts:205` → `getBioprospectingFactsForSource(sourceId)` →
`db.ts:2501` → `.eq("source_id", sourceId)`. **Both tiers only ever see ONE paper.**
Cross-source contradictions — the scientifically interesting case — are never detected.

### 🆕 Bug 3 — THE ADMIN REVIEW UI IS BROKEN
The review gate this fix depends on **does not work**.
- Live DB columns: `fact_a_id, fact_b_id, conflict_type, severity, status
  ('open'|'resolved'|'dismissed'), detected_at, metadata`.
- The client (`client/src/hooks/useAdminReview.ts:45-59`) declares the **stale spec
  schema**: `source_fact_id, contradiction_type, evidence_pack, resolution_status,
  created_at`.
- `AdminPage.tsx:241` → `row.source_fact_id.slice(0, 8)` → `source_fact_id` is
  `undefined` on every real row → **TypeError, the tab dies.**
- L252 `row.resolution_status === "unresolved"` is never true (DB says `status:"open"`)
  → the Resolve/Dismiss buttons never render anyway.

Invisible today **only because the flag is off → zero rows → empty table**.
**Fixing the LLM tier without fixing this ships rows into a crashing viewer.**

### 🆕 Bug 4 — Migration + spec drift
`supabase/migrations/20260610000000_*.sql` and the
`bioprospecting-contradiction-detection` spec both define the **old** column names.
Migration `20260617` documents the divergence. **The repo cannot rebuild the live DB.**

## Why it survived: the tests are theater

`__tests__/contradictionLlM.test.ts` **never imports the module.** It copy-pastes
`extractJsonArray` and the validator inline and tests the **copies** (L39-65, L112-121).
The "factsJson grouping" test re-implements grouping and **never asserts `id` is present**.
`adminRoutes.test.ts:181` mocks the real shape but only asserts `toHaveLength(1)` —
never renders.

> **Tests that duplicate the implementation instead of importing it CANNOT catch a
> contract mismatch. That is THE lesson here — bigger than the id bug itself.**

(Same class as the `citationGraph` suite, which asserted query *order* instead of behavior.)

## Cost guard reality — and a correction

`src/services/researchBrain/costService.ts:36`:
```ts
export type ApiProvider = "mistral_ocr" | "pubchem";
```
**No LLM call is cost-capped anywhere.** `recordLlmCall` (`llm-cost.ts`) is
accounting-only — no cap, no kill switch. `contradictionLlM.ts` doesn't even import it:
the tier is **untracked AND uncapped**.

**⚠️ Correction to the premise**: the tier **is already spending**.
`llm.createChatCompletion` fires (L130) and the result is **thrown away**. So fixing
the id bug is **COST-NEUTRAL** for intra-source — the same 1 call/source, it just stops
*wasting* it.

→ **The LLM cost guard is a prerequisite of cross-source LLM, NOT of the id fix.**

Volume today: ~1 call/source (~14/corpus). Cross-source per-group: ~30-80 calls
(~$0.30-0.60/pass). Cross-source single-prompt: ~28k input tokens and
**`maxTokens: 2000` truncates the output** → `extractJsonArray` returns `[]` → **silent
failure mode #2. Do not do that.**

## Cross-source is a combinatorial bomb

The rule-based detector crosses opposite buckets: `|dirA| × |dirB|`, worst case N²/4
per group. Intra-source N is tiny (~34 facts/paper). **Cross-source, a hub group
(`bryostatin|PKC` across 14 papers, N≈140) → ~4,900 rows from ONE group**, each via a
SELECT-then-INSERT round trip (no unique index) → ~10k queries and a drowned review queue.

**The fix is a modeling decision, not a limit constant**: cross-source should emit
**GROUP-LEVEL** contradictions (one canonical representative pair + the conflict axis,
the rest in `metadata`). An operator wants *"bryostatin|PKC: agonist vs antagonist across
papers X, Y, Z"* — not 4,900 pairwise rows. Keeps the pair-shaped schema. Still add
MAX_GROUP_SIZE / MAX_ROWS_PER_RUN + a real unique index.

## Other findings
- **One flag gates both tiers** (`BIOPROSPECTING_CONTRADICTION_DETECTION`). No separate
  LLM flag. Not in `.env.example` → OFF in prod.
- `options.force` is destructured and **never read** → admin re-detect can't force.
- **Mislabeled types**: a `measurement_direction` conflict is stored as
  `compound_mismatch` (L128), `relation_type` as `bioactivity_mismatch` (L164). The
  compounds *match* — that's the whole point of the group.
- `listContradictionsGlobal` accepts `sourceId` but **never applies the filter**.

## Recommended slicing

| PR | Scope | Cost | Verdict |
|---|---|---|---|
| **PR1** | id fix + **join-rate assertion** + `recordLlmCall` + separate `BIOPROSPECTING_CONTRADICTION_LLM` flag (default OFF) + **fix the admin UI (Bug 3)** + real importing tests + reconcile migration/spec | **$0 — cost-neutral** | **MUST-HAVE** |
| **PR2** | Rule-based cross-source. Measure the group-size histogram FIRST, then group across sources with bounds + **group-level rows** + a unique index | **Free, deterministic** | **MUST-HAVE** |
| **PR3** | LLM cost guard: extend `ApiProvider` + caps | — | Prerequisite for PR4 only |
| **PR4** | LLM adjudicates rule-based candidates | $$ | **DEFER — conditional** |

## The honest answer

**Rule-based cross-source alone is very likely enough for v1, and the LLM tier should
stay OFF.** Deterministic detection finds exactly the interesting case (two papers, same
compound+bioactivity, opposite direction) for free and reproducibly. The LLM's *claimed*
value is contextual/assay nuance — **unproven**, and this tier has produced literally
**zero evidence in its entire lifetime**. Make it correct, observable and switchable in
PR1; then prove its value with a measured offline eval against PR2's output before
spending a cent. Same deterministic-first pattern this codebase already used elsewhere.

Option "LLM adjudicates rule-based candidates" is the right *eventual* shape (it bounds
the candidate set before any token is spent) — but that's PR4, not now.

## Open product questions
1. Cross-source rows: **group-level or pair-level?** (Strongly recommend group-level.)
2. Cross-source trigger: on every source ingest (quadratic re-scan) or a periodic/manual
   corpus-wide sweep? (Recommend manual/scheduled sweep.)
3. What IS the group-size histogram on the 470-fact corpus? **Nobody knows — measure
   before designing bounds.**
4. Correct the mislabeled `conflict_type` values (migration + backfill), or leave alone?
5. Bug 3 (admin UI crash) in scope here, or its own PR? **It must be in PR1 — the review
   gate is a stated requirement of this change.**
