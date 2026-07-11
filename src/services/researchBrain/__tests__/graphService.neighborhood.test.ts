/**
 * Unit tests for `composeNeighborhood` in `graphService.ts`
 * (`graph-neighborhood-edges`).
 *
 * The endpoint's whole reason to exist is the INDUCED SUBGRAPH: the
 * edges BETWEEN the neighbors, not just the spokes to the focus. So
 * that is what these tests hammer:
 *
 *   1.  entity focus -> typed nodes (entity|compound|source only — facts
 *       are edges, never nodes) and typed+weighted edges
 *   2.  induced `co_occurs_with` between two neighbor compounds
 *   3.  induced `reports` between a neighbor compound and a neighbor source
 *   4.  induced `related_source` between two neighbor sources (this is the
 *       path that exercises the citation candidate fix end-to-end)
 *   5.  PRUNING: a co-occurring compound OUTSIDE the neighborhood yields
 *       neither a node nor an edge
 *   6.  PRUNING: a citation neighbor OUTSIDE the neighborhood yields
 *       neither a node nor an edge
 *   7.  DEDUPE: the same unordered pair + type is emitted once (both
 *       seeds of a `related_source` pair report the same edge)
 *   8.  every edge endpoint id exists in `nodes`
 *   9.  edges are sorted by weight desc
 *  10.  FAN-OUT BOUND: only `fanout` neighbors are expanded per class
 *       (asserted on the co-occurrence RPC call count)
 *  11.  SHORT-CIRCUIT: < 2 neighbors in a class -> no expansion at all
 *  12.  compound focus: 404-signal (`FocusNotFoundError`) on an unknown id
 *  13.  source focus: 404-signal on an unknown id
 *  14.  entity focus that matches nothing -> focus node, zero edges
 *
 * Hermetic: the Supabase client is a fixture-driven fake serving BOTH
 * the RPCs (`graph_entity_expand`, `graph_top_co_occurring`) and the
 * table reads used by `getFactLinks` / `getSourcesByIds` /
 * `getCompoundsByIds` / `buildCitationGraph`.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Fixture-driven fake DB (tables + RPCs)
// ---------------------------------------------------------------------------

type SourceRow = {
  id: string;
  title: string;
  doi: string | null;
  url: string | null;
  trust_tier: string;
};

type FactRow = {
  id: string;
  source_id: string;
  compound_canonical_id: string | null;
  species_taxon_id: string | null;
};

type CompoundRow = {
  compound_id: string;
  canonical_name: string;
  fact_count: number;
};

/**
 * RPC payloads are returned VERBATIM as Supabase's `data`:
 * `graph_entity_expand` yields a single jsonb object,
 * `graph_top_co_occurring` yields a row array.
 */
type RpcHandlers = Record<string, (args: any) => unknown>;

type Fixture = {
  sources: SourceRow[];
  facts: FactRow[];
  compounds: CompoundRow[];
  rpc: RpcHandlers;
};

type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "neq"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "ilike"; column: string; value: string }
  | { op: "notNull"; column: string };

type RpcCall = { name: string; args: any };

function matches(row: Record<string, unknown>, filter: Filter): boolean {
  const cell = row[filter.column];
  switch (filter.op) {
    case "eq":
      return cell === filter.value;
    case "neq":
      return cell !== filter.value;
    case "in":
      return filter.values.includes(cell);
    case "ilike":
      return (
        typeof cell === "string" &&
        cell.toLowerCase() === String(filter.value).toLowerCase()
      );
    case "notNull":
      return cell != null;
  }
}

function fakeDb(fixture: Fixture, rpcCalls: RpcCall[]) {
  const rowsFor = (table: string): Array<Record<string, unknown>> => {
    switch (table) {
      case "research_sources":
        return fixture.sources as unknown as Array<Record<string, unknown>>;
      case "research_bioprospecting_facts":
        return fixture.facts as unknown as Array<Record<string, unknown>>;
      case "research_graph_compound_aggregates":
        return fixture.compounds as unknown as Array<Record<string, unknown>>;
      default:
        return [];
    }
  };

  const makeBuilder = (table: string) => {
    const filters: Filter[] = [];
    let limitValue: number | null = null;

    const resolve = () => {
      let rows = rowsFor(table).filter((row) =>
        filters.every((f) => matches(row, f)),
      );
      if (limitValue != null) rows = rows.slice(0, limitValue);
      return rows;
    };

    const builder: any = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push({ op: "eq", column, value });
        return builder;
      },
      neq: (column: string, value: unknown) => {
        filters.push({ op: "neq", column, value });
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push({ op: "in", column, values });
        return builder;
      },
      ilike: (column: string, value: string) => {
        filters.push({ op: "ilike", column, value });
        return builder;
      },
      not: (column: string, op: string, value: unknown) => {
        if (op === "is" && value === null) {
          filters.push({ op: "notNull", column });
        }
        return builder;
      },
      limit: (n: number) => {
        limitValue = n;
        return builder;
      },
      maybeSingle: () =>
        Promise.resolve({ data: resolve()[0] ?? null, error: null }),
    };

    Object.defineProperty(builder, "then", {
      get() {
        return (onFulfilled: any, onRejected: any) =>
          Promise.resolve({ data: resolve(), error: null }).then(
            onFulfilled,
            onRejected,
          );
      },
    });

    return builder;
  };

  return {
    from: (table: string) => makeBuilder(table),
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args });
      const handler = fixture.rpc[name];
      const data = handler ? handler(args) : [];
      return Promise.resolve({ data, error: null });
    },
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __graphNeighborhoodTestClient: (() => any) | undefined;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__graphNeighborhoodTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__graphNeighborhoodTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__graphNeighborhoodTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__graphNeighborhoodTestClient ?? (() => null))(),
}));

import {
  composeNeighborhood,
  compoundNodeId,
  entityNodeId,
  FocusNotFoundError,
  sourceNodeId,
  type NeighborhoodEdge,
} from "../graphService";

let rpcCalls: RpcCall[];

function useFixture(fixture: Fixture): void {
  rpcCalls = [];
  const client = fakeDb(fixture, rpcCalls);
  globalThis.__graphNeighborhoodTestClient = () => client;
}

// --- fixture builders -------------------------------------------------------

const source = (
  id: string,
  title: string,
  doi: string | null = null,
): SourceRow => ({ id, title, doi, url: null, trust_tier: "internal" });

const compound = (
  compound_id: string,
  canonical_name: string,
  fact_count = 1,
): CompoundRow => ({ compound_id, canonical_name, fact_count });

let factSeq = 0;
const fact = (
  source_id: string,
  compound_canonical_id: string | null,
  species_taxon_id: string | null = null,
): FactRow => ({
  id: `f${++factSeq}`,
  source_id,
  compound_canonical_id,
  species_taxon_id,
});

const edgeOf = (
  edges: NeighborhoodEdge[],
  type: string,
  a: string,
  b: string,
): NeighborhoodEdge | undefined =>
  edges.find(
    (e) =>
      e.type === type &&
      ((e.source === a && e.target === b) || (e.source === b && e.target === a)),
  );

/**
 * The canonical fixture:
 *
 *   entity "antifungal"
 *     ├─ compounds  C1 (fc 5), C2 (fc 3)          [neighbors]
 *     └─ sources    S1, S2                         [neighbors]
 *
 *   C1 co-occurs with C2 (2) AND with CX (9)       CX is NOT a neighbor
 *   S1 and S2 both report C1                       -> related_source (shared compound)
 *   S3 also reports C1                             S3 is NOT a neighbor
 */
function canonicalFixture(): Fixture {
  return {
    sources: [
      source("S1", "Paper one", "10.1000/one"),
      source("S2", "Paper two", "10.1000/two"),
      source("S3", "Paper three (outside)", "10.1000/three"),
    ],
    facts: [
      fact("S1", "C1"),
      fact("S1", "C2"),
      fact("S2", "C1"),
      fact("S3", "C1"),
    ],
    compounds: [
      compound("C1", "Compound one", 5),
      compound("C2", "Compound two", 3),
      compound("CX", "Compound outside", 9),
    ],
    rpc: {
      graph_entity_expand: () => ({
        compounds: [
          { id: "C1", canonical_name: "Compound one", fact_count: 5 },
          { id: "C2", canonical_name: "Compound two", fact_count: 3 },
        ],
        facts: [],
        sources: [
          {
            id: "S1",
            title: "Paper one",
            doi: "10.1000/one",
            url: null,
            fact_count: 4,
          },
          {
            id: "S2",
            title: "Paper two",
            doi: "10.1000/two",
            url: null,
            fact_count: 2,
          },
        ],
      }),
      graph_top_co_occurring: (args: { p_compound_id: string }) => {
        if (args.p_compound_id === "C1") {
          return [
            { compound_id: "C2", canonical_name: "Compound two", fact_count: 2 },
            {
              compound_id: "CX",
              canonical_name: "Compound outside",
              fact_count: 9,
            },
          ];
        }
        if (args.p_compound_id === "C2") {
          return [
            { compound_id: "C1", canonical_name: "Compound one", fact_count: 2 },
          ];
        }
        return [];
      },
    },
  };
}

beforeEach(() => {
  useFixture(canonicalFixture());
});

// ---------------------------------------------------------------------------
// Entity focus — the de-starring path
// ---------------------------------------------------------------------------

describe("composeNeighborhood — entity focus", () => {
  it("returns typed nodes (no fact nodes) and typed, weighted edges", async () => {
    const result = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });

    expect(result.focus.id).toBe(entityNodeId("bioactivity", "antifungal"));
    expect(result.focus.type).toBe("entity");

    // Facts are EDGES, never nodes.
    for (const node of result.nodes) {
      expect(["entity", "compound", "source"]).toContain(node.type);
    }
    // focus + C1 + C2 + S1 + S2 (CX and S3 are outside the neighborhood)
    expect(result.nodes).toHaveLength(5);

    for (const edge of result.edges) {
      expect(typeof edge.weight).toBe("number");
      expect(edge.type).toBeTruthy();
    }
    expect(result.meta.counts.nodes).toBe(result.nodes.length);
    expect(result.meta.counts.edges).toBe(result.edges.length);
  });

  it("emits the spokes to compounds and sources", async () => {
    const { edges, focus } = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });

    expect(
      edgeOf(edges, "has_compound", focus.id, compoundNodeId("C1"))?.weight,
    ).toBe(5);
    expect(
      edgeOf(edges, "has_source", focus.id, sourceNodeId("S1"))?.weight,
    ).toBe(4);
  });

  it("emits the INDUCED edges between the neighbors (this is the de-star)", async () => {
    const { edges, focus } = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });

    // compound <-> compound
    const coOccur = edgeOf(
      edges,
      "co_occurs_with",
      compoundNodeId("C1"),
      compoundNodeId("C2"),
    );
    expect(coOccur).toBeDefined();
    expect(coOccur!.weight).toBe(2);

    // compound <-> source (fact-backed)
    const reports = edgeOf(
      edges,
      "reports",
      compoundNodeId("C1"),
      sourceNodeId("S1"),
    );
    expect(reports).toBeDefined();
    expect(reports!.weight).toBe(1);

    // source <-> source (citation graph; both share compound C1 -> weight 3)
    const related = edgeOf(
      edges,
      "related_source",
      sourceNodeId("S1"),
      sourceNodeId("S2"),
    );
    expect(related).toBeDefined();
    expect(related!.weight).toBe(3);

    // None of the three is incident to the focus node.
    for (const e of [coOccur!, reports!, related!]) {
      expect(e.source).not.toBe(focus.id);
      expect(e.target).not.toBe(focus.id);
    }
  });

  it("prunes cross-edges whose other endpoint is outside the neighborhood", async () => {
    const { nodes, edges } = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });

    const ids = new Set(nodes.map((n) => n.id));
    // CX co-occurs with C1 (weight 9 — the strongest hit) but is NOT a
    // neighbor. S3 shares C1 with S1/S2 but is NOT a neighbor either.
    expect(ids.has(compoundNodeId("CX"))).toBe(false);
    expect(ids.has(sourceNodeId("S3"))).toBe(false);
    for (const e of edges) {
      expect(e.source).not.toBe(compoundNodeId("CX"));
      expect(e.target).not.toBe(compoundNodeId("CX"));
      expect(e.source).not.toBe(sourceNodeId("S3"));
      expect(e.target).not.toBe(sourceNodeId("S3"));
    }
  });

  it("dedupes the same unordered pair + type (both seeds report S1<->S2)", async () => {
    const { edges } = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });

    const related = edges.filter((e) => e.type === "related_source");
    expect(related).toHaveLength(1);

    const coOccur = edges.filter((e) => e.type === "co_occurs_with");
    expect(coOccur).toHaveLength(1);
  });

  it("never references an edge endpoint that is absent from nodes", async () => {
    const { nodes, edges } = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it("sorts edges by weight desc", async () => {
    const { edges } = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i - 1].weight).toBeGreaterThanOrEqual(edges[i].weight);
    }
  });

  it("returns a focus-only neighborhood when the entity matches nothing", async () => {
    const base = canonicalFixture();
    useFixture({
      ...base,
      rpc: {
        ...base.rpc,
        graph_entity_expand: () => ({ compounds: [], facts: [], sources: [] }),
      },
    });

    const result = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "nothing-matches-this",
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe(result.focus.id);
    expect(result.edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fan-out bound (the N+1 guard)
// ---------------------------------------------------------------------------

describe("composeNeighborhood — fan-out bound", () => {
  it("expands at most `fanout` neighbors per class", async () => {
    const base = canonicalFixture();
    useFixture({
      ...base,
      rpc: {
        ...base.rpc,
        graph_entity_expand: () => ({
          compounds: [
            { id: "C1", canonical_name: "one", fact_count: 5 },
            { id: "C2", canonical_name: "two", fact_count: 4 },
            { id: "C3", canonical_name: "three", fact_count: 3 },
            { id: "C4", canonical_name: "four", fact_count: 2 },
            { id: "C5", canonical_name: "five", fact_count: 1 },
          ],
          facts: [],
          sources: [],
        }),
      },
    });

    await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
      fanout: 1,
    });

    const coOccurCalls = rpcCalls.filter(
      (c) => c.name === "graph_top_co_occurring",
    );
    // fanout=1 -> exactly ONE expansion, on the highest-fact_count compound.
    expect(coOccurCalls).toHaveLength(1);
    expect(coOccurCalls[0].args.p_compound_id).toBe("C1");
  });

  it("short-circuits a class with fewer than 2 neighbors", async () => {
    const base = canonicalFixture();
    useFixture({
      ...base,
      rpc: {
        ...base.rpc,
        graph_entity_expand: () => ({
          compounds: [{ id: "C1", canonical_name: "one", fact_count: 5 }],
          facts: [],
          sources: [
            {
              id: "S1",
              title: "Paper one",
              doi: "10.1000/one",
              url: null,
              fact_count: 4,
            },
          ],
        }),
      },
    });

    const { edges } = await composeNeighborhood({
      type: "entity",
      kind: "bioactivity",
      value: "antifungal",
    });

    // Nothing can be INDUCED between fewer than two nodes -> no RPC, no
    // citation graph. The `reports` link (1 compound x 1 source) still fires.
    expect(
      rpcCalls.filter((c) => c.name === "graph_top_co_occurring"),
    ).toHaveLength(0);
    expect(edges.some((e) => e.type === "co_occurs_with")).toBe(false);
    expect(edges.some((e) => e.type === "related_source")).toBe(false);
    expect(
      edgeOf(edges, "reports", compoundNodeId("C1"), sourceNodeId("S1")),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Compound / source focus
// ---------------------------------------------------------------------------

describe("composeNeighborhood — compound focus", () => {
  it("returns co_occurs_with + reports spokes for a known compound", async () => {
    const { focus, edges, nodes } = await composeNeighborhood({
      type: "compound",
      id: "C1",
    });

    expect(focus.id).toBe(compoundNodeId("C1"));
    expect(focus.type).toBe("compound");
    // C2 (co-occurring) and S1/S2/S3 (fact links to C1) are the neighbors.
    expect(nodes.map((n) => n.id)).toContain(compoundNodeId("C2"));
    expect(
      edgeOf(edges, "co_occurs_with", focus.id, compoundNodeId("C2")),
    ).toBeDefined();
    expect(
      edgeOf(edges, "reports", focus.id, sourceNodeId("S1")),
    ).toBeDefined();
  });

  it("throws FocusNotFoundError (-> 404) for an unknown compound id", async () => {
    await expect(
      composeNeighborhood({ type: "compound", id: "does-not-exist" }),
    ).rejects.toBeInstanceOf(FocusNotFoundError);
  });
});

describe("composeNeighborhood — source focus", () => {
  it("returns related_source + reports spokes for a known source", async () => {
    const { focus, edges } = await composeNeighborhood({
      type: "source",
      id: "S1",
    });

    expect(focus.id).toBe(sourceNodeId("S1"));
    expect(focus.type).toBe("source");
    // S2 and S3 both share compound C1 with S1 -> citation edges.
    const related = edges.filter((e) => e.type === "related_source");
    expect(related.length).toBeGreaterThanOrEqual(1);
    expect(
      edgeOf(edges, "related_source", focus.id, sourceNodeId("S2")),
    ).toBeDefined();
    // The focus's own compounds hang off it as `reports`.
    expect(
      edgeOf(edges, "reports", compoundNodeId("C1"), focus.id),
    ).toBeDefined();
  });

  it("throws FocusNotFoundError (-> 404) for an unknown source id", async () => {
    await expect(
      composeNeighborhood({ type: "source", id: "does-not-exist" }),
    ).rejects.toBeInstanceOf(FocusNotFoundError);
  });
});
