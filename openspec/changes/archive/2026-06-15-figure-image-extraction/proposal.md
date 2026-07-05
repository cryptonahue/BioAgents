# Proposal: figure-image-extraction

## Intent

`pdf-provenance-viewer` records figure *positions* (page, bbox, caption) but never the image file. The lightbox overlays a purple bbox on the PDF page — the user sees the figure *region* but cannot preview a clean crop, send the figure to a vision LLM, download it, or cache it offline. This change extracts image bytes per figure, persists to S3, exposes an auth-gated proxy, and renders the crop in the lightbox so figure citations are verifiable and reusable.

## Scope

### In Scope
- Mistral `include_image_base64: true` flip + base64 decode (Approach 4 — fast v1 raster path).
- Render-crop helper: pdfjs-dist page render + bbox crop + PNG encode (Approach 1 — vector-figure coverage).
- 5 new nullable columns on `research_evidence_figures` (`storage_path`, `mime_type`, `width`, `height`, `byte_size`).
- S3 helper `getFigureStoragePath(sourceId, figureIndex, format)`.
- New route `GET /api/research-brain/figures/:figureId/image` (auth required).
- Extend `evidence` endpoint to expose `imageUrl` on each figure row.
- Lightbox `<img>` render for figures with image; "Open image" / "Download" buttons; bbox color split (green = with image, purple = without).
- Per-image-byte cost tracking in `costService`.
- 5–10 min spike on `pdfjs-dist@5.4.296` legacy build `getOperatorList()` (gates PR #3 only).

### Out of Scope
- Local XObject extraction (PR #3, gated on spike).
- Multi-page figure stitching.
- Vision-LLM SMILES extraction (separate `compound-authority` follow-up).
- BYTEA / local filesystem storage.
- Bulk figure export / ZIP.

## Capabilities

### New Capabilities
- `figure-image-extraction`: image persistence, image proxy endpoint, render-crop + XObject extraction pipeline, schema columns, S3 layout.

### Modified Capabilities
- `pdf-table-extraction`: orchestrator gains a separate image-extraction pass after local table extraction; `loadFiguresForSource` and `evidence` return the new fields; `extracted_figure` adds `bytes`, `format`, `width`, `height`, `byteSize`.
- `pdf-provenance-viewer`: `evidence` endpoint emits `imageUrl`; lightbox renders `<img>` header; read-only contract preserved.
- `corpus-ingestion-dashboard`: per-source row shows figure extraction status (with image / bbox only / none).
- `api-cost-guard-rails`: Mistral provider threads image bytes into `recordApiCall`; informational only, no new cap scope.

## Approach

**v1 pipeline (PR #1 + #2):**
1. After local table extraction, orchestrator runs separate `extractPDFFigures(sourceId, pdf)` pass.
2. **Mistral path** (raster): flip `include_image_base64: true` in `mistralOcrProvider.ts:359`; parse `pages[i].images[j].image_base64`; decode to bytes; map back to figure rows by `(page, figureIndex)`.
3. **Render-crop path** (vector): render page via pdfjs-dist legacy build, `getImageData(bbox)`, encode PNG. Spike first: if `@napi-rs/canvas` fails to load in Bun, fall back to `Bun.spawn` + `pdftoppm` (poppler-utils in Docker).
4. Persist bytes to S3 at `figures/{sourceId}/{figureIndex}.{format}`. Update figure row with the 5 new columns (all nullable → graceful degradation).
5. Image proxy: `authResolver({ required: true })`, fetch S3 object, return bytes with `Content-Type: {mime_type}`, `Cache-Control: private, max-age=300`. 404 if `storage_path` null.
6. Evidence endpoint adds `imageUrl: "/api/research-brain/figures/{id}/image"` when `storage_path` non-null.
7. Frontend: `ProvenanceFigure.imageUrl?`; `EvidenceLightbox` shows `<img>` header + buttons; `BboxOverlay` switches green/purple.

**Local XObject (PR #3, gated on spike):** if legacy `getOperatorList()` returns image XObject data with usable transform + filter info, add `extractImages()` to `localPdfTableProvider.ts`. Same persistence path. If spike fails, document v1 limitation.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `supabase/migrations/<new>.sql` | New | 5 nullable columns on `research_evidence_figures` |
| `src/services/files/providers/mistralOcrProvider.ts` | Modified | Flip flag; parse base64; thread bytes into `recordApiCall` |
| `src/services/files/providers/localPdfTableProvider.ts` | Modified (PR #3) | Add `extractImages()` via XObject walk |
| `src/services/files/figureRenderCrop.ts` | New | Render-crop / pdftoppm helper (~80 LOC) |
| `src/services/files/pdfTableExtractor.ts` | Modified | Orchestrator: image pass, S3 persistence, column updates (~80 LOC) |
| `src/storage/index.ts` | Modified | `getFigureStoragePath()` helper |
| `src/routes/research-brain.ts` | Modified | New `GET /figures/:figureId/image` proxy (~90 LOC); extend `evidence` |
| `client/src/hooks/useProvenance.ts` | Modified | `imageUrl?: string` |
| `client/src/components/EvidenceLightbox.tsx` | Modified | `<img>` header, "Open image" / "Download" |
| `client/src/components/BboxOverlay.tsx` | Modified | Green/purple border split |
| `client/src/components/CorpusDashboard/*` | Modified | Figure extraction status indicator |
| `src/services/cost/costService.ts` | Modified | Per-image-byte cost breakdown |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Legacy `getOperatorList()` fails on XObject | Med | Spike first; fall back to `Bun.spawn` + `pdftoppm` |
| Mistral flag blows cost cap | Med | Feature flag; per-byte cost tracking; abort on cap estimate |
| `@napi-rs/canvas` doesn't load in Bun | Med | Same spike; pdftoppm fallback is safety net |
| Vector figures still empty | Med | Render-crop catches them; document v1 limitation until PR #3 |
| S3 cost growth (250GB @ 10k sources) | Low | ~$5/mo on S3 Standard; lifecycle to IA after 90d |
| Image proxy leaks bytes (auth bypass) | Low | Same `authResolver({required:true})` + `Content-Disposition` pattern as PDF proxy |
| PDF > 50MB memory blowup | Low | Reuse `MAX_PDF_BYTES` cap from PDF proxy |
| Existing test mocks break on new return fields | Low | Add-only fields, no shape change — verified vs `bioprospectingExtractor.tables.test.ts:190` |

## Rollback Plan

1. Revert Mistral flag to `false` (single-line flip).
2. Disable image proxy route.
3. `DOWN` migration drops the 5 new columns; viewer degrades to bbox-only (pre-change behavior).
4. Existing rows keep `storage_path = NULL` — read-only-safe.

S3 objects under `figures/{sourceId}/` are orphaned but harmless; cleanup is a separate job.

## Dependencies

- `pdfjs-dist@5.4.296` legacy build (already loaded).
- S3 storage provider (already configured).
- `poppler-utils` in Docker (only if `@napi-rs/canvas` spike fails).
- `@napi-rs/canvas` (only if spike succeeds — gated).
- No new env vars, no infra, no data migration.

## Success Criteria

- [ ] PR #1 merged: spike documented; Mistral flipped; schema migrated; image proxy live; `storage_path` populated for sample paper.
- [ ] PR #2 merged: lightbox renders cropped image for ≥80% of figures on sample MDPI paper; bbox color split visible.
- [ ] PR #3 merged OR explicitly closed: local XObject path shipped or v1 limitation documented.
- [ ] No regression in `pdf-provenance-viewer` scenarios.
- [ ] Image proxy requires auth (401 on unauthed request verified).
- [ ] Per-image-byte cost visible in cost logs after Mistral OCR call.
- [ ] Total LOC ≤ 1000 across 3 PRs; each PR ≤ 400 changed lines.

## PR Split

| PR | Scope | LOC | Gating |
|----|-------|-----|--------|
| **#1** Backend | Spike + Mistral flip + schema + persistence + image proxy + evidence endpoint + render-crop helper | ~350 | None |
| **#2** Frontend | Lightbox `<img>` + buttons + bbox color split + tests | ~200 | #1 merged |
| **#3** Local XObject | `extractImages()` on local provider + edge cases + tests | ~250 | Spike result |

---

## Proposal question round (for user review)

These are the product/PRD questions that should be answered before spec design. They uncover business rules, edge cases, and tradeoffs — not delivery mechanics.

1. **Cobertura vector vs raster en v1.** La v1 sale con Mistral flip (raster) + render-crop helper (vector). ¿Querés que la v1 prometa "toda figura extraída tiene imagen" o aceptás el badge "figura sin imagen" para los casos mixtos (figura vectorial en PDF que Mistral no detectó)? Esto define si necesitamos el render-crop helper en PR #1 o puede esperar a PR #3.

2. **Costo de Mistral con base64.** El flip `include_image_base64: true` infla la response 10-100x. La v1 lo staged tras un feature flag y agrega tracking per-byte al `costService`. ¿Querés un cap duro (ej. abortar si la estimación supera $X por página) o solo el tracking informativo y revisamos en 30 días?

3. **Disponibilidad offline.** Las figuras extraídas por Mistral viven en S3 y requieren conexión al API para verse (proxy auth-gated). ¿Querés también un modo "presigned URL" para que el cliente pueda embeber la imagen directamente (más rápido, pero el token caduca)? Esto cambia el endpoint de "stream" a "redirect".

4. **Versionado del figure file.** Si re-extraemos un source (ej. cambió el PDF upstream), el `storage_path` actual se sobreescribe o versiona (S3 key con timestamp). La v1 propone overwrite. ¿Te sirve o preferís versionado inmutable (más storage, más historia)?

5. **Multi-página.** Figuras que cruzan dos páginas (raro pero real en algunos journals) — bbox por página, no global. ¿Lo dejamos como "limitación conocida" en v1 o lo manejamos en el render-crop helper desde el inicio?

Asumimos defaults: (1) badge sin imagen aceptable en v1, (2) tracking informativo sin cap duro, (3) proxy con auth (no presigned), (4) overwrite, (5) limitación conocida v1. Si querés cambiar algo, decime y actualizo el proposal antes de pasar a specs.
