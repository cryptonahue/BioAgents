/**
 * Pure helper that turns a list of `ExtractedTable` into the
 * `tables:` block injected into the bioprospecting LLM prompt.
 *
 * Output format (per spec):
 *
 *   tables:
 *     page=1 table=0
 *     | Treatment | Yield [mg/mL] |
 *     | --- | --- |
 *     | A | 10 |
 *     | B | 20 |
 *     page=1 table=1
 *     | ...
 *
 * PR #2 of bioprospecting-multipage-table-merge — multi-page chain
 * walk + defensive merge:
 *
 *   - Fragments linked by `continuesFromId` collapse into a SINGLE
 *     `tables:` block whose body is the concatenation of every
 *     fragment in page-ascending order, with one `page=N table=M`
 *     sub-marker per fragment. This is the chain walk.
 *
 *   - Fragments that are NOT linked by FK but are consecutive
 *     `(page, tableIndex)` pairs that match the `hard` heuristic
 *     (no `Table N.` prefix on T₂ AND headers match) are folded
 *     into the head's chain at prompt-build time. This is the
 *     defensive merge — the escape hatch for cached rows that
 *     pre-date the FK column.
 *
 *   - Cycle detection via `Set<string>`: a repeat-id terminates
 *     the walk for that chain (the current node is treated as a
 *     fresh head). The `MAX_CHAIN_DEPTH` cap (10) is also a
 *     defensive stop on misconfigured chains.
 *
 *   - `TABLE_MERGE_ENABLED` env var (default `true`) gates the
 *     chain walk + defensive merge. When disabled, the helper
 *     falls back to the original per-fragment rendering.
 *
 * Empty cells in `rows` are normalized to `"-"` (the spec says
 * empty cells in extracted tables render as `-`).
 *
 * If the input list is empty, returns `""` — the caller checks
 * for empty and skips the injection in that case.
 */

import type { ExtractedTable } from "./pdfTableExtractor";

/** Env var key for the prompt chain walker kill switch. Default `true`. */
export const TABLE_MERGE_ENABLED_ENV = "TABLE_MERGE_ENABLED";

/** Maximum number of fragments in a single chain. Mirrors
 * `localPdfTableProvider.MAX_CHAIN_DEPTH` — the prompt walker and
 * the detector use the same defensive cap. */
export const MAX_CHAIN_DEPTH = 10;

/** TDZ-safe resolver for the `TABLE_MERGE_ENABLED` kill switch. */
const ENABLED_KEY = "__bioprospectingTableMergeEnabled";

function resolveMergeEnabled(): boolean {
  const cached = (globalThis as any)[ENABLED_KEY] as boolean | undefined;
  if (typeof cached === "boolean") return cached;
  const raw = (process.env[TABLE_MERGE_ENABLED_ENV] ?? "true")
    .toString()
    .toLowerCase()
    .trim();
  const enabled = raw === "true" || raw === "1" || raw === "yes";
  (globalThis as any)[ENABLED_KEY] = enabled;
  return enabled;
}

/** Public accessor for the kill switch. Memoized via `globalThis` so
 * Bun workers do not hit TDZ on `process.env`. */
export function isTableMergeEnabled(): boolean {
  return resolveMergeEnabled();
}

/** Test-only: force the next `isTableMergeEnabled()` call to re-read
 * the env var. */
export function _resetTableMergeEnabledForTests(): void {
  delete (globalThis as any)[ENABLED_KEY];
}

// ---------------------------------------------------------------------------
// Header normalization for the `hard` heuristic (defensive merge)
// ---------------------------------------------------------------------------

function normalizeHeaderForMatch(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function headersMatchForMerge(a: string[], b: string[]): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normalizeHeaderForMatch(a[i]) !== normalizeHeaderForMatch(b[i])) {
      return false;
    }
  }
  return true;
}

const TABLE_PREFIX_RE = /^Table\s+\d+\.?\s*/i;

function firstCellTextForMerge(t: ExtractedTable): string {
  if (!t.rows || t.rows.length === 0) return "";
  for (const row of t.rows) {
    if (row && row.some((c) => c && c.trim() && c.trim() !== "-")) {
      return (row[0] || "").trim();
    }
  }
  return (t.rows[0]?.[0] || "").trim();
}

function hasTablePrefixForMerge(t: ExtractedTable): boolean {
  const first = firstCellTextForMerge(t);
  if (!first) return false;
  return TABLE_PREFIX_RE.test(first);
}

// ---------------------------------------------------------------------------
// Chain data model
// ---------------------------------------------------------------------------

/** A node in a chain: the fragment + its in-batch synthetic
 * pointer so the walker can resolve forward references. */
interface ChainNode {
  table: ExtractedTable;
  /** In-batch synthetic pointer ("<page>-<tableIndex>") used to
   * resolve `continuesFromId` to the previous node without needing
   * a real DB id. The `id` field is preferred when present (the
   * post-INSERT case). */
  pointer: string;
  /** Real DB id when present. */
  id: string | null;
}

interface Chain {
  head: ChainNode;
  fragments: ChainNode[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildTablesPromptSection(tables: ExtractedTable[]): string {
  if (!tables || tables.length === 0) return "";

  // Kill switch: when the env var disables the chain walker, fall
  // back to the original per-fragment rendering (PR1 behavior).
  if (!isTableMergeEnabled()) {
    return renderPerFragment(tables);
  }

  // 1. Build the chain map. Each fragment gets a synthetic pointer
  //    and (when present) a real id. We then walk the FK chain.
  const chains = buildChains(tables);

  // 2. For each chain head, sort fragments by (page, tableIndex)
  //    ascending. The chain walk order is head-first then forward.
  for (const chain of chains) {
    chain.fragments.sort(
      (a, b) =>
        a.table.page - b.table.page ||
        a.table.tableIndex - b.table.tableIndex,
    );
  }

  // 3. Sort chains by the head's (page, tableIndex) ascending.
  chains.sort(
    (a, b) =>
      a.head.table.page - b.head.table.page ||
      a.head.table.tableIndex - b.head.table.tableIndex,
  );

  // 4. Emit one `tables:` block per chain.
  const lines: string[] = [];
  for (const chain of chains) {
    if (lines.length === 0) {
      lines.push("tables:");
    }
    for (let i = 0; i < chain.fragments.length; i++) {
      const node = chain.fragments[i];
      const t = node.table;
      lines.push(`  page=${t.page} table=${t.tableIndex}`);

      const headers = t.headers.map(normalizeCell);
      if (headers.length > 0) {
        lines.push(renderHeaderRow(headers));
        lines.push(renderSeparator(headers.length));
      }

      for (const row of t.rows) {
        const padded = [...row];
        while (padded.length < headers.length) padded.push("-");
        const normalized = padded.map(normalizeCell);
        lines.push(renderDataRow(normalized));
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-fragment fallback (used when TABLE_MERGE_ENABLED=false)
// ---------------------------------------------------------------------------

function renderPerFragment(tables: ExtractedTable[]): string {
  const grouped = [...tables].sort(
    (a, b) => a.page - b.page || a.tableIndex - b.tableIndex,
  );

  const lines: string[] = ["tables:"];

  for (const table of grouped) {
    lines.push(`  page=${table.page} table=${table.tableIndex}`);

    const headers = table.headers.map(normalizeCell);
    if (headers.length > 0) {
      lines.push(renderHeaderRow(headers));
      lines.push(renderSeparator(headers.length));
    }

    for (const row of table.rows) {
      const padded = [...row];
      while (padded.length < headers.length) padded.push("-");
      const normalized = padded.map(normalizeCell);
      lines.push(renderDataRow(normalized));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Chain construction
// ---------------------------------------------------------------------------

/**
 * Group the input into chains.
 *
 *   1. Build a pointer → node map and id → node map for fast lookup.
 *   2. Build a "prev" map: each node → the node that points at it
 *      via `continuesFromId` (the previous fragment in the chain).
 *      The prev node is resolved by id first, then by synthetic
 *      pointer. If the FK doesn't resolve to a node in this batch,
 *      the node has no prev in this batch.
 *   3. Identify chain heads: a fragment is a head when its prev
 *      in this batch is null. Tails have a prev; their chain is
 *      reached by walking forward from a head through "next"
 *      pointers (the node whose prev is the current node).
 *   4. For each head, walk forward (head → next whose prev is head
 *      → next whose prev is that → ...) with cycle detection via
 *      a `Set<string>` of visited pointers. Cap at MAX_CHAIN_DEPTH.
 *   5. After the FK walk, apply the defensive merge: scan
 *      unlinked fragments (singleton chains) for consecutive
 *      `(page, tableIndex)` pairs on adjacent pages that match
 *      the `hard` heuristic, and fold them into the closest
 *      preceding head.
 */
function buildChains(tables: ExtractedTable[]): Chain[] {
  // 1. Build nodes + lookup tables.
  const nodes: ChainNode[] = tables.map((t) => ({
    table: t,
    pointer: `${t.page}-${t.tableIndex}`,
    id: t.id ?? null,
  }));

  // Lookup: pointer → node, id → node. The walker tries the id
  // first, then falls back to the pointer (handles both the
  // pre-INSERT synthetic pointer case and the post-INSERT real id
  // case).
  const byPointer = new Map<string, ChainNode>();
  const byId = new Map<string, ChainNode>();
  for (const n of nodes) {
    byPointer.set(n.pointer, n);
    if (n.id) byId.set(n.id, n);
  }

  // 2. Build the "prev" map: each node's `continuesFromId`
  //    resolves to the PREVIOUS node in the chain (the fragment
  //    it continues). The walker follows prev forward through the
  //    chain. (In the chain `head → mid → tail`, head.prev = null,
  //    mid.prev = head, tail.prev = mid.)
  //
  //    Self-references (a fragment whose FK points to its own id)
  //    are treated as `null` prev: the fragment is a head of its
  //    own (singleton) chain, and the cycle detection in the
  //    walker prevents the loop from re-visiting it.
  const prev = new Map<string, ChainNode | null>();
  for (const n of nodes) {
    const fk = n.table.continuesFromId;
    if (!fk) {
      prev.set(n.pointer, null);
      continue;
    }
    const prevNode: ChainNode | null =
      byId.get(fk) ?? byPointer.get(fk) ?? null;
    if (prevNode === n) {
      // Self-reference → null out the prev so this fragment is
      // treated as a head. The walker's visited Set will prevent
      // a loop (the next-of lookup is filtered by `visited`).
      prev.set(n.pointer, null);
    } else {
      prev.set(n.pointer, prevNode);
    }
  }

  // 3. Build a forward map (pointer → next-node) for the walk.
  //    The next-node is the unvisited node whose prev is `cur`.
  //    For small N (chains of ≤ 10 fragments) this is fine to
  //    compute lazily by scanning nodes.
  const nextOf = (cur: ChainNode): ChainNode | null => {
    for (const n of nodes) {
      if (prev.get(n.pointer) === cur) return n;
    }
    return null;
  };

  // 4. Identify chain heads. A fragment is a head when its prev
  //    in this batch is null.
  const chains: Chain[] = [];
  for (const start of nodes) {
    const prevNode = prev.get(start.pointer);
    if (prevNode) continue; // not a head — another node in this batch points to it

    // Walk forward through the chain with cycle detection.
    const fragments: ChainNode[] = [];
    const visited = new Set<string>();
    let cur: ChainNode | null = start;
    while (cur && !visited.has(cur.pointer)) {
      visited.add(cur.pointer);
      fragments.push(cur);
      if (fragments.length >= MAX_CHAIN_DEPTH) break;
      cur = nextOf(cur);
    }

    chains.push({ head: start, fragments });
  }

  // 4. Defensive merge: unlinked fragments that the detector missed
  //    (no `continuesFromId` set, but adjacent `(page, tableIndex)`
  //    pair matches the `hard` heuristic) get folded into the
  //    closest preceding head's chain. We scan tables in
  //    (page, tableIndex) ascending order.
  applyDefensiveMerge(chains, nodes);

  return chains;
}

/**
 * Defensive merge pass. For every unlinked fragment (a head with
 * no chain in the FK map), check if a consecutive pair on adjacent
 * pages matches the `hard` heuristic. If yes, fold the fragment
 * into the closest preceding chain's tail.
 *
 * The walk order is `(page, tableIndex)` ascending. Two fragments
 * are "consecutive" when their pages differ by 1 AND they share
 * the same `tableIndex`.
 */
function applyDefensiveMerge(chains: Chain[], nodes: ChainNode[]): void {
  if (chains.length === 0 || nodes.length === 0) return;

  // 1. Build the chain map: pointer → chain. The defensive merge
  //    appends a fragment to the closest preceding chain in walk
  //    order.
  const chainByPointer = new Map<string, Chain>();
  for (const c of chains) {
    for (const f of c.fragments) chainByPointer.set(f.pointer, c);
  }

  // 2. Build the set of unlinked fragments: any fragment in a
  //    chain of length 1 (i.e., a singleton). The defensive merge
  //    only folds fragments that the FK walk did NOT chain —
  //    chains from the FK walk are not touched here.
  const unlinked = new Set<string>();
  for (const c of chains) {
    if (c.fragments.length === 1) {
      unlinked.add(c.head.pointer);
    }
  }

  // 3. Walk nodes in (page, tableIndex) ascending order. For each
  //    pair, if BOTH fragments are unlinked AND the pair matches
  //    the `hard` heuristic (no `Table N.` prefix on T₂ AND
  //    headers match case/whitespace), fold the second into the
  //    first's chain.
  const sorted = [...nodes].sort(
    (a, b) =>
      a.table.page - b.table.page || a.table.tableIndex - b.table.tableIndex,
  );

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (!unlinked.has(cur.pointer)) continue;
    if (cur.table.continuesFromId) continue; // already chained

    // Find the closest preceding fragment on page cur.page - 1
    // with the same tableIndex.
    const prev = sorted
      .slice(0, i)
      .reverse()
      .find(
        (n) =>
          n.table.page === cur.table.page - 1 &&
          n.table.tableIndex === cur.table.tableIndex,
      );
    if (!prev) continue;
    if (!unlinked.has(prev.pointer)) continue; // prev already chained — leave it
    if (prev.table.continuesFromId) continue;

    // Apply the `hard` heuristic. If it matches, fold.
    if (hasTablePrefixForMerge(cur.table)) continue;
    if (!headersMatchForMerge(prev.table.headers, cur.table.headers)) continue;

    // Fold: append `cur` to the same chain as `prev`. If `prev`
    // is currently its own single-fragment chain, merge them.
    const prevChain = chainByPointer.get(prev.pointer);
    const curChain = chainByPointer.get(cur.pointer);
    if (!prevChain || !curChain) continue;
    if (prevChain === curChain) continue; // already in same chain

    // Append cur's fragments to prev's chain, then drop the
    // empty cur chain.
    for (const f of curChain.fragments) {
      prevChain.fragments.push(f);
      chainByPointer.set(f.pointer, prevChain);
    }
    const idx = chains.indexOf(curChain);
    if (idx >= 0) chains.splice(idx, 1);
  }
}

// ---------------------------------------------------------------------------
// Cell / row rendering helpers (unchanged from the v1 implementation)
// ---------------------------------------------------------------------------

function normalizeCell(cell: string | null | undefined): string {
  if (cell == null) return "-";
  const trimmed = String(cell).trim();
  return trimmed === "" ? "-" : trimmed;
}

function renderHeaderRow(cells: string[]): string {
  return `    | ${cells.join(" | ")} |`;
}

function renderDataRow(cells: string[]): string {
  return `    | ${cells.join(" | ")} |`;
}

function renderSeparator(n: number): string {
  return `    | ${Array.from({ length: n }, () => "---").join(" | ")} |`;
}
