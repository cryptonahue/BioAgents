# Tasks: Bioprospecting Compound Authority

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,800 |
| 400-line budget risk | **High** — single PR would exceed budget |
| Chained PRs recommended | **Yes** — 3 reviewable slices |
| Suggested split | PR 1 Foundation · PR 2 Worker + PubChem · PR 3 API + UI + Provenance |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain (PR #2 base = PR #1; PR #3 base = PR #2) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | PR | Notes |
|------|------|----|-------|
| 1 | Migration + types + service skeleton (no HTTP) + unit tests | PR #1 | Base = feature branch |
| 2 | PubChem client + rate gate + backfill + BullMQ worker + seed loader | PR #2 | Base = PR #1 |
| 3 | 4 API routes + UI badge + provenance viewer + edit-reset audit hook | PR #3 | Base = PR #2 |

Forecast: PR #1 ≈ 700 LOC, PR #2 ≈ 500 LOC, PR #3 ≈ 600 LOC.

---

## Phase 1: Foundation (PR #1) — pure logic + data model, no HTTP/worker/API

- [x] 1.1 Migration `supabase/migrations/20260613000000_create_compound_authority.sql`: pgcrypto + 3 tables (`research_compounds`, `research_compound_aliases`, `compound_authority_audit` partitioned by month w/ default + 3 pre-created partitions), 5 indexes, 4 fact columns + `compound_authority_attempts` (5 total). All `IF NOT EXISTS`
- [x] 1.2 Add `CompoundStatus`, `ResearchCompound`, `ResearchCompoundAlias`, `CompoundAuthorityAuditEvent` to `types.ts`; extend `BioprospectingFact` with 4 spec'd optional fields + `compound_authority_attempts`
- [x] 1.3 `compoundAuthority.ts`: `looksLikeExtract` (pure regex, 17 cues, case-insensitive word boundary), `normalizeCompoundName` (NFKD + diacritic + lowercase + collapse), `resolveCompoundStatus(value, aliasMap)` (extract short-circuit → alias hit → pending)
- [x] 1.4 Same: `loadAliasMap` (single SQL `SELECT normalized_alias, compound_id`), `attachCompoundAuthority(fact, aliasMap)` (idempotent on verified; per-fact try/catch with pending fallback; logs errors)
- [x] 1.5 Same: `attachCanonicalToFact({ factId, canonicalId, status, error?, userId?, reason, attempts? })` — tx: update 4 columns + insert `status_change` audit row; idempotent on identical state; rollback if audit throws
- [x] 1.6 Same: `searchCompounds` (default 25, max 100; rank exact-normalized > alias > prefix > substring; read-only), `getCompoundById` (canonical + aliases)
- [x] 1.7 Same: `addAlias({ canonicalId, alias, confidence, userId })` (tx: insert + `manual_alias_add` audit; duplicate is a no-op, no new audit), `promoteToPending({ factId, userId, reason })` (throws "not in failed state" on non-failed; writes `status_change` audit)
- [x] 1.8 Wire `attachCompoundAuthority` into `bioprospectingExtractor.ts` between `normalizeFacts` and `replaceBioprospectingFactsForSource`; build `aliasMap` once per source
- [x] 1.9 `db.ts` `replaceBioprospectingFactsForSource`: write 4 new authority columns on every payload row from the fact object; never overwrite raw `compound`
- [x] 1.10 Re-export `compoundAuthority` from `researchBrain/index.ts`
- [x] 1.11 `__tests__/compoundAuthority.test.ts`: `looksLikeExtract` (pos/neg/case), `resolveCompoundStatus` (3 branches w/ injected Map), `attachCompoundAuthority` idempotency, `addAlias` no-op on dup, `promoteToPending` rejects non-failed, `attachCanonicalToFact` rollback on audit-insert throw
- [ ] 1.12 Manual: apply migration against test Supabase; run `bun test`; verify migration idempotency by re-applying

---

## Phase 2: PubChem Client + Backfill Worker (PR #2) — async resolution path + seed

- [x] 2.1 Add `CompoundAuthorityJobData = {}` + `CompoundAuthorityJobResult` to `queue/types.ts` and `researchBrain/types.ts`
- [x] 2.2 `compoundAuthority.ts` `RateGate`: closure over `last=0` + `pausedUntil=0`; `take()` blocks until `max(pausedUntil, last + minIntervalMs)`, sets `last`; `pause(ms)` raises `pausedUntil` to `max(pausedUntil, now + ms)`
- [x] 2.3 Same: `fetchPubChemCid(name, gate)` GET `/rest/pug/compound/name/{name}/cids/JSON` w/ 12s timeout; parse `PropertyTable.Properties[0].CID`; on 429 read `Retry-After` (seconds or HTTP-date), call `gate.pause`, throw `PubChemRateLimited`
- [x] 2.4 Same: `fetchPubChemProperties(cid, gate)` GET `/rest/pug/compound/cid/{cid}/property/InChIKey,MolecularFormula,IUPACName/JSON`; return `{ inchiKey, formula, iupac }` or null on 404
- [x] 2.5 Same: `upsertCanonicalByPubChem({ cid, inchiKey, formula, iupac })` (match `pubchem_cid` then `normalized_name`; insert w/ `status='pubchem'`); `upsertAlias` (idempotent on `(compound_id, normalized_alias)`)
- [x] 2.6 Same: `normalizeBioprospectingCompounds({ limit=50, dryRun?, onlyMissing=true })` — SELECT pending facts w/ `attempts<MAX_RETRIES OR at IS NULL OR at<NOW()-24h`, ORDER BY created_at LIMIT 50; per-fact: alias-map re-check first; on miss `gate.take → fetchPubChemCid → gate.take → fetchPubChemProperties → upsertCanonical → upsertAlias → attachCanonicalToFact('verified')`; on 404 increment attempts, `attachCanonicalToFact('pending' or 'failed')`; returns summary
- [x] 2.7 `BACKOFFS_MS = [60_000, 300_000, 1_500_000, 7_200_000, 28_800_000]` + `backoffFor(attempts)`. The `compound_authority_at` re-check window IS the backoff — inline comment that this design obviates BullMQ delayed jobs
- [x] 2.8 `src/services/queue/workers/compoundAuthority.worker.ts`: `createCompoundAuthorityWorker()` — `concurrency: 1`, `lockDuration: 300000`; calls `normalizeBioprospectingCompounds`; per-fact try/catch; logs `compound_authority_worker_started`
- [x] 2.9 `queues.ts`: `getCompoundAuthorityQueue()` w/ `attempts: 1`; on init, if `COMPOUND_AUTHORITY_ENABLED !== 'false'` AND `COMPOUND_AUTHORITY_INTERVAL_HOURS !== '0'`, register `queue.add('compound-authority-tick', {}, { repeat: { every: hours*3600*1000 } })`; if disabled, skip repeat but still register the queue
- [x] 2.10 Wire `createCompoundAuthorityWorker()` into `src/worker.ts` (after `createBioprospectingWorker`, add to `closePromises`, log `compoundAuthorityConcurrency: 1`)
- [x] 2.11 `seeds/compounds-top-50.json`: 50 hand-curated compounds (curcumin 969516, DHA 445580, EPA 446284, paclitaxel 36314, bryostatin 5280757, quercetin 5280343, resveratrol 445154, etc.) w/ `inchi_key`, `molecular_formula`, `iupac_name`, `compound_kind`, 3-5 starter aliases each
- [x] 2.12 `src/services/researchBrain/seedCompounds.ts`: `loadSeedCompounds(dryRun?)` reads `seeds/compounds-top-50.json` (Bun `import ... assert { type: "json" }`); for each entry upsert canonical (match `pubchem_cid` then `normalized_name`, `status='curated'`) + upsert each alias (`source='curated'`, `confidence='high'`); single tx wrapping the whole file; returns `{ canonicalsInserted, canonicalsSkipped, aliasesInserted, aliasesSkipped }`
- [x] 2.13 `scripts/seed/load-compounds.ts` (mirrors `scripts/normalize-taxonomy.ts`): parses `--dry-run`, calls `loadSeedCompounds`, prints summary JSON. Add to `package.json` as `"seed:compounds": "bun run scripts/seed/load-compounds.ts"`
- [x] 2.14 `__tests__/compoundAuthority.gate.test.ts`: gate enforces 250ms min interval between `take()`; `pause(ms)` blocks subsequent takes; multiple `pause()` calls take max
- [x] 2.15 `__tests__/compoundAuthority.backfill.test.ts`: stub `globalThis.fetch` w/ canned PubChem responses (CID 200, props 200, 404, 429 w/ `Retry-After: 1`); mock Supabase; assert: alias hit → verified w/o fetch; PubChem hit → verified + upserted canonical/alias; 5th 404 → failed; 429 reads Retry-After; one bad fact does not abort
- [x] 2.16 Spike: `scripts/spike-pubchem.ts` (NOT shipped) hits PubChem directly; capture response shape, `Retry-After`, `X-Throttling-Control`, 429 behavior; document inline in `compoundAuthority.ts`; remove before merge

---

## Phase 3: API + UI + Edit Reset (PR #3) — user-visible end-to-end

- [x] 3.1 `db.ts` `updateBioprospectingFactEntities`: when `patch.compound` differs, after patch (i) `resolveCompoundStatus(newCompound, aliasMap)`, (ii) insert `manual_edit` audit (old/new = `{ compound, compound_canonical_id, compound_authority_status }`, `user_id = correctedBy`, `reason = 'compound_text_changed'`), (iii) `attachCanonicalToFact(...)` writes second `status_change` row. Never overwrite raw `compound`
- [x] 3.2 Route `GET /api/research-brain/compounds/search?q=&limit=`: 400 on missing q, default limit 25 max 100, `authResolver({ required: false })`, returns `{ results: ResearchCompound[] }`
- [x] 3.3 Route `GET /api/research-brain/compounds/:id`: 200 + canonical + aliases, 404 on miss, `authResolver({ required: false })`
- [x] 3.4 Route `POST /api/research-brain/compounds/:id/aliases`: body `{ alias, confidence }` (400 on missing/invalid), calls `addAlias`, 201 w/ `{ id }`, `authResolver({ required: true, role: 'admin' })`
- [x] 3.5 Route `POST /api/research-brain/facts/:factId/authority/promote`: body `{ reason }` (400 on missing), calls `promoteToPending`, 200 on success, 404 on missing fact, 409 w/ `{ error: "not in failed state" }` on non-failed, `authResolver({ required: true, role: 'admin' })`
- [x] 3.6 `scripts/normalize-compounds.ts` (mirrors `scripts/normalize-taxonomy.ts`): parses `--limit`, `--dry-run`, `--all`; calls `normalizeBioprospectingCompounds`. Add to `package.json` as `"normalize:compounds": "bun run scripts/normalize-compounds.ts"`
- [x] 3.7 Client fact row + detail: when `compound_canonical_id` set and `canonical_name !== compound` (normalized), render `compound → {canonical_name}` badge w/ `title` showing InChIKey + PubChem CID; when `compound_authority_status === 'failed'`, render red dot w/ `title` showing last error
- [x] 3.8 Provenance viewer: when fact has `compound_canonical_id`, show canonical name + InChIKey + PubChem CID in lightbox header under raw `compound` (use existing `EvidenceLightbox` mount from `bioprospecting-pdf-provenance-viewer` PR #3)
- [x] 3.9 `.env.example`: 4 new vars w/ defaults + comments (`COMPOUND_AUTHORITY_INTERVAL_HOURS=6`, `COMPOUND_AUTHORITY_RATE_LIMIT_RPS=4`, `COMPOUND_AUTHORITY_MAX_RETRIES=5`, `COMPOUND_AUTHORITY_ENABLED=true`)
- [x] 3.10 `__tests__/compoundAuthority.routes.test.ts`: integration via `app.handle(new Request(...))`; assert search 200+Curcumin, search 400 missing q, get-by-id 200+aliases, get-by-id 404, add-alias admin 201, add-alias non-admin 403, add-alias 400 missing body, promote failed→pending 200, promote verified 409
- [x] 3.11 `__tests__/compoundAuthority.edit-reset.test.ts`: `updateBioprospectingFactEntities` w/ compound change; assert raw `compound` preserved, `compound_authority_status` reset per resolveCompoundStatus, TWO audit rows (manual_edit + status_change), authority columns reflect new state
- [x] 3.12 E2E: w/ `COMPOUND_AUTHORITY_ENABLED=false`, start worker, assert no repeat job but queue queryable; flip to `true` + restart, assert repeat registered; manually enqueue one tick via Bull Board, assert `normalizeBioprospectingCompounds` runs

---

## Phase 4: Cleanup / Rollout

- [ ] 4.1 `documentation/docs/SETUP.md`: add 4 `COMPOUND_AUTHORITY_*` env vars and `bun run seed:compounds` / `bun run normalize:compounds` commands
- [ ] 4.2 `documentation/docs/JOB_QUEUE.md`: document `compound-authority` queue behavior, env-driven repeat, 1-concurrency / 4-rps design rationale
- [ ] 4.3 Execute 6-step rollout from design (env-flip to `false` first, deploy, flip to `true`, observe run summary, log alias-hit dominance, verify PubChem ≤ 4 rps)
- [ ] 4.4 Capture run-summary log line in doc: `{ considered, aliasHits, pubchemHits, pubchemMisses, retriesScheduled, failed, elapsed }` for operator grep during rollout
