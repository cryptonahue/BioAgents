# Design: Bioprospecting Compound Authority

## Technical Approach

Mirror the `taxonomy.ts` pattern (status enum + alias table + backfill worker) and adapt it for chemistry: a `compoundAuthority.ts` service module owns PubChem resolution, a BullMQ scheduled job drives async backfill, a per-source alias map is built inline in `replaceBioprospectingFactsForSource` to stamp synchronous `verified` rows, and `attachCompoundAuthority(fact)` is the single sync entry point called from `bioprospectingExtractor.ts` between `normalizeFacts` and the inline merge. The 5-tuple `identity_key` is **not** changed; the four new fact columns are a parallel signal.

| Spec ref | Section | Implementation |
|---|---|---|
| research_compounds / _aliases / _audit | Tables | `supabase/migrations/20260613000000_create_compound_authority.sql` |
| BioprospectingFact 4 new columns | Fact columns | Same migration, `ALTER TABLE` block |
| `looksLikeExtract` | Pure helper | `compoundAuthority.ts` regex export |
| `resolveCompoundStatus` | Sync alias lookup | `compoundAuthority.ts` SQL + in-memory map |
| `attachCanonicalToFact` | Transactional status write | `compoundAuthority.ts`, used by both sync + worker paths |
| `searchCompounds` / `addAlias` / `promoteToPending` | Service API | `compoundAuthority.ts` |
| 4 API routes | Elysia | `src/routes/research-brain.ts` (extend) |
| `compound-authority` queue + worker | BullMQ | `queues.ts` (extend) + new `compoundAuthority.worker.ts` |
| Seed + idempotent loader | CLI | `seeds/compounds-top-50.json` + `scripts/seed/load-compounds.ts` |
| `attachCompoundAuthority(fact)` hook | Wiring | `bioprospectingExtractor.ts` + `db.ts` (fact edit path) |
| Audit row | JSONB | `compound_authority_audit` written by `attachCanonicalToFact`, `addAlias`, `promoteToPending`, edit-reset |

The architecture follows the project's "module + service + BullMQ worker" three-layer pattern. Each layer is independently testable; the worker is the only place that ever speaks HTTP to PubChem.

## Architecture Decisions

### Decision: Where to call `attachCompoundAuthority`

| Option | Tradeoff | Decision |
|---|---|---|
| In `bioprospectingExtractor.ts` after `normalizeFacts` | ✓ Stamps state BEFORE inline merge; `replaceBioprospectingFactsForSource` writes the columns directly; batch error isolated | **CHOSEN** |
| In `replaceBioprospectingFactsForSource` | Adds a second concern to the hot path; needs to re-fetch aliases per fact | Rejected |
| Post-hoc cron only | Facts stay `pending` until the worker runs; UI shows no badge for several hours | Rejected |

**Rationale:** The spec (`research-bioprospecting/spec.md` delta) mandates the call site be in the extractor. The pattern is also "stamp at the source of truth" — the fact row never exists without its authority state. The hook is synchronous, no network, no LLM; the only cost is one SQL `SELECT` to load the alias map per source.

### Decision: Scheduled job pattern (interval vs cron)

| Option | Tradeoff | Decision |
|---|---|---|
| BullMQ `repeat: { every: X }` (interval) | ✓ Simple, idempotent, restart-safe (BullMQ persists the next-tick timestamp), no `node-cron` dep | **CHOSEN** |
| `node-cron` separate timer | Two scheduling systems, restart-state divergence, no queue UI visibility | Rejected |
| `pg_cron` in Supabase | Couples DB scheduling to application logic, no BullMQ retry/delay machinery | Rejected |

**Setting:** `every: COMPOUND_AUTHORITY_INTERVAL_HOURS * 60 * 60 * 1000` (ms). The spec allows `0` to disable; we honor that by simply not calling `queue.add(name, {}, { repeat })` when the env is `0` (the queue is still registered, the worker still starts — admin can manually enqueue).

### Decision: Worker concurrency

| Option | Tradeoff | Decision |
|---|---|---|
| `concurrency: 1` | ✓ PubChem is single-bucket rate-limited; predictable retry/429 behavior; idempotent because of the `compound_authority_at` re-check window | **CHOSEN** |
| `concurrency: 4` | Throughput; but 4 workers all hitting PubChem at 4 rps = 16 rps, instant 429 | Rejected |
| `concurrency: 2` with internal gate | Adds an in-process gate that the existing 1-worker design doesn't need | Rejected |

### Decision: Batch size per run

| Option | Tradeoff | Decision |
|---|---|---|
| 50 facts per run | ✓ Small enough to finish inside one BullMQ cycle, 50 × 2 PubChem calls = 100 calls ≈ 25s at 4 rps; if more are pending, the next repeat run picks them up | **CHOSEN** |
| 500 facts per run (mirrors `taxonomy.ts`) | Mirrors existing pattern BUT each fact can require 2 PubChem calls (CID + property); 500 × 2 = 1000 calls ≈ 4 min; blocks lock and makes the worker less responsive to other queues | Rejected |
| Process all pending | Unbounded; one bad batch can starve the worker | Rejected |

**Spec asked for 50 not 500** (the design prompt says "cap at 50 per run + enqueue another run if more pending exist"). 50 is the safe default; the operator can raise it via `COMPOUND_AUTHORITY_BATCH_SIZE` env (default 50) if they want. If 50 are processed and ≥ 50 are still pending, the next interval picks them up naturally — we don't need to re-enqueue.

### Decision: Rate limiter

| Option | Tradeoff | Decision |
|---|---|---|
| `await new Promise(r => setTimeout(r, 250))` between requests | ✓ Trivial, deterministic, no state; 4 rps exactly; survives restart | **CHOSEN** |
| Token bucket | Smoother over long runs; adds ~30 LOC; not justified at 4 rps | Rejected |
| Global Redis gate | Wrong scope (BullMQ is in one process anyway); extra Redis traffic | Rejected |

**Implementation:** a `gate: { take(): Promise<void> }` object with `last = 0` (closure) and `minIntervalMs = 1000 / RPS`. Per call: `await sleep(max(0, last + minIntervalMs - now))`, then `last = now`. Wraps the gate around every PubChem fetch (CID lookup, property fetch, synonyms fetch). At 4 rps this is 250ms per call → 50 facts × 2 calls × 250ms = 25s. Fine.

### Decision: Retry-After handling

| Option | Tradeoff | Decision |
|---|---|---|
| Parse `Retry-After` header (seconds or HTTP-date) and pause gate | ✓ PubChem-documented behavior; respectful; the alternative is "swallow 429 and move on" which wastes the fact | **CHOSEN** |
| Ignore and let the next 429 fail | Fast path fails; we re-fetch the same bad fact next cycle | Rejected |
| Hard 30s pause on every 429 | Simpler but wastes time when PubChem says "wait 1s" | Rejected |

**Behavior on 429:** the gate sets `pausedUntil = max(pausedUntil, now + retryAfterMs)`; every subsequent `take()` blocks until that timestamp. The current fact is **pushed to the back of the batch** (deferred via a local "deferred" array) and processed after the pause elapses. We do NOT mark the fact `failed` on 429 — it's a server signal, not a name problem.

### Decision: Retry counter storage

| Option | Tradeoff | Decision |
|---|---|---|
| DB column `compound_authority_attempts` on the fact (counter incremented on miss) | ✓ Survives worker restart; visible to admin UI; participates in the audit (old_value/new_value) | **CHOSEN** |
| Worker in-memory counter | Lost on restart; fact re-attempted from 0 indefinitely | Rejected |
| BullMQ delayed job carry the counter | Couples retry state to a queue; harder to admin-view | Rejected |

**Implementation note:** the spec named the column `compound_authority_attempts` and listed 4 new fact columns. The design adds it as a 5th operational column. We MUST add it to the migration's `ALTER TABLE` block. Existing fact rows default to `0`.

### Decision: Seed format (offline CIDs vs on-demand PubChem)

| Option | Tradeoff | Decision |
|---|---|---|
| `seeds/compounds-top-50.json` with PubChem CID + InChIKey + aliases (offline-resolved) | ✓ First-deploy is offline; idempotent; no PubChem on load; reproducible | **CHOSEN** |
| Seed with names only; loader calls PubChem at load time | Risky on first deploy (PubChem rate limit, network); non-idempotent if PubChem returns different CID | Rejected |

**Loader flow:** for each entry, `UPSERT research_compounds (pubchem_cid=...) ON CONFLICT (pubchem_cid) DO NOTHING`; on a fresh insert, write the alias rows. Wrap the whole file in a single transaction (per spec). If CID is missing in a later entry, fall through to `compoundAuthority.upsertCompoundByName()` which DOES hit PubChem — but the top-50 ships with CIDs so this path is rarely used.

### Decision: Audit table partitioning

| Option | Tradeoff | Decision |
|---|---|---|
| Monthly range partitions on `created_at` | ✓ Keeps indexes small; the table is INSERT-heavy and read-rare (admin only); declarative PostgreSQL feature | **CHOSEN** |
| No partitioning | Simpler migration; one row per event means table grows ~50 rows per fact lifetime — at 100k facts, 5M rows in 1 year; still manageable but borderline | Rejected (defer to v2) |
| External logging (S3/ClickHouse) | Over-engineered for the spec | Rejected |

**Implementation:** `PARTITION BY RANGE (created_at)`; a default partition + the current month created at migration time; a single `ensureMonthlyPartitions()` function runs at worker startup (idempotent) and `CREATE` the next month if it doesn't exist. Documented as a follow-up if row count exceeds 1M; the proposal commits to "partition by month if it exceeds 1M rows" — we ship partitioning in v1 to avoid a v2 migration.

### Decision: BullMQ rate-limiter option

BullMQ has a built-in `limiter: { max, duration }` setting on `Queue`/`Worker`. We do **not** use it. BullMQ's limiter is per-worker-process and doesn't gracefully back off on 429. The custom gate is needed for the 429 pause + the per-fact 250ms cadence; BullMQ's limiter would be redundant and harder to reason about.

### Decision: Where the alias map is built

| Option | Tradeoff | Decision |
|---|---|---|
| One map per `replaceBioprospectingFactsForSource` call (per source) | ✓ Loaded once per source insert, not per fact; sub-millisecond lookups | **CHOSEN** |
| Global map loaded at process start | Stale across runs; needs invalidation on admin `addAlias` | Rejected |
| Per-fact SQL query | N+1; the extractor is the hot path | Rejected |

**Implementation:** `loadAliasMap(): Promise<Map<string, string>>` issues one `SELECT normalized_alias, compound_id FROM research_compound_aliases` (or two with both name+alias lookups). For ~10k aliases this is ~2MB; fine in memory.

### Decision: `attachCompoundAuthority` is a separate export, not inlined

The spec asks for a single function `attachCompoundAuthority(fact)` that the extractor calls once per fact. Internally it calls `resolveCompoundStatus` and stamps the in-memory fact object. The DB write happens later, in `replaceBioprospectingFactsForSource`, which now reads the four authority columns from the fact object. This keeps the extractor the single point of contact and avoids a second pass over the payload.

## Data Flow

### Synchronous path (extraction)

```
LLM emits raw fact objects
        │
        ▼
normalizeFacts (existing)  ── cleans JSON, resolves sourceTableRef
        │
        ▼
attachCompoundAuthority(fact)              ◀── NEW
   │  resolveCompoundStatus(fact.compound)
   │     ├── looksLikeExtract?     → { canonicalId: null, status: 'skipped', error: 'extract_or_mixture' }
   │     ├── aliasMap hit?         → { canonicalId: C.id, status: 'verified', at: NOW() }
   │     └── miss                  → { canonicalId: null, status: 'pending' }
   │  stamps the 4 columns on the in-memory fact
        │
        ▼
replaceBioprospectingFactsForSource        ◀── MODIFIED
   │  groups by identity_key (5-tuple, UNCHANGED)
   │  inserts with the 4 authority columns populated
        │
        ▼
research_bioprospecting_facts row written with
   compound = 'diferuloylmethane'  (raw, NEVER overwritten)
   compound_canonical_id = C_curcumin.id
   compound_authority_status = 'verified'
   compound_authority_at = NOW()
   compound_authority_error = NULL
```

### Asynchronous path (backfill worker)

```
BullMQ schedules `compound-authority` every COMPOUND_AUTHORITY_INTERVAL_HOURS
        │
        ▼
processCompoundAuthorityJob(job)           ◀── NEW WORKER
   │
   ▼
normalizeBioprospectingCompounds({ limit: 50 })
   │
   │  SELECT * FROM research_bioprospecting_facts
   │  WHERE compound_authority_status = 'pending'
   │    AND compound IS NOT NULL
   │    AND (compound_authority_attempts < COMPOUND_AUTHORITY_MAX_RETRIES
   │         OR compound_authority_at IS NULL
   │         OR compound_authority_at < NOW() - INTERVAL '24h')
   │  ORDER BY created_at ASC
   │  LIMIT 50
   │
   │  For each fact:
   │    ├── resolveCompoundStatus (in-memory map)  → on hit: attachCanonicalToFact('verified')
   │    ├── gate.take() → fetchPubChemCid(name)  → on hit:
   │    │     gate.take() → fetchPubChemProperties(cid)
   │    │     upsertCanonical({ pubchem_cid, inchi_key, formula, iupac })
   │    │     upsertAlias(name, canonical, source='pubchem')
   │    │     attachCanonicalToFact(fact.id, canonical.id, 'verified', 'pubchem_resolved')
   │    ├── on 404:
   │    │     attempts += 1
   │    │     if attempts < MAX_RETRIES:
   │    │         attachCanonicalToFact(fact.id, null, 'pending', 'pubchem 404 not found')
   │    │         scheduleDelayedRetry(fact.id, backoffFor(attempts))
   │    │     else:
   │    │         attachCanonicalToFact(fact.id, null, 'failed', 'pubchem 404 not found')
   │    └── on 429: gate.pause(retryAfter); defer fact to back of batch
   │
   ▼
log run summary
   { considered, aliasHits, pubchemHits, pubchemMisses, retriesScheduled, failed, elapsed }
```

### Edit-reset path (editorial flow)

```
Editor updates fact.compound via PATCH /facts/:id
        │
        ▼
updateBioprospectingFactEntities
   │  detects compound text changed
   │
   ▼
resolveCompoundStatus(newCompound)   ◀── reused
   │  inserts compound_authority_audit row
   │    event_type = 'manual_edit'
   │    old_value = { compound, compound_canonical_id, compound_authority_status }
   │    new_value = { compound, compound_canonical_id, compound_authority_status }
   │    user_id = editor
   │    reason = 'compound_text_changed'
   │
   ▼
attachCanonicalToFact(fact.id, newCanonical, newStatus)
   │  inserts a SECOND audit row
   │    event_type = 'status_change'
   │    user_id = editor
   │    reason = 'compound_text_changed' (or 'extract_detected')
   │
   ▼
Fact row updated; raw `compound` text preserved
```

## File Changes

| File | Action | Description |
|---|---|---|
| `supabase/migrations/20260613000000_create_compound_authority.sql` | Create | 3 new tables, 5 new fact columns, 5 indexes, monthly partitions, `pgcrypto` extension |
| `src/services/researchBrain/compoundAuthority.ts` | Create | LooksLikeExtract, resolveCompoundStatus, attachCanonicalToFact, attachCompoundAuthority, searchCompounds, addAlias, promoteToPending, normalizeBioprospectingCompounds, PubChem client, gate, retry counter helpers |
| `src/services/researchBrain/compoundAuthority.worker.ts` | Create | BullMQ worker; runs `normalizeBioprospectingCompounds` on each tick |
| `src/services/researchBrain/types.ts` | Modify | Add `CompoundStatus`, `ResearchCompound`, `ResearchCompoundAlias`, `CompoundAuthorityAuditEvent`; extend `BioprospectingFact` with 5 new columns (4 spec'd + `compound_authority_attempts`) |
| `src/services/researchBrain/bioprospectingExtractor.ts` | Modify | Call `attachCompoundAuthority(fact)` after `normalizeFacts`; build `aliasMap` once per source |
| `src/services/researchBrain/db.ts` | Modify | In `replaceBioprospectingFactsForSource`, write the 4 new columns from the fact object; in `updateBioprospectingFactEntities`, reset `compound_authority_status='pending'` when `compound` text changes + insert `manual_edit` audit row |
| `src/services/researchBrain/index.ts` | Modify | Re-export `compoundAuthority` |
| `src/services/queue/queues.ts` | Modify | Register `compound-authority` queue + repeatable job when env `> 0` |
| `src/services/queue/types.ts` | Modify | Add `CompoundAuthorityJobData`, `CompoundAuthorityJobResult` |
| `src/worker.ts` | Modify | Wire `createCompoundAuthorityWorker()` into the worker process |
| `src/routes/research-brain.ts` | Modify | 4 new routes: `GET /compounds/search`, `GET /compounds/:id`, `POST /compounds/:id/aliases` (admin), `POST /facts/:factId/authority/promote` (admin) |
| `seeds/compounds-top-50.json` | Create | Hand-curated top-50 with PubChem CIDs, InChIKeys, formulas, IUPAC names, ~150 starter aliases |
| `scripts/seed/load-compounds.ts` | Create | Idempotent loader; single transaction; logs summary |
| `package.json` | Modify | Add `"seed:compounds": "bun run scripts/seed/load-compounds.ts"` |
| `.env.example` | Modify | Add 4 `COMPOUND_AUTHORITY_*` vars with defaults |
| `client/src/.../bioprospecting/*` | Modify | Render `→ Canonical` badge when `compound_canonical_id` set; provenance viewer shows InChIKey + PubChem CID on click |

## Interfaces / Contracts

### Service module exports (`src/services/researchBrain/compoundAuthority.ts`)

```ts
// Types re-exported from types.ts
import type {
  CompoundStatus,
  ResearchCompound,
  ResearchCompoundAlias,
  CompoundAuthorityAuditEvent,
} from "./types";

// Regex-driven predicate, pure, no IO
export function looksLikeExtract(value: string | null | undefined): boolean;

// Resolve alias against in-memory map
export async function loadAliasMap(): Promise<Map<string, string>>;

// Decide initial status (sync, no network, no PubChem)
export function resolveCompoundStatus(
  value: string | null | undefined,
  aliasMap: Map<string, string>,
): { canonicalId: string | null; status: CompoundStatus; at: string | null; error: string | null };

// Stamp the 4 columns on the in-memory fact (called from extractor)
export function attachCompoundAuthority(
  fact: ExtractedBioprospectingFact,
  aliasMap: Map<string, string>,
): ExtractedBioprospectingFact & {
  compound_canonical_id: string | null;
  compound_authority_status: CompoundStatus;
  compound_authority_at: string | null;
  compound_authority_error: string | null;
};

// Transactional write of authority state + audit row (called by worker + admin)
export async function attachCanonicalToFact(params: {
  factId: string;
  canonicalId: string | null;
  status: CompoundStatus;
  error?: string | null;
  userId?: string | null;
  reason: string;            // 'pubchem_resolved' | 'pubchem_miss' | 'extract_detected' | 'admin_promote' | 'admin_alias_added' | 'compound_text_changed'
  attempts?: number;         // only used by worker to bump the counter
}): Promise<void>;

// PubChem HTTP client (worker only)
async function fetchPubChemCid(name: string, gate: RateGate): Promise<number | null>;
async function fetchPubChemProperties(cid: number, gate: RateGate): Promise<PubChemProperties | null>;
async function fetchPubChemSynonyms(cid: number, gate: RateGate): Promise<string[]>;

// Rate limiter (4 rps, respects Retry-After)
type RateGate = { take(): Promise<void>; pause(ms: number): void };

// Backfill script (called by worker + runnable from CLI)
export async function normalizeBioprospectingCompounds(params: {
  limit?: number;
  dryRun?: boolean;
  onlyMissing?: boolean;
}): Promise<{
  scannedFacts: number;
  aliasHits: number;
  pubchemHits: number;
  pubchemMisses: number;
  retriesScheduled: number;
  failed: number;
  elapsed: number;
}>;

// Service API (read + admin)
export async function searchCompounds(params: { query: string; limit?: number }): Promise<ResearchCompound[]>;
export async function getCompoundById(id: string): Promise<(ResearchCompound & { aliases: ResearchCompoundAlias[] }) | null>;
export async function addAlias(params: {
  canonicalId: string;
  alias: string;
  confidence: "high" | "medium" | "low";
  userId: string;
}): Promise<{ id: string }>;
export async function promoteToPending(params: {
  factId: string;
  userId: string;
  reason: string;
}): Promise<void>;
```

### 4 API routes

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `GET`  | `/api/research-brain/compounds/search?q=&limit=` | `required: false` | — | `{ results: ResearchCompound[] }` |
| `GET`  | `/api/research-brain/compounds/:id` | `required: false` | — | `ResearchCompound & { aliases: ResearchCompoundAlias[] }` |
| `POST` | `/api/research-brain/compounds/:id/aliases` | `required: true, role: 'admin'` | `{ alias, confidence }` | `{ id: string }` (HTTP 201) |
| `POST` | `/api/research-brain/facts/:factId/authority/promote` | `required: true, role: 'admin'` | `{ reason }` | `{ id, compound_authority_status: 'pending' }` (HTTP 200; HTTP 409 if not failed) |

### Migration (one file, idempotent)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) research_compounds
CREATE TABLE IF NOT EXISTS public.research_compounds (...);
CREATE INDEX IF NOT EXISTS idx_research_compounds_inchi_key ...;
CREATE INDEX IF NOT EXISTS idx_research_compounds_pubchem_cid ...;

-- 2) research_compound_aliases
CREATE TABLE IF NOT EXISTS public.research_compound_aliases (...);
CREATE INDEX IF NOT EXISTS idx_research_compound_aliases_normalized ...;

-- 3) compound_authority_audit (partitioned by month)
CREATE TABLE IF NOT EXISTS public.compound_authority_audit (...);
-- monthly partitions: default + current month
CREATE TABLE IF NOT EXISTS public.compound_authority_audit_default PARTITION OF public.compound_authority_audit DEFAULT;
CREATE TABLE IF NOT EXISTS public.compound_authority_audit_2026_06 PARTITION OF public.compound_authority_audit
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
-- +1-2 future months pre-created

-- 4) ALTER research_bioprospecting_facts (4 spec'd columns + 1 operational)
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS compound_canonical_id UUID REFERENCES public.research_compounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS compound_authority_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (compound_authority_status IN ('pending', 'verified', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS compound_authority_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS compound_authority_error TEXT,
  ADD COLUMN IF NOT EXISTS compound_authority_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_compound_canonical ...;
```

### Backoff schedule (worker only)

```ts
const BACKOFFS_MS = [60_000, 300_000, 1_500_000, 7_200_000, 28_800_000]; // 1m, 5m, 25m, 2h, 8h
function backoffFor(attempts: number): number {
  return BACKOFFS_MS[Math.min(attempts, BACKOFFS_MS.length - 1)];
}
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `looksLikeExtract` regex (positive + negative cases) | Pure function tests; `bun test`; no mocks |
| Unit | `resolveCompoundStatus` (alias hit / extract / miss) | Inject a `Map<string,string>`; assert return shape |
| Unit | `attachCanonicalToFact` writes a status_change audit row in the same transaction | Mock Supabase; assert both `update` and `insert` called; assert rollback on insert failure (mock the insert to throw) |
| Unit | `attachCompoundAuthority` is idempotent (verified on second call does not clobber) | Two calls in a row, assert the second is a no-op |
| Unit | `addAlias` writes both alias and audit row; re-submit of same alias is a no-op | Mock Supabase; assert idempotency |
| Unit | `promoteToPending` rejects non-failed facts | `expect(...).toThrow('not in failed state')` |
| Unit | Rate gate enforces 250ms minimum interval, respects 429 pause | `bun test` with `setTimeout`; assert timing within tolerance |
| Unit | PubChem client parses 200/404/429/500; 429 reads `Retry-After` | `fetch` mock returning canned responses |
| Integration | Backfill script: pending fact → PubChem hit → `verified` | Run `normalizeBioprospectingCompounds` against a seeded Supabase test DB; assert fact + audit rows |
| Integration | Backfill script: pending fact → PubChem 404 → `pending` with bumped attempts; 5th attempt → `failed` | Same as above with PubChem mock returning 404 |
| Integration | `replaceBioprospectingFactsForSource` writes authority columns; alias hit is `verified`, extract is `skipped`, miss is `pending` | Insert 3 facts; assert row state |
| Integration | Edit-reset: changing `fact.compound` inserts both `manual_edit` and `status_change` audit rows | Update via `updateBioprospectingFactEntities`; assert both audit rows |
| E2E | BullMQ worker end-to-end: enqueue → process → DB state | Enqueue manually; wait for completion; assert |
| E2E | API routes (200/201/400/401/403/404/409) | `app.handle(new Request(...))` integration test |

Test files:
- `src/services/researchBrain/__tests__/compoundAuthority.test.ts` — unit + service
- `src/services/researchBrain/__tests__/compoundAuthority.gate.test.ts` — rate limiter
- `src/services/researchBrain/__tests__/compoundAuthority.backfill.test.ts` — integration
- `src/services/researchBrain/__tests__/compoundAuthority.edit-reset.test.ts` — integration
- `src/services/researchBrain/__tests__/compoundAuthority.routes.test.ts` — API routes

## Migration / Rollout

| Step | Action | Reversible? |
|---|---|---|
| 1 | Apply migration; verify 3 new tables + 5 new fact columns + 5 indexes | Yes — `DROP TABLE` + `ALTER TABLE ... DROP COLUMN` (4 spec'd + 1 operational) |
| 2 | `bun run seed:compounds` to populate top-50 from `seeds/compounds-top-50.json` | Yes — `DELETE FROM research_compounds WHERE status='curated'` |
| 3 | Deploy with `COMPOUND_AUTHORITY_ENABLED=false` first; restart | Yes — env var flip |
| 4 | Re-deploy with `COMPOUND_AUTHORITY_ENABLED=true` and `COMPOUND_AUTHORITY_INTERVAL_HOURS=6` | Yes — env var flip |
| 5 | Observe run summary in logs; verify alias hits dominate, PubChem calls stay under 4 rps | n/a |
| 6 | Roll back: `COMPOUND_AUTHORITY_ENABLED=false` halts scheduling; existing data is untouched (FK with `ON DELETE SET NULL` is safe) | n/a |

The 5-retry window (24h) means the worst-case state is "many facts in `pending`" which is the same as the pre-change baseline. No data loss in any scenario.

## Open Questions

- [ ] **Should the `compound_authority_attempts` reset to 0 on `manual_edit`?** The spec says "edit reset re-resolves canonical id"; the attempts counter is a backfill concern. Recommend: yes, reset to 0 on edit so the curator's manual override is honored with a fresh attempt window. Confirm with team.
- [ ] **Audit row for `compound_authority_attempts` changes?** The spec only requires `old_value`/`new_value` to capture the canonical state; attempts are an internal counter. Recommend: do NOT add a separate audit event for counter changes; surface them in the status_change payload only when crossing 0→1 or N→failed. Confirm.
- [ ] **Bulk requeue endpoint deferred to Phase 2 — confirmed in the spec.** No action.
- [ ] **ChEBI column is present but unused.** Future cross-link. No action.
- [ ] **Existing facts (rows already in the DB before this migration) get `compound_authority_status='pending'` by default.** The first scheduled run will try to resolve them. Acceptable.
