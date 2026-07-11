/**
 * Unit tests for the citation graph service module
 * (`src/services/researchBrain/citationGraph.ts`).
 *
 * v1 is LLM-free: the citation graph is computed from SQL joins on
 * `research_bioprospecting_facts.compound_canonical_id`,
 * `species_taxon_id`, and the source's DOI. The endpoint does not
 * invoke the LLM at any point.
 *
 * `graph-neighborhood-edges` REWROTE the `buildCitationGraph` half of
 * this suite. The old tests scripted a flat sequence of query results
 * and therefore encoded the bug: they asserted the behavior of a
 * candidate query that AND-filtered on `.ilike("doi", sourceDoi)`, so a
 * "green" suite proved nothing about DOI-bearing sources — the very
 * sources whose neighbors were being dropped in production.
 *
 * The harness is now a small FIXTURE-DRIVEN fake DB (`fakeDb`): tests
 * declare `{ sources, facts }` and the fake evaluates the real filter
 * chain (`eq` / `neq` / `in` / `ilike` / `not is null` / `limit`)
 * against them. Query ORDER is no longer part of the contract; the
 * DATA is. That means these tests fail if the OR-union regresses back
 * to an AND-filter.
 *
 * Coverage matrix:
 *
 *   Pure helpers (no IO):
 *     1.  computeCitationWeight: 3 compound * 3 = 9
 *     2.  computeCitationWeight: 2 species * 2 = 4
 *     3.  computeCitationWeight: doi match = 5
 *     4.  computeCitationWeight: 2+1+doi = 13
 *     5.  computeCitationWeight: zero = 0
 *     6.  deriveEdgeKinds: zero -> []
 *     7.  deriveEdgeKinds: all three
 *     8.  CITATION_GRAPH_DEFAULT_LIMIT, CITATION_GRAPH_MAX_LIMIT
 *
 *   buildCitationGraph (fixture-driven fake DB):
 *     9.  source not found -> edges=[] + sourceFound=false
 *    10.  source has no canonical keys and no DOI -> edges=[] (no
 *         arbitrary "first 500 rows" candidate scan)
 *    11.  shared compound -> 1 edge with sharedCompounds
 *    12.  shared species -> 1 edge with sharedSpecies
 *    13.  shared DOI (no other overlap) -> 1 edge, doiMatch=true, weight=5
 *    14.  REGRESSION: a DOI-bearing focus STILL returns its
 *         shared-compound neighbors (different DOI / no DOI)
 *    15.  REGRESSION: a DOI-bearing focus STILL returns its
 *         shared-species neighbors
 *    16.  DOI adds its +5 bonus ON TOP of a shared-compound edge
 *    17.  a same-DOI duplicate outranks a species-only neighbor
 *    18.  the DOI is never applied as a filter on the candidate query
 *    19.  unrelated sources are excluded
 *    20.  multiple neighbors, sorted by weight desc + limit clamp
 *    21.  repeated fact rows dedupe to one shared compound id
 *    22.  the focus source is never its own neighbor
 *    23.  `sharedCompounds` holds the INTERSECTION with the focus, not
 *         the neighbor's whole compound list
 *    24.  the candidate scan stays bounded by `candidateLimit`
 *
 * The tests are hermetic: the Supabase service client is mocked. No DB
 * or network round-trip happens.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Fixture-driven fake DB
// ---------------------------------------------------------------------------

type SourceRow = {
  id: string;
  title: string;
  doi: string | null;
  trust_tier: string;
};

type FactRow = {
  source_id: string;
  compound_canonical_id: string | null;
  species_taxon_id: string | null;
};

type Fixture = {
  sources: SourceRow[];
  facts: FactRow[];
};

type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "neq"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "ilike"; column: string; value: string }
  | { op: "notNull"; column: string };

/** One recorded query, for call-shape assertions. */
type RecordedQuery = {
  table: string;
  columns: string;
  filters: Filter[];
  limit: number | null;
  terminal: "then" | "maybeSingle";
};

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

/**
 * A chainable Supabase-ish fake that RESOLVES AGAINST THE FIXTURE
 * instead of replaying a scripted sequence. It implements only what
 * `citationGraph.ts` uses: `.from().select().eq()/.neq()/.in()/.ilike()
 * /.not(col,"is",null).limit()` and the `then` / `maybeSingle`
 * terminals.
 */
function fakeDb(fixture: Fixture, queries: RecordedQuery[]) {
  const rowsFor = (table: string): Array<Record<string, unknown>> => {
    if (table === "research_sources") {
      return fixture.sources as unknown as Array<Record<string, unknown>>;
    }
    if (table === "research_bioprospecting_facts") {
      return fixture.facts as unknown as Array<Record<string, unknown>>;
    }
    return [];
  };

  const makeBuilder = (table: string, columns: string) => {
    const filters: Filter[] = [];
    let limitValue: number | null = null;

    const resolve = (terminal: "then" | "maybeSingle") => {
      queries.push({ table, columns, filters: [...filters], limit: limitValue, terminal });
      let rows = rowsFor(table).filter((row) =>
        filters.every((f) => matches(row, f)),
      );
      if (limitValue != null) rows = rows.slice(0, limitValue);
      return rows;
    };

    const builder: any = {
      select: (cols: string) => makeBuilder(table, cols),
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
      maybeSingle: () => {
        const rows = resolve("maybeSingle");
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
    };

    Object.defineProperty(builder, "then", {
      get() {
        return (onFulfilled: any, onRejected: any) =>
          Promise.resolve({ data: resolve("then"), error: null }).then(
            onFulfilled,
            onRejected,
          );
      },
    });

    return builder;
  };

  return {
    from: (table: string) => makeBuilder(table, "*"),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __citationGraphTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__citationGraphTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__citationGraphTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__citationGraphTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__citationGraphTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__citationGraphTestClient ?? (() => null))(),
}));

import {
  buildCitationGraph,
  computeCitationWeight,
  deriveEdgeKinds,
  CITATION_GRAPH_DEFAULT_LIMIT,
  CITATION_GRAPH_MAX_LIMIT,
  CITATION_WEIGHT_COMPOUND,
  CITATION_WEIGHT_SPECIES,
  CITATION_WEIGHT_DOI,
} from "../citationGraph";

let queries: RecordedQuery[];

/** Install a fixture-backed client and reset the query log. */
function useFixture(fixture: Fixture): void {
  queries = [];
  const client = fakeDb(fixture, queries);
  setMockServiceClient(() => client);
}

const src = (
  id: string,
  title: string,
  doi: string | null = null,
  trust_tier = "internal",
): SourceRow => ({ id, title, doi, trust_tier });

const fact = (
  source_id: string,
  compound_canonical_id: string | null,
  species_taxon_id: string | null = null,
): FactRow => ({ source_id, compound_canonical_id, species_taxon_id });

beforeEach(() => {
  useFixture({ sources: [], facts: [] });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("computeCitationWeight — pure", () => {
  it("3 shared compounds = 9", () => {
    expect(
      computeCitationWeight({
        sharedCompoundCount: 3,
        sharedSpeciesCount: 0,
        doiMatch: false,
      }),
    ).toBe(3 * CITATION_WEIGHT_COMPOUND);
  });

  it("2 shared species = 4", () => {
    expect(
      computeCitationWeight({
        sharedCompoundCount: 0,
        sharedSpeciesCount: 2,
        doiMatch: false,
      }),
    ).toBe(2 * CITATION_WEIGHT_SPECIES);
  });

  it("DOI match = 5", () => {
    expect(
      computeCitationWeight({
        sharedCompoundCount: 0,
        sharedSpeciesCount: 0,
        doiMatch: true,
      }),
    ).toBe(CITATION_WEIGHT_DOI);
  });

  it("2 compound + 1 species + DOI = 13", () => {
    expect(
      computeCitationWeight({
        sharedCompoundCount: 2,
        sharedSpeciesCount: 1,
        doiMatch: true,
      }),
    ).toBe(2 * 3 + 1 * 2 + 5);
  });

  it("zero overlap = 0", () => {
    expect(
      computeCitationWeight({
        sharedCompoundCount: 0,
        sharedSpeciesCount: 0,
        doiMatch: false,
      }),
    ).toBe(0);
  });
});

describe("deriveEdgeKinds — pure", () => {
  it("zero overlap -> empty array", () => {
    expect(
      deriveEdgeKinds({
        sharedCompoundCount: 0,
        sharedSpeciesCount: 0,
        doiMatch: false,
      }),
    ).toEqual([]);
  });

  it("all three kinds fire when the inputs are non-zero", () => {
    expect(
      deriveEdgeKinds({
        sharedCompoundCount: 1,
        sharedSpeciesCount: 1,
        doiMatch: true,
      }),
    ).toEqual(["shared_compound", "shared_species", "shared_doi"]);
  });

  it("only the kinds with non-zero counts are emitted", () => {
    expect(
      deriveEdgeKinds({
        sharedCompoundCount: 2,
        sharedSpeciesCount: 0,
        doiMatch: false,
      }),
    ).toEqual(["shared_compound"]);
  });
});

describe("limits", () => {
  it("default and max are sensible", () => {
    expect(CITATION_GRAPH_DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(CITATION_GRAPH_MAX_LIMIT).toBeGreaterThanOrEqual(
      CITATION_GRAPH_DEFAULT_LIMIT,
    );
  });
});

// ---------------------------------------------------------------------------
// buildCitationGraph — source resolution
// ---------------------------------------------------------------------------

describe("buildCitationGraph — source resolution", () => {
  it("returns sourceFound=false when the source does not exist", async () => {
    useFixture({ sources: [], facts: [] });

    const result = await buildCitationGraph({
      sourceId: "00000000-0000-0000-0000-0000000000a1",
    });
    expect(result.sourceFound).toBe(false);
    expect(result.edges).toEqual([]);
    expect(result.totalNeighbors).toBe(0);
  });

  it("returns no edges when the focus has no canonical keys and no DOI", async () => {
    // The focus has zero facts and no DOI, so it has NOTHING to match on.
    // Pre-fix this fell through to an unfiltered `research_sources` scan
    // (the arbitrary first 500 rows) and every other paper became a
    // candidate. Now: no branch fires, no candidate query is issued.
    useFixture({
      sources: [
        src("src1", "Focus with no keys"),
        src("src2", "Unrelated A"),
        src("src3", "Unrelated B"),
      ],
      facts: [fact("src2", "C1"), fact("src3", "C2")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.sourceFound).toBe(true);
    expect(result.edges).toEqual([]);
    expect(result.totalNeighbors).toBe(0);

    // No candidate hydration query ran — nothing to hydrate.
    const hydration = queries.filter(
      (q) =>
        q.table === "research_sources" &&
        q.filters.some((f) => f.op === "in" && f.column === "id"),
    );
    expect(hydration).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCitationGraph — single-signal edges
// ---------------------------------------------------------------------------

describe("buildCitationGraph — single-signal edges", () => {
  it("emits an edge with sharedCompounds when one compound overlaps", async () => {
    useFixture({
      sources: [
        src("src1", "Focus"),
        src("src2", "Anthoteibinene J — paper B"),
      ],
      facts: [fact("src1", "C1"), fact("src2", "C1")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.sourceFound).toBe(true);
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    expect(edge.otherSourceId).toBe("src2");
    expect(edge.otherTitle).toBe("Anthoteibinene J — paper B");
    expect(edge.sharedCompounds).toEqual(["C1"]);
    expect(edge.sharedCompoundCount).toBe(1);
    expect(edge.sharedSpecies).toEqual([]);
    expect(edge.doiMatch).toBe(false);
    expect(edge.weight).toBe(CITATION_WEIGHT_COMPOUND);
    expect(edge.kinds).toEqual(["shared_compound"]);
  });

  it("emits an edge with sharedSpecies when one species overlaps", async () => {
    useFixture({
      sources: [
        src("src1", "Focus"),
        src("src2", "Species B", null, "peer_reviewed"),
      ],
      facts: [fact("src1", null, "T1"), fact("src2", null, "T1")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].sharedSpecies).toEqual(["T1"]);
    expect(result.edges[0].weight).toBe(CITATION_WEIGHT_SPECIES);
    expect(result.edges[0].kinds).toEqual(["shared_species"]);
  });

  it("emits an edge with doiMatch=true when DOIs match case-insensitively", async () => {
    useFixture({
      sources: [
        src("src1", "Focus", "10.3390/MD23050044"),
        src("src2", "DOI match", "10.3390/md23050044", "peer_reviewed"),
      ],
      facts: [],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].otherSourceId).toBe("src2");
    expect(result.edges[0].doiMatch).toBe(true);
    expect(result.edges[0].weight).toBe(CITATION_WEIGHT_DOI);
    expect(result.edges[0].kinds).toEqual(["shared_doi"]);
  });
});

// ---------------------------------------------------------------------------
// buildCitationGraph — DOI is an OR-branch bonus, NOT an AND-filter
//
// THE regression suite for the `graph-neighborhood-edges` bug fix. Every
// focus here HAS a DOI. Pre-fix, `.ilike("doi", sourceDoi)` was applied to
// the candidate query, so all of these returned ZERO edges.
// ---------------------------------------------------------------------------

describe("buildCitationGraph — DOI is a bonus signal, not a candidate filter", () => {
  it("a DOI-bearing focus still returns its shared-compound neighbors", async () => {
    useFixture({
      sources: [
        src("src1", "Focus WITH a doi", "10.3390/md23050044", "peer_reviewed"),
        src("src2", "Different doi, shared compound", "10.1000/other"),
        src("src3", "No doi, shared compound", null),
      ],
      facts: [
        fact("src1", "C1"),
        fact("src2", "C1"),
        fact("src3", "C1"),
      ],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });

    // Pre-fix: [] — the candidate set collapsed to same-DOI sources.
    expect(result.edges).toHaveLength(2);
    const byId = new Map(result.edges.map((e) => [e.otherSourceId, e]));
    expect(byId.get("src2")?.kinds).toEqual(["shared_compound"]);
    expect(byId.get("src2")?.sharedCompounds).toEqual(["C1"]);
    expect(byId.get("src2")?.weight).toBe(CITATION_WEIGHT_COMPOUND);
    expect(byId.get("src2")?.doiMatch).toBe(false);
    expect(byId.get("src3")?.kinds).toEqual(["shared_compound"]);
  });

  it("a DOI-bearing focus still returns its shared-species neighbors", async () => {
    useFixture({
      sources: [
        src("src1", "Focus WITH a doi", "10.3390/md23050044"),
        src("src2", "No doi, shared species", null),
      ],
      facts: [fact("src1", null, "T1"), fact("src2", null, "T1")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].otherSourceId).toBe("src2");
    expect(result.edges[0].kinds).toEqual(["shared_species"]);
    expect(result.edges[0].doiMatch).toBe(false);
  });

  it("DOI equality adds its +5 bonus ON TOP of the shared-compound weight", async () => {
    useFixture({
      sources: [
        src("src1", "Focus", "10.3390/md23050044"),
        src("src2", "Same doi AND same compound", "10.3390/MD23050044"),
      ],
      facts: [fact("src1", "C1"), fact("src2", "C1")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    expect(edge.doiMatch).toBe(true);
    expect(edge.sharedCompoundCount).toBe(1);
    expect(edge.weight).toBe(CITATION_WEIGHT_COMPOUND + CITATION_WEIGHT_DOI);
    expect(edge.kinds).toEqual(["shared_compound", "shared_doi"]);
  });

  it("a same-DOI duplicate outranks a species-only neighbor", async () => {
    useFixture({
      sources: [
        src("src1", "Focus", "10.3390/md23050044"),
        src("src2", "Duplicate (same doi)", "10.3390/md23050044"),
        src("src3", "Species only", null),
      ],
      facts: [fact("src1", null, "T1"), fact("src3", null, "T1")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].otherSourceId).toBe("src2"); // weight 5
    expect(result.edges[1].otherSourceId).toBe("src3"); // weight 2
    expect(result.edges[0].weight).toBeGreaterThan(result.edges[1].weight);
  });

  it("never applies the DOI as a filter on a candidate/hydration query", async () => {
    useFixture({
      sources: [
        src("src1", "Focus", "10.3390/md23050044"),
        src("src2", "Shared compound", "10.1000/other"),
      ],
      facts: [fact("src1", "C1"), fact("src2", "C1")],
    });

    await buildCitationGraph({ sourceId: "src1" });

    // The DOI may only appear on its OWN branch: a `research_sources`
    // query selecting nothing but `id`. It must NEVER be a filter on the
    // candidate hydration query (which selects title/trust_tier).
    const doiFiltered = queries.filter((q) =>
      q.filters.some((f) => f.op === "ilike" && f.column === "doi"),
    );
    expect(doiFiltered).toHaveLength(1);
    expect(doiFiltered[0].table).toBe("research_sources");
    expect(doiFiltered[0].columns).toBe("id");

    const hydration = queries.find(
      (q) => q.table === "research_sources" && q.columns.includes("trust_tier"),
    );
    expect(hydration).toBeDefined();
    expect(
      hydration?.filters.some((f) => f.op === "ilike" && f.column === "doi"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCitationGraph — exclusion, sorting, limits, dedupe
// ---------------------------------------------------------------------------

describe("buildCitationGraph — exclusion and sorting", () => {
  it("excludes a source that shares no compound, no species, and no DOI", async () => {
    useFixture({
      sources: [
        src("src1", "Focus", "10.3390/md23050044"),
        src("src2", "Shared compound", null),
        src("src3", "Totally unrelated", "10.9999/nope"),
      ],
      facts: [fact("src1", "C1"), fact("src2", "C1"), fact("src3", "C9")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges.map((e) => e.otherSourceId)).toEqual(["src2"]);
  });

  it("never returns the focus source as its own neighbor", async () => {
    useFixture({
      sources: [src("src1", "Focus", "10.3390/md23050044")],
      // The focus shares its own compound and its own DOI with itself.
      facts: [fact("src1", "C1", "T1")],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toEqual([]);
    expect(result.totalNeighbors).toBe(0);
  });

  it("sorts by weight desc and clamps to limit", async () => {
    useFixture({
      sources: [
        src("src1", "Focus"),
        src("src2", "B 1 compound"),
        src("src3", "A 2 compounds"),
        src("src4", "C 1 species"),
      ],
      facts: [
        fact("src1", "C1", "T1"),
        fact("src1", "C2", null),
        fact("src2", "C1"),
        fact("src3", "C1"),
        fact("src3", "C2"),
        fact("src4", null, "T1"),
      ],
    });

    // limit=2 should return the top 2 by weight
    const result = await buildCitationGraph({ sourceId: "src1", limit: 2 });
    expect(result.totalNeighbors).toBe(3);
    expect(result.edges).toHaveLength(2);
    // src3 (2 compounds = 6) > src2 (1 compound = 3) > src4 (1 species = 2)
    expect(result.edges[0].otherSourceId).toBe("src3");
    expect(result.edges[0].weight).toBe(2 * CITATION_WEIGHT_COMPOUND);
    expect(result.edges[1].otherSourceId).toBe("src2");
  });
});

describe("buildCitationGraph — shared-id aggregation", () => {
  it("dedupes repeated compound_canonical_id rows for the same neighbor", async () => {
    useFixture({
      sources: [src("src1", "Focus"), src("src2", "Repeated compound")],
      facts: [
        fact("src1", "C1"),
        // The same compound is mentioned in 3 fact rows of the neighbor.
        fact("src2", "C1"),
        fact("src2", "C1"),
        fact("src2", "C1"),
      ],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges[0].sharedCompounds).toEqual(["C1"]);
    expect(result.edges[0].sharedCompoundCount).toBe(1);
    expect(result.edges[0].weight).toBe(CITATION_WEIGHT_COMPOUND);
  });

  it("sharedCompounds is the INTERSECTION with the focus, not the neighbor's whole list", async () => {
    useFixture({
      sources: [src("src1", "Focus"), src("src2", "Overlaps on C1 only")],
      facts: [
        fact("src1", "C1"),
        fact("src2", "C1"),
        // C7/C8 belong to the neighbor alone — they are NOT shared.
        fact("src2", "C7"),
        fact("src2", "C8"),
      ],
    });

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].sharedCompounds).toEqual(["C1"]);
    expect(result.edges[0].sharedCompoundCount).toBe(1);
    expect(result.edges[0].weight).toBe(CITATION_WEIGHT_COMPOUND);
  });
});

describe("buildCitationGraph — candidate bound", () => {
  it("keeps the candidate scan bounded by candidateLimit = min(500, limit*10)", async () => {
    // 40 neighbors all sharing C1; limit=2 -> candidateLimit=20.
    const sources: SourceRow[] = [src("src1", "Focus", "10.3390/md23050044")];
    const facts: FactRow[] = [fact("src1", "C1")];
    for (let i = 0; i < 40; i++) {
      sources.push(src(`n${i}`, `Neighbor ${i}`));
      facts.push(fact(`n${i}`, "C1"));
    }
    useFixture({ sources, facts });

    const result = await buildCitationGraph({ sourceId: "src1", limit: 2 });

    // The hydration query received at most candidateLimit ids...
    const hydration = queries.find(
      (q) => q.table === "research_sources" && q.columns.includes("trust_tier"),
    );
    const idFilter = hydration?.filters.find(
      (f) => f.op === "in" && f.column === "id",
    ) as { op: "in"; column: string; values: unknown[] } | undefined;
    expect(idFilter).toBeDefined();
    expect(idFilter!.values.length).toBeLessThanOrEqual(20);

    // ...and the response is still clamped to `limit`.
    expect(result.edges).toHaveLength(2);
    expect(result.totalNeighbors).toBeLessThanOrEqual(20);
  });
});
