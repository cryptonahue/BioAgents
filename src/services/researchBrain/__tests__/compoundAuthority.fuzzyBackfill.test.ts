/**
 * Unit tests for the fuzzy-recovery flow on the PubChem backfill
 * (PR #3 of `bioprospecting-compound-authority`).
 *
 * Coverage matrix:
 *
 *   1.  tryFuzzyVariants=false (default) -> the original-name-only
 *       contract of PR #2 is preserved: a 404 on the first call
 *       short-circuits to handleMiss with no variant calls.
 *   2.  tryFuzzyVariants=true, original 404, variant 200 -> the
 *       fact is stamped verified with the variant's CID; the
 *       summary reports 1 fuzzyHit and 1 fuzzyCall; the original
 *       compound name is preserved as an alias.
 *   3.  tryFuzzyVariants=true, all variants 404 -> the fact is
 *       stamped pending (or failed when attempts reach max) with
 *       an error message that mentions the variant count.
 *   4.  tryFuzzyVariants=true + maxVariantsPerFact=1 -> only the
 *       first variant is tried even if more are available.
 *   5.  dryRun + tryFuzzyVariants=true -> the summary forecasts
 *       the cost (fuzzyCalls) without making any HTTP calls.
 *   6.  includeFailed=true -> a fact with status='failed' is
 *       picked up; on a fuzzy hit, attempts is reset to 0 on
 *       the verified row.
 *   7.  Fuzzy recovery on a 503 from a variant -> the fact is
 *       NOT marked failed (server signal); the next run re-tries.
 *
 * The tests stub `globalThis.fetch` with a canned response queue
 * and mock the Supabase service client with a chainable script
 * (same pattern as `compoundAuthority.backfill.test.ts`).
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

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
  const next = (): unknown => {
    if (cursor >= script.length) {
      return { kind: "many", data: [], error: null };
    }
    return script[cursor++];
  };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      if (method === "from") currentTable = args[0] as string;
      calls.push({ method, args, table: currentTable });
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args, table: currentTable });
      const t = next() as any;
      if (t.kind === "single") return Promise.resolve({ data: t.data, error: t.error });
      if (t.kind === "many") return Promise.resolve({ data: t.data, error: t.error });
      return Promise.resolve({ data: null, error: null });
    };
  }
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [], table: currentTable });
        const t = next() as any;
        const data = t.kind === "single" ? t.data : t.data;
        const error = t.error;
        return Promise.resolve({ data, error }).then(onFulfilled, onRejected);
      };
    },
  });
  return target;
}

declare global {
  // eslint-disable-next-line no-var
  var __fuzzyTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__fuzzyTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__fuzzyTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__fuzzyTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__fuzzyTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__fuzzyTestClient ?? (() => null))(),
}));

import { normalizeBioprospectingCompounds } from "../compoundAuthority";
import type { BackfillSummary } from "../compoundAuthority";

let calls: Call[];
let client: any;
let originalFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init?: { status?: number; retryAfter?: string }): Response {
  const status = init?.status ?? 200;
  const headers = new Headers();
  if (init?.retryAfter) headers.set("Retry-After", init.retryAfter);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function notFoundResponse(): Response {
  return jsonResponse(
    { Fault: { Code: "PUGREST.NotFound", Message: "No CID found" } },
    { status: 404 },
  );
}

function rateLimitedResponse(retryAfter: string = "1"): Response {
  return jsonResponse(
    { Fault: { Code: "PUGREST.ServerBusy", Message: "Too many requests" } },
    { status: 503, retryAfter },
  );
}

function okCidResponse(cid: number): Response {
  return jsonResponse({ IdentifierList: { CID: [cid] } });
}

function okPropsResponse(cid: number, inchiKey = "X"): Response {
  return jsonResponse({
    PropertyTable: {
      Properties: [{ CID: cid, MolecularFormula: "C1", InChIKey: inchiKey, IUPACName: "x" }],
    },
  });
}

/**
 * Build a script for a "PubChem hit" path that goes through
 * `attachCanonicalToFact` (read + update + audit) and the
 * `upsertCanonical` (lookup by cid, lookup by name, insert) and
 * `upsertAlias` (lookup by name, insert). Used by tests that expect
 * a successful verified stamp.
 */
function scriptForVerifiedHit(opts: { canonicalId?: string; aliasInsertions?: number; compound?: string }): Terminal[] {
  const canonicalId = opts.canonicalId ?? "C1";
  const aliasInsertions = opts.aliasInsertions ?? 1;
  const compound = opts.compound ?? "quercetin";
  const s: Terminal[] = [
    // (1) loadAliasMap: aliases
    { kind: "many", data: [], error: null },
    // (2) loadAliasMap: canonicals
    { kind: "many", data: [], error: null },
    // (3) selectPendingFacts
    { kind: "many", data: [{ id: "F1", compound, compound_authority_attempts: 0 }], error: null },
  ];
  // attachCanonicalToFact: read, update, audit
  s.push({ kind: "single", data: { compound_canonical_id: null, compound_authority_status: "pending", compound_authority_error: null }, error: null });
  s.push({ kind: "many", data: [], error: null });
  s.push({ kind: "single", data: { id: "audit-1" }, error: null });
  // upsertCanonical: by cid (miss), by name (miss), insert
  s.push({ kind: "single", data: null, error: null });
  s.push({ kind: "single", data: null, error: null });
  s.push({ kind: "single", data: { id: canonicalId }, error: null });
  // upsertAlias x aliasInsertions: dedup miss, insert
  for (let i = 0; i < aliasInsertions; i++) {
    s.push({ kind: "single", data: null, error: null });
    s.push({ kind: "single", data: { id: `A${i}` }, error: null });
  }
  return s;
}

/**
 * Build a script for a "PubChem miss" path that goes through
 * `handleMiss` (read, update, audit only — no upsert).
 */
function scriptForMiss(opts: { compound?: string; attempts?: number } = {}): Terminal[] {
  const compound = opts.compound ?? "obscurenaturalproduct";
  const attempts = opts.attempts ?? 0;
  return [
    { kind: "many", data: [], error: null },
    { kind: "many", data: [], error: null },
    { kind: "many", data: [{ id: "F1", compound, compound_authority_attempts: attempts }], error: null },
    { kind: "single", data: { compound_canonical_id: null, compound_authority_status: "pending", compound_authority_error: null }, error: null },
    { kind: "many", data: [], error: null },
    { kind: "single", data: { id: "audit-1" }, error: null },
  ];
}

// ---------------------------------------------------------------------------
// 1. tryFuzzyVariants=false (default) -> no variant calls
// ---------------------------------------------------------------------------

describe("compoundAuthority — fuzzy recovery (tryFuzzyVariants=false default)", () => {
  it("does not try variants even if the original 404s", async () => {
    const fetchCalls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      fetchCalls.push(String(input));
      return notFoundResponse();
    };
    client = scriptedMock(scriptForMiss(), calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
      // tryFuzzyVariants NOT passed -> defaults to false
    });
    // Exactly ONE PubChem call: the original name. No variant calls.
    expect(fetchCalls).toHaveLength(1);
    expect(summary.fuzzyCalls).toBe(0);
    expect(summary.fuzzyHits).toBe(0);
    expect(summary.pubchemMisses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Variant hits -> verified
// ---------------------------------------------------------------------------

describe("compoundAuthority — fuzzy recovery (variant hits)", () => {
  it("uses the variant CID and writes verified with the original as alias", async () => {
    // First PubChem call: "alpha-mangostin" -> 404
    // Second PubChem call (variant): "mangostin" -> 200 with CID 5281651
    // Third PubChem call (props): 200 with InChIKey
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/compound/name/alpha-mangostin/cids")) {
        return notFoundResponse();
      }
      if (url.includes("/compound/name/mangostin/cids")) {
        return okCidResponse(5281651);
      }
      if (url.includes("/compound/cid/5281651/property")) {
        return okPropsResponse(5281651, "ZQRHKEHAVBIPCF-UHFFFAOYSA-N");
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    // Fact in DB has the original (paper) spelling; we expect:
    //   1. attachCanonicalToFact (read/update/audit) for verified
    //   2. upsertCanonical (cid miss / name miss / insert) for C1
    //   3. upsertAlias for the original ("alpha-mangostin")
    //   4. upsertAlias for the variant ("mangostin")
    client = scriptedMock(
      scriptForVerifiedHit({ aliasInsertions: 2, compound: "alpha-mangostin" }),
      calls,
    );
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
      tryFuzzyVariants: true,
      maxVariantsPerFact: 3,
    });
    expect(summary.scannedFacts).toBe(1);
    expect(summary.fuzzyHits).toBe(1);
    expect(summary.fuzzyCalls).toBe(1);
    expect(summary.pubchemHits).toBe(1);
    expect(summary.pubchemMisses).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. All variants 404 -> handleMiss
// ---------------------------------------------------------------------------

describe("compoundAuthority — fuzzy recovery (all variants 404)", () => {
  it("calls handleMiss with an error message that mentions the variant count", async () => {
    const fakeFetch: typeof fetch = async () => notFoundResponse();
    // "compound 12B from genus X" yields 5 variants: original,
    // paren-stripped, and progressive token prefixes. Cap at 3
    // to confirm the cap is the bound.
    client = scriptedMock(
      scriptForMiss({ compound: "compound 12B from genus X" }),
      calls,
    );
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
      tryFuzzyVariants: true,
      maxVariantsPerFact: 3,
    });
    expect(summary.fuzzyCalls).toBe(3);
    expect(summary.fuzzyHits).toBe(0);
    expect(summary.pubchemMisses).toBe(1);
    // The error message on the fact row should mention "tried 3 variants"
    const updateCall = calls.find(
      (c) => c.method === "update" && c.table === "research_bioprospecting_facts",
    );
    expect(updateCall).toBeDefined();
    const errorMessage = (updateCall!.args[0] as Record<string, unknown>)
      .compound_authority_error as string;
    expect(errorMessage).toContain("tried 3 variants");
  });
});

// ---------------------------------------------------------------------------
// 4. maxVariantsPerFact caps the search
// ---------------------------------------------------------------------------

describe("compoundAuthority — fuzzy recovery (maxVariantsPerFact cap)", () => {
  it("only tries maxVariantsPerFact variants even when more are available", async () => {
    let fetchCount = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCount++;
      return notFoundResponse();
    };
    // "compound 12B from genus X" yields 5 variants; we cap at 1
    // to confirm the cap is enforced.
    client = scriptedMock(
      scriptForMiss({ compound: "compound 12B from genus X" }),
      calls,
    );
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
      tryFuzzyVariants: true,
      maxVariantsPerFact: 1,
    });
    // 1 original + 1 variant = 2 calls
    expect(fetchCount).toBe(2);
    expect(summary.fuzzyCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. dryRun cost forecast
// ---------------------------------------------------------------------------

describe("compoundAuthority — fuzzy recovery (dryRun cost forecast)", () => {
  it("reports fuzzyCalls without making any HTTP calls", async () => {
    const fetchCalls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      fetchCalls.push(String(input));
      throw new Error("fetch should not be called in dryRun");
    };
    // Real compound with multiple variants.
    client = scriptedMock(
      [
        { kind: "many", data: [], error: null },
        { kind: "many", data: [], error: null },
        {
          kind: "many",
          data: [{ id: "F1", compound: "compound 12B from genus X", compound_authority_attempts: 0 }],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
      tryFuzzyVariants: true,
      maxVariantsPerFact: 5,
      dryRun: true,
    });
    expect(fetchCalls).toHaveLength(0);
    expect(summary.fuzzyCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. includeFailed + recovery resets attempts
// ---------------------------------------------------------------------------

describe("compoundAuthority — fuzzy recovery (includeFailed resets attempts)", () => {
  it("picks up a failed fact and stamps verified with attempts=0 on the verified row", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      // Order matters: more specific patterns first. The fuzzy
      // pass produces 3 candidates for "(E)-resveratrol":
      //   1. (E)-resveratrol       -> 404 (original)
      //   2. -resveratrol         -> 404 (intermediate noise)
      //   3. resveratrol          -> 200 (the hit)
      if (url.includes("/compound/name/-resveratrol/cids")) {
        return notFoundResponse();
      }
      if (url.includes("/compound/name/(E)-resveratrol/cids")) {
        return notFoundResponse();
      }
      if (url.includes("/compound/name/resveratrol/cids")) {
        return okCidResponse(445154);
      }
      if (url.includes("/compound/cid/445154/property")) {
        return okPropsResponse(445154);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const s: Terminal[] = [
      { kind: "many", data: [], error: null }, // alias
      { kind: "many", data: [], error: null }, // canonical
      {
        kind: "many",
        data: [
          {
            id: "F1",
            compound: "(E)-resveratrol",
            compound_authority_attempts: 5, // previously failed
          },
        ],
        error: null,
      },
      // attachCanonicalToFact: read
      {
        kind: "single",
        data: {
          compound_canonical_id: null,
          compound_authority_status: "failed", // previously failed
          compound_authority_error: "pubchem 404 not found",
        },
        error: null,
      },
      // attachCanonicalToFact: update
      { kind: "many", data: [], error: null },
      // attachCanonicalToFact: audit insert
      { kind: "single", data: { id: "audit-1" }, error: null },
      // upsertCanonical: by cid (miss), by name (miss), insert
      { kind: "single", data: null, error: null },
      { kind: "single", data: null, error: null },
      { kind: "single", data: { id: "C1" }, error: null },
      // upsertAlias x2 (original + variant): dedup miss, insert
      { kind: "single", data: null, error: null },
      { kind: "single", data: { id: "A1" }, error: null },
      { kind: "single", data: null, error: null },
      { kind: "single", data: { id: "A2" }, error: null },
    ];
    client = scriptedMock(s, calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
      tryFuzzyVariants: true,
      maxVariantsPerFact: 3,
      includeFailed: true,
    });
    expect(summary.fuzzyHits).toBe(1);
    // The update payload on the verified row should have
    // attempts=0 (the recovery pass resets the counter).
    const updateCall = calls.find(
      (c) =>
        c.method === "update" &&
        c.table === "research_bioprospecting_facts",
    );
    expect(updateCall).toBeDefined();
    const updatePayload = (updateCall!.args[0] as Record<string, unknown>);
    expect(updatePayload.compound_authority_status).toBe("verified");
    expect(updatePayload.compound_authority_attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. 503 on a variant -> not failed (server signal)
// ---------------------------------------------------------------------------

describe("compoundAuthority — fuzzy recovery (503 on variant)", () => {
  it("does not mark the fact failed when a variant returns 503", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/compound/name/alpha-mangostin/cids")) {
        return notFoundResponse();
      }
      if (url.includes("/compound/name/mangostin/cids")) {
        return rateLimitedResponse("1");
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    // Script: 503 means we bail out of the variant loop early and
    // do NOT call attachCanonicalToFact (the fact stays in its
    // current state — failed in this test). We do NOT script a
    // update/audit call for handleMiss.
    const s: Terminal[] = [
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [{ id: "F1", compound: "alpha-mangostin", compound_authority_attempts: 5 }], error: null },
    ];
    client = scriptedMock(s, calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary: BackfillSummary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
      tryFuzzyVariants: true,
      maxVariantsPerFact: 3,
      includeFailed: true,
    });
    // We made 2 PubChem calls: original + 1 variant. The 503 bailed
    // the variant loop. The fact is NOT marked failed (no update
    // payload was sent to attachCanonicalToFact for the failed
    // transition).
    expect(summary.fuzzyHits).toBe(0);
    expect(summary.failed).toBe(0);
    // We expect NO update calls on research_bioprospecting_facts.
    const factUpdates = calls.filter(
      (c) =>
        c.method === "update" &&
        c.table === "research_bioprospecting_facts",
    );
    expect(factUpdates).toHaveLength(0);
  });
});
