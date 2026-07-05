# Proposal: Discovery Persistence for Bioprospecting (v1 — Write-Through)

## Intent

Promote the `Discovery` entity from a JSONB blob inside `conversation_states.values` to a first-class, queryable, versioned resource. v1 ships a single PR that adds three new tables, a write-through path on the discovery agent, and one read endpoint used to verify persistence. v1 does NOT migrate existing read consumers (planning, reply, paper generation) off the JSONB cache — that is a follow-up PR. v1 does NOT add the re-evaluation endpoint — also deferred.

Why now: the discovery agent is the only piece of the deep-research cycle that has no durable home. Every cycle re-generates discoveries from scratch; the JSONB is a cache, not a record. We need a stable, FK-addressable, versioned table before we can build re-evaluation, provenance diffing, or "discoveries for this user" queries.

## Scope

### In Scope (v1, single PR, ~700 LOC)

- **3 new tables** in one migration: `research_discoveries`, `research_discovery_evidence`, `research_discovery_reeval_audit`. (See [Schema].)
- **Write-through on the discovery agent** (`src/agents/discovery/index.ts`): after the LLM call returns, dual-write each new/updated discovery to BOTH the new `research_discoveries` table AND `conversation_states.values.discoveries` (the existing JSONB cache).
- **Match helper** `discoveryStableKey()` in `src/agents/discovery/utils.ts` — normalizes `(title + claim)` to a lowercase token set and matches by **Jaccard similarity ≥ 0.7** against existing `discovery_key` rows in the conversation.
- **Desync handling (Q1 = c)**: if DB write succeeds but JSONB write fails (or vice-versa), **log an error and continue the cycle**. The deep-research workflow MUST NOT abort on a desync; the cache will re-sync on the next cycle.
- **1 v1 read endpoint**, auth-gated like the rest of `/api/deep-research/*`:
  - `GET /api/deep-research/conversations/:conversationId/discoveries` — returns the list of current discoveries for the conversation, read from the new table. v1 response is a flat list (no version grouping, no `?versions=true`); per-conversation list only.
- **Orphan evidence (Q4 = a)**: if a discovery references a `taskId` whose plan iteration has been archived, the evidence row renders with a `(task archivado)` badge — we preserve the historical link, we do not silently drop it.
- **Service module** `src/services/researchBrain/discoveryDb.ts` — mirrors the `contradictionDb.ts` / `compoundAuthority.ts` pattern. Exposes `upsertDiscovery()`, `getDiscoveriesForConversation()`, `getDiscoveryEvidence()`, `discoveryStableKey()`.
- **Spec file** `openspec/specs/discovery-persistence/spec.md` (written by sdd-spec).

### Out of Scope (deferred to follow-up changes)

- **Read migration off JSONB** (PR #2) — `src/agents/planning/index.ts`, `src/agents/reply/utils.ts`, `src/services/paper/*`, etc. still read from `conversation_states.values.discoveries`. v1 is write-side only.
- **Re-evaluation endpoint** (deferred; tracked separately) — `POST /api/deep-research/conversations/:conversationId/discoveries/:discoveryId/reevaluate`. The `research_discovery_reeval_audit` table, `last_checked_at` column, `reeval_status` enum, and the `idx_discoveries_reeval_due` partial index are shipped as **forward-compatible hooks** so PR #2 does not require a destructive migration.
- **Scheduled re-eval worker** (deferred) — the partial index on `last_checked_at` exists; the worker does not.
- **Versioned reads** (Q5 deferred) — `?versions=true`, `?since=`, etc. v1 returns a flat list per conversation.
- **Backfill of legacy conversations** — existing JSONB discoveries are NOT migrated to the new table. New cycles write through; old data stays where it is.
- **Graph/relationship edges** between discoveries (e.g. "this contradicts that") — separate change.
- **UI changes** — no frontend work in v1; the endpoint exists for verification and downstream callers.

## Capabilities

### New Capabilities

- `discovery-persistence` (v1): durable, versioned, FK-addressable storage for `Discovery` entities, with a write-through path from the discovery agent and one auth-gated read endpoint. Sets the foundation for re-evaluation and cross-conversation discovery queries.

### Modified Capabilities

- None at the spec level. The existing `Discovery` type in `src/types/core.ts:215-228` is unchanged. The JSONB path on `conversation_states.values.discoveries` is unchanged (still written, still read by all current consumers). v1 is purely additive on the storage side.

## Approach

### Storage (3 tables, 1 migration)

```sql
-- supabase/migrations/<date>_discovery_persistence.sql

CREATE TABLE research_discoveries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_group_id       UUID NOT NULL,                       -- stable across versions of "the same" finding
  conversation_id          UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id               UUID REFERENCES messages(id) ON DELETE SET NULL,  -- iteration that produced this version
  supersedes_discovery_id  UUID REFERENCES research_discoveries(id) ON DELETE SET NULL,
  is_current               BOOLEAN NOT NULL DEFAULT true,
  superseded_at            TIMESTAMPTZ,
  title                    TEXT NOT NULL,
  claim                    TEXT NOT NULL,
  summary                  TEXT NOT NULL,
  novelty                  TEXT,
  artifacts                JSONB NOT NULL DEFAULT '[]',         -- AnalysisArtifact[] (sparse, no FK)
  discovery_key            TEXT NOT NULL,                       -- normalized (title+claim) for matching
  -- Forward-compatible re-eval columns. v1 never writes them; PR #2 will.
  reeval_status            TEXT NOT NULL DEFAULT 'none'
    CHECK (reeval_status IN ('none', 'pending', 'clean', 'extended', 'contradicted')),
  reeval_notes             TEXT,
  last_checked_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "give me the current discoveries for this conversation"
CREATE INDEX idx_discoveries_conv_current
  ON research_discoveries (conversation_id) WHERE is_current;

-- History walk: "show me the chain of versions for this finding"
CREATE INDEX idx_discoveries_group
  ON research_discoveries (discovery_group_id);

-- Forward-compatible: PR #2 worker will scan this partial index.
CREATE INDEX idx_discoveries_reeval_due
  ON research_discoveries (last_checked_at) WHERE is_current;

CREATE TABLE research_discovery_evidence (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id  UUID NOT NULL REFERENCES research_discoveries(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL,                                  -- PlanTask.id (e.g. "ana-1") — no FK, tasks are JSONB
  job_id        TEXT,
  explanation   TEXT NOT NULL,
  source_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_discovery_evidence_discovery
  ON research_discovery_evidence (discovery_id);

-- Forward-compatible: PR #2 will append rows here on every re-eval.
-- v1 leaves it empty; the table exists so we don't need a destructive migration later.
CREATE TABLE research_discovery_reeval_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id    UUID NOT NULL REFERENCES research_discoveries(id) ON DELETE CASCADE,
  triggered_by    TEXT NOT NULL,                                -- 'user_button' | 'scheduled_worker' (v2)
  outcome         TEXT NOT NULL
    CHECK (outcome IN ('clean', 'extended', 'contradicted')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_discovery_reeval_audit_discovery
  ON research_discovery_reeval_audit (discovery_id, created_at DESC);
```

GRANTs mirror the existing pattern: `GRANT ALL TO anon, authenticated, service_role` on all three tables. RLS is conversation-scoped via `conversation_id` ownership, same as `research_bioprospecting_facts`.

### Matching (Q2 = a, Jaccard 0.7)

`discoveryStableKey()`:

```ts
// In src/agents/discovery/utils.ts
export function normalizeTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
     .replace(/[^a-z0-9\s]/g, ' ')
     .split(/\s+/)
     .filter(t => t.length > 2)
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function discoveryStableKey(title: string, claim: string): string {
  // Stable, debuggable string (NOT a hash). Per exploration Q4.
  return [...normalizeTokens(`${title} ${claim}`)].sort().join('|');
}

export function findMatchingDiscovery(
  incoming: { title: string; claim: string },
  existing: Array<{ id: string; discovery_key: string }>,
  threshold = 0.7,
): string | null {
  const incomingTokens = normalizeTokens(`${incoming.title} ${incoming.claim}`);
  let best: { id: string; score: number } | null = null;
  for (const row of existing) {
    const rowTokens = new Set(row.discovery_key.split('|'));
    const score = jaccard(incomingTokens, rowTokens);
    if (!best || score > best.score) best = { id: row.id, score };
  }
  return best && best.score >= threshold ? best.id : null;
}
```

**Default threshold 0.7** (Q2 = a). The function accepts a parameter so future tuning does not need a spec change.

### Write-through (dual-write always)

`src/agents/discovery/index.ts` already returns the merged discoveries to its caller (the deep-research worker), which then persists them via `updateConversationState()`. v1 inserts a `persistDiscoveriesToDb()` call **immediately after** the LLM `extractDiscoveries()` call returns, before the existing JSONB write. The dual-write pattern is:

1. Load current `is_current` discoveries for the conversation from the DB.
2. For each LLM output:
   - Compute `discovery_key`.
   - Run `findMatchingDiscovery()` → either UPDATE the matched row (`is_current` stays, `updated_at` advances, evidence rows merge) or INSERT a new row.
   - If the LLM explicitly removed a previously-seen discovery, set `superseded_at = NOW()` and `is_current = false` (soft delete — never hard delete).
3. **JSONB write still happens** — the existing `updateConversationState()` call is unchanged. v1 is additive.
4. **If DB write fails** (Q1 = c): log error, **continue** to JSONB write, **do not abort the cycle**. JSONB is still authoritative for this iteration; next cycle will reconcile. Symmetric: if DB write succeeds and JSONB fails, log error, **continue** — DB is authoritative; next cycle's read-back from DB will populate JSONB.

The match step is best-effort: if no existing row is above the 0.7 threshold, the incoming discovery is a new finding and gets a fresh row + a new `discovery_group_id`.

### API (Q3 = a, auth-gated)

`GET /api/deep-research/conversations/:conversationId/discoveries`

- Auth: `authResolver({ required: true })` — same pattern as the rest of `/api/deep-research/*`. No role check; JWT-or-anon handled the same way the existing routes do.
- Response: flat list of `is_current = true` rows for the conversation, ordered by `created_at DESC`. Each row includes its `evidence[]` (joined from `research_discovery_evidence`).
- v1 contract is intentionally minimal. No `?versions=`, no `?since=`, no `?group=` (Q5 deferred). Verification-only.
- 404 on unknown conversation (after auth), 401 on no auth, 200 on success.

### Orphan evidence (Q4 = a)

`getDiscoveryEvidence()` joins `research_discovery_evidence` against the in-memory `plan` tree to check whether each `taskId` still exists in any iteration. If not, the response row includes `evidence_archived: true` on that evidence entry. The frontend (out of scope for v1) renders a `(task archivado)` badge. v1 only guarantees the data shape; the badge is a downstream UI concern.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `supabase/migrations/<date>_discovery_persistence.sql` | New | 3 tables, 4 indexes, 1 CHECK constraint, GRANTs |
| `src/services/researchBrain/discoveryDb.ts` | New | `upsertDiscovery`, `getDiscoveriesForConversation`, `getDiscoveryEvidence`, `discoveryStableKey`, `findMatchingDiscovery` |
| `src/services/researchBrain/types.ts` | Modified | Add `ResearchDiscovery`, `ResearchDiscoveryEvidence`, `ResearchDiscoveryReevalAudit` |
| `src/services/researchBrain/index.ts` | Modified | Export the new service |
| `src/agents/discovery/index.ts` | Modified | Call `persistDiscoveriesToDb()` after LLM extraction, before JSONB write |
| `src/agents/discovery/utils.ts` | Modified | Add `normalizeTokens`, `jaccard`, `discoveryStableKey`, `findMatchingDiscovery` |
| `src/routes/deep-research/discoveries.ts` | New | Mounts `GET /conversations/:id/discoveries` |
| `src/index.ts` | Modified | Register the new route module |
| `src/middleware/authResolver.ts` | Untouched | Reuses existing `required: true` pattern |
| `openspec/specs/discovery-persistence/spec.md` | New | Spec written by sdd-spec |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Jaccard 0.7 misses a true match when the LLM heavily rephrases a finding | Med | Threshold is a parameter, tunable without a migration. v2 can swap to embedding cosine without changing the call site. v1 also keeps the JSONB cache, so a missed match degrades to "JSONB has it, DB doesn't yet" — recoverable on next cycle. |
| DB write succeeds, JSONB write fails (Q1) | Low | Log error, continue cycle. JSONB will re-sync from DB on next iteration's read-back. We do not abort the workflow. |
| JSONB write succeeds, DB write fails (Q1) | Low | Log error, continue cycle. Next cycle's `persistDiscoveriesToDb` will see the new LLM output and reconcile (idempotent upsert via `discovery_key`). |
| Discovery agent prompt assumes in-place mutation, not versioned rows | Med | Prompt update is part of v1: "merge evidence from prior version's `supersedes_discovery_id` chain, then create a new row". The match helper handles the row-vs-row decision. |
| Soft-deleted discoveries (`superseded_at`) accumulate forever | Low | Forward-compatible — re-eval PR can prune chains. v1 has no prune path; rows are cheap. |
| Conversation ownership check on the new endpoint | Low | Reuse the existing auth-resolver pattern; the conversation is fetched by id and 404s if not visible to the caller. |
| Existing read consumers (planning, reply, paper) read stale JSONB and ignore DB | High in v2 | **Accepted v1 limitation**: v1 is write-side only. PR #2 migrates read paths. JSONB and DB are kept in sync via dual-write, so there is no data correctness issue — just an architectural debt that v1 documents. |
| Legacy conversations have no DB rows | Low | Documented; no backfill. New cycles write through. |

## Rollback Plan

1. **Remove the route mount** — unregister `discoveries.ts` from `src/index.ts`. Endpoint 404s; no other consumer reads from the new tables.
2. **Revert the discovery agent change** — remove the `persistDiscoveriesToDb()` call from `src/agents/discovery/index.ts`. JSONB write path is unchanged and continues to be the source of truth.
3. **Drop the new tables** — `DROP TABLE IF EXISTS research_discovery_reeval_audit, research_discovery_evidence, research_discoveries CASCADE;`. CASCADE covers the self-FK on `supersedes_discovery_id`. No downstream FK from existing tables points to these.
4. **Drop the migration** — Supabase migration history is append-only in our current deploy; rolling back is a manual SQL step on the next deploy window.

The migration is forward-only on disk; the rollback is "stop writing, drop the tables".

## Dependencies

- `conversations` and `messages` tables (existing).
- `authResolver({ required: true })` (existing).
- Supabase service-role credentials (existing).
- The deep-research worker that calls `extractDiscoveries()` — the write-through hook lives in `src/agents/discovery/index.ts`, which is the single call site the worker uses.

## Success Criteria

- [ ] Migration `discovery_persistence` lands cleanly; 3 tables + 4 indexes + 1 CHECK constraint exist and are GRANTed.
- [ ] Discovery agent performs dual-write on every `extractDiscoveries()` call: DB row + JSONB cache.
- [ ] `discoveryStableKey()` produces a stable, debuggable normalized string; Jaccard 0.7 is the default threshold and is parameterizable.
- [ ] On DB/JSONB desync (Q1), the cycle logs an error and continues; no abort.
- [ ] `GET /api/deep-research/conversations/:conversationId/discoveries` returns the current discoveries for the conversation, auth-gated, 404 on unknown conversation.
- [ ] Orphan `taskId` references (Q4) round-trip with an `evidence_archived: true` flag on the affected evidence row.
- [ ] Forward-compatible hooks in place: `last_checked_at`, `reeval_status` enum, `idx_discoveries_reeval_due` partial index, and `research_discovery_reeval_audit` table — all empty in v1, ready for PR #2.
- [ ] No read-side consumer changed; JSONB remains the source of truth for the planning/reply/paper paths.
- [ ] ~700 LOC total. Single PR.
- [ ] New spec file `openspec/specs/discovery-persistence/spec.md` written by sdd-spec phase.
