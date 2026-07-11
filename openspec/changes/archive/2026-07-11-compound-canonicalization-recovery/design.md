# Design: Compound Canonicalization Recovery

## Technical Approach

This change is almost entirely **caller-side wiring + one guarded branch**, layered onto the
existing `bioprospecting-compound-authority` subsystem. There is NO new module, NO new table, NO
migration, and NO graph change. Two slices:

- **Slice 1 (Phase 1) — arm the dormant recovery engine.** The fuzzy/failed recovery path already
  exists inside `normalizeBioprospectingCompounds` → `selectPendingFacts` → `processOneFact`
  (`compoundAuthority.ts`). Only the callers never opt in. We add CLI flags to
  `scripts/normalize-compounds.ts` that thread `includeFailed`, `tryFuzzyVariants`, and
  `maxVariantsPerFact` into the existing driver. The routine 6h worker tick
  (`compoundAuthority.worker.ts` L131) is untouched.
- **Slice 2 (Phase 2) — feature-flagged accept-as-canonical.** A new `promoteLocalOnMiss` param
  threads through `NormalizeBackfillParams` → `ProcessCtx` → `handleMiss`. In `handleMiss`'s
  terminal branch (`compoundAuthority.ts` L1986, `nextAttempts >= max`) — where `failed` is stamped
  today — a guarded branch instead promotes the compound to a `status='local'` canonical row via a
  new `upsertCanonicalLocal`, records the raw name as an alias, links the fact, and writes an audit
  row. The branch fires only when the per-pass param is set AND the env master-arm is on; the
  routine tick sets neither, so its behavior is byte-for-byte unchanged.

| Design element | Section | Implementation site |
|---|---|---|
| CLI flags `--include-failed` / `--try-fuzzy-variants` / `--max-variants` / `--accept-local` | Phase 1 + arm Phase 2 | `scripts/normalize-compounds.ts` |
| `promoteLocalOnMiss` param + env master-arm | Phase 2 gate | `NormalizeBackfillParams`, `normalizeBioprospectingCompounds` (~L1623) |
| `ProcessCtx.promoteLocalOnMiss` thread | Phase 2 wiring | `processOneFact` (~L1789), `handleMiss` (~L1978) |
| Local-promotion branch | Phase 2 core | `handleMiss` terminal branch (L1986) |
| `upsertCanonicalLocal` (new) | Phase 2 canonical write | `compoundAuthority.ts` (new export, alongside `upsertCanonicalByPubChem` L1433) |
| `COMPOUND_AUTHORITY_REASONS.localPromoted` (new) | Phase 2 audit | `compoundAuthority.ts` L60 const |
| `BackfillSummary.localPromotions` (new) | Phase 2 observability | `BackfillSummary` (L1574) |
| `COMPOUND_AUTHORITY_ACCEPT_LOCAL` env flag | Phase 2 master-arm | driver + `.env.example` |
| `refresh_compound_aggregates()` post-batch | Backfill op | operator step (CLI run), not shipped code |

The subsystem's three-layer shape (pure helpers → service module → BullMQ worker) is preserved.
The worker remains the only routine caller and stays conservative; the CLI is the operator entry
point for the out-of-band recovery pass.

## Architecture Decisions

### Decision: Recovery pass is an explicit CLI opt-in, NOT a change to the 6h tick

| Option | Tradeoff | Decision |
|---|---|---|
| Thread recovery flags via CLI; leave `processCompoundAuthorityJob` calling `{ rps, maxRetries }` only | ✓ Routine tick stays conservative & idempotent; recovery is batched, out-of-band, operator-driven; zero risk to the live loop | **CHOSEN** |
| Add recovery flags to the 6h worker tick | The live loop would re-attempt every `failed` fact each cycle, contend for the daily PubChem cap, and (with the flag on) silently promote to `local` on every tick | Rejected |
| Separate recovery BullMQ queue/worker | Net-new infra for a one-shot backfill; overkill | Rejected (defer) |

**Rationale:** The proposal locks "Do NOT change the routine 6h tick's default behavior." The CLI
already exists as the operator harness; adding flags there is the minimal, reversible surface. The
worker's `normalizeBioprospectingCompounds({ rps, maxRetries })` call (L131) is left exactly as-is.

### Decision: Two-gate feature flag — per-pass param AND env master-arm

| Option | Tradeoff | Decision |
|---|---|---|
| `promoteLocalOnMiss` param (CLI opts in) gated by `COMPOUND_AUTHORITY_ACCEPT_LOCAL === "true"` env master-arm | ✓ Routine tick never sets the param → never promotes regardless of env; CLI must set BOTH the flag and arm the env → double safety; operator can globally disable in one env flip (rollback) | **CHOSEN** |
| Env flag only, checked inside `handleMiss` | If env on, the routine tick would ALSO promote — violates "OFF by default in the routine tick" | Rejected |
| Param only, no env | No global kill-switch; rollback needs a redeploy of caller code | Rejected |

**Effective gate:** `promoteLocalOnMiss = (params.promoteLocalOnMiss ?? false) && (process.env.COMPOUND_AUTHORITY_ACCEPT_LOCAL === "true")`, computed once in `normalizeBioprospectingCompounds` and threaded as a plain boolean into `ProcessCtx` and `handleMiss`. The env is read inside the driver function (not at module top-level) per the project's worker-TDZ guidance. The routine tick passes no `promoteLocalOnMiss`, so it resolves to `false` even when the env is armed.

### Decision: New `upsertCanonicalLocal` rather than overloading `upsertCanonicalByPubChem`

| Option | Tradeoff | Decision |
|---|---|---|
| New `upsertCanonicalLocal({ canonicalName })` — inserts `status='local'`, `pubchem_cid=null`, `metadata.unverified=true`; SELECT-by-`normalized_name` first for idempotency | ✓ `upsertCanonicalByPubChem` requires a CID and would need a nullable-CID branch that muddies its contract; a dedicated function keeps each path single-responsibility and readable | **CHOSEN** |
| Extend `upsertCanonicalByPubChem` with `cid?: null` | Forks its internal logic (CID-match step is meaningless for local); higher blast radius on a hot path | Rejected |
| Inline the insert in `handleMiss` | Duplicates normalization + conflict handling; not reusable/testable | Rejected |

**Behavior:** normalize via existing `normalizeForCompoundLookup`; `SELECT id FROM research_compounds WHERE normalized_name = $1`; if present return that id (convergence — see dedup invariant); else `INSERT ... status='local', pubchem_cid=NULL, canonical_name=<raw>, compound_kind='small_molecule', metadata='{"unverified":true,"promoted_by":"compound_authority_recovery"}'::jsonb`. The insert uses on-conflict-ignore on `normalized_name` then re-SELECTs, so a lost race under concurrency still converges to the single winning row. Returns `{ id, inserted }` matching `UpsertCanonicalResult`.

### Decision: Promoted fact stamps `compound_authority_status='verified'`; unverified-ness lives on the canonical row

| Option | Tradeoff | Decision |
|---|---|---|
| Fact → `verified`; canonical row carries `status='local'` + `metadata.unverified=true` | ✓ No migration (fact CHECK only allows `pending|verified|failed|skipped`, migration L141-142); the fact status means only "a canonical is attached"; the graph reads the canonical's `status`/`metadata` to flag unverified | **CHOSEN** |
| Add a new fact status (e.g. `local`/`accepted`) | Requires altering the fact `compound_authority_status` CHECK — a migration, explicitly out of scope | Rejected |
| Leave fact `failed` but set `compound_canonical_id` | Contradictory state (`failed` with a canonical); breaks the "failed ≈ no CID" invariant readers rely on | Rejected |

**Rationale:** `compound_canonical_id` populated is the entire fix for `compounds: 0`. The
`unverified` distinction is a property of the compound identity, not the fact-resolution outcome, so
it correctly lives on `research_compounds` (`status='local'`, `metadata.unverified`). Readers/UI/
graph MUST derive "verified vs unverified" from the canonical row, never from the fact's
`compound_authority_status`. This is the one intentional semantic overload and is called out as a
risk below.

### Decision: Promotion fires only at the terminal branch (genuine exhaustion), never on the first transient 404

| Option | Tradeoff | Decision |
|---|---|---|
| Promote in `handleMiss` only when `nextAttempts >= max` (the existing `failed` branch) | ✓ For already-`failed` facts (the dominant bucket) their stored attempts are already ≥ max, so the FIRST recovery-pass miss is terminal → immediate promotion; for `pending` facts, promotion waits until the retry budget is genuinely exhausted, preserving the transient-vs-genuine distinction | **CHOSEN** |
| Promote on the very first 404 regardless of attempts | A single transient/typo 404 on a fresh `pending` fact would mint a spurious `local` compound | Rejected |

**Note on ordering:** within `processOneFact` the sequence is strictly (1) PubChem exact name →
(2) deterministic fuzzy variants (only if `tryFuzzyVariants`) → (3) `handleMiss`. Local promotion
happens ONLY inside `handleMiss`'s terminal branch, i.e. after PubChem + every variant has 404'd
and the attempt budget is exhausted. `local` is always the last resort.

## Data Flow

### Recovery pass (CLI, out-of-band) — Phase 1 + Phase 2

```
$ bun run scripts/normalize-compounds.ts \
      --include-failed --try-fuzzy-variants --max-variants=3 --accept-local --limit=500
        │  (operator has also set COMPOUND_AUTHORITY_ACCEPT_LOCAL=true in env)
        ▼
normalizeBioprospectingCompounds({
    limit, includeFailed:true, tryFuzzyVariants:true,
    maxVariantsPerFact:3, promoteLocalOnMiss:true })
   │  promoteLocalOnMiss &&= (env COMPOUND_AUTHORITY_ACCEPT_LOCAL === "true")   ◀── master-arm
   │
   ▼
selectPendingFacts({ includeFailed:true })
   │  statusFilter = "pending,failed"        (L1742 — widened candidate set)
   │  onlyMissing filter SKIPPED for failed  (L1752 — every failed fact re-run once)
   │
   ▼  per fact (serial, RateGate-capped, day-cap aware):
processOneFact(fact, ctx{ tryFuzzyVariants, maxVariantsPerFact, promoteLocalOnMiss })
   │   1) alias map re-check → verified? attach & done
   │   2) fetchPubChemCid(name) ─── hit ─▶ props → upsertCanonicalByPubChem → attach 'verified'
   │   3) 404 + tryFuzzyVariants: buildCompoundNameVariants(name)[1..maxVariants]
   │        first variant CID hit ─▶ upsertCanonicalByPubChem(variant) → attach 'verified'
   │   4) still cid==null ─▶ handleMiss(fact, msg, summary, maxRetries, promoteLocalOnMiss)
   │
   ▼
handleMiss:
   nextAttempts = (fact.compound_authority_attempts ?? 0) + 1
   ├── nextAttempts < max ──▶ attach 'pending' (+attempts)         [unchanged]
   └── nextAttempts >= max (TERMINAL):
         ├── promoteLocalOnMiss === false ──▶ attach 'failed' (+attempts)   [unchanged — routine tick]
         └── promoteLocalOnMiss === true  ──▶  ◀── NEW Phase-2 branch
                canonical = upsertCanonicalLocal({ canonicalName: fact.compound })
                   → SELECT by normalized_name (converge) or INSERT status='local',
                     pubchem_cid=NULL, metadata.unverified=true
                upsertAlias({ compoundId: canonical.id, alias: fact.compound,
                              source: 'local_extraction', confidence: 'low' })   (non-fatal)
                attachCanonicalToFact({ factId, canonicalId: canonical.id,
                              status: 'verified', reason: 'local_promoted', attempts: 0 })
                   → transactional fact update + status_change audit row
                     (compensating rollback if the audit insert throws)
                summary.localPromotions++
        │
        ▼
(after the batch, operator runs)  SELECT refresh_compound_aggregates();
        │
        ▼
research_graph_entities.compound_count (live view) self-corrects → graph no longer `compounds: 0`
```

### Routine 6h worker tick — UNCHANGED

```
processCompoundAuthorityJob(job)                       (compoundAuthority.worker.ts L131)
   └── normalizeBioprospectingCompounds({ rps, maxRetries })
         • includeFailed  = false   → only `pending` facts
         • tryFuzzyVariants = false → exact-name only
         • promoteLocalOnMiss = false (param absent) → terminal branch stamps 'failed'
   → byte-for-byte identical to today, even if COMPOUND_AUTHORITY_ACCEPT_LOCAL is armed
```

## De-dup Invariant & Convergence

- `research_compounds.normalized_name` is `UNIQUE` (migration L37). `upsertCanonicalLocal`
  normalizes the fact's raw name with `normalizeForCompoundLookup` (NFKD + diacritic-strip +
  lowercase + separator-collapse) and keys the canonical row on that value.
- **One `local` canonical per normalized novel name.** Two distinct facts whose raw names normalize
  to the same string ("Anthoteibinene A" / "anthoteibinene-A") both resolve, via SELECT-by-
  `normalized_name`, to the SAME canonical id and each get their `compound_canonical_id` set to it.
  They converge — no duplicate canonical, one shared `local` identity.
- **Race safety:** the SELECT-then-INSERT is guarded by on-conflict-ignore on `normalized_name`
  plus a re-SELECT, so even concurrent inserters converge to the single winning row. In practice the
  backfill is single-process (worker concurrency 1; CLI one process; run out-of-band), so the
  constraint is a belt-and-suspenders guarantee, not a hot path.

## Idempotency & Concurrency

- **Re-run safety:** once a fact is promoted it is `compound_authority_status='verified'` with a
  `compound_canonical_id`, so `selectPendingFacts` (candidates limited to `pending`/`failed`) will
  NOT re-pick it on a later pass.
- **If re-picked anyway** (e.g. an admin resets it): `upsertCanonicalLocal` returns the existing id,
  `upsertAlias` is idempotent on `(compound_id, normalized_alias)`, and `attachCanonicalToFact`
  re-stamps identical state and writes exactly one additional audit row (benign, honest history).
- **Transactional attach + compensating rollback interaction:** `attachCanonicalToFact` updates the
  fact then inserts the audit row; if the audit insert throws it rolls the fact back to its prior
  state (L599-630). Because `upsertCanonicalLocal` + `upsertAlias` run BEFORE the attach, an
  audit-rollback can leave an orphan `local` canonical (no linked fact). This is benign and self-
  healing: the fact stays `failed`/`pending`, the next recovery pass re-picks it and re-converges to
  the SAME canonical via `normalized_name` (no duplicate, thanks to the UNIQUE key). Documented as
  an accepted edge, not a defect.
- **Rate/cost:** the pass runs through the existing `RateGate` (4 rps default, 429/503
  `Retry-After` aware) and the daily PubChem cap (`PUBCHEM_DAILY_REQUEST_CAP` via `costService`);
  `local` promotion itself issues NO PubChem calls (it only fires after exhaustion), so Phase 2 adds
  zero request-cap pressure.

## File Changes

| File | Action | Description |
|---|---|---|
| `scripts/normalize-compounds.ts` | Modify | Parse `--include-failed`, `--try-fuzzy-variants`, `--accept-local` (flags) and `--max-variants=N` (value); thread into `normalizeBioprospectingCompounds(params)` |
| `src/services/researchBrain/compoundAuthority.ts` | Modify | Add `promoteLocalOnMiss` to `NormalizeBackfillParams` + `ProcessCtx`; resolve env master-arm in driver; thread through `processOneFact` → `handleMiss`; new guarded terminal branch; new `upsertCanonicalLocal`; new `COMPOUND_AUTHORITY_REASONS.localPromoted`; new `BackfillSummary.localPromotions` |
| `src/services/queue/workers/compoundAuthority.worker.ts` | Unchanged | Routine tick keeps calling `{ rps, maxRetries }` only |
| `.env.example` | Modify | Add `COMPOUND_AUTHORITY_ACCEPT_LOCAL=false` (master-arm, OFF by default) with a comment |
| DB schema | None | No migration — `status='local'` + null CID + `metadata` already exist |
| Entity graph / API | None | Live view self-corrects once FK populated |

## Interfaces / Contracts

### `NormalizeBackfillParams` addition (`compoundAuthority.ts` L1538)

```ts
export type NormalizeBackfillParams = {
  // ... existing: limit, dryRun, onlyMissing, rps, maxRetries, fetchImpl, now,
  //     includeFailed, tryFuzzyVariants, maxVariantsPerFact ...

  /** Recovery-pass opt-in: when a fact's name + all deterministic
   * variants genuinely 404 and the retry budget is exhausted, promote
   * it to a canonical `research_compounds` row (status='local', null
   * CID, unverified) instead of stamping `failed`. Gated by the
   * `COMPOUND_AUTHORITY_ACCEPT_LOCAL` env master-arm — this param is a
   * no-op unless that env is "true". Default: false. The routine 6h
   * tick never sets this, so it never promotes. */
  promoteLocalOnMiss?: boolean;
};
```

### `BackfillSummary` addition (L1574)

```ts
export type BackfillSummary = {
  // ... existing counters ...
  /** Facts promoted to a status='local' canonical after genuine
   * PubChem exhaustion. 0 when the flag/env are off. */
  localPromotions: number;
};
```

### New reason constant (L60)

```ts
export const COMPOUND_AUTHORITY_REASONS = {
  // ... existing ...
  localPromoted: "local_promoted",
} as const;
```

### New export `upsertCanonicalLocal`

```ts
/** Upsert a canonical `research_compounds` row for a genuinely-absent
 * (not-in-PubChem) compound. Keyed on normalized_name (UNIQUE), so
 * repeat calls for the same normalized name converge to one row. No
 * PubChem CID; status='local'; metadata.unverified=true. */
export async function upsertCanonicalLocal(input: {
  canonicalName: string;
  compoundKind?: "small_molecule" | "peptide" | "protein" | "lipid" | "other";
}): Promise<UpsertCanonicalResult>; // { id: string; inserted: boolean }
```

### Changed private signatures

```ts
// processOneFact ctx gains the flag (L1781 ProcessCtx)
type ProcessCtx = { /* ... */ promoteLocalOnMiss: boolean };

// handleMiss gains the flag (L1978)
async function handleMiss(
  fact: PendingFactRow,
  errorMessage: string,
  summary: BackfillSummary,
  maxRetries: number,
  promoteLocalOnMiss: boolean,      // ◀── NEW
): Promise<void>;
```

### CLI arg parsing (`scripts/normalize-compounds.ts`)

```ts
const includeFailed    = hasFlag("include-failed");
const tryFuzzyVariants = hasFlag("try-fuzzy-variants");
const acceptLocal      = hasFlag("accept-local");
const maxVariants      = Number(readArg("max-variants") || "3");

await normalizeBioprospectingCompounds({
  limit, dryRun, onlyMissing,
  includeFailed,
  tryFuzzyVariants,
  maxVariantsPerFact: Number.isFinite(maxVariants) && maxVariants >= 0 ? maxVariants : 3,
  promoteLocalOnMiss: acceptLocal,   // only takes effect if env COMPOUND_AUTHORITY_ACCEPT_LOCAL=true
});
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `upsertCanonicalLocal` inserts `status='local'`, null CID, `metadata.unverified` on first call; returns existing id (no insert) on second call with same normalized name | Mock Supabase; assert insert payload + convergence |
| Unit | `handleMiss` terminal branch: `promoteLocalOnMiss=false` → `attach 'failed'` (today's behavior, regression lock); `promoteLocalOnMiss=true` → upsert-local + alias + `attach 'verified'` (reason `local_promoted`) | Mock the three helpers; assert call sequence |
| Unit | Env master-arm: driver zeroes `promoteLocalOnMiss` when `COMPOUND_AUTHORITY_ACCEPT_LOCAL !== "true"` even if the param is `true` | Set/unset env; assert no promotion |
| Unit | Sub-max miss with `promoteLocalOnMiss=true` stays `pending` (no premature promotion) | attempts < max; assert `pending` |
| Integration | Recovery pass over a `failed` fact absent from PubChem (mock 404 on name + all variants) → one `local` canonical, fact `verified`, `compound_canonical_id` set, `localPromotions=1`, audit row present | Seeded test DB + PubChem fetch mock |
| Integration | Two facts with names that normalize equal → one shared `local` canonical, both linked | Assert single `research_compounds` row |
| Integration | Routine tick config (`{ rps, maxRetries }`, env armed) does NOT promote — terminal miss still `failed` | Assert no `local` rows |
| Regression | CLI with no new flags reproduces today's behavior exactly | Snapshot summary |

## Rollback Plan

1. Flip `COMPOUND_AUTHORITY_ACCEPT_LOCAL=false` → all promotion stops instantly; `handleMiss`
   reverts to stamping `failed`. No redeploy of caller code needed.
2. Promoted `local` rows are additive and honestly flagged; leave them, or delete keyed on
   `status='local' AND pubchem_cid IS NULL AND metadata->>'unverified' = 'true'`. Facts'
   `compound_canonical_id` FK is `ON DELETE SET NULL` → removal degrades safely to unlinked.
3. No migration to revert.
4. Omitting the CLI flags reproduces today's behavior exactly (flags inert when unused).

## Risks / Tradeoffs

| Risk | Severity | Mitigation / Stance |
|---|---|---|
| Fact `compound_authority_status='verified'` conflated with PubChem-verified | Medium | ACCEPTED — unverified-ness is a canonical-row property (`status='local'`, `metadata.unverified`); readers/UI/graph MUST derive verified-ness from `research_compounds`, never from the fact status. No migration alternative in scope. |
| Singleton `local` pollution (distinct novel compounds) | Medium | ACCEPTED per locked policy; each honestly flagged `unverified`; keyed by `normalized_name` so exact re-occurrences merge. |
| Accept-as-canonical accidentally on in routine tick | Low | Two-gate: routine tick never sets the param → no promotion even with env armed. |
| Orphan `local` canonical if `attachCanonicalToFact` audit-rollback fires | Low | Self-heals — next pass re-converges via `normalized_name` UNIQUE; no duplicate. |
| Wrong merges from fuzzy variants | Low | Deterministic variants only; no edit-distance/synonym expansion. |
| PubChem daily cap / rate limit during backfill | Medium | Existing `RateGate` + `PUBCHEM_DAILY_REQUEST_CAP` + `limit ≤ 500`; `local` promotion issues zero PubChem calls. |

## Out of Scope (explicit)

- No DB migration (schema already supports `status='local'` + null CID + `metadata`).
- No change to the entity-graph capability, its API, or any graph query — the live view
  self-corrects once the FK is populated.
- No net-new authority (COCONUT / LOTUS / ChEBI), no PubChem synonym/autocomplete endpoint, no LLM
  name normalization — all deferred.
- No edit-distance / synonym fuzzy matching.
- No change to the routine 6h worker tick's default behavior.
- No curator-approval queue and no `≥N-sources` promotion threshold (promote on first genuine
  exhaustion, per locked decision).

## Open Questions

- [ ] Should `upsertCanonicalLocal` set `metadata.promoted_at` / `metadata.source_fact_id` for
  provenance beyond the audit row? Recommend: include `promoted_by` + `promoted_at`; the
  per-fact linkage is already in `compound_authority_audit`. Confirm with team.
- [ ] Alias `confidence` for the local self-alias: `low` proposed (it is an unverified spelling).
  Confirm.
