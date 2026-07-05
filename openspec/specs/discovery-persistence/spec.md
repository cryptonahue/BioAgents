# Spec: discovery-persistence

## Purpose

Promote the `Discovery` entity from a JSONB blob in
`conversation_states.values` to a first-class, queryable, versioned
resource. v1 ships a write-through from the discovery agent to new
relational tables and one auth-gated read endpoint. v1 is purely
additive: the JSONB cache stays the source of truth for planning,
reply, and paper-generation consumers. Follow-up changes migrate
read paths and add re-evaluation.

## Requirements

### Requirement: Discovery Persistence Capability

The system MUST provide a `discovery-persistence` capability that
dual-writes every discovery into a new relational store AND the
existing JSONB cache, and exposes one verification read endpoint.
Re-evaluation, version-grouped reads, and read-side migration off
JSONB are out of scope for v1.

#### Scenario: Capability is registered for v1

- GIVEN the `discovery-persistence` change is applied
- WHEN a deep-research cycle produces N discoveries
- THEN every discovery is persisted in `research_discoveries`
- AND the same set is written to
  `conversation_states.values.discoveries`
- AND no JSONB read consumer is broken

### Requirement: research_discoveries Table

The system MUST create `research_discoveries`:

```sql
CREATE TABLE research_discoveries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_group_id       UUID NOT NULL,
  conversation_id          UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id               UUID REFERENCES messages(id) ON DELETE SET NULL,
  supersedes_discovery_id  UUID REFERENCES research_discoveries(id) ON DELETE SET NULL,
  is_current               BOOLEAN NOT NULL DEFAULT true,
  superseded_at            TIMESTAMPTZ,
  title                    TEXT NOT NULL,
  claim                    TEXT NOT NULL,
  summary                  TEXT NOT NULL,
  novelty                  TEXT,
  artifacts                JSONB NOT NULL DEFAULT '[]',
  discovery_key            TEXT NOT NULL,
  reeval_status            TEXT NOT NULL DEFAULT 'none'
    CHECK (reeval_status IN ('none','pending','clean','extended','contradicted')),
  reeval_notes             TEXT,
  last_checked_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_discoveries_conv_current
  ON research_discoveries (conversation_id) WHERE is_current;
CREATE INDEX idx_discoveries_group
  ON research_discoveries (discovery_group_id);
CREATE INDEX idx_discoveries_reeval_due
  ON research_discoveries (last_checked_at) WHERE is_current;
```

#### Scenario: New finding inserts a fresh row

- GIVEN a conversation with no current rows
- WHEN the LLM returns one new discovery
- THEN a row is inserted with a fresh `discovery_group_id`,
  `is_current = true`, `supersedes_discovery_id IS NULL`,
  `discovery_key = discoveryStableKey(title, claim)`

#### Scenario: Matched finding supersedes the prior row

- GIVEN a current row R with `discovery_key` K
- WHEN the LLM output contains a discovery whose Jaccard similarity
  with K is ≥ 0.7
- THEN a new row is inserted with
  `supersedes_discovery_id = R.id` and R's `discovery_group_id`
- AND R is updated to `is_current = false`,
  `superseded_at = NOW()` (soft delete, row preserved)

#### Scenario: Removed finding is soft-deleted

- GIVEN a current row R
- WHEN the next cycle's LLM output contains no discovery that
  matches R
- THEN R is updated to `is_current = false`,
  `superseded_at = NOW()` (row preserved)

### Requirement: research_discovery_evidence Table

The system MUST create `research_discovery_evidence`:

```sql
CREATE TABLE research_discovery_evidence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id      UUID NOT NULL REFERENCES research_discoveries(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL,
  job_id            TEXT,
  explanation       TEXT NOT NULL,
  source_url        TEXT,
  evidence_archived BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_discovery_evidence_discovery
  ON research_discovery_evidence (discovery_id);
```

`task_id` references a `PlanTask.id`; no FK (tasks live in JSONB).

#### Scenario: Evidence rows attach to a new discovery

- GIVEN a discovery D with two supporting plan tasks T1, T2
- WHEN `persistDiscoveriesToDb()` runs
- THEN two rows are inserted with
  `discovery_id = D.id`, `task_id` matching T1 and T2,
  `evidence_archived = false`

#### Scenario: Orphan taskId is flagged archived

- GIVEN an evidence row E with `task_id = T1` and
  `evidence_archived = false`
- AND T1's plan iteration is archived
- WHEN the discoveries endpoint reads the conversation
- THEN E is returned with `evidence_archived = true` and the
  historical link is preserved

### Requirement: research_discovery_reeval_audit Table (Forward-Compatible)

The system MUST create the audit table as a forward-compatible hook
for the future re-evaluation change. v1 MUST NOT write to it:

```sql
CREATE TABLE research_discovery_reeval_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id    UUID NOT NULL REFERENCES research_discoveries(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('user_reeval','auto_reeval','llm_supersede','user_dismiss')),
  old_version_id  UUID REFERENCES research_discoveries(id) ON DELETE SET NULL,
  new_version_id  UUID REFERENCES research_discoveries(id) ON DELETE SET NULL,
  outcome         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### Scenario: Audit table is empty in v1

- GIVEN the change is applied
- WHEN a cycle completes
- THEN `research_discovery_reeval_audit` has zero rows
- AND the table accepts inserts without further migration

### Requirement: Discovery Stable Key and Jaccard Match

The system MUST compute a `discoveryStableKey` for every discovery
and match it against current rows using Jaccard similarity (default
threshold 0.7).

- Normalize: lowercase, NFKD, alphanumeric-only, drop tokens shorter
  than 3 chars.
- Sort tokens and join with `|` (stable debuggable string, not a
  hash).
- Score = `|a ∩ b| / |a ∪ b|`.
- Match when best score ≥ threshold.

The threshold MUST be a parameter (default 0.7) so future tuning
needs no spec change.

#### Scenario: High-similarity match supersedes prior row

- GIVEN R: "Compound X binds kinase Y" / "Strong evidence of binding
  affinity in vitro"
- WHEN the LLM returns a near-identical reformulation
- THEN Jaccard ≥ 0.7
- AND a new row is inserted with
  `supersedes_discovery_id = R.id`
- AND R becomes `is_current = false`

#### Scenario: Low-similarity creates a new finding

- GIVEN R about "kinase Y binding"
- WHEN the LLM returns an unrelated pathway finding
- THEN Jaccard < 0.7
- AND a new row gets a fresh `discovery_group_id`
- AND R stays `is_current = true`

#### Scenario: Threshold is parameterizable

- GIVEN a caller passes `threshold = 0.5`
- WHEN best Jaccard = 0.6
- THEN the discovery is treated as a match (0.6 ≥ 0.5)

### Requirement: Write-Through on the Discovery Agent

The discovery agent MUST dual-write every LLM-extracted discovery to
`research_discoveries` AND `conversation_states.values.discoveries`
on every `extractDiscoveries()` call. The DB write MUST run
immediately after the LLM call, before the JSONB write. Cycle MUST
NOT abort on either failure.

The agent's return to the caller (in-memory merged list) MUST be
unchanged in v1.

#### Scenario: Happy-path dual-write

- GIVEN the LLM returns 3 discoveries
- WHEN `extractDiscoveries()` completes
- THEN 3 rows are written to `research_discoveries`
- AND the same 3 are written to
  `conversation_states.values.discoveries`
- AND the worker receives the in-memory list

#### Scenario: DB write failure does not abort

- GIVEN the DB write throws
- WHEN the agent catches the error
- THEN it logs at error level
- AND the JSONB write proceeds
- AND the cycle continues to the next step

#### Scenario: JSONB write failure does not abort

- GIVEN the JSONB write throws
- WHEN the agent catches the error
- THEN it logs at error level
- AND the cycle continues (DB row already persisted)

### Requirement: Read Endpoint — Discoveries for Conversation

The system MUST expose
`GET /api/deep-research/conversations/:conversationId/discoveries`:

- Auth: `authResolver({ required: true })`.
- `401` on missing auth.
- `404` on unknown / unowned conversation.
- `200` with `{ discoveries: ResearchDiscovery[] }` on success.
- Filtered by `is_current = true`, ordered `created_at DESC`.
- Each row includes its joined `evidence[]`.
- v1 does NOT expose `?versions=`, `?since=`, `?group=`.

#### Scenario: Authenticated caller reads current discoveries

- GIVEN C owned by the caller with 3 current rows
- WHEN the endpoint is called with a valid JWT
- THEN `200 OK` with `{ discoveries: [...] }` of length 3
- AND rows ordered by `created_at DESC` with `evidence[]` joined

#### Scenario: Missing auth returns 401

- GIVEN no `Authorization` header
- WHEN the endpoint is called
- THEN the response is `401 Unauthorized`

#### Scenario: Unknown conversation returns 404

- GIVEN an id that does not exist or is not visible to the caller
- WHEN the endpoint is called
- THEN the response is `404 Not Found`
- AND no rows from other conversations are leaked

#### Scenario: Superseded rows are not returned

- GIVEN 5 rows total, 2 with `is_current = false`
- WHEN the endpoint is called
- THEN exactly the 3 current rows are returned

### Requirement: Service Module and Agent Integration

The system MUST provide
`src/services/researchBrain/discoveryPersistence.ts` exporting:

- `persistDiscoveriesToDb(discoveries, conversationId, messageId)`
- `getDiscoveriesForConversation(conversationId)`
- `discoveryStableKey(title, claim)`
- `findMatchingDiscovery(incoming, existing, threshold?)`

The discovery agent MUST call `persistDiscoveriesToDb()` after
`extractDiscoveries()` and before `updateConversationState()`.

#### Scenario: Module exports the required functions

- GIVEN the change is applied
- WHEN the discovery agent module is loaded
- THEN all four functions are importable from the persistence
  module

#### Scenario: Agent calls the persistence helper

- GIVEN the agent is invoked for a cycle
- WHEN the LLM returns discoveries
- THEN `persistDiscoveriesToDb()` is invoked with the discoveries,
  conversation id, and message id
- AND the call happens before the JSONB write

### Requirement: Forward-Compatible Hooks for Re-Evaluation

The system MUST ship these hooks so the future re-evaluation change
needs no destructive migration:

- `last_checked_at` column + partial index
  `idx_discoveries_reeval_due`.
- `reeval_status` enum + CHECK constraint.
- `research_discovery_reeval_audit` table.

v1 MUST NOT write to `last_checked_at`, `reeval_status`,
`reeval_notes`, or the audit table.

#### Scenario: Hooks exist but are unused in v1

- GIVEN the change is applied
- WHEN a cycle completes
- THEN every row has `reeval_status = 'none'` and
  `last_checked_at IS NULL`
- AND the audit table is empty
- AND the partial index on `last_checked_at` is present

## Out of Scope (v1)

Deferred to follow-up changes and MUST NOT be implemented in v1:
read-side migration off JSONB; the user re-evaluation endpoint;
the scheduled re-evaluation worker; version-grouped reads
(`?versions=true`, `?since=`, `?group=`); backfill of legacy
conversations; graph/relationship edges between discoveries; any
UI changes.
