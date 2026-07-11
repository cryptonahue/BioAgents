# Delta for bioprospecting-entity-graph

Relax access on the two read-only entity graph GET endpoints from
admin-only to any whitelisted authenticated user, so the new
`/graph` explorer page (usable by all whitelisted users) can read them.
The endpoints stay READ-ONLY and LLM-free; only the role gate is
dropped. No other endpoint changes.

## MODIFIED Requirements

### Requirement: Admin Authentication Gate

The two entity read endpoints —
`GET /api/research-brain/graph/entities/:kind/search` and
`GET /api/research-brain/graph/entities/:kind/:value/expand` — MUST be
gated by `authResolver({ required: true })` (authentication required,
NO role restriction), so any whitelisted authenticated user can read
them. The endpoints MUST return HTTP 401 when the caller has no auth
context, before executing any database query. An admin caller MUST
continue to succeed. Both endpoints MUST remain READ-ONLY (no insert,
update, or delete) and LLM-free; this delta changes ONLY the gate, not
the response contract or the query behavior.

(Previously: both endpoints were gated by
`authResolver({ required: true, role: "admin" })` and returned HTTP 403
for authenticated non-admin callers.)

#### Scenario: Unauthenticated request returns 401

- GIVEN no auth header is sent
- WHEN either entity endpoint is called
- THEN the response is HTTP 401
- AND no database query is executed

#### Scenario: Whitelisted non-admin request succeeds

- GIVEN a JWT-authenticated whitelisted user whose role is NOT `admin`
- WHEN either entity endpoint is called with valid parameters
- THEN the response is HTTP 200 with the normal entity/expand body
- AND no 403 is returned

#### Scenario: Admin request still succeeds

- GIVEN a JWT-authenticated user whose role is `admin`
- WHEN either entity endpoint is called with valid parameters
- THEN the response is HTTP 200 with the normal entity/expand body

#### Scenario: Endpoints remain read-only

- GIVEN the relaxed gating on the two entity endpoints
- WHEN either endpoint handles a request
- THEN it performs only read queries
- AND it never inserts, updates, or deletes any row
