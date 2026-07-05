# Design: discovery-persistence (v1)

## Overview

`discovery-persistence` v1 promotes the `Discovery` entity from a JSONB
blob in `conversation_states.values` to a first-class, queryable,
versioned resource. The change is **write-side only**: every discovery
extracted by the LLM is dual-written to a new relational store AND the
existing JSONB cache. One auth-gated read endpoint exposes the
relational store for verification.

**Read consumers (planning, reply, paper generation) are NOT migrated
in v1.** They continue reading from JSONB, which is kept in sync by the
dual-write. A follow-up change migrates the read paths.

This document is the technical design for v1. It is the contract the
`apply` phase will implement.

---

## 1. Scope of v1 (recap from spec/proposal)

| Area | In v1 | Out of v1 (deferred) |
|------|-------|----------------------|
| Storage | 3 new tables, write-through | Read-side migration |
| Match algorithm | Jaccard 0.7 in TypeScript | Embedding cosine / SQL trigger |
| Endpoints | `GET /conversations/:id/discoveries` | `?versions=`, `?since=`, `?group=`, re-eval |
| Worker | Discoveries persist after LLM call | Scheduled re-eval worker |
| Backfill | None | Legacy JSONB -> table backfill |
| Graph edges | None | Discovery-to-discovery relationships |
| UI | None | Frontend reads |

**Forward-compat hooks (v1 must ship):**
- `last_checked_at` column + partial index `idx_discoveries_reeval_due`
- `reeval_status` enum + CHECK constraint
- `research_discovery_reeval_audit` table (empty in v1)

---

## 2. Data Model

### 2.1 ER Summary

```
conversations (existing)
    id (uuid, PK)
    user_id (uuid, NOT NULL)

messages (existing)
    id (uuid, PK)
    conversation_id (uuid, FK -> conversations.id)

research_discoveries (NEW)
    id (uuid, PK)
    discovery_group_id (uuid, NOT NULL)            -- stable across versions
    conversation_id (uuid, FK -> conversations.id, ON DELETE CASCADE)
    message_id (uuid, FK -> messages.id, ON DELETE SET NULL)
    supersedes_discovery_id (uuid, FK -> research_discoveries.id, ON DELETE SET NULL)
    is_current (bool, default true)
    superseded_at (timestamptz, NULL)
    title, claim, summary (text, NOT NULL)
    novelty (text, NULL)
    artifacts (jsonb, default '[]')
    discovery_key (text, NOT NULL)                 -- normalized for Jaccard
    reeval_status (text, default 'none')           -- FORWARD-COMPAT
    reeval_notes (text, NULL)                      -- FORWARD-COMPAT
    last_checked_at (timestamptz, NULL)            -- FORWARD-COMPAT
    created_at, updated_at (timestamptz, NOT NULL)

research_discovery_evidence (NEW)
    id (uuid, PK)
    discovery_id (uuid, FK -> research_discoveries.id, ON DELETE CASCADE)
    task_id (text, NOT NULL)                       -- no FK; PlanTask is JSONB
    job_id (text, NULL)
    explanation (text, NOT NULL)
    source_url (text, NULL)                        -- nullable, forward-compat
    evidence_archived (bool, default false)        -- ORPHAN BADGE
    created_at (timestamptz, NOT NULL)

research_discovery_reeval_audit (NEW, forward-compat)
    id (uuid, PK)
    discovery_id (uuid, FK -> research_discoveries.id, ON DELETE CASCADE)
    event_type (text, CHECK in user_reeval|auto_reeval|llm_supersede|user_dismiss)
    old_version_id (uuid, FK -> research_discoveries.id, ON DELETE SET NULL)
    new_version_id (uuid, FK -> research_discoveries.id, ON DELETE SET NULL)
    outcome (text, NULL)
    notes (text, NULL)
    created_at (timestamptz, NOT NULL)
```

### 2.2 Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Versioning | Append-only, soft-delete via `is_current=false` + `superseded_at` | Reversible, audit-friendly, JSONB has no version concept. |
| Group ID | One `discovery_group_id` per logical finding, stable across versions | Lets PR #2 (versioned reads) walk the chain. |
| Match key storage | Normalized string (e.g. `kinase\|binding\|in\|vitro`), NOT a hash | Spec Q4: debuggable, "include both possibilities" answer picks normalized string. |
| Match algorithm | In-TS Jaccard 0.7 in v1 | Spec Q2: small dataset, no DB round-trip, easier to tune. SQL trigger if volume grows. |
| Forward-compat audit | Empty table in v1 | PR #2 inserts; v1 must NOT insert. |
| `evidence_archived` flag | Computed at READ time, not WRITE time | Source of truth is the plan tree in JSONB; the flag is a denormalized badge. |
| `task_id` FK | None | PlanTask lives in JSONB. The DB column is just a text reference. |
| `source_url` on evidence | New column, nullable | Per spec: future Lit re-eval may need it. v1 leaves it NULL. |
| Soft-fail on writes | Yes | Never abort the cycle on DB write failure (spec requirement). |

---

## 3. Migration

**File:** `supabase/migrations/20260616000001_create_discovery_persistence.sql`

Timestamp: `20260616000001` (one minute after the most recent migration
`20260616000200_get_contradiction_stats_rpc.sql`, but the next-day
rollover is irrelevant — Supabase migration order is filename sort, so
we use `0001` to be safe relative to existing `20260616000xxx` files;
**apply phase MUST verify the next free timestamp and adjust**).

> **Convention reminder:** Filenames are `YYYYMMDDHHMMSS_<slug>.sql`.
> The most recent existing file is `20260616000200`. Use
> `20260616000300_create_discovery_persistence.sql`.

### 3.1 DDL

```sql
-- Migration: Create research_discoveries + evidence + reeval_audit tables.
-- PR 1 of discovery-persistence.
--
-- Why this migration exists:
--   The Discovery entity lives only in conversation_states.values JSONB.
--   Every deep-research cycle re-extracts from scratch; there is no
--   durable, versioned record. We need a stable, FK-addressable, versioned
--   table before re-evaluation, provenance diffing, or "discoveries for
--   this user" queries are possible.
--
-- This migration is purely additive. Existing tables are untouched. The
-- JSONB cache path stays as the source of truth for planning / reply /
-- paper generation in v1. A follow-up change migrates read consumers.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) research_discoveries — one row per (conversation, finding-version).
--    discovery_group_id is stable across versions of "the same" finding;
--    supersedes_discovery_id points to the row being replaced.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_discoveries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_group_id       UUID NOT NULL,
  conversation_id          UUID NOT NULL
                            REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id               UUID
                            REFERENCES public.messages(id) ON DELETE SET NULL,
  supersedes_discovery_id  UUID
                            REFERENCES public.research_discoveries(id) ON DELETE SET NULL,

  is_current               BOOLEAN NOT NULL DEFAULT true,
  superseded_at            TIMESTAMPTZ,

  title                    TEXT NOT NULL,
  claim                    TEXT NOT NULL,
  summary                  TEXT NOT NULL,
  novelty                  TEXT,
  artifacts                JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Normalized (title + claim) token set, joined with '|'. Used by
  -- findMatchingDiscovery() at the TS layer (Jaccard >= 0.7).
  discovery_key            TEXT NOT NULL,

  -- Forward-compat: re-eval lifecycle. v1 NEVER writes these.
  -- PR #2 (re-evaluation) will use them.
  reeval_status            TEXT NOT NULL DEFAULT 'none'
    CHECK (reeval_status IN ('none','pending','clean','extended','contradicted')),
  reeval_notes             TEXT,
  last_checked_at          TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A discovery cannot supersede itself.
  CONSTRAINT no_self_supersede CHECK (id != supersedes_discovery_id)
);

-- Hot path: "current discoveries for this conversation"
-- Partial index because the typical read query filters on is_current=true.
CREATE INDEX IF NOT EXISTS idx_discoveries_conv_current
  ON public.research_discoveries (conversation_id)
  WHERE is_current;

-- History walk: "show all versions of this finding"
CREATE INDEX IF NOT EXISTS idx_discoveries_group
  ON public.research_discoveries (discovery_group_id);

-- Forward-compat: PR #2 worker will scan this index for
-- is_current=true AND last_checked_at IS NULL OR < NOW() - INTERVAL '24h'.
-- Partial index keeps it cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_discoveries_reeval_due
  ON public.research_discoveries (last_checked_at)
  WHERE is_current;

-- Foreign-key indexes (Postgres does NOT auto-index FKs).
CREATE INDEX IF NOT EXISTS idx_discoveries_supersedes
  ON public.research_discoveries (supersedes_discovery_id)
  WHERE supersedes_discovery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discoveries_message
  ON public.research_discoveries (message_id)
  WHERE message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) research_discovery_evidence — 1..N evidence rows per discovery.
--    task_id references a PlanTask in JSONB (no FK).
--    source_url is forward-compat: PR #2 will populate when re-eval
--    cites a specific Lit page. v1 leaves it NULL.
--    evidence_archived is computed at READ time (see route design).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_discovery_evidence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id      UUID NOT NULL
                      REFERENCES public.research_discoveries(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL,
  job_id            TEXT,
  explanation       TEXT NOT NULL,
  source_url        TEXT,
  evidence_archived BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovery_evidence_discovery
  ON public.research_discovery_evidence (discovery_id);

CREATE INDEX IF NOT EXISTS idx_discovery_evidence_task
  ON public.research_discovery_evidence (task_id);

-- ---------------------------------------------------------------------------
-- 3) research_discovery_reeval_audit — forward-compat hook.
--    v1 MUST NOT write to this table. PR #2 (re-evaluation) will.
--    The table exists so PR #2's migration is purely additive.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_discovery_reeval_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id    UUID NOT NULL
                    REFERENCES public.research_discoveries(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('user_reeval','auto_reeval','llm_supersede','user_dismiss')),
  old_version_id  UUID
    REFERENCES public.research_discoveries(id) ON DELETE SET NULL,
  new_version_id  UUID
    REFERENCES public.research_discoveries(id) ON DELETE SET NULL,
  outcome         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovery_reeval_audit_discovery
  ON public.research_discovery_reeval_audit (discovery_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at trigger on research_discoveries (mirrors existing pattern)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_update_research_discoveries_updated_at
  ON public.research_discoveries;

CREATE TRIGGER trigger_update_research_discoveries_updated_at
  BEFORE UPDATE ON public.research_discoveries
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

-- ---------------------------------------------------------------------------
-- Grants — mirror research_bioprospecting_contradictions pattern.
-- Backend uses service client (RLS bypassed). Future v2 RLS can
-- enforce conversation_id ownership via a policy keyed on
-- auth.jwt()->>sub.
-- ---------------------------------------------------------------------------
GRANT ALL ON TABLE public.research_discoveries
  TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_discovery_evidence
  TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_discovery_reeval_audit
  TO anon, authenticated, service_role;

COMMIT;
```

### 3.2 Notes for apply

- **Idempotent re-run:** every `CREATE` is `IF NOT EXISTS`, every
  trigger drop is `IF EXISTS`, and `CREATE EXTENSION` is
  `IF NOT EXISTS`. A failed-then-replayed migration is safe.
- **No backfill:** the migration does not touch existing data. Legacy
  conversations will have zero rows in `research_discoveries` until
  their next deep-research cycle. This is a documented v1 limitation.
- **No destructive ALTER:** all 3 tables are new. No existing schema
  is mutated.
- **`update_research_brain_updated_at()`** function is assumed to
  exist (it is referenced in compound authority and contradictions
  migrations). If absent on a fresh deploy, add it first.

---

## 4. Service Module: `discoveryPersistence.ts`

**File:** `src/services/researchBrain/discoveryPersistence.ts`

### 4.1 Public API

```typescript
// Re-exported from utils.ts (defined in §5.1 for testability)
export { normalizeTokens, jaccard, discoveryStableKey, findMatchingDiscovery } from "../../agents/discovery/utils";

export type PersistResult = {
  inserted: DiscoveryRowInserted[];
  superseded: string[];   // ids of rows that became is_current=false
  removed: string[];      // ids of rows soft-deleted because the LLM no longer mentions them
  unchanged: string[];    // ids of rows kept current (no match found, no removal)
  errors: string[];       // soft-fail event names (not thrown)
};

export type PersistParams = {
  discoveries: Discovery[];        // LLM output, after fixDiscoveryArtifactPaths()
  conversationId: string;
  messageId: string;
  threshold?: number;              // default 0.7
  loggerFields?: Record<string, unknown>;
};

export async function persistDiscoveriesToDb(
  params: PersistParams,
): Promise<PersistResult>;

export type ResearchDiscoveryRow = {
  id: string;
  discovery_group_id: string;
  conversation_id: string;
  message_id: string | null;
  supersedes_discovery_id: string | null;
  is_current: boolean;
  superseded_at: string | null;
  title: string;
  claim: string;
  summary: string;
  novelty: string | null;
  artifacts: AnalysisArtifact[];
  discovery_key: string;
  reeval_status: "none" | "pending" | "clean" | "extended" | "contradicted";
  reeval_notes: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ResearchDiscoveryEvidenceRow = {
  id: string;
  discovery_id: string;
  task_id: string;
  job_id: string | null;
  explanation: string;
  source_url: string | null;
  evidence_archived: boolean;
  created_at: string;
};

export async function getDiscoveriesForConversation(params: {
  conversationId: string;
}): Promise<ResearchDiscoveryRow[]>;
```

### 4.2 Internal flow: `persistDiscoveriesToDb`

The function is best-effort. The agent catches and logs any thrown
error; it never propagates. Internally:

1. **Load existing current rows** for the conversation:
   ```sql
   SELECT id, discovery_key, discovery_group_id
   FROM research_discoveries
   WHERE conversation_id = $1 AND is_current = true;
   ```
   If this query throws, log `discovery_persist_load_failed` and
   return an empty `PersistResult` (the JSONB write still happens).

2. **For each incoming discovery** (in order):
   - Compute `discovery_key = discoveryStableKey(title, claim)`.
   - Run `findMatchingDiscovery(d, existingRows, threshold)`.
   - **Match found** (`matchedId` is non-null):
     - Look up the existing row's `discovery_group_id`.
     - INSERT a new row with:
       - `supersedes_discovery_id = matchedId`
       - `discovery_group_id = <existing group id>` (preserve group)
       - `is_current = true`, `superseded_at = null`
       - All other fields from the incoming discovery.
     - UPDATE the old row:
       - `is_current = false`
       - `superseded_at = NOW()`
     - **Merge evidence**: copy OLD evidence rows into the NEW row's
       `evidenceArray` (deduped by `taskId`); then add the NEW rows.
       Rationale: the LLM's "Preserve all previous evidence" guidance
       (see `src/agents/discovery/prompts.ts:107`) means the new
       version should keep historical context, not replace it.
     - Add `matchedId` to `superseded[]`.
   - **No match** (Jaccard < threshold):
     - INSERT a new row with a fresh `discovery_group_id` (generate
       via `crypto.randomUUID()`), `supersedes_discovery_id = null`,
       `is_current = true`.
     - Add `newRow.id` to `inserted[]`.
     - Evidence: insert only the new evidence rows.
   - **Skip** if title or claim is empty (defensive — shouldn't
     happen, but the LLM has produced garbage before).

3. **Reconcile removals**: for any existing current row that did NOT
   match an incoming discovery, the LLM "removed" it.
   - UPDATE: `is_current = false`, `superseded_at = NOW()`.
   - Add the row's id to `removed[]`.
   - Rationale: the LLM's "Remove discoveries if new evidence
     contradicts them" guidance (see prompts.ts:115) means
     "not present in the new output" is the LLM's signal for removal.

4. **Bulk insert evidence** for all newly-inserted rows (one INSERT
   per row, or batched in chunks of 50 to keep payload reasonable).
   - On insert failure, log `discovery_evidence_insert_failed` and
     continue. The discovery row is still saved.

5. **Return** `{ inserted, superseded, removed, unchanged, errors }`.

### 4.3 Internal flow: `getDiscoveriesForConversation`

1. Query current rows ordered by `created_at DESC`:
   ```sql
   SELECT * FROM research_discoveries
   WHERE conversation_id = $1 AND is_current = true
   ORDER BY created_at DESC;
   ```
2. For each row, query its evidence:
   ```sql
   SELECT * FROM research_discovery_evidence
   WHERE discovery_id = ANY($1)
   ORDER BY created_at ASC;
   ```
3. Return the rows with `evidence[]` joined in-process. (Could be a
   single Supabase `.select("*, evidence:research_discovery_evidence(*)")`
   join — verify postgREST syntax in apply. Fallback: two queries.)

### 4.4 Soft-Fail Pattern (mandatory)

The function MUST NOT throw to the caller. Every catch site uses the
structured logger with a stable event name:

| Event name | Severity | When |
|------------|----------|------|
| `discovery_persist_load_failed` | error | Step 1 query fails |
| `discovery_persist_insert_failed` | error | Step 2 INSERT fails for one row |
| `discovery_persist_supersede_failed` | error | Step 2 UPDATE of old row fails |
| `discovery_evidence_insert_failed` | error | Step 4 INSERT fails |
| `discovery_persist_reconcile_failed` | error | Step 3 UPDATE for removals fails |
| `discovery_persist_completed` | info | Step 5 success, with counts |
| `discovery_persist_failed_soft_fail` | error | Top-level catch (caller-visible) |

Each log payload includes:
- `conversationId`
- `messageId`
- `discoveryCount` (LLM output size)
- `insertedCount`, `supersededCount`, `removedCount`
- `err.message` on errors
- `event: 'discovery_persist_failed_soft_fail'` on top-level

### 4.5 Idempotency

The function is **idempotent on rerun for the same `(messageId,
discovery_key)` tuple**: re-running within the same cycle is a no-op
because:

- A new `discovery_key` produces a new `discovery_group_id` and INSERT.
- An existing `discovery_key` matches via Jaccard, the matched row is
  soft-deleted, and a new row takes its place. If the cycle runs
  twice, the second run matches the *just-inserted* row's
  `discovery_key` exactly (Jaccard = 1.0), supersedes it, and the
  *first* run's row is soft-deleted. The end-state is "one current
  row, N historical rows". Acceptable for v1 because the v1 cycle is
  invoked once per `extractDiscoveries()` call.

If double-invocation becomes a problem in v2, add a `cycle_id` column
to filter scope. v1 does not need this.

### 4.6 Error tolerance matrix

| Failure | Behavior |
|---------|----------|
| Step 1 (load) throws | Log + return empty `PersistResult`. JSONB write still happens. |
| Step 2 INSERT throws for one row | Log per-row. Continue processing remaining rows. |
| Step 2 UPDATE (supersede) throws | Log. New row still inserted; old row stays current. **Risk**: a discovery may appear twice in `is_current=true`. Mitigated by next cycle's reconcile. |
| Step 2 evidence merge logic throws | Log. New discovery still persisted; old evidence not merged. |
| Step 3 reconcile (remove) throws | Log. Old rows stay current. Next cycle retries. |
| Step 4 evidence INSERT throws | Log per-row. Discovery row still persisted. |
| All steps throw | Top-level catch logs `discovery_persist_failed_soft_fail` and returns empty `PersistResult`. **Cycle continues.** |

---

## 5. Match Algorithm (TS, Jaccard 0.7)

**File:** `src/agents/discovery/utils.ts` (modified — existing `utils.ts`
already houses `extractDiscoveries` and `fixDiscoveryArtifactPaths`).

### 5.1 Pure functions (exported for tests)

```typescript
/**
 * Lowercase, NFKD-decompose (no-op in practice for our token set),
 * drop diacritics, replace non-alphanumeric runs with space, split,
 * filter tokens shorter than 3 chars. Returns a Set for O(1) lookup.
 */
export function normalizeTokens(s: string): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")   // strip diacritics
      .replace(/[^a-z0-9\s]/g, " ")     // alphanumeric + whitespace
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

/**
 * Standard Jaccard similarity: |A ∩ B| / |A ∪ B|.
 * Edge cases: both empty => 1 (trivially equal), one empty => 0.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Stable, debuggable normalized string. NOT a hash — we want to be
 * able to grep for "kinase|binding" in logs.
 */
export function discoveryStableKey(title: string, claim: string): string {
  const tokens = normalizeTokens(`${title} ${claim}`);
  return [...tokens].sort().join("|");
}

/**
 * Returns the id of the best matching existing row, or null if no
 * row scores >= threshold. Best match is the highest Jaccard score.
 * Ties broken by alphabetical id (deterministic).
 */
export function findMatchingDiscovery(
  incoming: { title: string; claim: string },
  existing: Array<{ id: string; discovery_key: string }>,
  threshold = 0.7,
): string | null {
  if (existing.length === 0) return null;
  const incomingTokens = normalizeTokens(`${incoming.title} ${incoming.claim}`);
  if (incomingTokens.size === 0) return null;

  let best: { id: string; score: number } | null = null;
  for (const row of existing) {
    if (!row.discovery_key) continue;
    const rowTokens = new Set(row.discovery_key.split("|"));
    const score = jaccard(incomingTokens, rowTokens);
    if (best === null || score > best.score) {
      best = { id: row.id, score };
    } else if (score === best.score && row.id < best.id) {
      // Tie-break: alphabetical id wins (deterministic).
      best = { id: row.id, score };
    }
  }
  return best && best.score >= threshold ? best.id : null;
}
```

### 5.2 Threshold parameterization

The threshold is a **parameter** on `findMatchingDiscovery` (default
0.7). Future tuning needs no spec change. The agent may pass a
non-default value via a future env var (`DISCOVERY_MATCH_THRESHOLD`);
v1 hard-codes 0.7.

### 5.3 Performance

For a conversation with ~50 current discoveries and an incoming
batch of ~5:

- `normalizeTokens` on 5 inputs: 5 set constructions, O(tokens).
- 5 × 50 = 250 `jaccard` calls. Each is O(|smallest|). For a
  normalized key of ~20 tokens, this is ~20 hash lookups. Total:
  ~5,000 ops. Sub-millisecond.

The in-TS approach scales to ~5000 current rows per conversation
comfortably. Beyond that, an SQL trigger with `pg_trgm` similarity is
the right next step (out of scope for v1).

---

## 6. Discovery Agent Dual-Write

### 6.1 `src/agents/discovery/index.ts` (modified)

Add a single helper call AFTER `fixDiscoveryArtifactPaths()` and
BEFORE the `end = new Date().toISOString()` line. The dual-write
contract is:

```typescript
// Existing line:
const fixedDiscoveries = fixDiscoveryArtifactPaths(discoveries, tasksToConsider);

// NEW: write-through to research_discoveries.
try {
  await persistDiscoveriesToDb({
    discoveries: fixedDiscoveries,
    conversationId: message.conversation_id,
    messageId: message.id,
    threshold: 0.7,
    loggerFields: { jobId: /* pulled from caller context if available */ },
  });
} catch (error) {
  // persistDiscoveriesToDb is contractually non-throwing. This catch
  // is a defensive belt-and-suspenders. Log and continue.
  logger.error(
    { err: error, conversationId: message.conversation_id },
    "discovery_persist_failed_soft_fail",
  );
}

// Existing line:
const end = new Date().toISOString();
```

The agent's return value is **unchanged**: `DiscoveryAgentResult` with
`fixedDiscoveries` flowing through. The worker's downstream code
(`conversationState.values.discoveries = discoveryResult.discoveries`)
is untouched.

### 6.2 `src/agents/discovery/utils.ts` (modified)

Append the 4 pure functions from §5.1 to the existing `utils.ts`. No
changes to `extractDiscoveries` or `fixDiscoveryArtifactPaths`.

### 6.3 Prompts

**`src/agents/discovery/prompts.ts` does NOT change in v1.** The LLM
already has the right "merge evidence" guidance
(`prompts.ts:107`: "Preserve all previous evidence — the
evidenceArray grows over time. Only exception ... contradicting
evidence"). The `discoveryStableKey` + Jaccard match is a server-side
concern, not an LLM concern.

If the apply phase finds that the LLM's "removed" signal is too
aggressive (i.e. omits a finding in one cycle and re-introduces it in
the next), we may need to soften step 3 of `persistDiscoveriesToDb`
to skip the "removed" reconciliation. Decision deferred to apply —
start with the spec's "removed if not present" rule.

---

## 7. Worker Integration

Two call sites need the same hook. Both currently set
`conversationState.values.discoveries = discoveryResult.discoveries`
and then call `persistConversationState()`. The v1 change is to ALSO
call `persistDiscoveriesToDb()` BEFORE the JSONB write.

### 7.1 `src/services/queue/workers/deep-research.worker.ts` (line ~957)

**Current code (lines 956-963):**
```typescript
// Update conversation state with discovery results if discovery ran
if (discoveryResult) {
  conversationState.values.discoveries = discoveryResult.discoveries;
  logger.info(
    { jobId: job.id, discoveryCount: discoveryResult.discoveries.length },
    "discoveries_updated",
  );
}
```

**New code (insert 1 new block + keep the existing 2 lines):**
```typescript
// Update conversation state with discovery results if discovery ran
if (discoveryResult) {
  // v1: write-through to research_discoveries BEFORE the JSONB write.
  // Soft-fails internally; cycle must NOT abort on this call.
  try {
    await persistDiscoveriesToDb({
      discoveries: discoveryResult.discoveries,
      conversationId,
      messageId: messageRecord.id,
      threshold: 0.7,
      loggerFields: { jobId: job.id },
    });
  } catch (err) {
    logger.error(
      { err, jobId: job.id, conversationId },
      "discovery_persist_failed_soft_fail",
    );
  }

  conversationState.values.discoveries = discoveryResult.discoveries;
  logger.info(
    { jobId: job.id, discoveryCount: discoveryResult.discoveries.length },
    "discoveries_updated",
  );
}
```

The import is added at the top of the worker:
```typescript
import { persistDiscoveriesToDb } from "../../researchBrain/discoveryPersistence";
```

### 7.2 `src/routes/deep-research/start.ts` (line ~1783)

Identical pattern: same try/catch block inserted BEFORE
`conversationState.values.discoveries = discoveryResult.discoveries;`.

```typescript
if (discoveryResult) {
  // v1: write-through to research_discoveries. Soft-fails.
  try {
    await persistDiscoveriesToDb({
      discoveries: discoveryResult.discoveries,
      conversationId,
      messageId: messageRecord.id,
      threshold: 0.7,
    });
  } catch (err) {
    logger.error(
      { err, conversationId },
      "discovery_persist_failed_soft_fail",
    );
  }

  conversationState.values.discoveries = discoveryResult.discoveries;
  logger.info(
    { discoveryCount: discoveryResult.discoveries.length },
    "discoveries_updated",
  );
}
```

The import is added at the top of `start.ts`:
```typescript
import { persistDiscoveriesToDb } from "../../services/researchBrain/discoveryPersistence";
```

### 7.3 Ordering rationale

`persistDiscoveriesToDb` runs **BEFORE** the JSONB write because:

1. **Causality**: if both succeed, the DB has the canonical record and
   the JSONB has the cache. If both fail, JSONB and DB are unchanged
   and the cycle continues.
2. **Recovery**: if DB succeeds and JSONB fails, the next cycle's
   read-back (or `getDiscoveriesForConversation` endpoint) returns
   the truth from the DB, and the LLM's next pass will repopulate
   the JSONB. The DB is the durable record.
3. **If JSONB succeeds and DB fails**: the JSONB is the truth for
   this iteration; the next cycle's `persistDiscoveriesToDb` will see
   the same LLM output and re-attempt. The DB eventually catches up.

The order is also what the spec says: "DB write runs immediately
after the LLM call, before the JSONB write."

---

## 8. Read Endpoint

### 8.1 Route: `src/routes/deep-research/discoveries.ts` (NEW)

**File pattern:** mirrors `src/routes/deep-research/paper.ts:37-66`.

```typescript
import { Elysia } from "elysia";
import { getConversation } from "../../db/operations";
import { getServiceClient } from "../../db/client";
import { authResolver } from "../../middleware/authResolver";
import type { AuthContext } from "../../types/auth";
import logger from "../../utils/logger";
import { getDiscoveriesForConversation } from "../../services/researchBrain/discoveryPersistence";

const supabase = getServiceClient();

export const deepResearchDiscoveriesRoute = new Elysia().guard(
  {
    beforeHandle: [
      authResolver({ required: true }),
    ],
  },
  (app) =>
    app.get(
      "/api/deep-research/conversations/:conversationId/discoveries",
      discoveriesHandler,
    ),
);

async function discoveriesHandler(ctx: any) {
  const { params, set, request } = ctx;
  const { conversationId } = params;

  const auth = (request as any).auth as AuthContext | undefined;
  const userId = auth?.userId;

  if (!userId) {
    set.status = 401;
    return { error: "Authentication required" };
  }

  if (!conversationId) {
    set.status = 400;
    return { error: "Missing conversationId" };
  }

  // Ownership check: 404 (not 403) on unknown/unowned conversation.
  // This mirrors the pattern in /paper endpoints.
  let conversation;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    logger.warn({ err, conversationId }, "discoveries_get_conversation_failed");
    set.status = 404;
    return { error: "Conversation not found" };
  }

  if (conversation.user_id !== userId) {
    logger.info(
      { conversationId, userId, ownerId: conversation.user_id },
      "discoveries_get_unowned_conversation",
    );
    set.status = 404;
    return { error: "Conversation not found" };
  }

  // Fetch current discoveries + joined evidence.
  let rows;
  try {
    rows = await getDiscoveriesForConversation({ conversationId });
  } catch (err) {
    logger.error(
      { err, conversationId, userId },
      "discoveries_get_db_query_failed",
    );
    set.status = 500;
    return { error: "Failed to fetch discoveries" };
  }

  // Build task-id presence map for the orphan-archived badge.
  // The plan tree is in JSONB; we don't load it here (out of scope for
  // v1 verification). v1 returns `evidence_archived: false` always.
  // PR #2 (read migration) will compute the actual flag from the
  // plan tree at the route layer.
  const response = {
    discoveries: rows.map((row) => ({
      id: row.id,
      discoveryGroupId: row.discovery_group_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      supersedesDiscoveryId: row.supersedes_discovery_id,
      isCurrent: row.is_current,
      supersededAt: row.superseded_at,
      title: row.title,
      claim: row.claim,
      summary: row.summary,
      novelty: row.novelty,
      artifacts: row.artifacts,
      discoveryKey: row.discovery_key,
      reevalStatus: row.reeval_status,
      reevalNotes: row.reeval_notes,
      lastCheckedAt: row.last_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // PR #2 will populate this from the plan tree in JSONB.
      evidence: [] as Array<{
        id: string;
        taskId: string;
        jobId: string | null;
        explanation: string;
        sourceUrl: string | null;
        evidenceArchived: boolean;
        createdAt: string;
      }>,
    })),
  };

  return response;
}
```

### 8.2 Response shape

```json
{
  "discoveries": [
    {
      "id": "uuid",
      "discoveryGroupId": "uuid",
      "conversationId": "uuid",
      "messageId": "uuid | null",
      "supersedesDiscoveryId": "uuid | null",
      "isCurrent": true,
      "supersededAt": "ISO8601 | null",
      "title": "string",
      "claim": "string",
      "summary": "string",
      "novelty": "string | null",
      "artifacts": [/* AnalysisArtifact[] */],
      "discoveryKey": "string",
      "reevalStatus": "none",
      "reevalNotes": null,
      "lastCheckedAt": null,
      "createdAt": "ISO8601",
      "updatedAt": "ISO8601",
      "evidence": [
        {
          "id": "uuid",
          "taskId": "ana-1",
          "jobId": "string | null",
          "explanation": "string",
          "sourceUrl": null,
          "evidenceArchived": false,
          "createdAt": "ISO8601"
        }
      ]
    }
  ]
}
```

v1 returns `evidence: []` for every row. **The route does NOT
populate `evidence_archived` in v1** — that flag's true source is the
plan tree in JSONB, which the v1 route does not read. The flag is in
the DB schema (default `false`) and in the response shape, but the
real computation lands in PR #2 (read migration). This is a
documented v1 limitation: spec scenario "Orphan taskId is flagged
archived" is NOT satisfied by v1's endpoint. Apply-phase documentation
MUST call this out in the spec's "Orphan taskId" scenario
implementation note.

### 8.3 Mount in `src/index.ts`

Insert near the existing deep-research route mounts (line 320-323):

```typescript
import { deepResearchDiscoveriesRoute } from "./routes/deep-research/discoveries";
// ...
.use(deepResearchDiscoveriesRoute) // GET /api/deep-research/conversations/:conversationId/discoveries
```

### 8.4 Why `paper.ts` is the closest mirror

- Both endpoints are auth-gated with `authResolver({ required: true })`
  at the guard level.
- Both have a `userId` ownership check (404, not 403) on the
  conversation.
- Both use `getConversation()` from `src/db/operations.ts`.
- The error-handling pattern (logger + `set.status = N` + JSON body)
  is identical.

`discoveries.ts` is smaller than `paper.ts` (~80 LOC vs ~677 LOC)
because it has no async job queue, no S3 presigned URLs, no LaTeX
compilation, and no sub-resources.

---

## 9. Service Module Wiring

### 9.1 Types

`src/services/researchBrain/types.ts` (modified): add three exported
types matching the DB row shapes.

```typescript
export type ResearchDiscovery = {
  id: string;
  discovery_group_id: string;
  conversation_id: string;
  message_id: string | null;
  supersedes_discovery_id: string | null;
  is_current: boolean;
  superseded_at: string | null;
  title: string;
  claim: string;
  summary: string;
  novelty: string | null;
  artifacts: AnalysisArtifact[];
  discovery_key: string;
  reeval_status: "none" | "pending" | "clean" | "extended" | "contradicted";
  reeval_notes: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ResearchDiscoveryEvidence = {
  id: string;
  discovery_id: string;
  task_id: string;
  job_id: string | null;
  explanation: string;
  source_url: string | null;
  evidence_archived: boolean;
  created_at: string;
};
```

The `evidence[]` join in `getDiscoveriesForConversation` returns rows
typed as `ResearchDiscovery & { evidence: ResearchDiscoveryEvidence[] }`.

### 9.2 Service index re-export

`src/services/researchBrain/index.ts` (modified): add

```typescript
export * from "./discoveryPersistence";
```

This is the same pattern as `contradictionDb`, `compoundAuthority`,
etc. Callers in `src/agents/discovery/index.ts` and
`src/services/queue/workers/deep-research.worker.ts` import from
`../../services/researchBrain/discoveryPersistence` (relative path) or
from the barrel. Either is fine; **prefer the direct module path** to
keep the import tree explicit and to avoid pulling the whole barrel
into the agent hot path.

---

## 10. Test Strategy

Hermetic tests only (no live DB / live LLM). Test file location mirrors
the existing `src/services/researchBrain/__tests__/` folder.

### 10.1 Unit tests: match algorithm

**File:** `src/agents/discovery/__tests__/utils.test.ts` (or new file
`discoveryStableKey.test.ts`).

Tests:

| Test | Input | Expected |
|------|-------|----------|
| `normalizeTokens` basic | `"Compound X binds kinase Y"` | `{compound, binds, kinase}` |
| `normalizeTokens` diacritics | `"Curcumín inhibits NF-κB"` | `{curcumin, inhibits, nfb}` (no κ) |
| `normalizeTokens` short tokens dropped | `"a an the kinase"` | `{the, kinase}` (`a` and `an` < 3 chars) |
| `normalizeTokens` punctuation | `"X, Y; Z!"` | `{, Z!}` after split... actually `{x, y, z}` after stripping non-alphanumeric |
| `jaccard` identical | A={kinase, binding}, B={kinase, binding} | `1.0` |
| `jaccard` disjoint | A={a,b}, B={c,d} | `0.0` |
| `jaccard` partial | A={kinase, binding, vitro}, B={kinase, binding, inhibitor} | `2/4 = 0.5` |
| `jaccard` both empty | A={}, B={} | `1.0` (defined) |
| `jaccard` one empty | A={}, B={x} | `0.0` |
| `discoveryStableKey` determinism | same input twice | same output |
| `discoveryStableKey` debuggable | `"Kinase Binding In Vitro"` | `binding|in|kinase|vitro` (sorted, not hashed) |
| `findMatchingDiscovery` high sim | incoming vs 0.8 Jaccard existing | returns id |
| `findMatchingDiscovery` low sim | incoming vs 0.3 Jaccard existing | returns null |
| `findMatchingDiscovery` empty existing | any incoming | null |
| `findMatchingDiscovery` tie-break | two existing with same score | lowest id wins |
| `findMatchingDiscovery` threshold parameter | threshold=0.5, score=0.6 | returns id (≥ threshold) |

### 10.2 Unit tests: service module

**File:** `src/services/researchBrain/__tests__/discoveryPersistence.test.ts`.

These tests mock the Supabase client. Use the existing
`getServiceClient` mock pattern from `compoundAuthority` tests (read
the test file to see how it's structured; do not duplicate setup
boilerplate).

Tests:

| Test | Setup | Expected |
|------|-------|----------|
| `persistDiscoveriesToDb` happy path | 3 new discoveries, empty DB | 3 inserts, 0 supersedes, 0 removes, no errors |
| `persistDiscoveriesToDb` supersede | 1 existing row, 1 new with Jaccard ≥ 0.7 | 1 insert, 1 supersede, evidence merged |
| `persistDiscoveriesToDb` no match | 1 existing with low Jaccard | 1 insert, fresh `discovery_group_id` |
| `persistDiscoveriesToDb` removed | 1 existing, LLM output omits it | soft-delete old, 0 new inserts |
| `persistDiscoveriesToDb` load fails | mock `.from(...).select(...)` throws | returns empty `PersistResult`, no throw, log emitted |
| `persistDiscoveriesToDb` insert fails | mock insert throws | logs per-row, continues with remaining |
| `persistDiscoveriesToDb` all steps fail | every call throws | returns empty `PersistResult`, no throw |
| `getDiscoveriesForConversation` happy | 2 rows, 3 evidence rows | returns 2 rows with evidence joined |
| `getDiscoveriesForConversation` no rows | empty DB | returns [] |
| `getDiscoveriesForConversation` only current | 3 rows, 1 superseded | returns 2 |

### 10.3 Unit tests: route

**File:** `src/routes/deep-research/__tests__/discoveries.test.ts`.

Mock `getServiceClient`, `getConversation`, and
`getDiscoveriesForConversation`. Mirror the existing
`paper.test.ts` patterns (auth, ownership, error).

Tests:

| Test | Setup | Expected |
|------|-------|----------|
| 200 happy | valid JWT, owned conv, 2 rows | 200, `{ discoveries: [...] }` of length 2 |
| 401 no auth | no JWT | 401 |
| 404 unknown conv | valid JWT, conv does not exist | 404 |
| 404 unowned conv | valid JWT, conv owned by other user | 404 (NOT 403) |
| 500 db query fails | mock throws | 500 |
| 200 empty | owned conv, 0 rows | 200, `{ discoveries: [] }` |

### 10.4 Integration smoke: agent dual-write

**File:** `src/agents/discovery/__tests__/index.test.ts` (new) OR
extend an existing test file. Mock `extractDiscoveries` to return a
fixed `Discovery[]`, mock `persistDiscoveriesToDb` with a spy, call
`discoveryAgent()`, assert the spy was called with the right args.

Tests:

| Test | Setup | Expected |
|------|-------|----------|
| `discoveryAgent` calls `persistDiscoveriesToDb` | mocked extract returns 2 discoveries | spy called with `discoveries=[...], conversationId, messageId, threshold=0.7` |
| `discoveryAgent` continues on persist throw | spy throws | agent's return value still has the discoveries (from `fixedDiscoveries`) |
| `discoveryAgent` still returns `fixedDiscoveries` | normal | return value's `discoveries` is the post-`fixDiscoveryArtifactPaths` array |

### 10.5 Coverage targets

- 100% line coverage on `discoveryPersistence.ts`
- 100% line coverage on the 4 match-algorithm pure functions
- 100% branch coverage on the route's auth + ownership paths
- Integration smoke covers the agent's call shape, not the DB

---

## 11. File-by-File Change Manifest

| File | Status | LOC est. | Notes |
|------|--------|----------|-------|
| `supabase/migrations/<TS>_create_discovery_persistence.sql` | NEW | ~110 | DDL, 3 tables, 8 indexes, 1 trigger, GRANTs |
| `src/services/researchBrain/discoveryPersistence.ts` | NEW | ~200 | Service module |
| `src/services/researchBrain/types.ts` | MODIFIED | +50 | Add `ResearchDiscovery`, `ResearchDiscoveryEvidence` |
| `src/services/researchBrain/index.ts` | MODIFIED | +1 | Re-export |
| `src/agents/discovery/utils.ts` | MODIFIED | +60 | Add 4 pure functions |
| `src/agents/discovery/index.ts` | MODIFIED | +20 | Add `persistDiscoveriesToDb` call |
| `src/routes/deep-research/discoveries.ts` | NEW | ~80 | Read endpoint |
| `src/index.ts` | MODIFIED | +2 | Mount the route |
| `src/services/queue/workers/deep-research.worker.ts` | MODIFIED | +20 | Add dual-write |
| `src/routes/deep-research/start.ts` | MODIFIED | +20 | Add dual-write |
| `src/agents/discovery/__tests__/utils.test.ts` | NEW | ~100 | Pure-function tests |
| `src/services/researchBrain/__tests__/discoveryPersistence.test.ts` | NEW | ~150 | Service tests |
| `src/routes/deep-research/__tests__/discoveries.test.ts` | NEW | ~80 | Route tests |
| `src/agents/discovery/__tests__/index.test.ts` | NEW | ~50 | Agent smoke test |

**Total estimated LOC (production):** ~560 (under the 700 LOC
budget from the proposal).
**Total estimated LOC (tests):** ~380.

---

## 12. Review Workload Guard

The `sdd-tasks` phase must forecast whether this work exceeds the
**400-line review budget** (`additions + deletions`). Estimate:

- Production: ~560 LOC
- Tests: ~380 LOC
- Migration SQL: ~110 LOC

**Forecast:**
- `Decision needed before apply: Yes` (single PR, ~1050 total LOC, above 400)
- `Chained PRs recommended: No` (the work is naturally a single
  unit: schema + service + 1 endpoint + agent hook; slicing it
  would require either a no-op migration or a half-wired
  service module)
- `400-line budget risk: High`

**Recommended delivery strategy:** **`single-pr` with the proposal's
~700 LOC scope, plus tests as a follow-up commit** OR **`auto-chain`:
PR #1 = migration + service module (no agent hook, no route); PR #2 =
agent hook + worker integration; PR #3 = route + tests**. The
`apply` phase MUST consult the orchestrator's cached
`delivery_strategy` and split accordingly.

**Recommended split if chained:**
- PR #1: migration + service module (no callers yet). ~310 LOC.
- PR #2: agent hook + worker integration. ~60 LOC. 0 schema risk.
- PR #3: route + types. ~150 LOC. Safe rollback (unmount route).
- PR #4: tests. ~380 LOC. No prod risk.

---

## 13. Rollback

Mirrors the proposal's rollback plan:

1. **Unmount the route** (PR #3 of the chain): remove
   `.use(deepResearchDiscoveriesRoute)` from `src/index.ts`. No other
   consumer reads from the new tables.
2. **Revert the discovery agent change** (PR #2): remove
   `persistDiscoveriesToDb()` from `index.ts`. JSONB is unchanged
   and remains the source of truth.
3. **Revert the worker + start.ts changes** (PR #2).
4. **Drop the new tables** (manual SQL on the next deploy window):
   ```sql
   DROP TABLE IF EXISTS public.research_discovery_reeval_audit CASCADE;
   DROP TABLE IF EXISTS public.research_discovery_evidence CASCADE;
   DROP TABLE IF EXISTS public.research_discoveries CASCADE;
   ```
   `CASCADE` covers the self-FK on `supersedes_discovery_id`. No
   downstream FK from existing tables points to these.
5. **Migration history is append-only** in the current Supabase
   setup; the migration file stays on disk, but its effects are
   reversed by the DROP.

No destructive ALTER on existing tables; no data migration; no
backfill. Rollback is "stop writing, drop the tables."

---

## 14. Open Items (apply-phase concerns, not blockers)

| Concern | Action |
|---------|--------|
| `evidence_archived` is not populated in v1 | Document in spec as a v1 limitation. PR #2 will populate from the plan tree. |
| LLM "removed" signal may be too aggressive | Apply phase tests with a sample run; if cycle 2 re-introduces a finding dropped in cycle 1, soften step 3 to only soft-delete on LLM-explicit "remove". Start with the spec's rule. |
| `discoveriesUpdated` log is duplicated (worker + start.ts) | Acceptable; the worker and the in-process path are independent code paths. |
| `crypto.randomUUID()` for `discovery_group_id` is fine on Bun | Verified. No need to use a Postgres default. |
| `getDiscoveriesForConversation` does NOT load the plan tree to compute `evidence_archived` | v1 ships with `evidence: []` for every row. See §8.2. |

---

## 15. Definition of Done

- [ ] Migration file lands cleanly; 3 tables + 8 indexes + 1 trigger
      + GRANTs exist.
- [ ] `discoveryPersistence.ts` module exports the 4 required
      functions; `getServiceClient` is the only DB entry point.
- [ ] `persistDiscoveriesToDb` is non-throwing and logs every failure
      with a stable event name.
- [ ] `discoveryStableKey` returns a stable, debuggable normalized
      string; Jaccard default threshold 0.7; threshold is a parameter.
- [ ] Discovery agent (`src/agents/discovery/index.ts`) calls
      `persistDiscoveriesToDb` AFTER `extractDiscoveries` and BEFORE
      the JSONB write; the call is wrapped in try/catch and never
      aborts the cycle.
- [ ] Worker (`deep-research.worker.ts:957-963`) and
      `start.ts:1783-1791` both call `persistDiscoveriesToDb` before
      the JSONB write.
- [ ] `GET /api/deep-research/conversations/:conversationId/discoveries`
      is mounted; auth-gated; 401 on no auth; 404 on unowned
      conversation; 200 with `{ discoveries: [...] }` on success;
      rows ordered by `created_at DESC`; only `is_current = true`
      returned.
- [ ] Forward-compat hooks: `last_checked_at` + `reeval_status` enum
      + `idx_discoveries_reeval_due` partial index +
      `research_discovery_reeval_audit` table all exist and are
      unused in v1.
- [ ] All read consumers (planning, reply, paper) still read from
      JSONB and are unchanged.
- [ ] Tests pass: pure-function, service, route, agent smoke.
- [ ] No `Discovery` type change. No JSONB schema change. No
      destructive ALTER on existing tables.
