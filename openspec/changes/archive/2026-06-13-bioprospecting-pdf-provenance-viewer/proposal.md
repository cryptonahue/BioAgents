# Proposal: Bioprospecting PDF Provenance Viewer

## Intent

Bioprospecting facts are extracted from PDFs with page + bbox provenance, but
researchers cannot visually verify those citations. Today, clicking a fact
opens nothing, forcing users to trust the extraction blindly or hunt through
raw PDFs. This change ships a viewer that renders the source PDF and overlays
a highlight box for the cited region, so provenance is auditable in one click.

## Scope

### In Scope
- Extraction pipeline: AUTO provider (`pdf-table-extractor` local-first,
  Mistral OCR fallback) on a strict quality gate (< 3 tables OR
  avg row confidence < 0.5 → fallback).
- New `research_evidence_tables` source-of-truth table; rows cached by
  `source_id` to avoid re-extraction.
- Viewer: hybrid entry — lightbox by default, "open in tab" button for the
  dedicated route `/viewer/:sourceId#bbox=...`.
- Facts without bbox fall back to the source page with a text-chunk highlight
  and a `provenance: text-only` badge.
- v1 is read-only with selection + copy; bbox is the supported provenance
  unit (no char-level offset).
- Multi-level headers preserved in markdown; empty cells render as `-`.
- Images/figures: bbox coords only, no file extraction.

### Out of Scope
- Inline cell editing (follow-up).
- Char-level provenance offsets (proposal is page + bbox only).
- Embedding-backed fact dedup (already deferred in `bioprospecting-fact-dedup`).
- PDF annotation export (PDF.js viewer is ephemeral; no write-back).

## Capabilities

### New Capabilities
- `pdf-table-extraction`: AUTO provider pipeline + strict quality gate +
  `research_evidence_tables` persistence with source-level caching.
- `pdf-provenance-viewer`: hybrid lightbox + dedicated route viewer with
  bbox overlay, page navigation, text-chunk fallback, and `provenance:
  text-only` badge.

### Modified Capabilities
- None. Existing `bioprospecting-fact-dedup` consumes fact rows unchanged;
  viewer is additive.

## Approach

Three chained PRs (each under the 400-line review budget):

1. **PR #1 — Extraction & persistence**: `pdf-table-extractor` adapter +
   Mistral OCR fallback adapter + quality gate + `research_evidence_tables`
   migration + `extractTablesForSource(sourceId)` service with cache check.
2. **PR #2 — Viewer route + lightbox**: `/viewer/:sourceId#bbox=...` route +
   PDF.js mount + bbox overlay component + "open in tab" affordance from
   the fact list.
3. **PR #3 — Text-chunk fallback + badges**: fact→chunk resolver for
   bbox-less facts, page highlight, `provenance: text-only` badge,
   selection + copy wiring.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/services/extraction/pdf-tables/` | New | `pdf-table-extractor` + Mistral OCR adapters, quality gate |
| `src/db/migrations/` | New | `research_evidence_tables` table |
| `src/routes/viewer/` | New | `/viewer/:sourceId` route + lightbox component |
| `src/services/facts/` | Modified | Wire bbox + page into fact→source lookup; add chunk fallback |
| `client/src/components/facts/` | Modified | "Open in viewer" button + provenance badge |
| `src/agents/literature/` | Modified | Trigger extraction on source ingest; persist tables |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `pdf-table-extractor` misreads scans | Med | Strict quality gate (< 3 tables OR avg row conf < 0.5) auto-falls back to Mistral OCR |
| Mistral OCR cost overrun on bulk re-ingest | Med | Cache by `source_id`; second pass is a no-op |
| Bbox coords drift between PDF render scales | Med | PDF.js renders at fixed scale (1.5×) and viewer transforms bbox; coords stored in PDF point space |
| Lightbox traps focus in deep workflows | Low | `Esc` closes; "open in tab" is one click away |
| Chained PRs desync (PR #2 lands before #1) | Low | PR #1 merges first; #2/#3 rebase against `main` not each other |

## Rollback Plan

- PR #1: drop `research_evidence_tables` migration; remove extraction
  service calls from ingest — literature agents return to current behavior.
- PR #2: remove `/viewer/:sourceId` route + lightbox component; fact list
  links become no-ops.
- PR #3: revert fact→chunk resolver and badge rendering.
- Each PR is independently revertible; no cross-PR schema coupling.

## Dependencies

- `pdf-table-extractor` (npm) — local extractor, no network.
- `@mistralai/mistral-ocr` (or equivalent) — fallback only, triggered by
  quality gate.
- `pdfjs-dist` — viewer rendering.
- Supabase migration tooling for `research_evidence_tables`.

## Success Criteria

- [ ] Every ingested PDF produces either extracted tables in
      `research_evidence_tables` OR a recorded fallback attempt.
- [ ] Quality gate logs every fallback decision with reason
      (`low_table_count` | `low_row_confidence`).
- [ ] Re-running extraction for the same `source_id` is a cache hit
      (zero API calls, zero table writes).
- [ ] Clicking a fact with bbox opens the lightbox on the correct page with
      the highlight box visually aligned to the cited region.
- [ ] "Open in tab" navigates to `/viewer/:sourceId#bbox=...` and restores
      the same view on reload.
- [ ] Facts without bbox show the source page, highlight the resolved text
      chunk, and display a `provenance: text-only` badge.
- [ ] v1 supports selection + copy; no inline editing is exposed.
- [ ] All three PRs land under the 400-line review budget each.
