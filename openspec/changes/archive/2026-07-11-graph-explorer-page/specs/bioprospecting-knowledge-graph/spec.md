# Delta for bioprospecting-knowledge-graph

Relax access on the two read-only graph GET endpoints owned by this
capability — compound search and the citation graph — from admin-only
to any whitelisted authenticated user, so the new `/graph` explorer page
(usable by all whitelisted users) can read them. The endpoints stay
READ-ONLY and LLM-free; only the role gate is dropped. No mutation,
review-UI, cost-totals, or table-merge endpoint changes.

## MODIFIED Requirements

### Requirement: Admin Authentication Gate

The two read endpoints —
`GET /api/research-brain/graph/compounds/search` and
`GET /api/research-brain/citations/:sourceId` — MUST be gated by
`authResolver({ required: true })` (authentication required, NO role
restriction), so any whitelisted authenticated user can read them. The
endpoints MUST return HTTP 401 when the caller has no auth context,
before executing any database query. An admin caller MUST continue to
succeed. Both endpoints MUST remain READ-ONLY and LLM-free; this delta
changes ONLY the gate on these two endpoints, not the response contract
or query behavior.

This relaxation is surgical and MUST NOT widen access to any other
endpoint. All mutation endpoints and any admin-only surfaces (review UI,
cost totals, table merges) MUST remain gated by
`authResolver({ required: true, role: "admin" })` and continue to return
HTTP 403 for authenticated non-admin callers.

(Previously: both read endpoints were gated by
`authResolver({ required: true, role: "admin" })` and returned HTTP 403
for authenticated non-admin callers.)

#### Scenario: Unauthenticated request returns 401

- GIVEN no auth header is sent
- WHEN `GET /graph/compounds/search` or `GET /citations/:sourceId` is
  called
- THEN the response is HTTP 401
- AND no database query is executed

#### Scenario: Whitelisted non-admin request succeeds on the read endpoints

- GIVEN a JWT-authenticated whitelisted user whose role is NOT `admin`
- WHEN `GET /graph/compounds/search?q=...` or
  `GET /citations/:sourceId` is called with valid parameters
- THEN the response is HTTP 200 with the normal body
- AND no 403 is returned

#### Scenario: Admin request still succeeds on the read endpoints

- GIVEN a JWT-authenticated user whose role is `admin`
- WHEN either relaxed read endpoint is called with valid parameters
- THEN the response is HTTP 200 with the normal body

#### Scenario: Non-graph admin endpoints stay admin-only

- GIVEN a JWT-authenticated whitelisted user whose role is NOT `admin`
- WHEN they call any mutation, review-UI, cost-totals, or table-merge
  admin endpoint (e.g. a `POST`/`DELETE` review or merge route)
- THEN the response is HTTP 403
- AND access is unchanged from before this delta

#### Scenario: Relaxed endpoints remain read-only

- GIVEN the relaxed gating on the compound-search and citations
  endpoints
- WHEN either endpoint handles a request
- THEN it performs only read queries
- AND it never inserts, updates, or deletes any row
