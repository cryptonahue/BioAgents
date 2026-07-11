# Proposal: Compound Canonicalization Recovery

## Intent

The shipped entity/compound graph shows `compounds: 0` because ~200 bioprospecting facts are stuck in `compound_authority_status = 'failed'` and ~235 in `pending`, none of which ever populate `compound_canonical_id`. Two root causes, both already addressable with existing code and schema:

1. The compound-authority subsystem already contains a full fuzzy/failed-recovery engine (`buildCompoundNameVariants` + `NormalizeBackfillParams.{tryFuzzyVariants, includeFailed, maxVariantsPerFact}`, wired into `processOneFact`), but it is **dormant** — the 6h worker tick calls `normalizeBioprospectingCompounds({ rps, maxRetries })` only, and the CLI exposes only `--limit`/`--dry-run`/`--all`. Nothing ever re-attempts a `failed` fact.
2. The **dominant** failure bucket is genuinely-absent novel marine natural products (anthoteibinenes and similar) that are not in PubChem under any spelling. No PubChem strategy can ever resolve them; they need an accept-as-canonical-without-external-id path. The schema **already permits** this (`research_compounds.status IN ('local', ...)`, nullable `pubchem_cid`) — no migration.

Success: the ~200 failed / ~235 pending facts are re-processed out-of-band; PubChem-present surface-variant misses resolve to real CIDs, and genuinely-absent compounds are promoted to canonical `status='local'` rows (flagged unverified) and linked. `compound_canonical_id` gets populated, so `research_graph_entities.compound_count` (a live view) self-corrects and the graph stops showing `compounds: 0`.

## Scope

### In Scope

- **Phase 1 — enable the dormant fuzzy/failed recovery (mostly reuse):**
  - Wire `tryFuzzyVariants` + `includeFailed` (+ `maxVariantsPerFact`) into an explicit, out-of-band recovery path so `failed` and `pending` facts are re-attempted with the existing deterministic name variants. Prefer a dedicated recovery pass/flags over changing the live 6h tick's default behavior — the routine tick stays conservative; recovery is an explicit, batched pass.
  - Add CLI flags to `scripts/normalize-compounds.ts`: `--include-failed`, `--try-fuzzy-variants`, and `--max-variants` (trivial passthrough), enabling a one-shot batched backfill over the ~200 failed / ~235 pending.
  - Fuzzy variants stay **CONSERVATIVE** — deterministic variants only (`buildCompoundNameVariants`: diacritics, hyphens, stereo/Greek/D-L prefixes, parenthetical provenance). NO edit-distance, NO synonym fuzzing.
- **Phase 2 — accept-as-canonical `status='local'` for genuinely-absent compounds:**
  - When a fact's name and all deterministic variants genuinely 404 across all PubChem tries (the terminal branch in `handleMiss`), PROMOTE it to a canonical `research_compounds` row keyed by `normalized_name`, `status='local'`, no `pubchem_cid`, flagged unverified; then link the fact via `compound_canonical_id`.
  - Reuse the existing `upsertCanonicalByPubChem` / `upsertAlias` / `attachCanonicalToFact` + `compound_authority_audit` patterns. **No DB migration** — the `research_compounds` CHECK constraint already allows `status='local'` with null CID (verified against `supabase/migrations/20260613000000_create_compound_authority.sql`).
  - Feature-flag the accept-as-canonical behavior (env flag, OFF by default in the routine tick; ENABLED for the recovery pass), following existing feature-flag/cost-guard conventions.
- **Backfill:** out-of-band batched CLI pass (`limit ≤ 500`, respect `MAX_BACKFILL_LIMIT`, the in-process `RateGate`, and the daily PubChem cap `PUBCHEM_DAILY_REQUEST_CAP`), idempotent, soft-fail, per-fact try/catch (all already built). After a batch, refresh `refresh_compound_aggregates()` (materialized view); the `research_graph_entities` live view needs no refresh.

### Out of Scope

- **Net-new authorities (COCONUT / LOTUS / ChEBI)** — deferred. COCONUT is strongest for natural products if this is revisited after Phase 1 data quantifies the residual.
- **LLM name normalization** pre-lookup — deferred, feature-flag-gated future work.
- **Edit-distance / synonym fuzzy matching** — excluded due to wrong-merge risk (distinct compounds colliding).
- **Any change to the entity-graph capability or its API** — the graph is a live view; populating the FK is the entire fix.
- **DB migration** — none required; the schema already supports `status='local'` + null CID.

## Locked Decisions

### Promotion policy — promote on the FIRST genuine miss

**No `≥N-sources` threshold. No curator-approval queue.** A fact whose name and all deterministic variants genuinely 404 is promoted to a canonical `status='local'` row immediately.

**Rationale:** novel marine natural products legitimately appear in a single paper. A source-count threshold or approval gate would drop exactly the singleton discoveries this system exists to capture. Trust is preserved via the `unverified` flag (surfaced everywhere the compound is shown), not by withholding data. Singleton "pollution" is an acceptable, honestly-labeled cost; silently discarding novel-compound discoveries is not.

### Graph & visibility — no graph change, show unverified

- NO graph code change. Once `compound_canonical_id` is populated, `research_graph_entities.compound_count` (a live view) fixes itself.
- Unverified `status='local'` compounds are **SHOWN** in the graph, flagged as unverified — NOT filtered out.

### Fuzzy-merge risk tolerance — deterministic variants only

Conservative deterministic variants only. No edit-distance or synonym expansion at any layer of this change.

## Approach

### Phase 1 — flag-wiring (Low effort, pure reuse)

The recovery engine already exists and is wired into `processOneFact`'s fuzzy fallback (`compoundAuthority.ts` L1847-1850) and `selectPendingFacts`'s widened candidate set (`statusFilter = includeFailed ? "pending,failed" : "pending"`, L1742). `includeFailed` also resets the attempts counter (L1967) for a clean recovery pass. The gap is purely the callers:

- `scripts/normalize-compounds.ts` — add `--include-failed`, `--try-fuzzy-variants`, `--max-variants` and thread them into the existing `normalizeBioprospectingCompounds(params)` call. This is the primary operator entry point for the batched backfill.
- The 6h worker tick (`compoundAuthority.worker.ts` L131) keeps calling with `{ rps, maxRetries }` only — its conservative default is intentionally preserved. Recovery is operator-driven via the CLI (or a separate opt-in recovery flag), not folded into the routine tick.

### Phase 2 — accept-as-canonical promotion

The promotion hook is the terminal branch of `handleMiss` (`compoundAuthority.ts` L1986, `nextAttempts >= max`). Today it calls `attachCanonicalToFact({ canonicalId: null, status: "failed", ... })`. Under the feature flag (and in the recovery pass), that branch instead:

1. Upserts a canonical `research_compounds` row keyed by `normalized_name`, `status='local'`, `pubchem_cid = null`, flagged unverified in `metadata` (reusing the `upsertCanonicalByPubChem` upsert pattern adapted for the local/no-CID case).
2. Optionally records the raw name as an alias (`upsertAlias`, `source='local_extraction'`).
3. Calls `attachCanonicalToFact` to link the fact (`compound_canonical_id` set, status reflecting the promotion) and writes a `compound_authority_audit` row for provenance.

All promotion is additive and idempotent (upsert on `normalized_name UNIQUE`). When the flag is OFF (routine tick), `handleMiss` retains today's `failed` behavior exactly.

### Backfill execution

Run the CLI recovery pass out-of-band from the 6h worker so it does not contend with the live tick. The pass is batched (`limit ≤ 500`, `MAX_BACKFILL_LIMIT` enforced), idempotent, soft-fail per fact, and automatically respects the `RateGate` and daily PubChem cap. After each batch, call `refresh_compound_aggregates()`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `scripts/normalize-compounds.ts` | Modified | Add `--include-failed`, `--try-fuzzy-variants`, `--max-variants`; thread into driver call |
| `src/services/researchBrain/compoundAuthority.ts` | Modified | `handleMiss` terminal branch: feature-flagged accept-as-canonical promotion via existing upsert/alias/attach patterns |
| `src/services/queue/workers/compoundAuthority.worker.ts` | Unchanged (default) | Routine 6h tick stays conservative; no recovery flags by default |
| `.env.example` | Modified | New feature flag for accept-as-canonical (OFF by default) |
| DB schema | None | No migration — `status='local'` + null CID already permitted |
| Entity graph / API | None | Live view self-corrects once FK populated |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Wrong merges from fuzzy variants | Low | Deterministic variants only; no edit-distance/synonym expansion |
| Singleton `local` pollution (distinct novel compounds) | Medium | Accepted by locked policy; each is honestly flagged `unverified`; keyed by `normalized_name` so exact re-occurrences merge correctly |
| Accept-as-canonical accidentally on in routine tick | Low | Feature flag OFF by default; only the explicit recovery pass enables it |
| PubChem rate limit / daily cap during backfill | Medium | Existing `RateGate` (429/503 aware) + `PUBCHEM_DAILY_REQUEST_CAP` + batched `limit ≤ 500` |
| Backfill contends with live 6h tick | Low | Run out-of-band via CLI; per-fact try/catch, soft-fail, idempotent upserts |
| Unverified compounds mistaken for verified in UI | Medium | `unverified` flag surfaced everywhere shown, including the graph |

## Rollback Plan

1. **Disable the feature flag** — routine and future runs stop promoting to `local`; `handleMiss` reverts to marking `failed`. No schema change to undo.
2. **Promoted `local` rows are additive** — they can be left in place (honestly flagged unverified) or removed by targeted delete keyed on `status='local' AND pubchem_cid IS NULL AND metadata->unverified`. Facts' `compound_canonical_id` FK is `ON DELETE SET NULL`, so removal degrades safely back to unlinked.
3. **No migration to revert** — nothing structural changed.
4. **CLI flags are inert when unused** — omitting `--include-failed`/`--try-fuzzy-variants` reproduces today's behavior exactly.

## Dependencies

- Existing `bioprospecting-compound-authority` capability: `buildCompoundNameVariants`, `NormalizeBackfillParams`, `processOneFact`, `handleMiss`, `upsertCanonicalByPubChem`, `upsertAlias`, `attachCanonicalToFact`, `compound_authority_audit`, `RateGate`, `costService` day-cap.
- `research_compounds` CHECK constraint permitting `status='local'` + null `pubchem_cid` (confirmed).
- `refresh_compound_aggregates()` materialized-view refresh; `research_graph_entities` live view.
- PubChem PUG-REST (anonymous), no new authority.

## Success Criteria

- [ ] `scripts/normalize-compounds.ts` accepts `--include-failed`, `--try-fuzzy-variants`, `--max-variants` and threads them into `normalizeBioprospectingCompounds`.
- [ ] A batched CLI recovery pass re-processes `failed` + `pending` facts, resetting attempts, respecting `MAX_BACKFILL_LIMIT`, the `RateGate`, and the daily PubChem cap.
- [ ] PubChem-present surface-variant misses resolve to real CIDs via deterministic variants (no edit-distance/synonym matching used).
- [ ] With the feature flag ON, genuine 404s promote to a `status='local'`, null-CID, unverified-flagged `research_compounds` row keyed by `normalized_name`, and the fact links via `compound_canonical_id`.
- [ ] Promotion is idempotent and additive; a `compound_authority_audit` row records each promotion.
- [ ] Feature flag OFF (routine 6h tick) reproduces today's `failed` behavior exactly; no migration is applied.
- [ ] After a backfill batch, `refresh_compound_aggregates()` runs; `research_graph_entities.compound_count` reflects the newly-linked compounds (graph no longer `compounds: 0`).
- [ ] Unverified `local` compounds appear in the graph flagged unverified (not filtered).
- [ ] No change to the entity-graph capability or its API.

## Delivery

- Small change, mostly reuse. Estimated well under the 400-line review budget.
- Slice 1 (Phase 1): CLI flag-wiring + threading into the existing driver.
- Slice 2 (Phase 2): feature-flagged accept-as-canonical branch in `handleMiss` reusing upsert/alias/attach patterns.
- Backfill is an operational step (CLI run), not code shipped in the PR.
