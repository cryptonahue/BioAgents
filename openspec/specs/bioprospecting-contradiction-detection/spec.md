# Spec: bioprospecting-contradiction-detection

## Purpose

Detect and surface logical contradictions across bioassay data
sources so operators can resolve them via the dedicated admin
`/admin` page. The capability covers the
`research_bioprospecting_contradictions` table, a rule-based
detection pass, an LLM-assisted detection pass, a queue trigger
on corpus-ingestion completion, a feature flag, and a global
admin-only API surface (list + stats) that backs the Contras and
Stats tabs of the admin page.

The detection contract (table schema, rule-based pass,
LLM-assisted pass, queue trigger, feature flag) is preserved
unchanged. The rev (added by `bioprospecting-review-ui`) is
purely additive: two new admin-only routes for global listing
and activity stats, a `get_contradiction_stats` Postgres
function, and the new `getContradictionStats` /
`listContradictionsGlobal` helpers in
`src/services/researchBrain/contradictionDb.ts` that back those
routes.

Geographic conflict detection is deferred. Real-time streaming
contradiction detection is deferred. Both remain out of scope
for v1.

## Requirements

### Requirement: Contradiction Detection Capability

The system MUST provide a `bioprospecting-contradiction-detection`
capability that detects logical contradictions across bioassay
data sources to prevent downstream analysis errors and improve
data reliability.

**Trigger**: Automatic after corpus ingestion completes
(triggered by job queue event
`bioprospecting:extraction:completed`).

**Feature Flag**: `BIOPROSPECTING_CONTRADICTION_DETECTION=true`
enables BOTH rule-based AND LLM-assisted passes. When `false`,
no contradiction detection runs.

#### Scenario: Contradiction detection disabled

- GIVEN `BIOPROSPECTING_CONTRADICTION_DETECTION=false`
- WHEN corpus ingestion completes
- THEN no contradiction detection jobs are enqueued
- AND no rows are written to `research_bioprospecting_contradictions`

#### Scenario: Contradiction detection enabled via flag

- GIVEN `BIOPROSPECTING_CONTRADICTION_DETECTION=true`
- WHEN corpus ingestion completes for a source
- THEN a `ContradictionDetectionJobData` job is enqueued to the
  `bioprospecting` queue
- AND rule-based detection runs
- AND LLM-assisted detection runs (if LLM provider available)

### Requirement: research_bioprospecting_contradictions Table

The system MUST create a
`research_bioprospecting_contradictions` table with the
following schema:

```sql
CREATE TABLE IF NOT EXISTS public.research_bioprospecting_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES public.research_sources(id) ON DELETE CASCADE,
  source_fact_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  conflicting_fact_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  contradiction_type TEXT NOT NULL,
  evidence_pack JSONB NOT NULL DEFAULT '{}',
  rule_version TEXT,
  llm_version TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'unresolved',
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Indexes:**

```sql
CREATE INDEX IF NOT EXISTS idx_contradictions_source ON public.research_bioprospecting_contradictions (source_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_a ON public.research_bioprospecting_contradictions (source_fact_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_b ON public.research_bioprospecting_contradictions (conflicting_fact_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_type ON public.research_bioprospecting_contradictions (contradiction_type);
CREATE INDEX IF NOT EXISTS idx_contradictions_status ON public.research_bioprospecting_contradictions (resolution_status);
```

The full column semantics and evidence-pack JSON contract are
defined in the originating
`bioprospecting-contradiction-detection` change (see
`openspec/changes/bioprospecting-contradiction-detection/specs/bioprospecting-contradiction-detection/spec.md`).

#### Scenario: Store measurement_direction contradiction

- GIVEN two facts from different sources describing the same
  compound-target interaction
- WHEN fact A has `measurement_direction: agonist` and fact B
  has `measurement_direction: antagonist`
- THEN a row is inserted with `contradiction_type:
  measurement_direction`
- AND `evidence_pack` contains both facts' values and provenance

#### Scenario: Store relation_type contradiction

- GIVEN two facts with conflicting `relation_type` values for the
  same target
- WHEN the detection pass runs
- THEN a row is inserted with `contradiction_type: relation_type`
- AND `resolution_status` defaults to `'unresolved'`

### Requirement: Global Contradictions List Query

The system MUST provide a
`listContradictionsGlobal({ status?, sourceId?, limit, offset })`
helper in `src/services/researchBrain/contradictionDb.ts` that
returns contradictions across all sources, ordered by
`created_at DESC` and paginated. The helper is the data source
for the new admin-only
`GET /api/research-brain/contradictions` route.

**Behavior:**

- The helper accepts an optional `status` filter
  (`'unresolved' | 'resolved' | 'dismissed'`), an optional
  `sourceId` UUID filter, a `limit` (default `50`, max `200`),
  and an `offset` (default `0`).
- The helper returns
  `{ rows: Contradiction[], total: number, limit: number, offset:
  number }`. `total` is the unpaginated `COUNT(*)` for the same
  filter combination.
- The helper issues at most two queries: a `COUNT(*)` for
  `total` and a `SELECT ... ORDER BY created_at DESC LIMIT ...
  OFFSET ...` for the page.
- The helper is read-only; it MUST NOT insert, update, or
  delete rows in `research_bioprospecting_contradictions`.

The helper extends the existing `contradictionDb.ts` module
(which today exposes only per-source queries and the
`runContradictionDetectionForSource` entry point). It MUST NOT
replace or remove the per-source query — that surface is still
used by the per-source evidence pack endpoint.

#### Scenario: Helper returns paged rows and total

- GIVEN 100 contradictions across all sources
- WHEN `listContradictionsGlobal({ limit: 20, offset: 40 })` runs
- THEN `rows.length <= 20`
- AND `rows` is ordered by `created_at DESC`
- AND `total = 100`

#### Scenario: Status filter narrows the helper result

- GIVEN 30 unresolved and 70 resolved contradictions
- WHEN `listContradictionsGlobal({ status: 'unresolved', limit: 50,
  offset: 0 })` runs
- THEN `rows.length <= 30`
- AND every row has `resolution_status = 'unresolved'`
- AND `total = 30`

#### Scenario: SourceId filter narrows the helper result

- GIVEN contradictions across 3 sources S1, S2, S3
- WHEN `listContradictionsGlobal({ sourceId: 'S2' })` runs
- THEN every returned row has `source_id = S2`
- AND `total` reflects only S2's contradictions

### Requirement: Contradiction Stats Query

The system MUST provide a `getContradictionStats()` helper in
`src/services/researchBrain/contradictionDb.ts` that returns
the activity snapshot for the new admin-only
`GET /api/research-brain/contradictions/stats` route. The shape
extends the contradiction metrics with the dedup metrics in the
same response object (Q4 decision: Contras + Dedup in one
card).

**Behavior:**

- The helper runs at most eight `COUNT(*)` queries (one per
  metric × window). It does NOT cache results in v1.
- The helper returns
  `{ today: StatsWindow, last7d: StatsWindow }` where
  `StatsWindow = { found, resolved, dismissed, pending, merges,
  unmerges }`.
- `pending` is computed in code as
  `max(0, found - resolved - dismissed)` and is never
  negative.
- The dedup metrics (`merges`, `unmerges`) are issued against
  `research_bioprospecting_fact_edges` (not against
  `research_bioprospecting_dedup_audit`) so the metric counts
  are not skewed by audit-only rows.

**Stats response shape:**

```json
{
  "today":  { "found": 12, "resolved": 3, "dismissed": 1, "pending": 8, "merges": 47,  "unmerges": 2 },
  "last7d": { "found": 124, "resolved": 38, "dismissed": 12, "pending": 74, "merges": 311, "unmerges": 18 }
}
```

**Metric definitions:**

- `found` — `COUNT(contradictions WHERE created_at >= window)`.
- `resolved` — `COUNT(contradictions WHERE resolution_status =
  'resolved' AND resolved_at >= window)`.
- `dismissed` — `COUNT(contradictions WHERE resolution_status =
  'dismissed' AND resolved_at >= window)`.
- `pending` — `found - resolved - dismissed` (computed in code
  after the SQL aggregation; MUST NOT be negative — clamped to
  `0`).
- `merges` — `COUNT(fact_edges WHERE merged_at >= window AND
  is_active = true)`.
- `unmerges` — `COUNT(fact_edges WHERE unmerged_at >= window)`.

The `today` window is `created_at >= NOW() - INTERVAL '1 day'`.
The `last7d` window is `created_at >= NOW() - INTERVAL '7 days'`.
The endpoint issues at most eight `COUNT(*)` queries (one per
metric × window) and MUST NOT cache the response in v1.

#### Scenario: Helper returns both windows

- GIVEN a populated `research_bioprospecting_contradictions`
  table
- WHEN `getContradictionStats()` runs
- THEN the response has the keys `today` and `last7d`
- AND each window has exactly the keys `found`, `resolved`,
  `dismissed`, `pending`, `merges`, `unmerges`

#### Scenario: Pending is clamped to zero on drift

- GIVEN a window where `resolved + dismissed = 20` and
  `found = 15` (clock-skew anomaly)
- WHEN the helper computes `pending`
- THEN `pending = 0` for that window
- AND the underlying `found`, `resolved`, `dismissed` counts
  are unchanged

### Requirement: Admin-Only Global List Route

The system MUST expose
`GET /api/research-brain/contradictions` as an
admin-only, paginated, filterable list of all contradictions
across all sources. The route is added to
`src/routes/research-brain.ts` and calls the new
`listContradictionsGlobal` helper from
`src/services/researchBrain/contradictionDb.ts`.

**Behavior:**

- The route is registered behind
  `authResolver({ required: true, role: 'admin' })`.
- The route accepts `status`, `sourceId`, `limit`, and
  `offset` query params with the same semantics as the
  helper.
- The route echoes `limit` and `offset` in its response
  (using the clamped values, not the raw requested values)
  so the client can render a "page N of M" footer.
- `limit` defaults to `50`, clamped server-side to a
  maximum of `200`. Negative `offset` is treated as `0`;
  non-integer values are rejected with `400`.

The existing per-source route
(`GET /api/research-brain/sources/:id/contradictions` or its
equivalent) is preserved unchanged. The new global route is
additive.

**Response (200):**

```json
{
  "contradictions": [
    {
      "id": "uuid",
      "sourceId": "uuid",
      "sourceFactId": "uuid",
      "conflictingFactId": "uuid",
      "contradictionType": "measurement_direction | relation_type | ...",
      "evidencePack": { "...": "..." },
      "ruleVersion": "1.0" | null,
      "llmVersion": "1.0" | null,
      "resolutionStatus": "unresolved",
      "resolvedBy": "uuid" | null,
      "resolvedAt": "iso8601" | null,
      "createdAt": "iso8601",
      "updatedAt": "iso8601"
    }
  ],
  "total": 0,
  "limit": 50,
  "offset": 0
}
```

#### Scenario: Admin fetches unresolved across all sources

- GIVEN 30 unresolved contradictions across sources S1, S2
- WHEN the admin calls
  `GET /api/research-brain/contradictions?status=unresolved&limit=50&offset=0`
- THEN the response includes up to 50 rows
- AND every row has `resolution_status = 'unresolved'`
- AND `total >= 30`

#### Scenario: Status filter narrows the list

- GIVEN contradictions with mixed `resolution_status` values
- WHEN `GET /api/research-brain/contradictions?status=resolved`
  is called
- THEN every row in `contradictions[]` has
  `resolutionStatus = 'resolved'`
- AND `total` reflects the filtered count, not the
  unfiltered count

#### Scenario: Pagination respects limit and offset

- GIVEN 75 unresolved contradictions
- WHEN
  `GET /api/research-brain/contradictions?status=unresolved&limit=20&offset=40`
  is called
- THEN `contradictions[]` has at most 20 rows
- AND `total = 75`
- AND `limit = 20` and `offset = 40` are echoed back

#### Scenario: Default list returns unresolved first

- GIVEN 100 contradictions in the table across all statuses
- WHEN `GET /api/research-brain/contradictions` is called
  with no query params
- THEN the response includes up to 50 rows
- AND `total >= 50`
- AND `limit = 50` and `offset = 0` are echoed back

#### Scenario: Oversized limit is clamped

- GIVEN a call with `?limit=10000`
- WHEN the route runs
- THEN the SQL `LIMIT` is `200`
- AND the response echoes `limit: 200` (the effective limit,
  not the requested one)

#### Scenario: Non-integer limit is rejected

- GIVEN a call with `?limit=abc`
- WHEN the route runs
- THEN the response is `400 Bad Request`
- AND no rows are returned

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the route is hit
- THEN the response is `401` or `403`
- AND no contradiction data is returned

### Requirement: Admin-Only Contradiction Stats Route

The system MUST expose
`GET /api/research-brain/contradictions/stats` as an
admin-only endpoint that returns the activity snapshot for
the Stats tab. The route is added to
`src/routes/research-brain.ts` and calls the new
`getContradictionStats` helper.

**Behavior:**

- The route is registered behind
  `authResolver({ required: true, role: 'admin' })`.
- The route takes no query params.
- The route returns
  `{ today: StatsWindow, last7d: StatsWindow }` with the
  same six-metric shape documented above (see "Contradiction
  Stats Query").

#### Scenario: Admin fetches the stats snapshot

- GIVEN the system is in steady state
- WHEN the admin calls the route
- THEN the response has `today` and `last7d` keys
- AND each window has 6 non-negative integer metrics
- AND `pending = max(0, found - resolved - dismissed)` in
  both windows

#### Scenario: Pending is non-negative even with bookkeeping drift

- GIVEN a clock anomaly where `resolved + dismissed > found`
  in a window
- WHEN the stats route runs
- THEN `pending` is clamped to `0` in both windows
- AND the underlying `found`, `resolved`, `dismissed` counts
  are returned unaltered

#### Scenario: All six metrics surface in the stats card

- GIVEN an admin calls the route
- WHEN the response is received
- THEN `today` and `last7d` each contain exactly the keys
  `found`, `resolved`, `dismissed`, `pending`, `merges`,
  `unmerges`
- AND all 12 numbers are non-negative integers

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the route is hit
- THEN the response is `401` or `403`
