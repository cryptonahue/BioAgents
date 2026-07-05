/**
 * `useTableChain` — compute the chain (list of fragments in
 * page-ascending order) that a given table belongs to. PR #2 of
 * `bioprospecting-multipage-table-merge`.
 *
 * Pure function of the cached `evidence.tables` array. Walks
 * `continuesFromId` forward from the head (using `Set<string>` for
 * cycle detection, the same defensive pattern the prompt builder
 * uses) and returns the ordered list of fragments.
 *
 * Used by:
 *   - `EvidenceLightbox` to render the "Part X of N" badge + pager.
 *   - `ViewerPage` to show the "Part X of N" suffix on chain
 *     members in the sidebar.
 */
import { useMemo } from "preact/hooks";

import type { SourceEvidenceTable } from "./useSourceEvidence";

export interface TableChainFragment {
  id: string;
  page: number;
  tableIndex: number;
}

export function useTableChain(
  tables: SourceEvidenceTable[] | null | undefined,
  currentTableId: string | null | undefined,
): TableChainFragment[] {
  return useMemo(
    () => computeTableChain(tables ?? [], currentTableId ?? null),
    [tables, currentTableId],
  );
}

/** Pure helper — exported for tests + reuse without a hook
 * dependency. Walks the chain forward starting at the table whose
 * `id` is `startId`. The start is found by walking BACKWARDS from
 * the current table (following incoming FKs) until a head is
 * reached (a row with `continuesFromId === null`). The walk uses
 * `Set<string>` for cycle detection and caps at 10 fragments. */
export function computeTableChain(
  tables: SourceEvidenceTable[],
  startId: string | null,
): TableChainFragment[] {
  if (!tables || tables.length === 0 || !startId) return [];

  // 1. Build the lookup: id → table.
  const byId = new Map<string, SourceEvidenceTable>();
  for (const t of tables) {
    if (t.id) byId.set(t.id, t);
  }

  // 2. Find the start table.
  let cur: SourceEvidenceTable | undefined = byId.get(startId);
  if (!cur) return [];

  // 3. Walk backwards from the start to the head. A row is a
  //    head when `continuesFromId` is null. The start itself
  //    might already be a head, or it might be deep in a chain.
  //    Use cycle detection (visited set) and a 10-iteration cap
  //    as defensive stops.
  const visitedBack = new Set<string>();
  while (
    cur &&
    cur.continuesFromId &&
    !visitedBack.has(cur.id) &&
    visitedBack.size < 10
  ) {
    visitedBack.add(cur.id);
    const prev = byId.get(cur.continuesFromId);
    if (!prev) break;
    cur = prev;
  }

  if (!cur) return [];

  // 4. Walk forward from the head, collecting the chain.
  const head: SourceEvidenceTable = cur;
  const chain: TableChainFragment[] = [];
  const visited = new Set<string>();
  let walk: SourceEvidenceTable | undefined = head;
  while (walk && !visited.has(walk.id) && chain.length < 10) {
    visited.add(walk.id);
    chain.push({
      id: walk.id,
      page: walk.page,
      tableIndex: walk.tableIndex,
    });
    // Find the next fragment whose `continuesFromId` is this
    // one's id. (In practice a chain has at most one such row.)
    const next = tables.find(
      (t) => t.continuesFromId === walk!.id && t.id !== walk!.id,
    );
    walk = next;
  }

  // 5. Sort by (page, tableIndex) ascending so the "Part X of N"
  //    ordering is consistent with the page-by-page render.
  chain.sort((a, b) => a.page - b.page || a.tableIndex - b.tableIndex);
  return chain;
}
