# Tasks: Bioprospecting Review UI

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Changed lines | ~1100-1400 (FE ~700, BE ~350, tests ~250) |
| 400-line risk | High |
| Chained PRs | No (size:exception per Q5) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

## Phase 1: Migrations

- [x] 1.1 Create `20260616000000_create_dedup_audit.sql` — dedup_audit table + 3 indexes per spec
- [x] 1.2 Create `20260616000100_dedup_edge_soft_delete.sql` — 3 cols + index (`ADD COLUMN IF NOT EXISTS`)
- [x] 1.3 Create `20260616000200_get_contradiction_stats_rpc.sql` — `get_contradiction_stats` SECURITY DEFINER via `COUNT(*) FILTER`; grant `EXECUTE` to `service_role`

## Phase 2: Backend Types + Service

- [x] 2.1 Add to `types.ts`: `StatsWindow`, `StatsResponse`, `RecentDedupEvent`, `UnmergeRequest`, `UnmergeResponse`, `ReasonCategory` (~30 LOC)
- [x] 2.2 Create `reviewService.ts` — export 4 helpers + 4 error classes; re-export `getDuplicateGroup` (~200 LOC)
- [x] 2.3 Modify `db.ts`: add `WHERE is_active = true` to edge reads in `getDuplicateGroup`; modify `index.ts` to re-export `reviewService`

## Phase 3: Backend Routes (admin-gated)

- [x] 3.1 Add `GET /contradictions` — `status`/`sourceId`/`limit`/`offset`; default 50/max 200; 400 on non-integer
- [x] 3.2 Add `GET /contradictions/stats` — call `getContradictionStats()`; clamp `pending >= 0`
- [x] 3.3 Add `GET /dedup/events` — `limit`/`offset`/`since`; default `since=7d`
- [x] 3.4 Add `POST /dedup/:factId/unmerge` — validate `reasonCode` enum; map helper errors to 400/404/409

## Phase 4: Backend Tests (22 cases)

- [x] 4.1 Create `__tests__/reviewService.test.ts` (12): unmerge happy/double, list filters, `pending` clamp
- [x] 4.2 Extend `__tests__/dedup.test.ts` (2): group null on unmerged; merged-ids excludes unmerged
- [x] 4.3 Create `__tests__/adminRoutes.test.ts` (8): list/stats/events/unmerge + 401/403 via `generateTestJWT`

## Phase 5: Frontend Hooks + Role Gate

- [x] 5.1 Create `useAdmin.ts` — `useAdmin()` decodes JWT `claims.role` (~30 LOC)
- [x] 5.2 Create `useAdminReview.ts` — 6 hooks: `useAdminContradictions`, `useResolveContradiction`, `useBulkResolveContradictions` (`Promise.allSettled` + 50-cap), `useDedupEvents`, `useUnmergeFact`, `useAdminStats` (~250 LOC)
- [x] 5.3 Modify `hooks/index.ts` — re-export `useAdmin` + 6 admin hooks

## Phase 6: Frontend Page + CSS

- [x] 6.1 Create `AdminPage.tsx` — `useState<"contras"|"dedup"|"stats">`; default `"contras"`; 3 co-located sub-components (~700-800 LOC)
- [x] 6.2 ContrasTab — table with checkbox, Resolve/Dismiss per row, filter chips, 50/page pagination, footer action bar; bulk via `useBulkResolveContradictions` with optimistic UI + rollback + toast
- [x] 6.3 DedupTab — window selector (`24h|7d|30d|all`, default 7d); Unmerge dialog with `<select required>` (4 enum) + `<textarea>` optional; submit disabled until dropdown set
- [x] 6.4 StatsTab — single card 2 sections × 6 metrics; `pending` tile amber when > 0; "View all activity →" links to Contras `?status=resolved`
- [x] 6.5 Create `admin.css` — tab bar, tables, dialog, stats grid; reuse `corpus.css` variables (~150 LOC)

## Phase 7: Frontend Wiring

- [x] 7.1 Modify `Sidebar.jsx` — add "Admin" button below "Research Brain", gated on `useAdmin().isAdmin`
- [x] 7.2 Modify `pages/index.ts` — `export { AdminPage } from './AdminPage'`
- [x] 7.3 Modify `index.jsx` — import `AdminPage` + `admin.css`; register `<AdminPage path="/admin" />` in both shells

## Phase 8: Frontend Tests (5 cases)

- [x] 8.1 Create `__tests__/useAdminReview.test.ts` (3): fetch+cache, bulk partial-failure rollback, unmerge payload
- [x] 8.2 Create `__tests__/AdminPage.test.tsx` (2): tab switching, unmerge submit-disabled

## Phase 9: Verification

- [x] 9.1 4 new test files pass (27 cases); admin token hits 4 routes, user 403; migrations idempotent
- [x] 9.2 `bun run dev` + `bun run build:client` clean; PR body reports LOC `<= 1400`

## Archive Reconciliation Note (sdd-archive)

All 28 implementation tasks were marked complete by `sdd-apply` evidence in
the implementation summary (observation #245) and the post-fix verify report
after commit `7e5b4d4` closed W1/W2/W4. W3 (non-atomic unmerge UPDATE+INSERT)
is explicitly deferred per orchestrator — Supabase JS client limitation,
CAS guard on the UPDATE prevents double-unmerge. Stale checkboxes
reconciled mechanically by `sdd-archive` per the SDD skill's exceptional
reconciliation rule, backed by `apply-progress` (impl summary #245) and
`verify-report` (#246 rev 1) proof.
