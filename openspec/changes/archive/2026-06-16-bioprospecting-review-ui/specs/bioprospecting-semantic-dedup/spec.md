# Delta for bioprospecting-semantic-dedup

This delta is introduced by the `bioprospecting-review-ui`
change. The existing `bioprospecting-fact-dedup` contract
(identity-key normalization, edge table, inline merge,
backfill, search filter, lineage helpers) is preserved
unchanged. The delta is additive: three soft-delete columns
on `research_bioprospecting_fact_edges`, a new
`research_bioprospecting_dedup_audit` table, two new admin-only
API routes, two new service helpers, and a read-path filter
update on the existing `getDuplicateGroup` /
`findMergedFactIds` helpers so unmerged edges are invisible
to the lineage query layer.

The capability here is named `bioprospecting-semantic-dedup`
to match the change folder, but the underlying domain object is
the same fact-edge lineage owned by the
`bioprospecting-fact-dedup` capability. The
`research_bioprospecting_fact_edges` table and the
`getDuplicateGroup` / `findMergedFactIds` helpers are extended
in place; the new columns and the new audit table are added
without removing or weakening any existing constraint.

## ADDED Requirements

### Requirement: Soft-Delete Columns on fact_edges

The system MUST add three soft-delete columns to
`research_bioprospecting_fact_edges` so an unmerge is
reversible and does not require touching the `identity_key`
partial unique index on `research_bioprospecting_facts`.

**Schema:**

```sql
ALTER TABLE public.research_bioprospecting_fact_edges
  ADD COLUMN IF NOT EXISTS is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS unmerged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unmerged_by TEXT;

CREATE INDEX IF NOT EXISTS idx_dedup_edge_active_canonical
  ON public.research_bioprospecting_fact_edges (canonical_fact_id, is_active);
```

**Column semantics:**

- `is_active` — defaults to `TRUE` for all new and existing
  edges. The unmerge flow sets it to `FALSE`. Existing rows
  backfill to `TRUE` via the `DEFAULT TRUE` clause on
  `ALTER TABLE ADD COLUMN`.
- `unmerged_at` — server timestamp of the unmerge; NULL on
  un-touched edges.
- `unmerged_by` — TEXT column for the admin's identifier;
  NULL on un-touched edges.

The unmerge is a soft-delete (`is_active = false`) rather
than a hard delete. The `merged_fact_id` row in
`research_bioprospecting_facts` retains its
`merged_into_fact_id` cache value; a future reconciliation
job can clear stale cache rows. The `identity_key` partial
unique index is NOT touched, so the previously-merged fact
remains eligible to re-merge into a different canonical via
the normal inline-merge path.

#### Scenario: New edges default to is_active = true

- GIVEN the migration has run
- WHEN the inline merge in
  `replaceBioprospectingFactsForSource` inserts a new edge
- THEN the new edge has `is_active = true`
- AND `unmerged_at` and `unmerged_by` are NULL

#### Scenario: Existing edges backfill to is_active = true

- GIVEN the migration runs against a table with 100
  pre-existing edge rows
- WHEN the `ALTER TABLE` completes
- THEN all 100 rows have `is_active = true`
- AND no row is hidden from the existing
  `getDuplicateGroup` / `findMergedFactIds` queries

### Requirement: research_bioprospecting_dedup_audit Schema

The system MUST create a `research_bioprospecting_dedup_audit`
table that records every unmerge event for a bioprospecting
fact edge. The table mirrors the existing
`compound_authority_audit` pattern.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.research_bioprospecting_dedup_audit (
  id                  BIGSERIAL PRIMARY KEY,
  fact_id             UUID NOT NULL
                        REFERENCES public.research_bioprospecting_facts(id)
                        ON DELETE CASCADE,
  event_type          TEXT NOT NULL
                        CHECK (event_type IN ('merge', 'unmerge')),
  old_canonical_id    UUID
                        REFERENCES public.research_bioprospecting_facts(id)
                        ON DELETE SET NULL,
  new_canonical_id    UUID
                        REFERENCES public.research_bioprospecting_facts(id)
                        ON DELETE SET NULL,
  user_id             TEXT,
  reason              TEXT,
  reason_category     TEXT
                        CHECK (reason_category IN (
                          'false_positive',
                          'different_compound',
                          'measurement_error',
                          'other'
                        )),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dedup_audit_fact_created
  ON public.research_bioprospecting_dedup_audit (fact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dedup_audit_created
  ON public.research_bioprospecting_dedup_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dedup_audit_reason_category
  ON public.research_bioprospecting_dedup_audit (reason_category)
  WHERE reason_category IS NOT NULL;
```

The full column semantics are documented in the
`bioprospecting-review-ui` spec (see
"research_bioprospecting_dedup_audit Schema"). This delta
defines the table ownership and its relationship to the
edge table.

#### Scenario: Unmerge writes one audit row

- GIVEN an active edge `(canonical_fact_id = C, merged_fact_id = M)`
- WHEN the unmerge runs
- THEN a row is inserted into
  `research_bioprospecting_dedup_audit` with
  `event_type = 'unmerge'`, `fact_id = M`,
  `old_canonical_id = C`, `new_canonical_id = NULL`,
  `reason_category` set to the dropdown value
- AND the audit insert is part of the same transaction as
  the edge soft-delete (or a compensating audit row is
  written on rollback)

#### Scenario: Inline merge does not write an audit row

- GIVEN the inline merge in
  `replaceBioprospectingFactsForSource` runs and inserts
  a new edge
- WHEN the merge completes
- THEN no row is written to
  `research_bioprospecting_dedup_audit`
- AND the inline merge path is unchanged (the `'merge'`
  enum value is reserved for a future change)

### Requirement: Lineage Helpers Filter On is_active

The system MUST update the existing `getDuplicateGroup` and
`findMergedFactIds` helpers in
`src/services/researchBrain/db.ts` to add `WHERE is_active =
true` to every query that reads from
`research_bioprospecting_fact_edges`. After the update, an
unmerged edge is invisible to the lineage query layer.

**Behavior:**

- `getDuplicateGroup(factId)` MUST join only active edges
  when resolving the duplicate group. The returned
  `merged[]` array MUST NOT include a previously-unmerged
  fact.
- `findMergedFactIds(factIds)` MUST return only the
  `merged_fact_id` values that appear in an active edge.
  Unmerged facts MUST NOT be in the returned set.
- The update is purely additive to the WHERE clause; the
  function signatures and return shapes are unchanged.
- The search filter (the `includeDuplicates` flag on
  `searchBioprospectingFacts`) is unchanged. A fact whose
  edge is unmerged becomes a standalone canonical and is
  surfaced by the default search the same way any other
  canonical is.

#### Scenario: Unmerged sibling is not in the duplicate group

- GIVEN an edge `(canonical = C, merged = M)` was
  unmerged, so the edge row has `is_active = false`
- AND a new edge `(canonical = C', merged = M')` is
  active
- WHEN `getDuplicateGroup(M)` is called (M is
  unmerged)
- THEN the result is `null` (M is no longer part of any
  active duplicate group)
- AND when `getDuplicateGroup(C)` is called
- THEN the result is `{ canonical: C, merged: [] }` (no
  active edges for C)

#### Scenario: Unmerged fact is not in findMergedFactIds

- GIVEN facts `[A, B, C, D]` where the edge for B was
  unmerged (so B is no longer a `merged_fact_id` in an
  active edge)
- AND D is still merged into some canonical
- WHEN `findMergedFactIds([A, B, C, D])` runs
- THEN the result is `{D}` (only D, not B)

#### Scenario: Active edge still resolves the group

- GIVEN an edge `(canonical = C, merged = M)` with
  `is_active = true`
- WHEN `getDuplicateGroup(M.id)` is called
- THEN the result is `{ canonical: C, merged: [M] }` —
  unchanged from the pre-delta behavior

### Requirement: listRecentMergeEvents Service Helper

The system MUST provide a `listRecentMergeEvents({ limit,
offset, since })` helper in
`src/services/researchBrain/db.ts` that returns recent
merge and unmerge events on bioprospecting fact edges. The
helper is the data source for the new admin-only
`GET /api/research-brain/dedup/events` route.

**Behavior:**

- The helper accepts `limit` (default `50`, max `200`),
  `offset` (default `0`), and `since` (`'24h' | '7d' |
  '30d' | 'all'`, default `'7d'`).
- The helper returns
  `{ events: RecentDedupEvent[] }` where
  `RecentDedupEvent` includes
  `{ eventId, factId, canonicalId, mergedFactId, matchRule,
  mergedAt, unmergedAt?, unmergedBy?, isActive, reasonCode?,
  reasonDetail? }`.
- Each event is a row from
  `research_bioprospecting_fact_edges` left-joined to the
  most recent `research_bioprospecting_dedup_audit` row
  for that `fact_id` (NULL when no unmerge audit exists).
- The helper includes BOTH `is_active = true` and
  `is_active = false` edges; the client filters to
  whichever view it wants.
- The helper is read-only; it MUST NOT insert, update, or
  delete rows.

#### Scenario: Default window is last 7 days

- GIVEN merge events across the last 30 days
- WHEN `listRecentMergeEvents({})` runs
- THEN only events with
  `merged_at >= NOW() - INTERVAL '7 days'` are returned
- AND rows are ordered by `merged_at DESC`

#### Scenario: All-time window returns everything

- GIVEN merge events older than 30 days
- WHEN `listRecentMergeEvents({ since: 'all' })` runs
- THEN those events are included (paginated)

#### Scenario: Active and unmerged edges both surface

- GIVEN a mix of active merges and unmerged edges
- WHEN the helper runs
- THEN both `is_active = true` and `is_active = false`
  edges are returned
- AND the `reasonCode` and `reasonDetail` come from the
  most recent unmerge audit row for each fact

### Requirement: unmergeFact Service Helper

The system MUST provide an `unmergeFact({ factId, userId,
reason, reasonCategory })` helper in
`src/services/researchBrain/db.ts` that soft-deletes the
active edge for a merged fact and writes a corresponding
audit row. The helper is the data source for the new
admin-only `POST /api/research-brain/dedup/:factId/unmerge`
route.

**Behavior:**

- The helper looks up the active edge
  (`merged_fact_id = factId AND is_active = true`).
- If no active edge is found, the helper throws a
  domain error
  `NoActiveEdgeError` (the route layer maps this to
  `409 Conflict`).
- If multiple active edges are found (defensive — the
  schema permits this), the helper throws
  `AmbiguousEdgeError` (the route layer also maps this to
  `409 Conflict`).
- The helper updates the edge row to
  `is_active = false, unmerged_at = NOW(),
  unmerged_by = userId` in a single SQL statement with
  the `WHERE is_active = true` clause as the CAS guard.
- The helper inserts the audit row in the same
  transaction. If the audit insert fails, the edge
  update is rolled back.
- The helper returns
  `{ edge: UpdatedEdge, audit: AuditRow }`.

The full validation contract (404 for missing fact, 400
for invalid `reasonCategory`, 409 for missing/ambiguous
active edge) is documented in the `bioprospecting-review-ui`
spec. This delta defines the helper and its error shape;
the route layer maps the errors to HTTP status codes.

#### Scenario: Happy-path unmerge updates edge and writes audit

- GIVEN an active edge `(canonical = C, merged = M)`
  with `is_active = true`
- WHEN `unmergeFact({ factId: M, userId: 'admin-1',
  reason: 'wrong species', reasonCategory:
  'false_positive' })` runs
- THEN the edge row is updated to
  `is_active = false, unmerged_at = NOW(),
  unmerged_by = 'admin-1'`
- AND a row is inserted into
  `research_bioprospecting_dedup_audit` with
  `event_type = 'unmerge'`, `fact_id = M`,
  `old_canonical_id = C`, `new_canonical_id = NULL`,
  `user_id = 'admin-1'`, `reason = 'wrong species'`,
  `reason_category = 'false_positive'`
- AND the helper returns
  `{ edge, audit }`

#### Scenario: No active edge throws NoActiveEdgeError

- GIVEN a fact M with no active edge
- WHEN `unmergeFact({ factId: M, ... })` runs
- THEN the helper throws `NoActiveEdgeError`
- AND no edge is updated
- AND no audit row is written

#### Scenario: Concurrent unmerge is rejected by CAS

- GIVEN two admins call `unmergeFact({ factId: M, ... })`
  concurrently
- WHEN the second call's UPDATE runs with
  `WHERE is_active = true`
- THEN zero rows are affected
- AND the second call throws `NoActiveEdgeError`
- AND only the first call's audit row exists

### Requirement: Admin-Only Dedup Events Route

The system MUST expose
`GET /api/research-brain/dedup/events` as an admin-only,
paginated, time-windowed list of recent merge and unmerge
events. The route is added to `src/routes/research-brain.ts`
and calls the new `listRecentMergeEvents` helper.

**Behavior:**

- The route is registered behind
  `authResolver({ required: true, role: 'admin' })`.
- The route accepts `limit`, `offset`, and `since` query
  params with the same semantics as the helper.
- The route returns
  `{ events: RecentDedupEvent[] }`.

The full response shape is documented in the
`bioprospecting-review-ui` spec. This delta defines the
route registration and helper binding; the response contract
is shared.

#### Scenario: Admin fetches last 7 days

- GIVEN the system is in steady state
- WHEN the admin calls
  `GET /api/research-brain/dedup/events?limit=50&offset=0`
  (no `since`)
- THEN the response returns the 50 most recent events in
  the last 7 days
- AND the rows are ordered by `merged_at DESC`

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the route is hit
- THEN the response is `401` or `403`
- AND no event data is returned

### Requirement: Admin-Only Unmerge Route

The system MUST expose
`POST /api/research-brain/dedup/:factId/unmerge` as an
admin-only mutation that soft-deletes the active edge for
a merged fact and writes a corresponding audit row. The
route is added to `src/routes/research-brain.ts` and calls
the new `unmergeFact` helper.

**Behavior:**

- The route is registered behind
  `authResolver({ required: true, role: 'admin' })`.
- The route parses `reasonCode` and `reasonDetail` from
  the request body, validates `reasonCode` against the
  enum, and forwards both to the helper.
- The route maps helper errors to HTTP status codes:
  - `NoActiveEdgeError` / `AmbiguousEdgeError` → `409`
  - `InvalidReasonCategoryError` → `400`
  - `FactNotFoundError` → `404`
- The route returns
  `{ edge: UpdatedEdge, audit: AuditRow }` on `200`.

The full validation contract, response shape, and
authorization behavior are documented in the
`bioprospecting-review-ui` spec. This delta defines the
route registration and error mapping.

#### Scenario: Admin unmerges with reasonCategory

- GIVEN an active edge `(canonical = C, merged = M)`
- WHEN the admin POSTs to
  `/api/research-brain/dedup/M/unmerge` with body
  `{ reasonCode: 'different_compound', reasonDetail:
  'Limonene and pinene' }`
- THEN the response is `200`
- AND the response body includes the updated `edge` and
  the new `audit` row

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the route is hit
- THEN the response is `401` or `403`
- AND no edge is updated
- AND no audit row is written

## MODIFIED Requirements

### Requirement: read-only Lineage Helpers (modified)

The `findMergedFactIds` and `getDuplicateGroup` helpers
MUST add `WHERE is_active = true` to every read of
`research_bioprospecting_fact_edges` so an unmerged edge
is invisible to the lineage query layer. The function
signatures and return shapes are unchanged. The pre-delta
scenarios (subset return, group resolution from either
side, null for standalone facts) continue to hold for
ACTIVE edges only.

This is a clarification of the existing requirement: the
two helpers are still read-only, still exported from
`src/services/researchBrain/db.ts`, and still surface
dedup lineage. The only behavioral change is that an
unmerged edge is no longer visible to these helpers.

#### Scenario: Unmerged edge is invisible to findMergedFactIds

- GIVEN facts `[A, B, C, D]` where the edge for B was
  unmerged
- AND D is still merged into some canonical via an
  active edge
- WHEN `findMergedFactIds([A, B, C, D])` runs
- THEN the result is `{D}` (only D)
- AND B is not in the returned set, even though B's
  `research_bioprospecting_facts.merged_into_fact_id`
  cache is still populated

#### Scenario: Unmerged edge is invisible to getDuplicateGroup

- GIVEN an edge `(canonical = C, merged = M)` was
  unmerged, so the edge row has `is_active = false`
- WHEN `getDuplicateGroup(M.id)` runs
- THEN the result is `null` (M is not part of any active
  duplicate group)
- AND no error is raised — the helper returns `null` to
  signal "no active edges reference this fact"

#### Scenario: Active edge still resolves the group

- GIVEN an edge `(canonical = C, merged = M)` with
  `is_active = true`
- WHEN `getDuplicateGroup(M.id)` runs
- THEN the result is `{ canonical: C, merged: [M] }` —
  identical to the pre-delta behavior

## REMOVED Requirements

None.
