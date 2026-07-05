# Delta for bioprospecting-contradiction-detection

This delta is introduced by the `bioprospecting-review-ui` change.
The existing contradiction-detection contract (table schema,
rule-based pass, LLM-assisted pass, queue trigger, geographic
out-of-scope marker) is preserved unchanged. The delta is
additive: two new admin-only routes for global listing and
activity stats, plus a new helper query in `contradictionDb.ts`
that backs both routes.

## ADDED Requirements

### Requirement: Global Contradictions List Query

The system MUST provide a
`listContradictionsGlobal({ status?, sourceId?, limit, offset })`
helper in `src/services/researchBrain/contradictionDb.ts` that
returns contradictions across all sources, ordered by
`created_at DESC` and paginated. The helper is the data source
for the new admin-only `GET
/api/research-brain/contradictions` route.

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

The existing per-source route
(`GET /api/research-brain/sources/:id/contradictions` or its
equivalent) is preserved unchanged. The new global route is
additive.

#### Scenario: Admin fetches unresolved across all sources

- GIVEN 30 unresolved contradictions across sources S1, S2
- WHEN the admin calls
  `GET /api/research-brain/contradictions?status=unresolved&limit=50&offset=0`
- THEN the response includes up to 50 rows
- AND every row has `resolution_status = 'unresolved'`
- AND `total >= 30`

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
  same six-metric shape documented in
  `bioprospecting-review-ui`.

The full response shape, metric definitions, and clamping
behavior are documented in the
`bioprospecting-review-ui` spec (see "Contradiction Stats
Route"). This delta defines the route registration and
helper; the response contract is shared.

#### Scenario: Admin fetches the stats snapshot

- GIVEN the system is in steady state
- WHEN the admin calls the route
- THEN the response has `today` and `last7d` keys
- AND each window has 6 non-negative integer metrics
- AND `pending = max(0, found - resolved - dismissed)` in
  both windows

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the route is hit
- THEN the response is `401` or `403`

## MODIFIED Requirements

None. The pre-delta contract (table schema, rule-based pass,
LLM-assisted pass, queue trigger, feature flag) is preserved.
The two new routes and the two new helpers are purely
additive.

## REMOVED Requirements

None.
