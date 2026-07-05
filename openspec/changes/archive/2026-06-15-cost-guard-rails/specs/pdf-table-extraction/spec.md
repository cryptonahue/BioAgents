# Delta for pdf-table-extraction

## ADDED Requirements

### Requirement: Orchestrator Handles CostCapExceededError

The `pdfTableExtractor` orchestrator MUST wrap every call to
`MistralTableExtractionProvider.callOcr` with the `costService`
cap check (`checkCap`) and increment (`recordApiCall`) calls
defined in the `api-cost-guard-rails` capability. When the cap
is hit, the orchestrator MUST catch the
`CostCapExceededError` and transparently fall back to the
`local` provider for the rest of the run. The fallback MUST
NOT raise an error to the caller; the run continues with the
local result.

**Behavior:**

- Before calling `mistralOcrProvider.callOcr`, the orchestrator
  MUST call `costService.checkCap({ provider: 'mistral_ocr',
  estimatedCostUsd: pdf.byteLength / 100_000 * costPerPage,
  sourceId, runId })`.
- If `checkCap.allowed === false` for ANY cap scope (run,
  source, day, month), the orchestrator MUST short-circuit to
  the local provider WITHOUT calling Mistral.
- If `checkCap.allowed === true`, the orchestrator calls
  Mistral. On the way out, it MUST call
  `costService.recordApiCall({ provider: 'mistral_ocr',
  units: pages.length, costUsd: actualCost, sourceId, runId })`.
- If `recordApiCall` returns `cap_hit !== null` (cap crossed
  mid-call), the orchestrator MUST discard the Mistral result
  and run the local provider, then log the cap-hit event.
- When the local provider runs as a cost-driven fallback (not
  a quality-gate fallback), the persisted rows MUST carry
  `extraction_provider='local'` and the reason MUST be
  `provider=local, reason=cost_cap` in the
  `pdf_table_extraction_quality_gate` log event.
- The orchestrator MUST respect the
  `globalThis.__mistralOcrDisabledToday__` and
  `__mistralOcrDisabledThisMonth__` flags set by
  `costService` after a cap hit, and MUST short-circuit to
  `local` without calling `checkCap` again until the flag
  resets.

#### Scenario: Per-day cap → transparent local fallback

- GIVEN daily Mistral cost has reached
  `MISTRAL_OCR_DAILY_COST_CAP_USD=50`
- WHEN the orchestrator processes the next source in the run
- THEN `checkCap.allowed` is `false`
- AND the orchestrator calls the local provider
- AND the local result is persisted with
  `extraction_provider='local'`
- AND a WARN log is emitted with
  `event=mistral_disabled_today, provider=local,
  reason=cost_cap`

#### Scenario: Pre-call estimate exceeds per-source cap

- GIVEN a 5 MB PDF (estimate 50 pages, $2.50) and
  `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD=2`
- WHEN the orchestrator runs `checkCap` for source S
- THEN `wouldHitPerSource=true` is returned
- AND the orchestrator skips Mistral and uses the local
  provider
- AND a WARN is logged with `event=mistral_cap_source_exceeded,
  sourceId=S`

#### Scenario: Monthly cap → ERROR log + local fallback

- GIVEN monthly Mistral cost has reached
  `MISTRAL_OCR_MONTHLY_COST_CAP_USD=1000`
- WHEN the orchestrator processes the next source
- THEN `checkCap.allowed` is `false`
- AND the local provider runs
- AND an ERROR is logged with
  `event=mistral_disabled_this_month, provider=local,
  reason=cost_cap`

#### Scenario: Provider-disabled flag short-circuits subsequent calls

- GIVEN `globalThis.__mistralOcrDisabledToday__ === true`
  (set earlier in the same process)
- WHEN the orchestrator processes a new source
- THEN it does NOT call `checkCap`
- AND it calls the local provider directly
- AND the `mistral_disabled_today` log is NOT re-emitted in
  the same day

## MODIFIED Requirements

### Requirement: Mistral Provider (Fallback)

The system MUST implement a `mistral` provider that wraps the
Mistral OCR API. The Mistral provider is the fallback for scanned
or low-quality PDFs and is the primary path only when
`TABLE_EXTRACTION_PROVIDER=mistral`. The provider MUST cooperate
with the `api-cost-guard-rails` capability: every `callOcr`
invocation is wrapped with a cap check and a `recordApiCall`
increment via `costService`.

**Behavior contract:**

- The provider MUST be implemented at
  `src/services/files/pdfTableExtractor.ts` and exported as
  `class MistralTableExtractionProvider implements TableExtractionProvider`
  with `readonly name = "mistral"`.
- The provider MUST call Mistral's OCR endpoint with the PDF and
  parse the structured response into `ExtractedTable[]`.
- The provider MUST emit `confidence` from Mistral's per-block
  confidence (averaged per row). When the API does not return a
  confidence, the provider defaults to `0.5`.
- The provider MUST record `extraction_provider='mistral'` in
  every persisted row, regardless of who initiated the call (auto
  fallback or direct mode).
- The provider MUST accept `runId` and `sourceId` as part of
  its call context (in addition to the PDF buffer) so the
  orchestrator can thread them into `costService.checkCap` and
  `recordApiCall`.
- The provider MUST call `costService.checkCap` before the
  Mistral API call. When `checkCap.allowed === false`, the
  provider MUST throw `CostCapExceededError({ scope: cap_hit })`
  and the orchestrator catches and falls back to `local`.
- The provider MUST call `costService.recordApiCall` after a
  successful Mistral call, passing the actual
  `pages.length` as `units` and the actual computed USD cost.

(Previously: The provider was responsible only for the
Mistral API call. Cost awareness, cap checks, and
`runId`/`sourceId` threading are now part of the contract.)

#### Scenario: Mistral provider extracts from a scanned PDF

- GIVEN a scanned PDF (image-only, no text layer) and
  `MISTRAL_API_KEY` is set
- AND `checkCap` returns `allowed=true`
- WHEN the Mistral provider runs
- THEN it returns N `ExtractedTable` objects with per-block
  confidences
- AND the result is persisted with `extraction_provider='mistral'`
- AND `recordApiCall` is called with `units=N`

#### Scenario: Mistral API key missing

- GIVEN `MISTRAL_API_KEY` is unset and the Mistral provider is
  selected
- WHEN the provider runs
- THEN it throws `TableExtractionProviderError` with a clear
  "missing MISTRAL_API_KEY" message
- AND the orchestrator logs the failure and returns the local
  result (auto) or an empty result (mistral mode)

#### Scenario: Pre-call cap check rejects the call

- GIVEN the daily cap is already exhausted
- WHEN the orchestrator calls the Mistral provider
- THEN `checkCap` returns `allowed=false`
- AND the provider throws `CostCapExceededError({ scope:
  'day' })` without calling Mistral
- AND the orchestrator falls back to the local provider
- AND logs `event=mistral_disabled_today, provider=local,
  reason=cost_cap`

#### Scenario: Post-call cap crossed mid-call

- GIVEN daily cap is $49.95 and the next call adds $0.10
- WHEN the orchestrator calls the Mistral provider
- THEN Mistral returns the result successfully
- AND `recordApiCall` returns `cap_hit='day'`
- AND the orchestrator discards the Mistral result
- AND the local provider runs
- AND `event=mistral_disabled_today` is logged

### Requirement: Provider Abstraction And Selection

The system MUST define a provider abstraction that hides the local
and Mistral implementations behind a single
`extractPDFTables(sourceId, pdfBuffer, runId?): Promise<ExtractedTables>`
function. The active provider is selected at startup from the
`TABLE_EXTRACTION_PROVIDER` environment variable and is one of:

- `auto` — run the local provider first, then evaluate the quality
  gate; fall back to Mistral OCR if the gate fails. Mistral is
  itself subject to the cost cap; on cap hit, fall back to
  `local`.
- `local` — run the local provider only; never call Mistral.
- `mistral` — skip the local provider entirely; run Mistral OCR.
  On cost cap hit, fall back to `local` and log the cap event.

The active mode is read once at process start and held in a
module-private `getTableExtractionProvider()` accessor. The accessor
MUST export the resolved provider name (`'auto' | 'local' | 'mistral'`)
so logs and the quality gate can record the decision context.

**Provider interface (logical):**

```typescript
interface TableExtractionProvider {
  readonly name: "local" | "mistral";
  extract(pdf: Uint8Array, ctx: { runId?: string; sourceId?: string }): Promise<ExtractedTable[]>;
}

interface ExtractedTable {
  page: number;            // 1-indexed
  tableIndex: number;      // 0-based ordinal on page
  headers: string[];       // flattened per multi-level rule
  rows: string[][];        // empty cells as "-"
  bbox: { x: number; y: number; w: number; h: number; page: number; units: "pt" };
  confidence: number;      // [0, 1]
  markdown: string;        // derived from headers + rows
}
```

The orchestrator (`extractPDFTables`) handles the cache check, the
quality gate, and the cost-cap fallback; providers only do the
per-document extraction (and the Mistral provider additionally
cooperates with `costService`).

(Previously: `extractPDFTables` was the 2-arg signature
`(sourceId, pdfBuffer)`. The new signature adds an optional
`runId` and a `ctx` object for the provider, and the
`CostCapExceededError` fallback path is now part of the
orchestrator's contract.)

#### Scenario: auto mode runs local first

- GIVEN `TABLE_EXTRACTION_PROVIDER=auto` and a digital PDF (no
  scanned pages)
- WHEN `extractPDFTables(S, pdf)` is called and no cached tables
  exist for S
- THEN the local provider runs
- AND if its output passes the quality gate, the result is persisted
  with `extraction_provider='local'`
- AND Mistral is NOT called

#### Scenario: auto mode falls back to mistral on low confidence

- GIVEN `TABLE_EXTRACTION_PROVIDER=auto` and the local provider
  returns 1 table with average row confidence 0.32
- AND `checkCap({ provider: 'mistral_ocr', ... })` returns
  `allowed=true`
- WHEN the quality gate runs
- THEN the local result is discarded
- AND the Mistral provider is called
- AND the persisted result has `extraction_provider='mistral'`

#### Scenario: Cost cap mid-fallback → second local pass

- GIVEN `TABLE_EXTRACTION_PROVIDER=auto` and the local result
  fails the quality gate
- AND `checkCap` returns `cap_hit='day'` (daily cap already
  exhausted)
- WHEN the orchestrator runs
- THEN the local result is re-evaluated and persisted as the
  final result
- AND `event=mistral_disabled_today, provider=local,
  reason=cost_cap` is logged
- AND no Mistral API call is made

#### Scenario: local mode never calls mistral

- GIVEN `TABLE_EXTRACTION_PROVIDER=local`
- WHEN the local provider returns a low-confidence result
- THEN the local result is persisted as-is
- AND Mistral is NOT called (the gate is bypassed in `local` mode)

#### Scenario: mistral mode skips local

- GIVEN `TABLE_EXTRACTION_PROVIDER=mistral`
- WHEN `extractPDFTables(S, pdf)` is called
- THEN the local provider is NOT invoked
- AND the Mistral provider is called directly
- AND the persisted result has `extraction_provider='mistral'`

#### Scenario: Cache hit short-circuits provider calls

- GIVEN `research_evidence_tables` already has rows for `source_id`
  S
- WHEN `extractPDFTables(S, pdf)` is called
- THEN no provider is called
- AND the cached rows are returned verbatim
- AND no new rows are inserted (idempotent)
