/**
 * Read wrapper for `research_evidence_tables` and
 * `research_evidence_figures`. Centralizes the loader so the
 * bioprospecting extractor, the viewer endpoint (PR #2), and any
 * future caller share the same query shape.
 *
 * The shape returned matches the in-memory `ExtractedTable` /
 * `ExtractedFigure` types so callers can pass the result
 * straight to `buildTablesPromptSection` or to the viewer JSON
 * response.
 */

import {
  loadFiguresForSource as loadFiguresFromService,
  loadTablesForSource as loadTablesFromService,
  type ExtractedFigure,
  type ExtractedTable,
} from "../files/pdfTableExtractor";

// Re-export the underlying types so the rest of the researchBrain
// package doesn't need to reach into `services/files` for them.
export type { ExtractedFigure, ExtractedTable };

/**
 * Load all persisted tables for a source, in `(page, tableIndex)`
 * ascending order. Returns `[]` if the source has no tables or the
 * DB read fails (the underlying loader logs and returns `[]` on
 * error so callers can rely on a non-throwing signature).
 */
export async function loadTablesForSource(
  sourceId: string,
): Promise<ExtractedTable[]> {
  const rows = await loadTablesFromService(sourceId);
  return rows.map((row) => ({
    page: row.page,
    tableIndex: row.table_index,
    headers: row.headers ?? [],
    rows: row.rows ?? [],
    bbox: row.bbox,
    confidence: Number(row.extraction_confidence),
    markdown: row.markdown,
  }));
}

/**
 * Load all persisted figures for a source, in `(page, figureIndex)`
 * ascending order. Returns `[]` on no rows or DB error.
 */
export async function loadFiguresForSource(
  sourceId: string,
): Promise<ExtractedFigure[]> {
  const rows = await loadFiguresFromService(sourceId);
  return rows.map((row) => ({
    page: row.page,
    figureIndex: row.figure_index,
    bbox: row.bbox,
    caption: row.caption,
  }));
}
