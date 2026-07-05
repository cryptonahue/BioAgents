# Spec: bioprospecting-review-ui

## Purpose

Provide operators and admins with a single, first-class surface to
triage the three detection systems wired into the Research Brain:
fact-level review, contradiction detection, and semantic dedup. The
backend for contradictions and dedup already exists; this capability
ships the dedicated `/admin` page and its four supporting backend
routes so operators can answer "what needs my attention?" without
knowing source IDs or calling APIs by hand.

The capability gates everything on the JWT `role === "admin"` claim —
both the API routes and the sidebar nav button — and follows the
existing `authResolver({ required: true, role: 'admin' })` pattern at
`src/middleware/authResolver.ts:334-353`. Non-admin callers receive
`401`/`403` from the API and never see the nav button in the UI.

## Requirements

### Requirement: Admin Review UI Capability

The system MUST provide a `bioprospecting-review-ui` capability
exposing an admin-only `/admin` page with three internal tabs —
Contradictions (Contras), Dedup, and Stats — and four new backend
routes that feed the page. The page is the operator's primary
review surface for bioprospecting detection output.

The capability is read-mostly: contradictions can be resolved or
dismissed (per-row or in bulk), and dedup edges can be soft-unmerged
with a reason. Both writes write a corresponding audit row
(`research_bioprospecting_dedup_audit` for unmerges) so the
soft-delete is fully reversible.

#### Scenario: Admin opens the page

- GIVEN an admin user with `claims.role === "admin"`
- WHEN the user navigates to `/admin`
- THEN the `AdminPage` mounts in `LegacyAppShell` (or
  `CoralAppShell`)
- AND the Contradictions tab is selected by default
- AND the page renders the three tab buttons (Contras, Dedup, Stats)

#### Scenario: Non-admin user does not see the nav button

- GIVEN a non-admin user with `claims.role !== "admin"`
- WHEN the Sidebar renders
- THEN the "Admin" nav button is NOT present in the DOM
- AND navigating to `/admin` directly returns 401 or 403 from the
  API guards

#### Scenario: Non-admin API caller is rejected

- GIVEN a request to any of the four new admin routes
- WHEN the JWT `claims.role` is not `"admin"`
- THEN the route returns `401` (unauthenticated) or `403`
  (authenticated but not admin)
- AND no data is leaked in the response body

### Requirement: research_bioprospecting_dedup_audit Schema

The system MUST create a `research_bioprospecting_dedup_audit` table
that records every unmerge (and, in future, merge) event for a
bioprospecting fact edge. The table mirrors the existing
`compound_authority_audit` pattern: append-only, JSONB-bag-friendly
semantics, and a `reason_category` enum to keep structured reporting
honest.

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

**Column semantics:**

- `id` — surrogate primary key (`BIGSERIAL` to keep the audit table
  cheap to insert).
- `fact_id` — the fact being unmerged (the `merged_fact_id` side of
  the edge). `ON DELETE CASCADE` so deleting a fact also clears its
  audit history.
- `event_type` — `'unmerge'` in v1. The `'merge'` value is reserved
  for a future change that wants to audit the inline-merge step; the
  current inline merge in `replaceBioprospectingFactsForSource` does
  not write to this table.
- `old_canonical_id` / `new_canonical_id` — both NULL-able. For an
  unmerge, `old_canonical_id` is the canonical the fact was merged
  into, and `new_canonical_id` is NULL (the fact becomes standalone
  again, not a member of a new group).
- `user_id` — TEXT column for the admin's identifier (admin id or
  email). Nullable for system-originated rows.
- `reason` — free-text detail from the unmerge dialog textarea.
  Optional.
- `reason_category` — one of the four structured values. Optional
  (NULL allowed) for system-originated rows; required for the v1
  `POST /api/research-brain/dedup/:factId/unmerge` endpoint.
- `created_at` — server timestamp at insert.

#### Scenario: Unmerge writes a single audit row

- GIVEN an active edge `(canonical_fact_id = C, merged_fact_id = M)`
- WHEN the admin calls
  `POST /api/research-brain/dedup/:factId/unmerge` for M with
  `reasonCategory = 'false_positive'`
- THEN a row is inserted into
  `research_bioprospecting_dedup_audit` with
  `event_type = 'unmerge'`, `fact_id = M`, `old_canonical_id = C`,
  `new_canonical_id = NULL`, `user_id = <admin>`,
  `reason_category = 'false_positive'`
- AND the audit row is created in the same transaction as the edge
  soft-delete (or a compensating audit row is written on rollback)

#### Scenario: Reason category enum is enforced

- GIVEN an attempt to insert a row with
  `reason_category = 'unsupported_value'`
- WHEN the INSERT runs
- THEN the insert MUST fail with a CHECK constraint violation
- AND no row is written

#### Scenario: Audit rows are preserved when a fact is deleted

- GIVEN a fact F with two unmerge audit rows
- WHEN `DELETE FROM research_bioprospecting_facts WHERE id = F` runs
- THEN the audit rows are removed (CASCADE) — audit history is
  per-fact, not per-edge
- AND any audit row that referenced F as `old_canonical_id` or
  `new_canonical_id` is preserved (SET NULL) so the
  dedup-events timeline keeps its shape

### Requirement: Soft-Delete Columns on fact_edges

The system MUST add three soft-delete columns to
`research_bioprospecting_fact_edges` so an unmerge is reversible and
does not require touching the `identity_key` partial unique index on
`research_bioprospecting_facts`.

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

- `is_active` — defaults to `TRUE` for all new and existing edges.
  Unmerge sets it to `FALSE`. The default + backfill on existing
  rows is implicit (`DEFAULT TRUE` populates the new column for
  existing rows during `ALTER TABLE ADD COLUMN ... NOT NULL
  DEFAULT TRUE` on PostgreSQL 11+).
- `unmerged_at` — server timestamp of the unmerge; NULL on
  un-touched edges.
- `unmerged_by` — TEXT column for the admin's identifier; NULL on
  un-touched edges.

The unmerge flow is a soft-delete (`is_active = false`) rather than
a hard delete. The `merged_fact_id` row in
`research_bioprospecting_facts` retains its `merged_into_fact_id`
cache value; a future reconciliation job can clear stale cache
rows. The `identity_key` partial unique index is NOT touched, so the
previously-merged fact remains eligible to re-merge into a
different canonical via the normal inline-merge path.

#### Scenario: Unmerge sets is_active = false

- GIVEN an active edge `(canonical_fact_id = C, merged_fact_id = M)`
  with `is_active = true`
- WHEN the admin calls
  `POST /api/research-brain/dedup/M/unmerge`
- THEN the edge row is updated to
  `is_active = false, unmerged_at = NOW(), unmerged_by = <admin>`
- AND the edge row is NOT deleted
- AND `identity_key` on `research_bioprospecting_facts` is
  unchanged

#### Scenario: Existing read paths filter on is_active

- GIVEN edges where some have `is_active = true` and others
  `is_active = false`
- WHEN `getDuplicateGroup(factId)` runs
- THEN only active edges are joined — the returned group contains
  only the still-merged siblings
- AND when `findMergedFactIds(factIds)` runs
- THEN only `merged_fact_id` values from active edges are returned
- AND the previously-unmerged fact M is NOT in the returned set

#### Scenario: Double-unmerge is rejected

- GIVEN an edge with `is_active = false`
- WHEN the admin calls `POST /api/research-brain/dedup/M/unmerge`
  again
- THEN the route returns `409 Conflict` (no active edge to
  unmerge)
- AND no audit row is written
- AND the soft-delete columns are NOT touched a second time

### Requirement: Global Contradictions List Route

The system MUST expose `GET /api/research-brain/contradictions` as
an admin-only, paginated, filterable list of all contradictions
across all sources. The route is additive: the existing per-source
list endpoint is preserved.

**Request:**

- Auth: `authResolver({ required: true, role: 'admin' })`
- Query params (all optional):
  - `status` — one of `'unresolved' | 'resolved' | 'dismissed'`
    (case-insensitive). Filters by `resolution_status`.
  - `sourceId` — UUID; filters by `source_id`.
  - `limit` — integer, default `50`, max `200`. Clamped
    server-side.
  - `offset` — integer, default `0`, non-negative. Clamped
    server-side.

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

The `total` field is the unpaginated `COUNT(*)` for the same filter
combination, allowing the client to render a "page N of M" footer.

#### Scenario: Default list returns unresolved first

- GIVEN 100 contradictions in the table across all statuses
- WHEN `GET /api/research-brain/contradictions` is called with no
  query params
- THEN the response includes up to 50 rows
- AND `total >= 50`
- AND `limit = 50` and `offset = 0` are echoed back

#### Scenario: Status filter narrows the list

- GIVEN contradictions with mixed `resolution_status` values
- WHEN `GET /api/research-brain/contradictions?status=resolved` is
  called
- THEN every row in `contradictions[]` has
  `resolutionStatus = 'resolved'`
- AND `total` reflects the filtered count, not the unfiltered count

#### Scenario: Pagination respects limit and offset

- GIVEN 75 unresolved contradictions
- WHEN `GET /api/research-brain/contradictions?status=unresolved&limit=20&offset=40`
  is called
- THEN `contradictions[]` has at most 20 rows
- AND `total = 75`
- AND `limit = 20` and `offset = 40` are echoed back

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the same route is hit
- THEN the response is `401` or `403`
- AND no contradiction data is returned

### Requirement: Contradiction Stats Route

The system MUST expose
`GET /api/research-brain/contradictions/stats` as an admin-only
endpoint returning the activity snapshot for the Stats tab. The
shape extends the contradiction metrics with the dedup metrics in
the same card.

**Request:**

- Auth: `authResolver({ required: true, role: 'admin' })`
- No query params.

**Response (200):**

```json
{
  "today": {
    "found":      12,
    "resolved":    3,
    "dismissed":   1,
    "pending":     8,
    "merges":     47,
    "unmerges":    2
  },
  "last7d": {
    "found":     124,
    "resolved":  38,
    "dismissed": 12,
    "pending":    74,
    "merges":    311,
    "unmerges":   18
  }
}
```

**Metric definitions:**

- `found` — `COUNT(contradictions WHERE created_at >= window)`.
- `resolved` — `COUNT(contradictions WHERE resolution_status =
  'resolved' AND resolved_at >= window)`.
- `dismissed` — `COUNT(contradictions WHERE resolution_status =
  'dismissed' AND resolved_at >= window)`.
- `pending` — `found - resolved - dismissed` (computed in code
  after the SQL aggregation; MUST NOT be negative — clamped to `0`).
- `merges` — `COUNT(fact_edges WHERE merged_at >= window AND
  is_active = true)`.
- `unmerges` — `COUNT(fact_edges WHERE unmerged_at >= window)`.

The `today` window is `created_at >= NOW() - INTERVAL '1 day'`. The
`last7d` window is `created_at >= NOW() - INTERVAL '7 days'`. The
endpoint issues at most eight `COUNT(*)` queries (one per
metric × window) and MUST NOT cache the response in v1.

#### Scenario: All six metrics surface in the stats card

- GIVEN an admin calls the route
- WHEN the response is received
- THEN `today` and `last7d` each contain exactly the keys
  `found`, `resolved`, `dismissed`, `pending`, `merges`,
  `unmerges`
- AND all 12 numbers are non-negative integers

#### Scenario: Pending is non-negative even with bookkeeping drift

- GIVEN a clock anomaly where `resolved + dismissed > found` in a
  window
- WHEN the stats route runs
- THEN `pending` is clamped to `0` in both windows
- AND the underlying `found`, `resolved`, `dismissed` counts are
  returned unaltered

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the same route is hit
- THEN the response is `401` or `403`

### Requirement: Dedup Events List Route

The system MUST expose
`GET /api/research-brain/dedup/events` as an admin-only,
paginated, time-windowed list of recent merge and unmerge events
on bioprospecting fact edges. The endpoint is the data source for
the Dedup tab.

**Request:**

- Auth: `authResolver({ required: true, role: 'admin' })`
- Query params (all optional):
  - `limit` — integer, default `50`, max `200`. Clamped
    server-side.
  - `offset` — integer, default `0`. Clamped server-side.
  - `since` — one of `'24h' | '7d' | '30d' | 'all'`, default
    `'7d'`. Maps to `merged_at >= NOW() - INTERVAL '...'` for the
    chosen window; `'all'` omits the time filter.

**Response (200):**

```json
{
  "events": [
    {
      "eventId": "uuid | string",
      "factId": "uuid",
      "canonicalId": "uuid",
      "mergedFactId": "uuid",
      "matchRule": "identity_key | embedding",
      "mergedAt": "iso8601",
      "unmergedAt": "iso8601" | null,
      "unmergedBy": "text" | null,
      "isActive": true,
      "reasonCode": "false_positive | different_compound | measurement_error | other" | null,
      "reasonDetail": "text" | null
    }
  ]
}
```

Each event row is a join across
`research_bioprospecting_fact_edges` and
`research_bioprospecting_dedup_audit` (left-join on `fact_id`,
keeping the most recent audit row). Both active merges
(`is_active = true`) and unmerged edges (`is_active = false`) are
returned; the client filters to whichever view it wants.

#### Scenario: Default window is last 7 days

- GIVEN merge events across the last 30 days
- WHEN `GET /api/research-brain/dedup/events` is called with no
  query params
- THEN the response includes only events with
  `merged_at >= NOW() - INTERVAL '7 days'`
- AND the rows are ordered by `merged_at DESC`

#### Scenario: All-time window returns everything

- GIVEN merge events older than 30 days
- WHEN
  `GET /api/research-brain/dedup/events?since=all` is called
- THEN those events are included in the response (paginated)

#### Scenario: Active and unmerged events both surface

- GIVEN a mix of active merges and edges that have been unmerged
- WHEN the route runs
- THEN both `is_active = true` and `is_active = false` edges are
  returned
- AND the `reasonCode` and `reasonDetail` come from the most
  recent unmerge audit row for that fact

### Requirement: Unmerge Route

The system MUST expose
`POST /api/research-brain/dedup/:factId/unmerge` as an
admin-only mutation that soft-deletes the active edge for a
merged fact and writes a corresponding audit row. The endpoint is
the backend for the "Unmerge" button in the Dedup tab.

**Request:**

- Auth: `authResolver({ required: true, role: 'admin' })`
- Path param: `factId` — UUID of the merged fact (the
  `merged_fact_id` side of the edge).
- Body (JSON):
  ```json
  {
    "reasonCode":   "false_positive | different_compound | measurement_error | other",
    "reasonDetail": "free text (optional)"
  }
  ```
- Validation:
  - `reasonCode` MUST be one of the four enum values; otherwise
    `400 Bad Request`.
  - The `factId` path param MUST reference a fact; otherwise
    `404 Not Found`.
  - There MUST be exactly one active edge
    (`is_active = true AND merged_fact_id = factId`); otherwise
    `409 Conflict` (no active edge to unmerge, or ambiguous
    multi-edge case which the system rejects as a defensive
    measure).

**Response (200):**

```json
{
  "edge": {
    "canonicalFactId": "uuid",
    "mergedFactId":    "uuid",
    "matchRule":       "identity_key",
    "mergedAt":        "iso8601",
    "isActive":        false,
    "unmergedAt":      "iso8601",
    "unmergedBy":      "admin-id"
  },
  "audit": {
    "id":              "bigint-string",
    "factId":          "uuid",
    "eventType":       "unmerge",
    "oldCanonicalId":  "uuid",
    "newCanonicalId":  null,
    "userId":          "admin-id",
    "reason":          "text" | null,
    "reasonCategory":  "false_positive | different_compound | measurement_error | other",
    "createdAt":       "iso8601"
  }
}
```

The implementation MUST update the edge and insert the audit row
in the same transaction. The `WHERE is_active = true` clause on
the UPDATE is the CAS guard: a second concurrent unmerge sees zero
rows affected and the route returns `409`.

#### Scenario: Successful unmerge updates edge and writes audit

- GIVEN an active edge `(canonical_fact_id = C, merged_fact_id = M)`
  with `is_active = true`
- AND a body `{ "reasonCode": "different_compound", "reasonDetail":
  "Limonene and pinene, not the same compound" }`
- WHEN the admin POSTs to `/api/research-brain/dedup/M/unmerge`
- THEN the response is `200`
- AND the edge row is updated to
  `is_active = false, unmerged_at = NOW(), unmerged_by = <admin>`
- AND an audit row is inserted with
  `event_type = 'unmerge'`, `old_canonical_id = C`,
  `new_canonical_id = NULL`,
  `reason_category = 'different_compound'`,
  `reason = 'Limonene and pinene, not the same compound'`
- AND the response body includes the updated `edge` and the
  inserted `audit` row

#### Scenario: Invalid reasonCode returns 400

- GIVEN a body `{ "reasonCode": "not_a_real_category" }`
- WHEN the route runs
- THEN the response is `400 Bad Request`
- AND no edge is updated
- AND no audit row is written

#### Scenario: No active edge returns 409

- GIVEN a fact M with no active edge
- WHEN the admin POSTs to `/api/research-brain/dedup/M/unmerge`
- THEN the response is `409 Conflict`
- AND no edge is updated
- AND no audit row is written

#### Scenario: Nonexistent fact returns 404

- GIVEN a factId that does not exist in
  `research_bioprospecting_facts`
- WHEN the admin POSTs to the route
- THEN the response is `404 Not Found`

#### Scenario: Non-admin is rejected

- GIVEN a non-admin caller
- WHEN the route is hit
- THEN the response is `401` or `403`
- AND no edge is updated
- AND no audit row is written

### Requirement: Admin Page Mounting

The system MUST mount the `AdminPage` at `/admin` in both
`LegacyAppShell` and `CoralAppShell`, gated on the same
`useAdmin()` hook that the sidebar nav button uses. The page
internally manages an `'contras' | 'dedup' | 'stats'` tab state
and renders the appropriate sub-component.

**Behavior:**

- The route is registered in `client/src/index.jsx` for both
  shells.
- The new `client/src/styles/admin.css` is imported once at the
  top of the entry file (or lazily on the route load).
- The page is reachable only when `claims.role === "admin"`; the
  shells route to a 404 or a redirect to `/` for non-admins, in
  addition to the sidebar not showing the nav button.
- The Contradictions tab is selected by default on first mount.

#### Scenario: Admin lands on the Contras tab

- GIVEN an admin navigates to `/admin`
- WHEN the page mounts
- THEN the Contras tab is the active tab
- AND the Contras list makes its initial `GET
  /api/research-brain/contradictions?status=unresolved&limit=50&offset=0`
  call

#### Scenario: Admin switches to the Stats tab

- GIVEN the admin is on the Contras tab
- WHEN the admin clicks the "Stats" tab button
- THEN the Stats component mounts
- AND it makes its `GET
  /api/research-brain/contradictions/stats` call
- AND the card renders the 12 numbers (today × 6, last7d × 6)

### Requirement: Contras Tab Bulk Resolve

The system MUST support bulk resolve and bulk dismiss on the
Contradictions tab. Bulk is implemented client-side as N×calls to
`POST /api/research-brain/contradictions/:id/resolve` (the
existing per-row route), with optimistic UI updates and
per-row rollback on partial failure.

**Behavior:**

- Each row in the Contras table has a checkbox.
- When at least one row is selected, a footer action bar appears
  with: "Resolve selected (N)", "Dismiss selected (N)", and
  "Clear selection" buttons.
- Clicking "Resolve selected" iterates the selected rows in
  parallel (e.g. via `Promise.allSettled`) and calls the
  per-row resolve route for each.
- On success, the row fades out of the unresolved list.
- On any `4xx`/`5xx` from a single resolve, that specific row
  reverts (re-fades-in) and a toast surfaces the error.
- The action bar hides again once the selection is empty or
  cleared.

#### Scenario: Bulk resolve on 3 selected rows

- GIVEN three unresolved contradictions are selected
- WHEN the admin clicks "Resolve selected (3)"
- THEN three `POST /api/research-brain/contradictions/:id/resolve`
  calls fire in parallel
- AND on `200` from all three, the three rows fade out
- AND a success toast is shown

#### Scenario: Partial failure reverts only the failed row

- GIVEN three selected rows: A, B, C
- WHEN the resolve calls return `200` for A, `500` for B, `200`
  for C
- THEN rows A and C fade out
- AND row B is restored (re-fades-in)
- AND a toast surfaces the error from B's response

### Requirement: Dedup Tab Unmerge Dialog

The system MUST require the operator to pick a `reasonCode` from a
fixed dropdown before submitting an unmerge. The free-text
`reasonDetail` is optional. Submitting without a selected
`reasonCode` is rejected client-side (submit button stays
disabled); the API additionally validates and returns `400` on
missing/invalid `reasonCode`.

**Behavior:**

- The unmerge dialog renders a `<select required>` with the
  four values: `'false_positive' | 'different_compound' |
  'measurement_error' | 'other'`. The dropdown defaults to
  empty (placeholder option).
- Below the dropdown, a `<textarea>` for optional `reasonDetail`
  has a helper line "Detail is optional" beneath it.
- The submit button is disabled until a `reasonCode` is
  selected.
- On submit, the client POSTs
  `POST /api/research-brain/dedup/:factId/unmerge` with
  `{ reasonCode, reasonDetail }`.
- On `200`, the row fades out and a success toast surfaces
  "Unmerged".
- On `4xx`/`5xx`, an inline error renders under the dialog and
  the row stays.

#### Scenario: Submit blocked until dropdown is set

- GIVEN the unmerge dialog is open with no `reasonCode` selected
- WHEN the operator types into the textarea only
- THEN the submit button is disabled
- AND no network call is made

#### Scenario: Submit succeeds with reasonCode only

- GIVEN the dropdown is set to `'measurement_error'`
- AND the textarea is empty
- WHEN the operator clicks "Unmerge"
- THEN the route receives `{ reasonCode: 'measurement_error' }`
- AND the audit row is written with
  `reason_category = 'measurement_error'`, `reason = NULL`

#### Scenario: Server rejects invalid reasonCode

- GIVEN a request body with an unknown reasonCode (e.g. via a
  crafted client)
- WHEN the route validates the body
- THEN the response is `400`
- AND the dialog shows an inline error
- AND no edge is updated

### Requirement: Stats Card Shape

The system MUST render a single Stats card with two side-by-side
sections: `Today` and `Last 7 days`. Each section shows the six
metric tiles: `Found | Resolved | Dismissed | Pending | Merges |
Unmerges`. The card auto-refreshes on tab open (no polling in v1).

**Behavior:**

- The Stats component issues a single
  `GET /api/research-brain/contradictions/stats` call on mount.
- The card renders 12 numbers in total (2 windows × 6 metrics).
- The `pending` tile is highlighted when its value is greater
  than zero (a soft visual cue, e.g. amber background).
- A "View all activity →" link navigates to the Contras tab with
  `?status=resolved` pre-applied (or its client-side equivalent).
- No polling, no background refresh in v1 — the card reflects
  the moment the tab was opened.

#### Scenario: Card renders 12 numbers

- GIVEN the stats endpoint returns
  `today = { found: 12, resolved: 3, dismissed: 1, pending: 8, merges: 47, unmerges: 2 }`
  and `last7d = { ... }`
- WHEN the Stats component renders
- THEN the card shows 12 numbers in the documented layout
- AND the "View all activity →" link is visible below the card

#### Scenario: Pending tile is highlighted when non-zero

- GIVEN `today.pending = 8` and `last7d.pending = 74`
- WHEN the card renders
- THEN both `pending` tiles are highlighted
- AND the other tiles are unhighlighted

### Requirement: Admin Hooks

The system MUST expose a set of admin-only client hooks that
encapsulate the new API calls. The hooks live in
`client/src/hooks/useAdminReview.ts` (or are appended to
`useResearchBrain.ts` if a sibling file is preferred).

**Hooks (minimum):**

- `useAdminContradictions({ status?, sourceId?, page })` —
  fetches `GET /api/research-brain/contradictions` with the
  given filter and pagination. Returns `{ data, isLoading,
  error, refetch }`.
- `useResolveContradiction()` — single mutation against
  `POST /api/research-brain/contradictions/:id/resolve`.
- `useBulkResolveContradictions()` — N×mutation helper used by
  the Contras tab bulk action.
- `useDedupEvents({ since?, page })` — fetches
  `GET /api/research-brain/dedup/events` with the given window
  and pagination.
- `useUnmergeFact()` — mutation against
  `POST /api/research-brain/dedup/:factId/unmerge`, accepting
  `{ reasonCode, reasonDetail }`.
- `useAdminStats()` — fetches
  `GET /api/research-brain/contradictions/stats`.

The hooks are pure thin wrappers over `fetch`; they MUST NOT
duplicate auth logic (the request includes the JWT bearer token
through the existing fetch interceptor).

#### Scenario: useAdminContradictions fetches the unresolved list

- GIVEN the Contras tab mounts with default filters
- WHEN the page renders
- THEN `useAdminContradictions({ status: 'unresolved', page: 0 })`
  fires
- AND the response is rendered into the table

#### Scenario: useUnmergeFact sends the dialog payload

- GIVEN the unmerge dialog submit handler builds
  `{ reasonCode: 'false_positive', reasonDetail: 'wrong species' }`
- WHEN the operator clicks submit
- THEN `useUnmergeFact().mutate({ factId, reasonCode,
  reasonDetail })` fires
- AND the route receives
  `POST /api/research-brain/dedup/:factId/unmerge` with that
  body

### Requirement: Pagination Defaults

The system MUST default list endpoints to 50 rows per page and
clamp `limit` to a maximum of 200. The default is hard-coded in
both the route handler and the client hook; clients can override
`limit` and `offset` per call.

**Behavior:**

- `GET /api/research-brain/contradictions?limit=` defaults to
  `50` when the param is absent; values above `200` are clamped
  to `200`.
- `GET /api/research-brain/dedup/events?limit=` follows the same
  default and clamp.
- Negative `offset` is treated as `0`; non-integer `limit` or
  `offset` is rejected with `400`.

#### Scenario: Missing limit defaults to 50

- GIVEN a call with no `limit` query param
- WHEN the route runs
- THEN `limit = 50` is used in the SQL `LIMIT` clause
- AND the response echoes `limit: 50`

#### Scenario: Oversized limit is clamped

- GIVEN a call with `?limit=10000`
- WHEN the route runs
- THEN the SQL `LIMIT` is `200`
- AND the response echoes `limit: 200` (the effective limit, not
  the requested one)

#### Scenario: Non-integer limit is rejected

- GIVEN a call with `?limit=abc`
- WHEN the route runs
- THEN the response is `400 Bad Request`
- AND no rows are returned

### Requirement: Admin Styling

The system MUST add a new CSS file
`client/src/styles/admin.css` that mirrors the table styling of
`client/src/styles/corpus.css` and is imported once at the top
level of the client entry. The CSS is the single source of
visual truth for the Admin page.

**Behavior:**

- `admin.css` is imported in `client/src/index.jsx` (or lazily
  on the `/admin` route) so the styles are available without
  per-component imports.
- The CSS defines: tab bar layout, table styling for both
  Contras and Dedup tables, dialog styling for the unmerge
  modal, and the Stats card grid (2 windows × 6 metrics).
- The CSS does NOT introduce new design tokens — it reuses the
  existing CSS variables and color palette from
  `corpus.css`.

#### Scenario: Admin page renders with the admin stylesheet

- GIVEN `admin.css` is imported in the entry file
- WHEN the Admin page mounts
- THEN the tab bar, tables, dialog, and Stats card use the
  documented styles
- AND the page does not fall back to un-styled HTML

## MODIFIED Requirements

None. This is a new capability. The dedup soft-delete changes
appear as deltas in the `bioprospecting-semantic-dedup` spec
and the contradiction global list/stats changes appear as
deltas in the `bioprospecting-contradiction-detection` spec.

## REMOVED Requirements

None.
