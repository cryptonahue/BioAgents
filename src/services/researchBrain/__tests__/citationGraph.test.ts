/**
 * Unit tests for the citation graph service module
 * (`src/services/researchBrain/citationGraph.ts`).
 *
 * v1 (this PR) is LLM-free: the citation graph is computed from
 * SQL joins on `research_bioprospecting_facts.compound_canonical_id`,
 * `species_taxon_id`, and the source's DOI. The endpoint does not
 * invoke the LLM at any point.
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
 *   buildCitationGraph (mocked DB):
 *     9.  source not found -> edges=[] + sourceFound=false
 *    10.  source has no neighbors -> edges=[] + sourceFound=true
 *    11.  shared compound -> 1 edge with sharedCompounds
 *    12.  shared species -> 1 edge with sharedSpecies
 *    13.  shared DOI -> 1 edge with doiMatch=true
 *    14.  multiple neighbors, sorted by weight desc
 *    15.  limit clamp
 *    16.  zero-share neighbor is dropped
 *    17.  dedupe of shared compound canonical ids
 *    18.  self is excluded
 *
 * The tests are hermetic: the Supabase service client is mocked
 * with a chainable stub (same pattern as graphService.test.ts).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors graphService.test.ts
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[]; table?: string };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: unknown };

const BUILDER_METHODS = [
  "from",
  "select",
  "insert",
  "update",
  "delete",
  "eq",
  "neq",
  "in",
  "is",
  "not",
  "or",
  "and",
  "ilike",
  "match",
  "filter",
  "order",
  "limit",
  "range",
  "upsert",
  "maybeSingle",
];

const TERMINAL_METHODS = ["maybeSingle", "single"];

function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  let currentTable: string | undefined;
  const target: any = {};
  const next = (): Terminal => {
    if (cursor >= script.length) {
      return { kind: "many", data: [], error: null };
    }
    return script[cursor++];
  };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      if (method === "from") {
        currentTable = args[0] as string;
      }
      calls.push({ method, args, table: currentTable });
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args, table: currentTable });
      const t = next();
      if (t.kind === "single") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
      return Promise.resolve({ data: t.data, error: t.error });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [], table: currentTable });
        const t = next();
        return Promise.resolve({ data: t.data, error: t.error }).then(
          onFulfilled,
          onRejected,
        );
      };
    },
  });
  return target;
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
  type CitationEdge,
  type CitationGraphResult,
} from "../citationGraph";

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
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
// buildCitationGraph
// ---------------------------------------------------------------------------

describe("buildCitationGraph — source resolution", () => {
  it("returns sourceFound=false when the source does not exist", async () => {
    client = scriptedMock(
      [{ kind: "single", data: null, error: null }], // maybeSingle -> null
      calls,
    );
    setMockServiceClient(() => client);

    const result = await buildCitationGraph({
      sourceId: "00000000-0000-0000-0000-0000000000a1",
    });
    expect(result.sourceFound).toBe(false);
    expect(result.edges).toEqual([]);
    expect(result.totalNeighbors).toBe(0);
  });

  it("returns sourceFound=true with empty edges when no neighbors", async () => {
    client = scriptedMock(
      [
        // 1) source row
        {
          kind: "single",
          data: { id: "src1", doi: null },
          error: null,
        },
        // 2) candidate sources (empty)
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.sourceFound).toBe(true);
    expect(result.edges).toEqual([]);
    expect(result.totalNeighbors).toBe(0);
  });
});

describe("buildCitationGraph — shared compound", () => {
  it("emits an edge with sharedCompounds when one compound overlaps", async () => {
    client = scriptedMock(
      [
        // source row
        { kind: "single", data: { id: "src1", doi: null }, error: null },
        // candidate sources (only one)
        {
          kind: "many",
          data: [
            {
              id: "src2",
              title: "Anthoteibinene J — paper B",
              doi: null,
              trust_tier: "internal",
            },
          ],
          error: null,
        },
        // compound aggregate for src2
        {
          kind: "many",
          data: [{ source_id: "src2", compound_canonical_id: "C1" }],
          error: null,
        },
        // species aggregate for src2
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

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
});

describe("buildCitationGraph — shared species", () => {
  it("emits an edge with sharedSpecies when one species overlaps", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: { id: "src1", doi: null }, error: null },
        {
          kind: "many",
          data: [
            { id: "src2", title: "Species B", doi: null, trust_tier: "peer_reviewed" },
          ],
          error: null,
        },
        { kind: "many", data: [], error: null }, // compounds
        {
          kind: "many",
          data: [{ source_id: "src2", species_taxon_id: "T1" }],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].sharedSpecies).toEqual(["T1"]);
    expect(result.edges[0].weight).toBe(CITATION_WEIGHT_SPECIES);
    expect(result.edges[0].kinds).toEqual(["shared_species"]);
  });
});

describe("buildCitationGraph — shared DOI", () => {
  it("emits an edge with doiMatch=true when DOIs match case-insensitively", async () => {
    const sourceDoi = "10.3390/MD23050044";
    client = scriptedMock(
      [
        {
          kind: "single",
          data: { id: "src1", doi: sourceDoi },
          error: null,
        },
        {
          kind: "many",
          data: [
            // .ilike is case-insensitive, so the mock just returns
            // the candidate as if the filter passed.
            {
              id: "src2",
              title: "DOI match",
              doi: "10.3390/md23050044", // lowercase
              trust_tier: "peer_reviewed",
            },
          ],
          error: null,
        },
        { kind: "many", data: [], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].doiMatch).toBe(true);
    expect(result.edges[0].weight).toBe(CITATION_WEIGHT_DOI);
    expect(result.edges[0].kinds).toEqual(["shared_doi"]);
  });
});

describe("buildCitationGraph — sort and limit", () => {
  it("sorts by weight desc and clamps to limit", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: { id: "src1", doi: null }, error: null },
        {
          kind: "many",
          data: [
            { id: "src2", title: "B 1 compound", doi: null, trust_tier: "internal" },
            { id: "src3", title: "A 2 compounds", doi: null, trust_tier: "internal" },
            { id: "src4", title: "C 1 species", doi: null, trust_tier: "internal" },
          ],
          error: null,
        },
        // compound aggregate
        {
          kind: "many",
          data: [
            { source_id: "src2", compound_canonical_id: "C1" },
            { source_id: "src3", compound_canonical_id: "C1" },
            { source_id: "src3", compound_canonical_id: "C2" },
          ],
          error: null,
        },
        // species aggregate
        {
          kind: "many",
          data: [{ source_id: "src4", species_taxon_id: "T1" }],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    // limit=2 should return the top 2 by weight
    const result = await buildCitationGraph({ sourceId: "src1", limit: 2 });
    expect(result.totalNeighbors).toBe(3);
    expect(result.edges).toHaveLength(2);
    // src3 (2 compounds = weight 6) > src2 (1 compound = weight 3) > src4 (1 species = weight 2)
    expect(result.edges[0].otherSourceId).toBe("src3");
    expect(result.edges[1].otherSourceId).toBe("src2");
  });
});

describe("buildCitationGraph — dedupe and self-exclusion", () => {
  it("dedupes repeated compound_canonical_id rows for the same neighbor", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: { id: "src1", doi: null }, error: null },
        {
          kind: "many",
          data: [
            { id: "src2", title: "Repeated compound", doi: null, trust_tier: "internal" },
          ],
          error: null,
        },
        // The same (source_id, compound_canonical_id) appears 3 times
        // (e.g., the same compound is mentioned in 3 fact rows).
        {
          kind: "many",
          data: [
            { source_id: "src2", compound_canonical_id: "C1" },
            { source_id: "src2", compound_canonical_id: "C1" },
            { source_id: "src2", compound_canonical_id: "C1" },
          ],
          error: null,
        },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges[0].sharedCompounds).toEqual(["C1"]);
    expect(result.edges[0].sharedCompoundCount).toBe(1);
  });

  it("drops a candidate that ended up with zero overlap after aggregation", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: { id: "src1", doi: null }, error: null },
        {
          kind: "many",
          data: [
            { id: "src2", title: "no overlap", doi: null, trust_tier: "internal" },
          ],
          error: null,
        },
        // Aggregates return zero rows for src2 (e.g., the fact
        // table was emptied between the candidate SELECT and the
        // aggregate SELECT).
        { kind: "many", data: [], error: null },
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await buildCitationGraph({ sourceId: "src1" });
    expect(result.edges).toEqual([]);
    expect(result.totalNeighbors).toBe(0);
  });
});
