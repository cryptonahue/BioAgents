/**
 * Offline route tests for the PAGED Library list.
 *
 * `GET /api/library` no longer returns the whole corpus. It reads one page out
 * of `public.library_papers` through the `library_list_papers()` RPC, and these
 * tests lock in the HTTP contract around that:
 *
 *   - the query bag is normalized (clamped + allowlisted) before it reaches the
 *     database, and the response ECHOES what was actually run;
 *   - pagination metadata (`total`, `page`, `pageSize`, `totalPages`) is
 *     derived from the RPC's total, not from `papers.length`;
 *   - rows are shaped into the client's camelCase paper, with `evidenceCount: 0`
 *     preserved (a zero-evidence paper is a real state, not a missing field);
 *   - `/api/library/facets` is not swallowed by `/api/library/:docId`.
 *
 * The Supabase service client is stubbed at the `db/client` module boundary, so
 * nothing here touches a network or a database — the same offline strategy the
 * other route tests in this directory use.
 */

import { describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Elysia } from "elysia";

process.env.SUPABASE_URL = "http://localhost:9999";
process.env.SUPABASE_SERVICE_KEY = "dummy-service-key";
process.env.BIOAGENTS_SECRET = "test-secret";
process.env.AUTH_MODE = "none";

/** Every RPC call the route makes, in order. */
const rpcCalls: Array<{ fn: string; args: any }> = [];

/** What the stubbed `library_list_papers` should resolve to next. */
let listResult: { total: number; papers: any[] } = { total: 0, papers: [] };
let listError: any = null;

mock.module("../../db/client", () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === "library_list_papers") {
        return listError
          ? { data: null, error: listError }
          : { data: listResult, error: null };
      }
      if (fn === "library_facets") {
        return {
          data: {
            taxa: [{ value: "Porites lobata", count: 14 }],
            geography: [{ value: "Caribbean Sea", count: 9 }],
            years: [{ value: 2018, count: 3 }],
            trustTiers: [{ value: "curated", count: 5 }],
          },
          error: null,
        };
      }
      return { data: null, error: new Error(`unexpected rpc: ${fn}`) };
    },
  }),
  getAnonClient: () => ({}),
  getSupabaseClient: () => ({}),
  resetClients: () => {},
}));

let libraryRoute: any;

beforeAll(async () => {
  ({ libraryRoute } = await import("../library"));
});

afterEach(() => {
  rpcCalls.length = 0;
  listResult = { total: 0, papers: [] };
  listError = null;
});

function app() {
  return new Elysia().use(libraryRoute);
}

async function get(url: string) {
  const res = await app().handle(new Request(`http://localhost${url}`));
  return { status: res.status, body: (await res.json()) as any };
}

const ROW = {
  title: "Coral-Reef-Microbiome_2018_Springer-New-York-LLC.pdf",
  display_title: "Coral Reef Microbiome",
  chunk_count: 42,
  type: "pdf",
  size: 918_273,
  file_path: "/docs/Coral-Reef-Microbiome_2018_Springer-New-York-LLC.pdf",
  last_modified: "2026-01-01T00:00:00.000Z",
  research_source_id: "11111111-1111-4111-8111-111111111111",
  doi: "10.1234/coral.2018",
  trust_tier: "curated",
  bioprospecting_fact_count: 7,
  meta_title: "The coral reef microbiome",
  year: 2018,
  publisher: "Springer",
  evidence_count: 0,
  taxa: ["Porites lobata"],
  geography: ["Caribbean Sea"],
};

describe("GET /api/library (paged)", () => {
  it("defaults to page 1, 25 per page, most recent first", async () => {
    listResult = { total: 0, papers: [] };
    const { status } = await get("/api/library");

    expect(status).toBe(200);
    expect(rpcCalls[0]?.fn).toBe("library_list_papers");
    expect(rpcCalls[0]?.args).toMatchObject({
      p_search: null,
      p_taxon: null,
      p_geography: null,
      p_year: null,
      p_trust_tier: null,
      p_sort: "year",
      p_dir: "desc",
      p_limit: 25,
      p_offset: 0,
    });
  });

  it("passes search, filters and sort down to the RPC as VALUES", async () => {
    await get(
      "/api/library?q=caribbean%20coral&taxon=Porites%20lobata" +
        "&geography=Caribbean%20Sea&year=2018&trustTier=curated" +
        "&sort=evidence&dir=asc&page=3&pageSize=10",
    );

    expect(rpcCalls[0]?.args).toMatchObject({
      p_search: "caribbean coral",
      p_taxon: "Porites lobata",
      p_geography: "Caribbean Sea",
      p_year: 2018,
      p_trust_tier: "curated",
      p_sort: "evidence",
      p_dir: "asc",
      p_limit: 10,
      // page 3 of 10 -> the 21st row onward
      p_offset: 20,
    });
  });

  it("clamps the page size and rejects an unknown sort key before the DB", async () => {
    await get("/api/library?pageSize=5000&sort=size;DROP%20TABLE&page=0");

    expect(rpcCalls[0]?.args).toMatchObject({
      p_limit: 100,
      p_sort: "year",
      p_offset: 0,
    });
  });

  it("derives pagination metadata from the RPC total, not from the page length", async () => {
    listResult = { total: 250, papers: [ROW] };
    const { body } = await get("/api/library?pageSize=25&page=2");

    expect(body.total).toBe(250);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(25);
    expect(body.totalPages).toBe(10);
    expect(body.papers).toHaveLength(1);
  });

  it("echoes the query the server actually ran", async () => {
    const { body } = await get("/api/library?q=coral&sort=nonsense&dir=UP");
    expect(body.query).toEqual({
      q: "coral",
      taxon: "",
      geography: "",
      year: null,
      trustTier: "",
      sort: "year",
      dir: "desc",
    });
  });

  it("shapes a row into the client paper, keeping evidenceCount: 0 visible", async () => {
    listResult = { total: 1, papers: [ROW] };
    const { body } = await get("/api/library");
    const paper = body.papers[0];

    expect(paper).toMatchObject({
      docId: Buffer.from(ROW.title, "utf-8").toString("base64url"),
      title: ROW.title,
      type: "pdf",
      size: 918_273,
      chunkCount: 42,
      // A paper the agent cannot cite: present, and explicitly zero.
      evidenceCount: 0,
      researchSourceId: ROW.research_source_id,
      doi: "10.1234/coral.2018",
      doiUrl: "https://doi.org/10.1234/coral.2018",
      year: 2018,
      publisher: "Springer",
      metaTitle: "The coral reef microbiome",
      trustTier: "curated",
      bioprospectingFactCount: 7,
      taxa: ["Porites lobata"],
      geography: ["Caribbean Sea"],
    });
  });

  it("omits empty optional fields rather than nulling them", async () => {
    listResult = {
      total: 1,
      papers: [
        {
          ...ROW,
          doi: null,
          year: null,
          publisher: null,
          meta_title: null,
          trust_tier: null,
          bioprospecting_fact_count: null,
          taxa: [],
          geography: [],
        },
      ],
    };
    const { body } = await get("/api/library");
    const paper = body.papers[0];

    for (const key of [
      "doi",
      "doiUrl",
      "year",
      "publisher",
      "metaTitle",
      "trustTier",
      "bioprospectingFactCount",
      "taxa",
      "geography",
    ]) {
      expect(paper).not.toHaveProperty(key);
    }
  });

  it("returns 500 when the RPC fails (e.g. the migration has not been applied)", async () => {
    listError = { message: 'function public.library_list_papers does not exist' };
    const { status, body } = await get("/api/library");

    expect(status).toBe(500);
    expect(body.error).toBe("Failed to list library");
  });
});

describe("GET /api/library/facets", () => {
  it("is routed to the facets handler, not to /api/library/:docId", async () => {
    const { status, body } = await get("/api/library/facets");

    expect(status).toBe(200);
    expect(rpcCalls[0]?.fn).toBe("library_facets");
    expect(body.taxa).toEqual([{ value: "Porites lobata", count: 14 }]);
    expect(body.geography).toEqual([{ value: "Caribbean Sea", count: 9 }]);
    expect(body.years).toEqual([{ value: 2018, count: 3 }]);
    expect(body.trustTiers).toEqual([{ value: "curated", count: 5 }]);
  });
});
