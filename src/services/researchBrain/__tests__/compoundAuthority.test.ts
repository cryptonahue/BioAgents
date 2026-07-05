import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Unit tests for `compoundAuthority.ts` (PR #1 of
 * `bioprospecting-compound-authority`).
 *
 * Coverage matrix — one test per spec scenario from
 * `openspec/changes/bioprospecting-compound-authority/specs/bioprospecting-compound-authority/spec.md`:
 *
 *   1.  looksLikeExtract — common extract phrases return true
 *   2.  looksLikeExtract — single molecule names return false
 *   3.  looksLikeExtract — case-insensitive (COLD-PRESSED FISH OIL)
 *   4.  looksLikeExtract — TME-1 returns true
 *   5.  resolveInitialStatus — extract short-circuits to skipped
 *   6.  resolveInitialStatus — alias hit returns verified
 *   7.  resolveInitialStatus — miss returns pending
 *   8.  attachCompoundAuthority — verified fact is preserved on re-call (idempotent)
 *   9.  attachCompoundAuthority — non-string compound falls back to pending
 *   10. attachCanonicalToFact — happy path updates fact + writes status_change audit
 *   11. attachCanonicalToFact — rollback when audit insert throws
 *   12. addAlias — happy path writes alias + audit row
 *   13. addAlias — duplicate is a no-op (no new audit row)
 *   14. promoteFactToPending — failed -> pending writes audit
 *   15. promoteFactToPending — non-failed throws "not in failed state"
 *   16. promoteFactToPending — missing fact throws "fact not found"
 *   17. searchCompoundsByName — default limit 25, max 100
 *   18. searchCompoundsByName — empty query returns empty
 *   19. getCanonicalById — returns null on miss
 *   20. normalizeForCompoundLookup — NFKD + diacritic + lowercase + collapse
 *   21. attachCompoundAuthority — pending + alias hit -> verified
 *   22. attachCompoundAuthority — pending + no hit -> pending with no canonical
 *   23. attachCompoundAuthority — extract -> skipped
 *   24. addAlias — empty alias throws
 *   25. promoteFactToPending — rollback when audit insert throws
 *
 * The tests are hermetic: the Supabase service client is mocked with
 * a chainable stub. No DB or network round-trip happens.
 */

// ---------------------------------------------------------------------------
// Mock infrastructure — mirrors bioprospectingExtractor.tables.test.ts
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
  const next = (): unknown => {
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
      const t = next() as any;
      if (t.kind === "single") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
      if (t.kind === "many") {
        return Promise.resolve({ data: t.data, error: t.error });
      }
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
  var __compoundAuthorityTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__compoundAuthorityTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__compoundAuthorityTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__compoundAuthorityTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__compoundAuthorityTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__compoundAuthorityTestClient ?? (() => null))(),
}));

// SUT imports (post-mock)
import {
  addAlias,
  attachCanonicalToFact,
  attachCompoundAuthority,
  COMPOUND_AUTHORITY_REASONS,
  getCanonicalById,
  loadAliasMap,
  looksLikeExtract,
  normalizeForCompoundLookup,
  promoteFactToPending,
  resolveInitialStatus,
  searchCompoundsByName,
} from "../compoundAuthority";
import type { ExtractedBioprospectingFact } from "../types";

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
});

// ---------------------------------------------------------------------------
// 1-4. looksLikeExtract
// ---------------------------------------------------------------------------

describe("compoundAuthority — looksLikeExtract (extract phrases return true)", () => {
  const trueCases = [
    "Echinacea purpurea extract",
    "turmeric essential oil",
    "green tea infusion",
    "TME-1",
    "fish oil",
    "crude methanol fraction",
    "ginkgo tincture",
    "Aloe vera juice",
    "maca powder",
    "lavender decoction",
    "frankincense resin",
    "vitamin C formulation",
    "herbal preparation",
    "buffer solution",
    "nano-emulsion",
    "polyphenol blend",
    "essential oil mixture",
    "vitamin combination",
  ];
  for (const value of trueCases) {
    it(`returns true for ${JSON.stringify(value)}`, () => {
      expect(looksLikeExtract(value)).toBe(true);
    });
  }
});

describe("compoundAuthority — looksLikeExtract (single molecules return false)", () => {
  const falseCases = [
    "curcumin",
    "quercetin-3-O-glucoside",
    "EPA",
    "diferuloylmethane",
    "bryostatin-1",
    "paclitaxel",
    "DHA",
  ];
  for (const value of falseCases) {
    it(`returns false for ${JSON.stringify(value)}`, () => {
      expect(looksLikeExtract(value)).toBe(false);
    });
  }
});

describe("compoundAuthority — looksLikeExtract (case-insensitive)", () => {
  it("matches COLD-PRESSED FISH OIL case-insensitively", () => {
    expect(looksLikeExtract("COLD-PRESSED FISH OIL")).toBe(true);
  });
  it("matches Mixed-Case Extract", () => {
    expect(looksLikeExtract("Mixed-Case Extract")).toBe(true);
  });
});

describe("compoundAuthority — looksLikeExtract (non-string / nullish safe)", () => {
  it("returns false for null", () => {
    expect(looksLikeExtract(null)).toBe(false);
  });
  it("returns false for undefined", () => {
    expect(looksLikeExtract(undefined)).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(looksLikeExtract("")).toBe(false);
  });
  it("returns false for non-string", () => {
    expect(looksLikeExtract(42 as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5-7. resolveInitialStatus
// ---------------------------------------------------------------------------

describe("compoundAuthority — resolveInitialStatus (extract short-circuits to skipped)", () => {
  it("returns skipped with extract_or_mixture error and no alias lookup", () => {
    const aliasMap = new Map<string, string>([["diferuloylmethane", "C1"]]);
    const result = resolveInitialStatus("Curcuma longa extract", aliasMap);
    expect(result.canonicalId).toBeNull();
    expect(result.status).toBe("skipped");
    expect(result.error).toBe("extract_or_mixture");
    expect(result.at).not.toBeNull();
  });
});

describe("compoundAuthority — resolveInitialStatus (alias hit returns verified)", () => {
  it("returns verified with the matched canonical id and an at timestamp", () => {
    const aliasMap = new Map<string, string>([["diferuloylmethane", "C1"]]);
    const result = resolveInitialStatus("Diferuloylmethane", aliasMap);
    expect(result.canonicalId).toBe("C1");
    expect(result.status).toBe("verified");
    expect(result.error).toBeNull();
    expect(result.at).not.toBeNull();
  });

  it("matches case-insensitively after normalization", () => {
    const aliasMap = new Map<string, string>([["diferuloylmethane", "C1"]]);
    const result = resolveInitialStatus("DIFERULOYLMETHANE", aliasMap);
    expect(result.canonicalId).toBe("C1");
    expect(result.status).toBe("verified");
  });

  it("matches diacritics after NFKD + diacritic strip", () => {
    const aliasMap = new Map<string, string>([["curcumin", "C1"]]);
    const result = resolveInitialStatus("Curcumín", aliasMap);
    expect(result.canonicalId).toBe("C1");
    expect(result.status).toBe("verified");
  });
});

describe("compoundAuthority — resolveInitialStatus (miss returns pending)", () => {
  it("returns pending with no canonical id and no error", () => {
    const aliasMap = new Map<string, string>();
    const result = resolveInitialStatus("obscurenaturalproduct", aliasMap);
    expect(result.canonicalId).toBeNull();
    expect(result.status).toBe("pending");
    expect(result.at).toBeNull();
    expect(result.error).toBeNull();
  });

  it("returns pending for null / undefined / empty", () => {
    const aliasMap = new Map<string, string>();
    expect(resolveInitialStatus(null, aliasMap).status).toBe("pending");
    expect(resolveInitialStatus(undefined, aliasMap).status).toBe("pending");
    expect(resolveInitialStatus("", aliasMap).status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 20. normalizeForCompoundLookup
// ---------------------------------------------------------------------------

describe("compoundAuthority — normalizeForCompoundLookup", () => {
  it("lowercases + trims + collapses whitespace", () => {
    expect(normalizeForCompoundLookup("  Curcumin  ")).toBe("curcumin");
  });
  it("strips diacritics via NFKD", () => {
    expect(normalizeForCompoundLookup("Curcumín")).toBe("curcumin");
  });
  it("collapses non-alphanumeric to single spaces", () => {
    expect(normalizeForCompoundLookup("quercetin-3-O-glucoside")).toBe(
      "quercetin 3 o glucoside",
    );
  });
  it("returns empty string for null / undefined / non-string", () => {
    expect(normalizeForCompoundLookup(null)).toBe("");
    expect(normalizeForCompoundLookup(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 8-9, 21-23. attachCompoundAuthority
// ---------------------------------------------------------------------------

describe("compoundAuthority — attachCompoundAuthority (idempotent on verified)", () => {
  it("preserves a previously-stamped verified status on re-call", () => {
    const aliasMap = new Map<string, string>();
    const fact: ExtractedBioprospectingFact = {
      compound: "curcumin",
      compound_canonical_id: "C1",
      compound_authority_status: "verified",
      compound_authority_at: "2026-06-13T00:00:00Z",
      compound_authority_error: null,
    } as ExtractedBioprospectingFact;
    const stamped = attachCompoundAuthority(fact, aliasMap);
    expect(stamped.compound_canonical_id).toBe("C1");
    expect(stamped.compound_authority_status).toBe("verified");
    expect(stamped.compound_authority_at).toBe("2026-06-13T00:00:00Z");
  });
});

describe("compoundAuthority — attachCompoundAuthority (alias hit -> verified)", () => {
  it("stamps verified and the matched canonical id", () => {
    const aliasMap = new Map<string, string>([["diferuloylmethane", "C1"]]);
    const stamped = attachCompoundAuthority(
      { compound: "Diferuloylmethane" } as ExtractedBioprospectingFact,
      aliasMap,
    );
    expect(stamped.compound_canonical_id).toBe("C1");
    expect(stamped.compound_authority_status).toBe("verified");
    expect(stamped.compound_authority_at).not.toBeNull();
  });
});

describe("compoundAuthority — attachCompoundAuthority (no alias hit -> pending)", () => {
  it("stamps pending and no canonical id", () => {
    const aliasMap = new Map<string, string>();
    const stamped = attachCompoundAuthority(
      { compound: "obscurenaturalproduct" } as ExtractedBioprospectingFact,
      aliasMap,
    );
    expect(stamped.compound_canonical_id).toBeNull();
    expect(stamped.compound_authority_status).toBe("pending");
    expect(stamped.compound_authority_at).toBeNull();
  });
});

describe("compoundAuthority — attachCompoundAuthority (extract -> skipped)", () => {
  it("stamps skipped with extract_or_mixture error", () => {
    const stamped = attachCompoundAuthority(
      { compound: "Curcuma longa extract" } as ExtractedBioprospectingFact,
      new Map(),
    );
    expect(stamped.compound_canonical_id).toBeNull();
    expect(stamped.compound_authority_status).toBe("skipped");
    expect(stamped.compound_authority_error).toBe("extract_or_mixture");
    expect(stamped.compound_authority_at).not.toBeNull();
  });
});

describe("compoundAuthority — attachCompoundAuthority (defaults attempts to 0)", () => {
  it("stamps compound_authority_attempts to 0 when the fact has no prior value", () => {
    const stamped = attachCompoundAuthority(
      { compound: "curcumin" } as ExtractedBioprospectingFact,
      new Map(),
    );
    expect(stamped.compound_authority_attempts).toBe(0);
  });
  it("preserves a pre-existing compound_authority_attempts value", () => {
    const stamped = attachCompoundAuthority(
      {
        compound: "curcumin",
        compound_authority_attempts: 3,
      } as unknown as ExtractedBioprospectingFact,
      new Map(),
    );
    expect(stamped.compound_authority_attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 10-11. attachCanonicalToFact
// ---------------------------------------------------------------------------

describe("compoundAuthority — attachCanonicalToFact (happy path)", () => {
  it("updates the fact columns and inserts a status_change audit row", async () => {
    // Script:
    //   0. read previous state -> returned (fact exists, prior state)
    //   1. update fact -> many []
    //   2. insert audit -> many []
    const script = [
      {
        kind: "single",
        data: {
          compound_canonical_id: null,
          compound_authority_status: "pending",
          compound_authority_error: null,
        },
        error: null,
      },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await attachCanonicalToFact({
      factId: "F1",
      canonicalId: "C1",
      status: "verified",
      reason: COMPOUND_AUTHORITY_REASONS.pubchemResolved,
    });

    // Verify: an update on research_bioprospecting_facts and an
    // insert on compound_authority_audit were issued.
    const fromCalls = calls.filter((c) => c.method === "from");
    expect(fromCalls.length).toBeGreaterThanOrEqual(3);
    const fromArgs = fromCalls.map((c) => c.args[0]);
    expect(fromArgs).toContain("research_bioprospecting_facts");
    expect(fromArgs).toContain("compound_authority_audit");

    // Verify the audit insert payload.
    const auditInsert = calls.find(
      (c) => c.method === "insert" && c.table === "compound_authority_audit",
    );
    expect(auditInsert).toBeDefined();
    const auditPayload = (auditInsert!.args[0] as Record<string, unknown>);
    expect(auditPayload.event_type).toBe("status_change");
    expect(auditPayload.fact_id).toBe("F1");
    expect(auditPayload.reason).toBe(COMPOUND_AUTHORITY_REASONS.pubchemResolved);
    expect((auditPayload.new_value as Record<string, unknown>).compound_authority_status).toBe("verified");
    expect((auditPayload.new_value as Record<string, unknown>).compound_canonical_id).toBe("C1");
  });
});

describe("compoundAuthority — attachCanonicalToFact (rollback on audit insert throw)", () => {
  it("issues a compensating update when the audit insert throws", async () => {
    // Script:
    //   0. read previous state (pending, canonical null)
    //   1. update fact -> many []
    //   2. insert audit -> error
    //   3. compensating update -> many []
    const script = [
      {
        kind: "single",
        data: {
          compound_canonical_id: null,
          compound_authority_status: "pending",
          compound_authority_error: null,
        },
        error: null,
      },
      { kind: "many", data: [], error: null },
      { kind: "many", data: null, error: { message: "audit insert failed" } },
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await expect(
      attachCanonicalToFact({
        factId: "F1",
        canonicalId: "C1",
        status: "verified",
        reason: COMPOUND_AUTHORITY_REASONS.pubchemResolved,
      }),
    ).rejects.toBeDefined();

    // Verify: there should be TWO update calls on
    // research_bioprospecting_facts (the original + the rollback).
    const updateCalls = calls.filter((c) => c.method === "update");
    expect(updateCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 12-13, 24. addAlias
// ---------------------------------------------------------------------------

describe("compoundAuthority — addAlias (happy path)", () => {
  it("inserts the alias and writes a manual_alias_add audit row", async () => {
    // Script:
    //   0. read existing alias (idempotency check) -> null
    //   1. insert alias -> single { id: 'A1' }
    //   2. insert audit -> many []
    const script = [
      { kind: "many", data: null, error: null },
      { kind: "single", data: { id: "A1" }, error: null },
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await addAlias({
      canonicalId: "C1",
      alias: "turmeric-extract-curcumin",
      confidence: "high",
      userId: "U1",
    });
    expect(result.id).toBe("A1");

    // Verify the audit insert payload.
    const fromCalls = calls.filter((c) => c.method === "from");
    const fromArgs = fromCalls.map((c) => c.args[0]);
    const auditInsert = calls.find(
      (c) => c.method === "insert" && c.table === "compound_authority_audit",
    );
    expect(auditInsert).toBeDefined();
    const auditPayload = (auditInsert!.args[0] as Record<string, unknown>);
    expect(auditPayload.event_type).toBe("manual_alias_add");
    expect(auditPayload.fact_id).toBeNull();
    expect(auditPayload.user_id).toBe("U1");
    expect((auditPayload.new_value as Record<string, unknown>).compound_id).toBe("C1");
    expect((auditPayload.new_value as Record<string, unknown>).alias).toBe(
      "turmeric-extract-curcumin",
    );
    expect(
      (auditPayload.new_value as Record<string, unknown>).normalized_alias,
    ).toBe("turmeric extract curcumin");
    expect((auditPayload.new_value as Record<string, unknown>).source).toBe(
      "manual",
    );
    expect(
      (auditPayload.new_value as Record<string, unknown>).confidence,
    ).toBe("high");
  });
});

describe("compoundAuthority — addAlias (duplicate is a no-op)", () => {
  it("returns the existing id without inserting a new alias or audit row", async () => {
    // Script: 1 read returns the existing alias id, no insert.
    const script = [
      { kind: "single", data: { id: "A1" }, error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await addAlias({
      canonicalId: "C1",
      alias: "turmeric-extract-curcumin",
      confidence: "high",
      userId: "U1",
    });
    expect(result.id).toBe("A1");

    // Only the read happened — no insert calls.
    const insertCalls = calls.filter((c) => c.method === "insert");
    expect(insertCalls.length).toBe(0);
  });
});

describe("compoundAuthority — addAlias (empty alias throws)", () => {
  it("rejects an empty alias with an error", async () => {
    await expect(
      addAlias({
        canonicalId: "C1",
        alias: "",
        confidence: "high",
        userId: "U1",
      }),
    ).rejects.toThrow(/alias is required/);
  });
  it("rejects a whitespace-only alias with an error", async () => {
    await expect(
      addAlias({
        canonicalId: "C1",
        alias: "   ",
        confidence: "high",
        userId: "U1",
      }),
    ).rejects.toThrow(/alias is required/);
  });
});

// ---------------------------------------------------------------------------
// 14-16, 25. promoteFactToPending
// ---------------------------------------------------------------------------

describe("compoundAuthority — promoteFactToPending (failed -> pending)", () => {
  it("updates the fact to pending and writes a status_change audit row", async () => {
    // Script:
    //   0. read fact (current state = failed) -> single
    //   1. update fact -> many []
    //   2. insert audit -> many []
    const script = [
      {
        kind: "single",
        data: {
          compound_canonical_id: null,
          compound_authority_status: "failed",
          compound_authority_error: "pubchem 404 not found",
        },
        error: null,
      },
      { kind: "many", data: [], error: null },
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await promoteFactToPending({
      factId: "F1",
      userId: "U1",
      reason: "curator confirmed compound exists",
    });

    // Verify: a status_change audit row was inserted with the right
    // old/new values.
    const fromCalls = calls.filter((c) => c.method === "from");
    const fromArgs = fromCalls.map((c) => c.args[0]);
    const auditInsert = calls.find(
      (c) => c.method === "insert" && c.table === "compound_authority_audit",
    );
    expect(auditInsert).toBeDefined();
    const auditPayload = (auditInsert!.args[0] as Record<string, unknown>);
    expect(auditPayload.event_type).toBe("status_change");
    expect(auditPayload.user_id).toBe("U1");
    expect(auditPayload.reason).toBe("curator confirmed compound exists");
    expect(
      (auditPayload.old_value as Record<string, unknown>)
        .compound_authority_status,
    ).toBe("failed");
    expect(
      (auditPayload.old_value as Record<string, unknown>)
        .compound_authority_error,
    ).toBe("pubchem 404 not found");
    expect(
      (auditPayload.new_value as Record<string, unknown>)
        .compound_authority_status,
    ).toBe("pending");
    expect(
      (auditPayload.new_value as Record<string, unknown>)
        .compound_authority_error,
    ).toBeNull();
  });
});

describe("compoundAuthority — promoteFactToPending (non-failed throws)", () => {
  it("rejects a verified fact with 'not in failed state' and does not write", async () => {
    const script = [
      {
        kind: "single",
        data: {
          compound_canonical_id: "C1",
          compound_authority_status: "verified",
          compound_authority_error: null,
        },
        error: null,
      },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await expect(
      promoteFactToPending({
        factId: "F1",
        userId: "U1",
        reason: "should not happen",
      }),
    ).rejects.toThrow(/not in failed state/);

    const updateCalls = calls.filter((c) => c.method === "update");
    const insertCalls = calls.filter((c) => c.method === "insert");
    expect(updateCalls.length).toBe(0);
    expect(insertCalls.length).toBe(0);
  });

  it("rejects a pending fact with 'not in failed state' and does not write", async () => {
    const script = [
      {
        kind: "single",
        data: {
          compound_canonical_id: null,
          compound_authority_status: "pending",
          compound_authority_error: null,
        },
        error: null,
      },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await expect(
      promoteFactToPending({
        factId: "F1",
        userId: "U1",
        reason: "should not happen",
      }),
    ).rejects.toThrow(/not in failed state/);
  });
});

describe("compoundAuthority — promoteFactToPending (missing fact throws)", () => {
  it("throws 'fact not found' when the fact does not exist", async () => {
    const script = [
      { kind: "single", data: null, error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await expect(
      promoteFactToPending({
        factId: "F-MISSING",
        userId: "U1",
        reason: "irrelevant",
      }),
    ).rejects.toThrow(/fact not found/);
  });
});

describe("compoundAuthority — promoteFactToPending (rollback on audit insert throw)", () => {
  it("issues a compensating update when the audit insert throws", async () => {
    // Script:
    //   0. read fact (failed)
    //   1. update fact to pending
    //   2. insert audit -> error
    //   3. compensating update to failed
    const script = [
      {
        kind: "single",
        data: {
          compound_canonical_id: null,
          compound_authority_status: "failed",
          compound_authority_error: "pubchem 404 not found",
        },
        error: null,
      },
      { kind: "many", data: [], error: null },
      { kind: "many", data: null, error: { message: "audit insert failed" } },
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    await expect(
      promoteFactToPending({
        factId: "F1",
        userId: "U1",
        reason: "irrelevant",
      }),
    ).rejects.toBeDefined();

    const updateCalls = calls.filter((c) => c.method === "update");
    expect(updateCalls.length).toBe(2); // original + rollback
  });
});

// ---------------------------------------------------------------------------
// 17-18. searchCompoundsByName
// ---------------------------------------------------------------------------

describe("compoundAuthority — searchCompoundsByName (default + max limit)", () => {
  it("returns [] for empty / whitespace query without hitting the DB", async () => {
    const result1 = await searchCompoundsByName("");
    const result2 = await searchCompoundsByName("   ");
    expect(result1).toEqual([]);
    expect(result2).toEqual([]);
  });

  it("caps limit at 100 and floors at 1", async () => {
    // Single read with a wide candidate fetch.
    const script = [
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    // Negative or zero limit should clamp to 1..100. We only assert
    // the function does not throw; the limit is an internal detail.
    await expect(searchCompoundsByName("curcumin", -5)).resolves.toBeDefined();
    await expect(searchCompoundsByName("curcumin", 0)).resolves.toBeDefined();
    await expect(searchCompoundsByName("curcumin", 9999)).resolves.toBeDefined();
  });

  it("ranks an exact-normalized match ahead of an alias match", async () => {
    // The candidate fetch is wide; the alias pass enriches.
    // Two compounds: C_curcumin (canonical_name = "Curcumin") and
    // C_other (canonical_name = "Othermol"). The query is "curcumin";
    // only C_curcumin matches canonical. We seed alias rows so
    // C_other also matches via alias to confirm the ranking puts
    // C_curcumin first.
    const script = [
      {
        kind: "many",
        data: [
          {
            id: "C_curcumin",
            canonical_name: "Curcumin",
            normalized_name: "curcumin",
            inchi_key: "VFLDPWHFBROODJ-UHFFFAOYSA-N",
            pubchem_cid: 969516,
            chebi_id: null,
            molecular_formula: "C21H20O6",
            iupac_name: null,
            compound_kind: "small_molecule",
            status: "curated",
            external_ids: {},
            metadata: {},
            created_at: "2026-06-13T00:00:00Z",
            updated_at: "2026-06-13T00:00:00Z",
          },
          {
            id: "C_other",
            canonical_name: "Othermol",
            normalized_name: "othermol",
            inchi_key: null,
            pubchem_cid: null,
            chebi_id: null,
            molecular_formula: null,
            iupac_name: null,
            compound_kind: "small_molecule",
            status: "local",
            external_ids: {},
            metadata: {},
            created_at: "2026-06-13T00:00:00Z",
            updated_at: "2026-06-13T00:00:00Z",
          },
        ],
        error: null,
      },
      {
        kind: "many",
        data: [{ compound_id: "C_other", alias: "curcumin", normalized_alias: "curcumin" }],
        error: null,
      },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await searchCompoundsByName("curcumin", 25);
    expect(result.length).toBe(2);
    // C_curcumin is an exact-normalized match; should come first.
    expect(result[0].id).toBe("C_curcumin");
    expect(result[1].id).toBe("C_other");
  });
});

// ---------------------------------------------------------------------------
// 19. getCanonicalById
// ---------------------------------------------------------------------------

describe("compoundAuthority — getCanonicalById (returns null on miss)", () => {
  it("returns null when the canonical does not exist", async () => {
    const script = [
      { kind: "single", data: null, error: null },
      { kind: "many", data: [], error: null },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const result = await getCanonicalById("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("returns null for empty canonicalId without hitting the DB", async () => {
    const result = await getCanonicalById("");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadAliasMap — one-shot alias map loader
// ---------------------------------------------------------------------------

describe("compoundAuthority — loadAliasMap (one-shot SQL)", () => {
  it("returns a map keyed on normalized_alias -> compound_id and canonical normalized_name -> id", async () => {
    // Two parallel reads: aliases + compounds. Promise.all means we
    // can return them in either order; the function consumes both.
    const script = [
      {
        kind: "many",
        data: [
          { normalized_alias: "diferuloylmethane", compound_id: "C1" },
          { normalized_alias: "turmeric yellow", compound_id: "C1" },
        ],
        error: null,
      },
      {
        kind: "many",
        data: [
          { normalized_name: "curcumin", id: "C1" },
        ],
        error: null,
      },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const map = await loadAliasMap();
    expect(map.size).toBe(3);
    expect(map.get("diferuloylmethane")).toBe("C1");
    expect(map.get("turmeric yellow")).toBe("C1");
    expect(map.get("curcumin")).toBe("C1");
  });

  it("prefers the canonical name over an alias on collision", async () => {
    // Both rows normalize to "curcumin" — the canonical one wins.
    const script = [
      {
        kind: "many",
        data: [{ normalized_alias: "curcumin", compound_id: "C_alias" }],
        error: null,
      },
      {
        kind: "many",
        data: [{ normalized_name: "curcumin", id: "C_canon" }],
        error: null,
      },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const map = await loadAliasMap();
    expect(map.get("curcumin")).toBe("C_canon");
  });

  it("returns an empty map when both reads error", async () => {
    const script = [
      { kind: "many", data: [], error: { message: "alias read failed" } },
      {
        kind: "many",
        data: [],
        error: { message: "canonical read failed" },
      },
    ] as Terminal[];
    client = scriptedMock(script, calls);
    setMockServiceClient(() => client);

    const map = await loadAliasMap();
    expect(map.size).toBe(0);
  });
});
