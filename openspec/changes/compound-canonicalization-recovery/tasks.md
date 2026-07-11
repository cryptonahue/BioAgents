# Tasks: Compound Canonicalization Recovery

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~90–130 (mostly reuse; 1 new fn + CLI flags) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR (Phase 1 wiring + Phase 2 branch cohere) |
| Delivery strategy | ask-on-risk |
| Chain strategy | size-exception (n/a — single PR) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | CLI flags arm the dormant recovery engine | PR 1 | `scripts/normalize-compounds.ts` only; driver already supports the params |
| 2 | Feature-flagged accept-as-canonical (`upsertCanonicalLocal` + `handleMiss` branch + env) | PR 1 | `compoundAuthority.ts` + `.env.example`; small, cohesive with Unit 1 |

---

## Phase 1: Arm the dormant recovery engine (CLI wiring)

- [x] 1.1 `scripts/normalize-compounds.ts`: parse `--include-failed`, `--try-fuzzy-variants`, `--accept-local` via `hasFlag`; parse `--max-variants=N` via `readArg` (default 3, guard `Number.isFinite && >= 0`).
- [x] 1.2 Same: thread `includeFailed`, `tryFuzzyVariants`, `maxVariantsPerFact`, `promoteLocalOnMiss: acceptLocal` into the existing `normalizeBioprospectingCompounds(params)` call. Limit stays clamped by driver `MAX_BACKFILL_LIMIT` (500). No new flags when unused ⇒ today's behavior exactly.
- [x] 1.3 Confirm-only (NO code change): driver already implements the engine — `selectPendingFacts` widens `statusFilter` to `pending,failed` (L1742), skips `onlyMissing` for failed (L1752), resets `attempts=0` when `includeFailed` (L1967), and `processOneFact` tries `buildCompoundNameVariants` when `tryFuzzyVariants` (L1847). Verify wiring reaches these. CONFIRMED: params thread through the existing driver unchanged.

## Phase 2: Accept-as-canonical promotion (`compoundAuthority.ts`)

- [x] 2.1 Add `localPromoted: "local_promoted"` to `COMPOUND_AUTHORITY_REASONS` (L60).
- [x] 2.2 Add `localPromotions: number` to `BackfillSummary` (L1574); init `0` in the summary object (~L1644).
- [x] 2.3 Add `promoteLocalOnMiss?: boolean` to `NormalizeBackfillParams` (L1538) with the design's doc comment.
- [x] 2.4 In `normalizeBioprospectingCompounds` resolve the two-gate flag INSIDE the function (TDZ-safe): `const promoteLocalOnMiss = (params.promoteLocalOnMiss ?? false) && (process.env.COMPOUND_AUTHORITY_ACCEPT_LOCAL === "true")`; add it to `ProcessCtx` (L1785). Depends on 2.3.
- [x] 2.5 New export `upsertCanonicalLocal({ canonicalName, compoundKind? })` near `upsertCanonicalByPubChem` (L1433): normalize via `normalizeForCompoundLookup`; `SELECT id WHERE normalized_name` → return `{ id, inserted:false }`; else INSERT `status='local'`, `pubchem_cid=NULL`, `inchi_key=NULL`, `canonical_name=<raw>`, `metadata={unverified:true, promoted_by, promoted_at}`, on-conflict-ignore on `normalized_name` + re-SELECT (race-safe). Zero PubChem calls. Returns `UpsertCanonicalResult`.
- [x] 2.6 Extend `handleMiss` signature with `promoteLocalOnMiss: boolean` (L1978); thread it from `processOneFact` via `ctx`. Depends on 2.4.
- [x] 2.7 In `handleMiss` terminal branch (`nextAttempts >= max`, L1986): if `promoteLocalOnMiss` → `upsertCanonicalLocal(fact.compound)` → `upsertAlias({ source:'local_extraction', confidence:'low' })` (non-fatal) → `attachCanonicalToFact({ status:'verified', reason: localPromoted, attempts:0 })` → `summary.localPromotions++`. Else path unchanged (`failed`). Depends on 2.1, 2.2, 2.5, 2.6.
- [x] 2.8 Confirm-only (NO change): `compoundAuthority.worker.ts` L131 still calls `{ rps, maxRetries }` only ⇒ `promoteLocalOnMiss` resolves `false`, never promotes. CONFIRMED: worker call at L131 unchanged.

## Phase 3: Env + docs

- [x] 3.1 `.env.example`: add `COMPOUND_AUTHORITY_ACCEPT_LOCAL=false` (master-arm, OFF by default) with a comment noting it only affects the CLI recovery pass.

## Phase 4: Verification (repo tdd:false — no mandated runner)

- [x] 4.1 `bun tsc --noEmit` passes clean. Only pre-existing errors in `scripts/ingest-marine-drugs.ts` remain (out of scope); no new errors in changed files.
- [ ] 4.2 Dry-run: `bun run scripts/normalize-compounds.ts --dry-run --include-failed --try-fuzzy-variants --max-variants=3` — inspect summary, no writes.
- [ ] 4.3 Small live batch `--include-failed --try-fuzzy-variants --limit=20`: confirm a surface-variant fact (e.g. `β-Carotene`→`beta-carotene`) flips to `verified` with `compound_canonical_id` set.
- [ ] 4.4 Env ON + `--accept-local`: a genuinely-absent fact promotes to a `local` canonical (null CID, `metadata.unverified`), fact links `verified`, `localPromotions++`, one audit row. Then env OFF (or no `--accept-local`): same fact stays `failed`.
- [ ] 4.5 Idempotency: re-run the promoted batch — no duplicate `research_compounds` row (one per `normalized_name`), no double-link, no dup alias.
- [ ] 4.6 `SELECT refresh_compound_aggregates();` then confirm `research_graph_entities.compound_count > 0` for a promoted compound.
- [ ] 4.7 Optional (not mandated): lightweight unit tests in `__tests__/compoundAuthority.*.test.ts` — `upsertCanonicalLocal` insert-then-converge, `handleMiss` terminal OFF→`failed` / ON→promote, env master-arm zeroing, sub-max miss stays `pending`.
