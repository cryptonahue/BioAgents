/**
 * Quality gate for the local table extraction output.
 *
 * Pure function. Decides whether the local provider's output is
 * "good enough" to skip the Mistral fallback. The decision is
 * driven by two signals:
 *   - `low_table_count`: fewer than `MIN_TABLES` (3) chain heads.
 *   - `low_row_confidence`: average row confidence < `MIN_AVG_CONFIDENCE` (0.5).
 *
 * When the gate fails, the orchestrator calls Mistral. When it
 * passes, the orchestrator persists the local result and returns.
 *
 * The thresholds are exported as constants so tests and operators
 * can reference them.
 *
 * PR #2 of bioprospecting-multipage-table-merge: the gate now
 * counts CHAIN HEADS (rows with `continuesFromId === null`) instead
 * of raw fragment count. A 50-row table that spans 3 pages is 1
 * chain head, not 3 tables. The raw count is still reported as
 * `tables` for backwards compatibility (logging / diagnostics),
 * but the `low_table_count` check uses `chainHeads`.
 *
 * When `TABLE_MERGE_ENABLED` is false (the prompt walker kill
 * switch) the gate falls back to today's raw-count behavior so
 * the operator has a single switch to disable the chain-aware
 * counting.
 */

import type { ExtractedTable } from "./pdfTableExtractor";
import { isTableMergeEnabled } from "./pdfTablePromptBuilder";

export const MIN_TABLES = 3;
export const MIN_AVG_CONFIDENCE = 0.5;

export type QualityGateDecision =
  | {
      action: "pass";
      reason: "passed";
      /** Number of chain heads (rows with `continuesFromId === null`).
       * PR #2: replaces the raw fragment count for the
       * `low_table_count` check. */
      chainHeads: number;
      /** Raw number of `ExtractedTable` rows. Reported for
       * backwards compatibility (logging / diagnostics). */
      tables: number;
      avgConfidence: number;
    }
  | {
      action: "fallback";
      reason: "low_table_count";
      chainHeads: number;
      tables: number;
      avgConfidence: number;
    }
  | {
      action: "fallback";
      reason: "low_row_confidence";
      chainHeads: number;
      tables: number;
      avgConfidence: number;
    };

/**
 * Count the number of chain heads in a list of tables. A head is
 * a row that is the FIRST fragment in a chain — it has no
 * `continuesFromId` set (no outgoing FK), OR it has a self-reference
 * (a misconfigured FK that points at itself; treated as a head by
 * the cycle detection in the prompt builder).
 *
 * Tails (rows whose `continuesFromId` points at a row in the list)
 * are NOT counted as heads — they belong to the head's chain.
 *
 * Public helper — exported so callers (orchestrator, scripts) can
 * reuse the same counting logic.
 */
export function chainHeadCount(tables: ExtractedTable[]): number {
  if (!tables || tables.length === 0) return 0;

  let count = 0;
  for (const t of tables) {
    // A row is a head when it has no outgoing FK at all. (Rows
    // whose FK points to a row in the list are tails, not heads;
    // rows whose FK points to a row outside the list are orphans
    // — they DO have an outgoing FK, so they are not heads. The
    // "no outgoing FK" criterion is the cleanest definition and
    // matches what the prompt builder's head detection does.)
    if (t.continuesFromId == null) {
      count++;
    }
  }
  return count;
}

/**
 * Evaluate the quality of a list of extracted tables. Returns the
 * decision the orchestrator should act on, plus the diagnostic
 * numbers (chain head count, raw table count, average row
 * confidence) that drove it.
 *
 * PR #2: when `TABLE_MERGE_ENABLED` is true, the gate uses
 * `chainHeadCount` for the `low_table_count` check (a 3-page
 * chain counts as 1). When the kill switch is off, the gate
 * falls back to the raw fragment count for backwards compatibility.
 */
export function evaluateQualityGate(
  tables: ExtractedTable[],
): QualityGateDecision {
  const tableCount = tables.length;
  const useChainCount = isTableMergeEnabled();
  const headCount = useChainCount ? chainHeadCount(tables) : tableCount;

  const rowConfidences: number[] = [];
  for (const t of tables) {
    for (const row of t.rows) {
      rowConfidences.push(rowConfidence(row));
    }
  }

  const avgConfidence =
    rowConfidences.length === 0
      ? 0
      : rowConfidences.reduce((a, b) => a + b, 0) / rowConfidences.length;

  if (headCount < MIN_TABLES) {
    return {
      action: "fallback",
      reason: "low_table_count",
      chainHeads: headCount,
      tables: tableCount,
      avgConfidence,
    };
  }
  if (avgConfidence < MIN_AVG_CONFIDENCE) {
    return {
      action: "fallback",
      reason: "low_row_confidence",
      chainHeads: headCount,
      tables: tableCount,
      avgConfidence,
    };
  }
  return {
    action: "pass",
    reason: "passed",
    chainHeads: headCount,
    tables: tableCount,
    avgConfidence,
  };
}

/**
 * Per-row confidence: `min(1, totalChars / (numCells * 8))`. Empty
 * cells (`"-"`) count as 0 chars. This is the same formula used by
 * the local provider when computing the table-level confidence; the
 * gate uses it on the post-extraction rows to keep the two signals
 * aligned.
 */
export function rowConfidence(row: string[]): number {
  const totalChars = row.reduce(
    (n, cell) => n + (cell === "-" || !cell ? 0 : cell.length),
    0,
  );
  return Math.min(1, totalChars / Math.max(1, row.length * 8));
}
