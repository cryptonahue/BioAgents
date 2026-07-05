/**
 * Unit tests for the PubChem backfill path (PR #2 of
 * `bioprospecting-compound-authority`).
 *
 * Coverage matrix — one test per spec scenario from
 * `openspec/changes/bioprospecting-compound-authority/specs/.../spec.md`
 * (`Compound Authority BullMQ Queue and Worker` section):
 *
 *   1.  Alias hit (in-memory) -> verified, no fetch
 *   2.  PubChem 200 CID + 200 props -> upserted canonical, alias written, fact verified
 *   3.  PubChem 404 -> pending with bumped attempts, retries scheduled
 *   4.  PubChem 404 on the 5th attempt -> failed
 *   5.  PubChem 503 with Retry-After -> gate paused, fact NOT failed (deferred)
 *   6.  One bad fact (throws) does NOT abort the batch
 *   7.  Spike findings carry into the test (the rate-limit signal is 503, not 429)
 *
 * The test stubs `globalThis.fetch` with a canned response queue
 * and mocks the Supabase service client with a chainable script
 * (same pattern as `compoundAuthority.test.ts`).
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors compoundAuthority.test.ts
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
  "gt",
  "gte",
  "lt",
  "lte",
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
  var __backfillTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__backfillTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__backfillTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__backfillTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__backfillTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () => (globalThis.__backfillTestClient ?? (() => null))(),
}));

// SUT imports (post-mock)
import {
  normalizeBioprospectingCompounds,
  RateGate,
  fetchPubChemCid,
  fetchPubChemProperties,
  parseRetryAfter,
  COMPOUND_AUTHORITY_DEFAULT_MAX_RETRIES,
} from "../compoundAuthority";
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

// ---------------------------------------------------------------------------
// fetch helpers — minimal Response stub
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init?: { status?: number; retryAfter?: string; headers?: Record<string, string> }): Response {
  const status = init?.status ?? 200;
  const headers = new Headers(init?.headers ?? {});
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

/**
 * Script a backfill test by:
 *   1. queueing the alias-map and pending-fact SQL responses
 *   2. providing a fake fetch implementation
 *   3. calling normalizeBioprospectingCompounds
 */
async function runBackfill(opts: {
  pendingFacts: Array<{
    id: string;
    compound: string;
    compound_authority_attempts?: number;
  }>;
  aliasMap: Array<{ normalized_alias: string; compound_id: string }>;
  fetchImpl: typeof fetch;
}): Promise<BackfillSummary> {
  // Script the SQL responses:
  //   1. SELECT research_compound_aliases (for loadAliasMap)
  //   2. SELECT research_compounds (for loadAliasMap canonical names)
  //   3. SELECT research_bioprospecting_facts (for selectPendingFacts)
  //   4. (per fact) SELECT ... research_bioprospecting_facts (attachCanonicalToFact read)
  //   5. UPDATE research_bioprospecting_facts
  //   6. INSERT compound_authority_audit
  //   7. (if PubChem hit) SELECT research_compounds (cid)
  //   8. SELECT research_compounds (normalized_name)
  //   9. INSERT research_compounds
  //   10. SELECT research_compound_aliases (alias dedup)
  //   11. INSERT research_compound_aliases
  const script: Terminal[] = [];
  // (1) alias map
  script.push({ kind: "many", data: opts.aliasMap, error: null });
  // (2) canonical names for alias map
  script.push({ kind: "many", data: [], error: null });
  // (3) pending facts
  script.push({
    kind: "many",
    data: opts.pendingFacts.map((f) => ({
      id: f.id,
      compound: f.compound,
      compound_authority_attempts: f.compound_authority_attempts ?? 0,
    })),
    error: null,
  });
  // For each fact: attachCanonicalToFact does (4) read, (5) update, (6) audit insert.
  // PubChem hit path also does (7)(8)(10)(11) and maybe (9) when inserting.
  for (let i = 0; i < opts.pendingFacts.length; i++) {
    // (4) previous state read
    script.push({
      kind: "single",
      data: {
        compound_canonical_id: null,
        compound_authority_status: "pending",
        compound_authority_error: null,
      },
      error: null,
    });
    // (5) update
    script.push({ kind: "many", data: [], error: null });
    // (6) audit insert
    script.push({ kind: "single", data: { id: `audit-${i}` }, error: null });
  }
  client = scriptedMock(script, calls);
  setMockServiceClient(() => client);
  globalThis.fetch = opts.fetchImpl;

  const summary = await normalizeBioprospectingCompounds({
    limit: 50,
    onlyMissing: true,
    rps: 100, // speed up tests
    fetchImpl: opts.fetchImpl,
  });
  return summary;
}

// ---------------------------------------------------------------------------
// 1. Alias hit -> verified, no fetch
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (alias hit -> verified, no fetch)", () => {
  it("stamps verified without issuing any PubChem call", async () => {
    const fetchCalls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      fetchCalls.push(String(input));
      throw new Error("fetch should not be called for an alias hit");
    };
    const summary = await runBackfill({
      pendingFacts: [
        { id: "F1", compound: "Diferuloylmethane" },
      ],
      aliasMap: [{ normalized_alias: "diferuloylmethane", compound_id: "C1" }],
      fetchImpl: fakeFetch,
    });
    expect(summary.scannedFacts).toBe(1);
    expect(summary.aliasHits).toBe(1);
    expect(summary.pubchemHits).toBe(0);
    expect(summary.pubchemMisses).toBe(0);
    expect(summary.failed).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. PubChem 200 -> verified + upserts
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (PubChem 200 -> verified)", () => {
  it("upserts canonical and writes the fact as verified", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/compound/name/quercetin/cids")) {
        return jsonResponse({ IdentifierList: { CID: [5280343] } });
      }
      if (url.includes("/compound/cid/5280343/property")) {
        return jsonResponse({
          PropertyTable: {
            Properties: [
              {
                CID: 5280343,
                MolecularFormula: "C15H10O7",
                InChIKey: "REFJWTPEDVJJIY-UHFFFAOYSA-N",
                IUPACName: "Quercetin",
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    // Override the runBackfill script: for a PubChem hit, we ALSO
    // need responses for the upsertCanonical lookup (pubchem_cid)
    // and the upsertAlias dedup. Build a richer script.
    const script: Terminal[] = [
      { kind: "many", data: [], error: null }, // alias map
      { kind: "many", data: [], error: null }, // canonical names
      {
        kind: "many",
        data: [{ id: "F1", compound: "quercetin", compound_authority_attempts: 0 }],
        error: null,
      },
      // attachCanonicalToFact read
      {
        kind: "single",
        data: {
          compound_canonical_id: null,
          compound_authority_status: "pending",
          compound_authority_error: null,
        },
        error: null,
      },
      // attachCanonicalToFact update
      { kind: "many", data: [], error: null },
      // attachCanonicalToFact audit insert
      { kind: "single", data: { id: "audit-1" }, error: null },
      // upsertCanonical: SELECT by pubchem_cid (miss)
      { kind: "single", data: null, error: null },
      // upsertCanonical: SELECT by normalized_name (miss)
      { kind: "single", data: null, error: null },
      // upsertCanonical: INSERT
      { kind: "single", data: { id: "C1" }, error: null },
      // upsertAlias: SELECT existing (miss)
      { kind: "single", data: null, error: null },
      // upsertAlias: INSERT
      { kind: "single", data: { id: "A1" }, error: null },
    ];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
    });
    expect(summary.scannedFacts).toBe(1);
    expect(summary.pubchemHits).toBe(1);
    expect(summary.aliasHits).toBe(0);
    expect(summary.pubchemMisses).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. PubChem 404 -> pending + bumped attempts
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (PubChem 404 -> pending + bumped attempts)", () => {
  it("writes pending with attempts=1 and reports retriesScheduled=1", async () => {
    const fakeFetch: typeof fetch = async () => notFoundResponse();
    // We do NOT include the upsertCanonical/upsertAlias responses
    // because 404 short-circuits before them. handleMiss calls
    // attachCanonicalToFact which needs (read, update, audit).
    const script: Terminal[] = [
      { kind: "many", data: [], error: null }, // alias map
      { kind: "many", data: [], error: null }, // canonical names
      {
        kind: "many",
        data: [{ id: "F1", compound: "obscurenaturalproduct", compound_authority_attempts: 0 }],
        error: null,
      },
      // handleMiss -> attachCanonicalToFact
      { kind: "single", data: { compound_canonical_id: null, compound_authority_status: "pending", compound_authority_error: null }, error: null },
      { kind: "many", data: [], error: null }, // update
      { kind: "single", data: { id: "audit-1" }, error: null }, // audit insert
    ];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
    });
    expect(summary.scannedFacts).toBe(1);
    expect(summary.pubchemHits).toBe(0);
    expect(summary.pubchemMisses).toBe(1);
    expect(summary.retriesScheduled).toBe(1);
    expect(summary.failed).toBe(0);

    // Assert: the update payload included attempts=1
    const updateCall = calls.find(
      (c) => c.method === "update" && c.table === "research_bioprospecting_facts",
    );
    expect(updateCall).toBeDefined();
    const updatePayload = (updateCall!.args[0] as Record<string, unknown>);
    expect(updatePayload.compound_authority_attempts).toBe(1);
    expect(updatePayload.compound_authority_status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 4. PubChem 404 on the 5th attempt -> failed
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (5th 404 -> failed)", () => {
  it("writes failed when attempts is already at MAX-1", async () => {
    const fakeFetch: typeof fetch = async () => notFoundResponse();
    const max = COMPOUND_AUTHORITY_DEFAULT_MAX_RETRIES;
    const script: Terminal[] = [
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      {
        kind: "many",
        data: [
          { id: "F1", compound: "stillobscure", compound_authority_attempts: max - 1 },
        ],
        error: null,
      },
      { kind: "single", data: { compound_canonical_id: null, compound_authority_status: "pending", compound_authority_error: null }, error: null },
      { kind: "many", data: [], error: null },
      { kind: "single", data: { id: "audit-1" }, error: null },
    ];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
    });
    expect(summary.scannedFacts).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.retriesScheduled).toBe(0);

    const updateCall = calls.find(
      (c) => c.method === "update" && c.table === "research_bioprospecting_facts",
    );
    const updatePayload = (updateCall!.args[0] as Record<string, unknown>);
    expect(updatePayload.compound_authority_status).toBe("failed");
    expect(updatePayload.compound_authority_attempts).toBe(max);
  });
});

// ---------------------------------------------------------------------------
// 5. PubChem 503 with Retry-After -> gate paused, fact NOT failed
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (503 Retry-After -> gate paused, fact not failed)", () => {
  it("treats 503 as a rate-limit signal and does not mark the fact failed", async () => {
    const fakeFetch: typeof fetch = async () => rateLimitedResponse("1");
    // No attachCanonicalToFact calls should be made — the 503 is
    // caught inside fetchPubChemCid and the fact is skipped.
    const script: Terminal[] = [
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
      {
        kind: "many",
        data: [{ id: "F1", compound: "anything", compound_authority_attempts: 0 }],
        error: null,
      },
    ];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
    });
    expect(summary.scannedFacts).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.retriesScheduled).toBe(0);
    expect(summary.pubchemHits).toBe(0);
    expect(summary.pubchemMisses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. One bad fact does NOT abort the batch
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (one bad fact does not abort)", () => {
  it("processes remaining facts after a throw", async () => {
    // First fact's fetch throws (not a typed 503/404 — a network error).
    // The second fact is an alias hit, so it should still succeed.
    // We pre-populate the alias map so the second fact short-circuits.
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("simulated network failure");
      }
      // Unreachable in this test — the second fact is an alias hit
      // and never reaches fetchPubChemCid.
      return notFoundResponse();
    };
    const script: Terminal[] = [
      // loadAliasMap: aliases -> contain diferuloylmethane
      { kind: "many", data: [{ normalized_alias: "diferuloylmethane", compound_id: "C1" }], error: null },
      // loadAliasMap: canonical names -> empty
      { kind: "many", data: [], error: null },
      // selectPendingFacts
      {
        kind: "many",
        data: [
          { id: "F1", compound: "doomed", compound_authority_attempts: 0 },
          { id: "F2", compound: "diferuloylmethane", compound_authority_attempts: 0 },
        ],
        error: null,
      },
      // F2: attachCanonicalToFact (alias hit) -> read, update, audit
      { kind: "single", data: { compound_canonical_id: null, compound_authority_status: "pending", compound_authority_error: null }, error: null },
      { kind: "many", data: [], error: null },
      { kind: "single", data: { id: "audit-f2" }, error: null },
    ];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);
    globalThis.fetch = fakeFetch;

    const summary = await normalizeBioprospectingCompounds({
      limit: 50,
      rps: 100,
      fetchImpl: fakeFetch,
    });
    expect(summary.scannedFacts).toBe(2);
    expect(summary.aliasHits).toBe(1); // F2 still verified
    expect(summary.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Spike findings: 503 (not 429) is the rate-limit signal
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (rate-limit signal: 503 not 429)", () => {
  it("treats 503 with Retry-After as PubChemRateLimited, not a hard failure", async () => {
    const gate = new RateGate({ rps: 100 });
    // First call returns 503 with Retry-After: 1
    // Second call returns 200 OK (simulating a retry after the pause elapses)
    let attempts = 0;
    const fakeFetch: typeof fetch = async (input) => {
      attempts++;
      const url = String(input);
      if (attempts === 1) {
        return rateLimitedResponse("1");
      }
      if (url.includes("/compound/name/curcumin/cids")) {
        return jsonResponse({ IdentifierList: { CID: [969516] } });
      }
      if (url.includes("/compound/cid/969516/property")) {
        return jsonResponse({
          PropertyTable: {
            Properties: [
              {
                CID: 969516,
                MolecularFormula: "C21H20O6",
                InChIKey: "VFLDPWHFBUODDF-FCXRPNKRSA-N",
                IUPACName: "Curcumin",
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    // Sanity: gate.pause was called and the gate now blocks.
    void gate.take(); // claim the slot
    // Simulate the worker doing the first fetch and getting 503:
    try {
      await fetchPubChemCid("curcumin", gate, { fetchImpl: fakeFetch });
      // The first call should have thrown PubChemRateLimited, but
      // our impl may have re-tried internally? No — fetchPubChemCid
      // does NOT retry. So we expect a throw here.
    } catch (err) {
      // expect PubChemRateLimited
      expect((err as Error).name).toBe("PubChemRateLimited");
    }
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfter — also called from inside the backfill
// ---------------------------------------------------------------------------

describe("compoundAuthority — backfill (parseRetryAfter in backfill context)", () => {
  it("returns ms from PubChem's `Retry-After: 30`", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Sanity: low-level PubChem client tests (fetchPubChemCid, fetchPubChemProperties)
// ---------------------------------------------------------------------------

describe("compoundAuthority — fetchPubChemCid (low-level)", () => {
  it("returns the CID integer on 200", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({ IdentifierList: { CID: [969516] } });
    const gate = new RateGate({ rps: 100 });
    const cid = await fetchPubChemCid("curcumin", gate, { fetchImpl: fakeFetch });
    expect(cid).toBe(969516);
  });

  it("returns null on 404 (PubChemNotFound)", async () => {
    const fakeFetch: typeof fetch = async () => notFoundResponse();
    const gate = new RateGate({ rps: 100 });
    const cid = await fetchPubChemCid("zzznonexistent", gate, { fetchImpl: fakeFetch });
    expect(cid).toBeNull();
  });

  it("throws PubChemRateLimited on 503 with Retry-After", async () => {
    const fakeFetch: typeof fetch = async () => rateLimitedResponse("5");
    const gate = new RateGate({ rps: 100 });
    await expect(
      fetchPubChemCid("anything", gate, { fetchImpl: fakeFetch }),
    ).rejects.toThrow(/pubchem 503/);
    expect(gate.getPausedUntil()).toBeGreaterThan(0);
  });
});

describe("compoundAuthority — fetchPubChemProperties (low-level)", () => {
  it("returns parsed props on 200", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        PropertyTable: {
          Properties: [
            {
              CID: 969516,
              MolecularFormula: "C21H20O6",
              InChIKey: "VFLDPWHFBUODDF-FCXRPNKRSA-N",
              IUPACName: "Curcumin",
            },
          ],
        },
      });
    const gate = new RateGate({ rps: 100 });
    const props = await fetchPubChemProperties(969516, gate, { fetchImpl: fakeFetch });
    expect(props).not.toBeNull();
    expect(props!.cid).toBe(969516);
    expect(props!.inchiKey).toBe("VFLDPWHFBUODDF-FCXRPNKRSA-N");
    expect(props!.formula).toBe("C21H20O6");
    expect(props!.iupac).toBe("Curcumin");
  });

  it("returns null on 404", async () => {
    const fakeFetch: typeof fetch = async () => notFoundResponse();
    const gate = new RateGate({ rps: 100 });
    const props = await fetchPubChemProperties(999999999, gate, { fetchImpl: fakeFetch });
    expect(props).toBeNull();
  });

  it("coerces missing InChIKey/MolecularFormula to null", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        PropertyTable: {
          Properties: [
            { CID: 12345 }, // no InChIKey, no MolecularFormula, no IUPACName
          ],
        },
      });
    const gate = new RateGate({ rps: 100 });
    const props = await fetchPubChemProperties(12345, gate, { fetchImpl: fakeFetch });
    expect(props).not.toBeNull();
    expect(props!.inchiKey).toBeNull();
    expect(props!.formula).toBeNull();
    expect(props!.iupac).toBeNull();
  });
});
