# Exploration: compound-canonicalization-recovery

> SDD explore phase. Artifact store: openspec. Date: 2026-07-11.
> Goal: recover the ~200 FAILED / ~235 PENDING compound-authority resolutions so
> facts link to canonical compounds and the entity/compound graph stops showing
> `compounds: 0`.

## Executive summary

The compound-authority subsystem already contains a full fuzzy/failed-recovery
engine — it is just **dormant**: the running 6h worker and the CLI never turn it
on. The largest failure bucket (novel marine natural products absent from
PubChem) is unrecoverable by any PubChem strategy and needs an
"accept-as-canonical-without-external-id" path, which the schema **already
supports** (no migration). Once `compound_canonical_id` is populated, the
graph's `compounds: 0` fixes itself with zero graph changes.

## Existing subsystem recap (verified in code)

**Resolution flow** (`src/services/researchBrain/compoundAuthority.ts`, ~2009 lines):
- Sync/extract-time: `attachCompoundAuthority` → `resolveInitialStatus` stamps
  `verified` (alias-map hit), `skipped` (`looksLikeExtract` — oils/fractions/
  mixtures), or `pending`. No IO.
- Async backfill: `normalizeBioprospectingCompounds` (driver) → `selectPendingFacts`
  → `processOneFact` → PubChem PUG-REST (`fetchPubChemCid` → `fetchPubChemProperties`)
  → `upsertCanonicalByPubChem` + `upsertAlias` → `attachCanonicalToFact`
  (transactional update + `compound_authority_audit` row with compensating rollback).
- Rate control: in-process `RateGate` (default 4 rps, honors PubChem `Retry-After`
  on 429/503), daily cap via `costService` (`PUBCHEM_DAILY_REQUEST_CAP`, default 200K).
- Worker: `src/services/queue/workers/compoundAuthority.worker.ts`, concurrency 1,
  repeatable tick, aborts cleanly on day-cap.

**Status lifecycle** (`research_bioprospecting_facts.compound_authority_status` CHECK):
`pending | verified | failed | skipped`.
- `failed` is set ONLY by `handleMiss` after `compound_authority_attempts >=
  maxRetries` (default 5) consecutive PubChem **404s**.
- Rate-limit (429/503) does **not** fail a fact — it pauses the gate and re-picks.
- So "failed" ≈ *the exact name genuinely returns no CID after 5 tries*.
  "pending" ≈ *not yet processed, or inside the re-check window / under maxRetries*.

**Data model**: `research_compounds` (canonical; `status IN local|pubchem|chebi|
manual|curated`; `normalized_name UNIQUE`; nullable `pubchem_cid`, `chebi_id`),
`research_compound_aliases` (`UNIQUE(compound_id, normalized_alias)`),
`compound_authority_audit` (monthly-partitioned JSONB diff). Facts link via
`compound_canonical_id UUID FK ... ON DELETE SET NULL`.
Migration: `supabase/migrations/20260613000000_create_compound_authority.sql`.

## Why ~200 compounds fail

1. **Exact-name-only lookup.** Only `/compound/name/{name}/cids/JSON` is used. No
   PubChem synonym/autocomplete endpoint, no ChEBI, no substructure. One spelling,
   one shot (× retries).
2. **Genuinely absent novel marine NPs** (anthoteibinenes and similar). Not in
   PubChem at all → 404 on every variant → become `failed` permanently. **This is
   the dominant, structurally-unrecoverable bucket for this corpus.**
3. **Surface-variant misses** of compounds that *are* in PubChem (diacritics,
   hyphens, stereo/Greek/D-L prefixes, parenthetical provenance, multi-compound
   strings). Recoverable — and the recovery code **already exists** but is off.

## The load-bearing discovery

`buildCompoundNameVariants()` + `NormalizeBackfillParams.{tryFuzzyVariants,
includeFailed, maxVariantsPerFact}` are fully implemented and wired into
`processOneFact`'s fuzzy fallback. `includeFailed` even resets the attempts
counter for a clean recovery pass. **But:**
- `processCompoundAuthorityJob` calls `normalizeBioprospectingCompounds({ rps,
  maxRetries })` — no fuzzy, no includeFailed.
- `scripts/normalize-compounds.ts` exposes only `--limit`, `--dry-run`, `--all`.

So today nothing ever recovers a `failed` fact. Turning it on is a flag-wiring change.

## Approaches

| # | Approach | Recovery yield | Cost | False-merge risk | Reuse vs extend | Effort |
|---|----------|---------------|------|------------------|-----------------|--------|
| A | **Enable existing fuzzy + includeFailed** (wire worker + CLI flags) | Surface-variant misses of PubChem-present compounds only | ~free | Low (conservative deterministic variants) | Pure reuse | Low |
| B | **Accept-as-canonical `status='local'`** (keyed by `normalized_name`, no CID, unverified) | The genuinely-absent marine NPs (the ~200 core) | ~free | Medium — distinct novel compounds colliding on normalized name; singleton pollution | Reuses upsert/alias/audit; new promotion path; no migration | Medium |
| C | PubChem synonym/autocomplete endpoint | Marginal beyond A for NPs | free | Low-Med | Extend client | Medium |
| D | Alternate authority (COCONUT/LOTUS for NPs; ChEBI) | Some NPs (COCONUT is the NP DB, most relevant) | net-new integration + rate/cost | Med | Net-new client + resolver branch (`status='chebi'` exists) | Med-High |
| E | LLM name normalization pre-lookup (feature-flagged, cost-gated) | Messy/multi-compound strings | LLM $ per fact | Med (hallucinated names) | Net-new, gated | Medium |

## Recommendation — phased

- **Phase 1 (ship now, Low effort): enable the dormant recovery.** Add
  `tryFuzzyVariants`/`includeFailed` (+ `maxVariantsPerFact`) to the worker tick
  (or a dedicated recovery tick) and add `--include-failed` / `--try-fuzzy-variants`
  flags to `scripts/normalize-compounds.ts`. Run a one-shot batched CLI pass over
  the ~200 failed + ~235 pending. **This quantifies the residual genuinely-absent
  set before building anything new.**
- **Phase 2 (the real fix for a marine-NP corpus): accept-as-canonical
  `status='local'`.** For a fact whose name (and all variants) genuinely 404s,
  promote it to a canonical `research_compounds` row keyed by `normalized_name`,
  `status='local'`, no `pubchem_cid`, flagged unverified; link the fact. Reuses
  `upsertCanonicalByPubChem`/`upsertAlias`/`attachCanonicalToFact` patterns; **no
  migration**. Gate it (feature flag) and consider a promotion threshold (≥N
  distinct sources or curator approval) to avoid singleton pollution.
- **Defer** C, D (COCONUT strongest for NPs), and E until Phase 1 data shows the
  residual is worth the net-new cost.

## Backfill strategy

- Use the existing `includeFailed + tryFuzzyVariants` path via the CLI, batched
  (`limit ≤ 500`, `MAX_BACKFILL_LIMIT` enforced), out-of-band from the 6h worker so
  it doesn't contend with the live tick. Per-fact try/catch, soft-fail, idempotent
  upserts, and attempts-reset are already built. Respects the daily PubChem cap and
  RateGate automatically.
- After a batch, call `refresh_compound_aggregates()` (materialized view). The
  `research_graph_entities` live view updates `compound_count` automatically.

## Graph relationship — no graph change needed

`research_graph_entities.compound_count = COUNT(DISTINCT compound_canonical_id)`,
and the bioactivity-expand CTE joins `research_compounds` on
`compound_canonical_id`. Populating the FK is the entire fix for `compounds: 0`.

## Open product questions (decide before proposal)

1. **Accept unverified-authority (`status='local'`) compounds into the canonical
   set and the graph?** ← pivotal; without it the marine-NP core stays unrecoverable.
2. **Promotion threshold for `local` canonicals** — promote on first genuine miss,
   or require ≥N distinct sources / curator approval?
3. **Fuzzy-merge risk tolerance** — conservative deterministic variants only, or add
   synonym/edit-distance (higher yield, higher wrong-merge risk)?
4. **Surface unverified compounds in the graph flagged as "unverified", or filter
   them from certain views?**
5. **Appetite/budget for a net-new authority (COCONUT/LOTUS/ChEBI) or LLM
   normalization** (both feature-flagged)?
