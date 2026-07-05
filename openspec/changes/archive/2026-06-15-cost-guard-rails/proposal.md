# Proposal: cost-guard-rails

## Intent

External API spend (Mistral OCR, PubChem) is untracked and uncapped.
One bad PDF (corrupt, 1000+ pages) can drive hundreds of Mistral
calls in a run, blowing the monthly budget. PubChem is free in
dollars but a rate-limit violation triggers an IP ban — the existing
`RateGate` only smooths 4 rps, it doesn't bound daily volume. LLM
spend is already tracked (`record_llm_call`, `llm_cost`); we extend
that proven pattern to all external APIs with per-run, per-source,
per-day (24h), and per-month (rolling 30-day) caps, inline dashboard
surfacing, and a dedicated admin drill-down. When Mistral's daily
cap is hit, the orchestrator transparently falls back to the local
table provider for the rest of the day.

## Scope

### New capability: `api-cost-guard-rails`

**Schema** — new `daily_api_usage(day, provider, units, cost_usd, calls_count, cap_*, last_cap_warn_at, updated_at)` table; 2 new columns on `research_ingestion_runs` (`ext_api_cost NUMERIC(10,6)`, `ext_api_calls JSONB`); atomic `record_api_call(run_id, source_id, provider, units, cost_usd, metadata) → (totals, cap_hit)` RPC that does `SELECT … FOR UPDATE` on the day row before comparing against env-driven caps. Monthly cap = 30-day rolling sum of `daily_api_usage` at read time. `daily_api_usage` retained 35 days then GC'd.

**Service** — `src/services/researchBrain/costService.ts` is the single import point. Exposes `checkAndIncrement`, `getDayUsage`, `getMonthUsage`, `getSourceUsage`, `isProviderDisabled`. TDZ-safe `globalThis` flags for `mistralDisabledToday` / `mistralDisabledThisMonth`. WARN at `COST_ALERT_SOFT_THRESHOLD` (0.8 default), idempotent via `last_cap_warn_at`.

**Env vars** (add to `.env.example`):
```bash
MISTRAL_OCR_DAILY_COST_CAP_USD=50
MISTRAL_OCR_MONTHLY_COST_CAP_USD=1000
MISTRAL_OCR_PER_SOURCE_COST_CAP_USD=2
PUBCHEM_DAILY_REQUEST_CAP=200000
COST_ALERT_HARD_BLOCK=true
COST_ALERT_SOFT_THRESHOLD=0.8
MISTRAL_OCR_ENABLED=true   # preserved
PUBCHEM_ENABLED=true       # preserved
```

**Integration** — `mistralOcrProvider.callOcr` wrapped pre-call with a `pdf.byteLength / 100_000` page estimator (safe over-count), reconciled post-call with `pages.length`. On `cap_hit="day"`, throw `CostCapExceededError`; `pdfTableExtractor` catches, switches to `local`, logs `mistral_disabled_today` (WARN). `pubchemFetch` wrapped similarly (per-day cap only — worker has no `runId`); `compoundAuthority.worker` checks `isProviderDisabled("pubchem")` before each tick and aborts cleanly with `summary.capHit="day"`. `runId`/`sourceId` thread through `bioprospectingExtractor → ensureTablesForSource → extractPDFTables → provider`.

**Failure-mode matrix (locked)**:

| Scenario | Behavior |
| --- | --- |
| Per-run cap | `CostCapExceededError` → orchestrator falls back to `local`; logs `mistral_cap_run_exceeded`; run continues. |
| Per-source cap | Same fallback path; logged with `sourceId`; run NOT aborted. |
| Per-day cap | `mistral_disabled_today` WARN; `globalThis` flag; transparent `local` fallback for rest of day. |
| Per-month cap (rolling 30d) | `mistral_disabled_this_month` ERROR; hard block; fallback still applies. |
| `MISTRAL_OCR_ENABLED=false` | Short-circuit at module init (TDZ-safe, matches `TABLE_MERGE_ENABLED` pattern). |
| RPC failure (DB blip) | Log + soft-fail; do NOT abort. Best-effort visibility. |

**Visibility** — `GET /api/research-brain/ingestion/runs/:id` returns `extApiCost` + `extApiCallsCount` next to `llmCost`. `IngestionProgressNotification` extended with `apiCost?` / `apiCallsCount?` for real-time WebSocket updates. Corpus dashboard renders "LLM $X / External API $Y". New `GET /api/admin/cost-totals?since=24h&provider=mistral_ocr|pubchem|all` (admin-only via `authResolver({ required: true, role: 'admin' })`) returns per-day/per-provider totals, cap utilization %, soft-warn timestamps, last cap-hit events. Mounted as `/admin/cost-totals`.

**Alert delivery** — WARN at 80% → log + dashboard only. No webhook/email in v1 (YAGNI per locked Q2). Operators check the dashboard.

### Out of scope (deferred)

- Webhook / email / Discord alert delivery.
- Per-user / per-tenant caps (single-tenant).
- Mistral call retries with cost-aware backoff (no retries today).
- `callOcr` single-call refactor (currently called twice per PDF).
- Multi-region cap coordination.

## Approach summary

```
Mistral.callOcr(pdf)
  └── costService.checkAndIncrement({provider:"mistral_ocr", ...})
       ├── RPC: record_api_call (atomic FOR UPDATE + cap check + increment)
       ├── cap_hit='day'   → throw → pdfTableExtractor → fallback to "local"
       │                     + log mistral_disabled_today (WARN)
       ├── cap_hit='month' → hard block, fallback
       └── cap_hit=NULL    → continue; warn at 80%

pubchemFetch(url, gate)
  └── costService.checkAndIncrement({provider:"pubchem", units:1, costUsd:0})
       ├── cap_hit='day' → throw → worker aborts pass cleanly
       └── continue
```

## PR split (3 chained, ~750 LOC total, all under 400-line budget)

| PR | Scope | ~LOC |
| --- | --- | --- |
| #1 | Migration (`daily_api_usage` + 2 columns + `record_api_call` RPC) + `costService.ts` + env vars + cap-math / race / soft-threshold unit tests | ~280 |
| #2 | Mistral wrap: `callOcr` + thread `runId`/`sourceId` through `bioprospectingExtractor → pdfTableExtractor` + local fallback + integration tests | ~220 |
| #3 | PubChem wrap + worker day-cap + admin `/admin/cost-totals` route + WebSocket `apiCost` field + corpus dashboard inline surface | ~250 |

## Affected areas

| Area | Impact |
| --- | --- |
| `supabase/migrations/<ts>_add_api_cost_tracking.sql` | New |
| `src/services/researchBrain/costService.ts` | New |
| `src/services/files/providers/mistralOcrProvider.ts` | Modified (wrap `callOcr`) |
| `src/services/researchBrain/compoundAuthority.ts` | Modified (wrap `pubchemFetch`) |
| `src/services/researchBrain/llm-cost.ts` | Modified (`recordApiCall` shim) |
| `src/services/queue/workers/bioprospecting.worker.ts` | Modified (thread `runId`) |
| `src/services/queue/workers/compoundAuthority.worker.ts` | Modified (day-cap check) |
| `src/services/researchBrain/bioprospectingExtractor.ts` | Modified (`runId`/`sourceId` params) |
| `src/services/files/pdfTableExtractor.ts` | Modified (catch + fallback) |
| `src/routes/research-brain.ts` | Modified (return `extApiCost`) |
| `src/routes/admin/cost-totals.ts` | New |
| `src/services/queue/notify.ts` + `types.ts` | Modified (`apiCost` field) |
| `.env.example` + `documentation/docs/SETUP.md` | Modified |
| `openspec/specs/api-cost-guard-rails/spec.md` | New |

## Risks

| Risk | Mitigation |
| --- | --- |
| `callOcr` called twice per PDF | Count both, document. Refactor deferred. |
| Pre-call page estimate under-counts | Over-counts on average; reconcile post-call. Safe direction. |
| RPC failure overshoots cap | Soft-fail, no abort. Best-effort. |
| Compound worker has no `runId` | Day cap only; documented. |
| Multi-worker race on day cap | `SELECT … FOR UPDATE` in RPC; Postgres serializes. |
| 400-line review budget | 3-PR chained split locks each slice < 400. |

## Rollback plan

- **PR #1**: drop migration; `costService.ts` dead code until #2 wires it. No runtime impact.
- **PR #2**: feature-flag behind `MISTRAL_OCR_COST_GUARD=true`; flip to `false` to restore direct OCR. `ext_api_calls` JSONB harmless if empty.
- **PR #3**: admin route additive — delete file. WebSocket `apiCost` field is optional. PubChem wrap gated by `PUBCHEM_ENABLED`.

## Success criteria

- [ ] Daily Mistral cap hit → transparent `local` fallback, `mistral_disabled_today` WARN logged, run continues.
- [ ] Bad PDF (1000+ pages) capped at `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD` ($2 default); other sources still process.
- [ ] Dashboard shows "LLM $X / External API $Y" inline per run.
- [ ] `/admin/cost-totals` returns per-day, per-provider totals with cap utilization %; admin-only.
- [ ] WARN at 80% in logs + dashboard; no webhook/email.
- [ ] Monthly = rolling 30-day window; `daily_api_usage` GC'd after 35 days.
- [ ] Compound worker aborts cleanly on day cap; facts re-pick next tick.
- [ ] Ships as 3 chained PRs, each under 400-line review budget.
- [ ] Concurrent workers cannot race past the cap (RPC `FOR UPDATE` test).

## Capabilities contract

### New Capabilities
- `api-cost-guard-rails`: per-run, per-source, per-day (24h), and per-month (rolling 30-day) cost caps for external API providers (Mistral OCR, PubChem), inline corpus dashboard surfacing, admin drill-down route, transparent fallback to local provider on Mistral daily cap.

### Modified Capabilities
- `pdf-table-extraction`: orchestrator must catch `CostCapExceededError` and switch to `local` provider for the remaining sources of the run.
- `research-bioprospecting`: ingest runs expose `extApiCost` / `extApiCallsCount`; `IngestionProgressNotification` carries `apiCost` / `apiCallsCount`.

## Resolved decisions (locked)

1. **Q1 day-cap failure mode**: transparent fallback to `local`; `mistral_disabled_today` WARN; run continues.
2. **Q2 alert delivery**: log + dashboard only; no webhook/email in v1.
3. **Q3 per-source cap**: YES; default $2/paper; `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD=2`.
4. **Q4 monthly window**: rolling 30-day, no cron reset; `daily_api_usage` retained 35 days.
5. **Hard/soft**: hard with override — `COST_ALERT_HARD_BLOCK=true` default.
6. **Cap scope**: daily + monthly (rolling 30d) + per-run + per-source.
7. **Visibility**: inline summary on corpus dashboard + admin tab `/admin/cost-totals`.
