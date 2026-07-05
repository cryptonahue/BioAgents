# Tasks: Bioprospecting PDF Provenance Viewer

## Review Workload Forecast

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Medium

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,200 across 3 PRs (~350-400 each) |
| Suggested split | PR #1 (backend) → PR #2 (frontend viewer) → PR #3 (fallback + badges) |
| Delivery strategy | ask-on-risk |

| Unit | Goal | PR | Notes |
|------|------|-----|-------|
| 1 | Backend extraction + persistence + extractor integration | PR #1 | base = feature branch; spike test gates the work |
| 2 | Frontend viewer route + lightbox + 3 backend endpoints | PR #2 | base = PR #1 branch |
| 3 | Text-chunk fallback + badges + citation wiring | PR #3 | base = PR #2 branch |

## Phase 1: Backend Foundation (PR #1)

> **v2 changes (2026-06-13):** `pdf-table-extractor` is removed. The local
> provider is now a custom detector on `pdfjs-dist@5` legacy build (no
> canvas, no worker). Spike (1.1) is already verified end-to-end — see
> Engram `sdd/bioprospecting-pdf-provenance-viewer/spike-v5-success`.
> The spike is now a unit test that asserts the detector recovers
> positions from a hand-rolled PDF.

- [x] 1.1 Spike test `src/services/files/__tests__/localPdfTableProvider.spike.test.ts` — hand-roll a PDF with 6 known text items, run the custom detector, assert bboxes match within 1.0 pt
- [x] 1.2 Create `supabase/migrations/20260612000000_create_research_evidence_tables.sql` (design §4)
- [x] 1.3 Create `src/services/files/pdfTableExtractor.ts` — provider abstraction, `extractPDFTables` orchestrator, `globalThis` mode memoization
- [x] 1.4 Create `src/services/files/providers/localPdfTableProvider.ts` — custom detector on `pdfjs-dist@5` legacy build; row/column clustering; multi-level header detection; bbox union; confidence = `min(1, chars / (cells * 8))`
- [x] 1.5 Create `src/services/files/providers/mistralOcrProvider.ts` — pure `fetch`; structured `pages[i].tables` or markdown-only; pixel→PDF-points via `DPI/72`
- [x] 1.6 Create `src/services/files/qualityGate.ts` — pure `evaluateQualityGate(tables)` → `low_table_count` (< 3) | `low_row_confidence` (avg < 0.5) | `passed`
- [x] 1.7 Create `src/services/files/pdfTablePromptBuilder.ts` — pure `buildTablesPromptSection(tables)`; group by `(page, tableIndex)` asc; empty cells → `-`
- [x] 1.8 Create `src/services/researchBrain/tables.ts` — `loadTablesForSource` / `loadFiguresForSource` thin wrappers
- [x] 1.9 Modify `bioprospectingExtractor.ts` — `llmFactsForChunkBatch` injects `tables:` section before `Chunks:` + "prefer tables over prose" rule
- [x] 1.10 Modify `bioprospectingExtractor.ts` — extend `ExtractedBioprospectingFact` with `sourceTableRef`; `normalizeFacts` resolves ref → `evidence_table_id`; log on miss
- [x] 1.11 Modify `src/services/researchBrain/db.ts` — `replaceBioprospectingFactsForSource` payload passes `evidence_table_id`
- [x] 1.12 Modify `bioprospectingExtractor.ts` — `extractBioprospectingFactsForSource` calls `extractPDFTables(sourceId, pdfBuffer)` once after chunks load
- [x] ~~1.13 Add `pdf-table-extractor` to `package.json`~~ (REMOVED — v2 doesn't add a new dep; `pdfjs-dist@5.4.296` is already installed transitively via `pdf-parse@2.4.5`)
- [x] 1.14 Create `src/services/files/__tests__/qualityGate.test.ts` — boundary cases
- [x] 1.15 Create `src/services/files/__tests__/pdfTablePromptBuilder.test.ts` — empty input, single/multi-level headers, ordering
- [x] 1.16 Create `src/services/files/__tests__/localPdfTableProvider.test.ts` — additional unit tests for the clustering algorithm (deterministic, hand-rolled fixtures; does not hit pdfjs)

## Phase 2: Backend Viewer Endpoints (PR #2)

> **v2 note (2026-06-13):** the three backend endpoints (2.1, 2.2,
> 2.3) and their unit test suite landed in PR #1's commit
> (`4d2ffd6`) along with the extraction pipeline. The implementation
> matches the design's §6 contracts exactly:
> - `src/routes/research-brain.ts` lines 1012–1350 (3 routes added)
> - `src/routes/__tests__/research-brain.provenance.test.ts` (route-level
>   smoke tests covering 404, 502, 413, ordering, precedence)
> The apply phase for PR #2 only needs to mark these complete and
> move to the frontend work (Phase 3).

- [x] 2.1 Add `GET /api/research-brain/sources/:sourceId/evidence` to `src/routes/research-brain.ts`
- [x] 2.2 Add `GET /api/research-brain/sources/:sourceId/pdf` — `getStorageProvider().download(file_path)`, stream PDF inline; 404/502/413
- [x] 2.3 Add `GET /api/research-brain/facts/:factId/provenance` — precedence `table → figure → chunk → text-only`; 404 unknown fact

## Phase 3: Frontend Viewer (PR #2)

- [x] 3.1 Add `pdfjs-dist` to `package.json`
- [x] 3.2 Create `client/src/lib/pdfjs.ts` — `GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs"` (absolute path; worker served by backend)
- [x] 3.3 Create `client/src/lib/bbox.ts` — `PDFJS_RENDER_SCALE = 1.5`; `bboxToPixels(bbox)`
- [x] 3.4 Create `client/src/hooks/useProvenance.ts` — fetch `facts/:id/provenance` + `parseViewerHash` / `buildViewerHash` helpers
- [x] 3.5 Create `client/src/hooks/useSourceEvidence.ts` — fetch `sources/:id/evidence`
- [x] 3.6 Create `client/src/hooks/usePdfDocument.ts` — wrap `pdfjsLib.getDocument`; `goToPage(n)`; `destroy()` on unmount
- [x] 3.7 Create `client/src/components/EvidenceViewer.tsx` — render PDF at 1.5×; reads bbox/type from URL hash or prop; cancel-in-flight render; text-layer for selection+copy
- [x] 3.8 Create `client/src/components/BboxOverlay.tsx` — table (blue) | figure (purple) | chunk (yellow) | text-only (no div)
- [x] 3.9 Create `client/src/components/EvidenceLightbox.tsx` — modal; Esc closes; custom focus trap (~20 LOC); "Open in tab"
- [x] 3.10 Create `client/src/pages/ViewerPage.tsx` — `/viewer/:sourceId`
- [x] 3.11 Create `client/src/pages/LibraryViewerPage.tsx` — `/library/:docId/viewer` (resolves docId → sourceId via `usePaperMeta`)
- [x] 3.12 Modify `client/src/pages/index.ts` — export both new pages
- [x] 3.13 Modify `client/src/index.jsx` — register both routes in `LegacyAppShell` and `CoralAppShell`
- [x] 3.14 Create `client/src/styles/provenance.css` — lightbox backdrop, highlight colors, focus-trap outline
- [x] 3.15 Modify `src/index.ts` — serve `/pdfjs/pdf.worker.mjs` (pins the standard build, not the legacy build, for the worker)

## Phase 4: Text-Chunk Fallback + Badges (PR #3)

- [x] 4.1 Create `client/src/contexts/ProvenanceContext.tsx` — provider + lightbox; `openLightbox` / `openInTab`
- [x] 4.2 Create `client/src/utils/provenanceTrigger.ts` — `openProvenanceLightbox` + `openProvenanceInTab`
- [x] 4.3 Create `client/src/components/ProvenanceBadge.tsx` — focusable pill; aria-label for text-only
- [x] 4.4 Create `client/src/hooks/useTextChunkSearch.ts` — PDF.js text-layer search first 80 chars; null on miss
- [x] 4.5 Modify `InlineCitationText.jsx` — add `role="button"`, `data-provenance-trigger`, `data-fact-id`; click/Cmd-click/Enter routing
- [x] 4.6 Modify `client/src/pages/LibraryPage.tsx` — render `<ProvenanceBadge />` for text-only facts
- [x] 4.7 Modify `client/src/pages/ResearchBrainPage.tsx` — same badge insertion on the evidence pack
- [x] 4.8 Modify `client/src/index.jsx` — wrap `Root` with `<ProvenanceProvider>` in both shells
- [x] 4.9 Append badge styles to `client/src/styles/provenance.css`
- [x] 4.10 Create `client/src/hooks/__tests__/useTextChunkSearch.test.ts` — text-layer hit, graceful miss

## Phase 5: Verification (PR #3 final)

- [x] 5.1 Run `bun test`; cross-check every Given/When/Then scenario from the three specs against executed tests or route-level smoke
- [x] 5.2 Verify `src/services/files/index.ts` + `src/services/researchBrain/index.ts` re-export new symbols
- [x] 5.3 Add short note to `CLAUDE.md` under "Deep Research" — citation click opens lightbox; "Open in tab" navigates to `/viewer/:sourceId#...`; reload preserves hash

## Relevant Files

- Source: `openspec/changes/bioprospecting-pdf-provenance-viewer/{proposal.md,design/design.md,specs/*/spec.md}`
- Backend: `src/services/files/{pdfTableExtractor.ts,qualityGate.ts,pdfTablePromptBuilder.ts,providers/*}`, `src/services/researchBrain/{bioprospectingExtractor.ts,db.ts,types.ts,tables.ts,index.ts}`, `src/routes/research-brain.ts`
- Storage: `src/storage/index.ts` + `src/storage/providers/s3.ts` (reuse `getStorageProvider()`)
- Migrations: new `20260612000000_*.sql` after `20260610000000_create_bioprospecting_contradictions.sql`
- Frontend new: `client/src/{lib/pdfjs.ts,lib/bbox.ts,hooks/{useProvenance,useSourceEvidence,usePdfDocument,useTextChunkSearch}.ts,components/{EvidenceViewer,EvidenceLightbox,BboxOverlay,ProvenanceBadge}.tsx,contexts/ProvenanceContext.tsx,utils/provenanceTrigger.ts,pages/{ViewerPage,LibraryViewerPage}.tsx,styles/provenance.css}`
- Frontend modified: `client/src/index.jsx`, `client/src/pages/{index.ts,LibraryPage.tsx,ResearchBrainPage.tsx}`, `client/src/components/InlineCitationText.jsx`
- Deps: **no new direct dep for PR #1** — `pdfjs-dist@5.4.296` is already installed transitively. PR #2 will add `pdfjs-dist` as a direct dep for the frontend bundle.
- Test pattern: `src/services/researchBrain/__tests__/dedup.test.ts` (chainable supabase mock)
- Config: `openspec/config.yaml` (`rules.apply.tdd: false`)
