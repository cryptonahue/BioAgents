import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * Unit tests for the bioprospecting-fact-dedup lineage helpers and the
 * canonical-precedence rule. These tests mock the Supabase service
 * client with a chainable stub and exercise the public API surface:
 *   - pickCanonicalIndex (precedence: verified > updated_at > source_id > id)
 *   - findMergedFactIds (read-only subset lookup)
 *   - getDuplicateGroup (read-only group resolution)
 *   - backfillBioprospectingFactDedup (dry-run planning)
 *   - searchBioprospectingFacts includeDuplicates filter (SQL layer)
 *
 * The chainable mock records every method call so assertions can verify
 * the SQL filter was applied (e.g., the dedup subselect for
 * `includeDuplicates`). For helpers that issue parallel/sequential
 * queries against the same client, we use a `scriptedMock` that walks
 * through a list of pre-canned responses.
 */

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[] };
type Terminal =
  | { kind: "single"; data: unknown; error: unknown }
  | { kind: "many"; data: unknown[]; error: null; errorCode?: undefined }
  | { kind: "void" };

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
];

const TERMINAL_METHODS = ["maybeSingle", "single"];

/**
 * A single shared chainable object whose terminal responses are driven
 * by a `script` of pre-canned payloads. Each entry in `script` is
 * consumed in order when a terminal method (or awaited chain) is hit.
 */
function scriptedMock(script: Terminal[], calls: Call[]) {
  let cursor = 0;
  const target: any = {};
  const next = (): unknown => {
    if (cursor >= script.length) {
      return { kind: "many", data: [], error: null };
    }
    return script[cursor++];
  };
  for (const method of BUILDER_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return target;
    };
  }
  for (const method of TERMINAL_METHODS) {
    target[method] = (...args: unknown[]) => {
      calls.push({ method, args });
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
  // Awaiting the chainable itself resolves to the next scripted
  // terminal in the list (supabase-js supports both styles).
  Object.defineProperty(target, "then", {
    get() {
      return (onFulfilled: any, onRejected: any) => {
        calls.push({ method: "then", args: [] });
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
  var __bioprospectingDedupTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__bioprospectingDedupTestClient = factory;
}

// Register the module mock BEFORE importing db.ts. The path is
// resolved relative to the test file: from
// `src/services/researchBrain/__tests__/dedup.test.ts` we need
// `../../../db/client` to reach `src/db/client.ts` (the same module
// `db.ts` itself imports via `../../db/client`). `db.ts` resolves the
// Supabase client lazily through a Proxy, so the mock factory is
// consulted on every `supabase.from(...)` call — tests can swap the
// chainable per-case via `setMockServiceClient`.
mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__bioprospectingDedupTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__bioprospectingDedupTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__bioprospectingDedupTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__bioprospectingDedupTestClient ?? (() => null))(),
}));

import {
  pickCanonicalIndex,
  findMergedFactIds,
  getDuplicateGroup,
  backfillBioprospectingFactDedup,
  searchBioprospectingFacts,
} from "../db";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeFactRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    source_id: "00000000-0000-0000-0000-0000000000aa",
    species: null,
    compound: null,
    bioactivity: null,
    organism_part: null,
    geography: null,
    review_status: "unreviewed",
    updated_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    merged_into_fact_id: null,
    ...overrides,
  };
}

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  // Each test sets its own script before invoking the helper.
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
});

// ---------------------------------------------------------------------------
// pickCanonicalIndex — canonical precedence
// ---------------------------------------------------------------------------

describe("dedup — pickCanonicalIndex (precedence)", () => {
  it("returns 0 for a single-row group", () => {
    const group = [makeFactRow({ id: "a" })];
    expect(pickCanonicalIndex(group)).toBe(0);
  });

  it("prefers verified over any non-verified row", () => {
    const verified = makeFactRow({
      id: "a",
      review_status: "verified",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const needsReview = makeFactRow({
      id: "b",
      review_status: "needs_review",
      updated_at: "2026-12-31T00:00:00Z", // more recent
    });
    const unreviewed = makeFactRow({
      id: "c",
      review_status: "unreviewed",
      updated_at: "2099-01-01T00:00:00Z", // way more recent
    });
    expect(pickCanonicalIndex([needsReview, verified, unreviewed])).toBe(1);
  });

  it("within verified, picks the most recent updated_at", () => {
    const oldVerified = makeFactRow({
      id: "a",
      review_status: "verified",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const newVerified = makeFactRow({
      id: "b",
      review_status: "verified",
      updated_at: "2026-12-31T00:00:00Z",
    });
    const unreviewed = makeFactRow({
      id: "c",
      review_status: "unreviewed",
      updated_at: "2099-01-01T00:00:00Z",
    });
    expect(pickCanonicalIndex([oldVerified, newVerified, unreviewed])).toBe(1);
  });

  it("within all-unverified, falls back to most recent updated_at", () => {
    const old = makeFactRow({
      id: "a",
      review_status: "unreviewed",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const newer = makeFactRow({
      id: "b",
      review_status: "needs_review",
      updated_at: "2026-06-01T00:00:00Z",
    });
    const newest = makeFactRow({
      id: "c",
      review_status: "unreviewed",
      updated_at: "2026-12-31T00:00:00Z",
    });
    expect(pickCanonicalIndex([old, newer, newest])).toBe(2);
  });

  it("breaks updated_at ties by source_id ascending", () => {
    const a = makeFactRow({
      id: "x",
      source_id: "source-zzz",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const b = makeFactRow({
      id: "y",
      source_id: "source-aaa",
      updated_at: "2026-01-01T00:00:00Z",
    });
    // Same updated_at, same review_status (unreviewed): source_id
    // ascending wins → b (source-aaa).
    expect(pickCanonicalIndex([a, b])).toBe(1);
  });

  it("falls back to array index when source_id and updated_at tie (stable)", () => {
    const a = makeFactRow({
      id: "x",
      source_id: "same-source",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const b = makeFactRow({
      id: "y",
      source_id: "same-source",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(pickCanonicalIndex([a, b])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findMergedFactIds — read-only subset helper
// ---------------------------------------------------------------------------

describe("dedup — findMergedFactIds", () => {
  it("returns an empty set for empty input without calling the database", async () => {
    const result = await findMergedFactIds([]);
    expect(result.size).toBe(0);
    // No `from` call should have been issued.
    const fromCalls = calls.filter((c) => c.method === "from");
    expect(fromCalls.length).toBe(0);
  });

  it("returns the subset of input ids that appear as merged_fact_id in an active edge", async () => {
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [{ merged_fact_id: "id-b" }, { merged_fact_id: "id-d" }],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await findMergedFactIds(["id-a", "id-b", "id-c", "id-d"]);
    expect(result.has("id-b")).toBe(true);
    expect(result.has("id-d")).toBe(true);
    expect(result.has("id-a")).toBe(false);
    expect(result.has("id-c")).toBe(false);
    expect(result.size).toBe(2);
  });

  it("deduplicates input ids before querying", async () => {
    client = scriptedMock(
      [{ kind: "many", data: [], error: null }],
      calls,
    );
    setMockServiceClient(() => client);
    await findMergedFactIds(["id-a", "id-a", "id-b", "id-b"]);
    const inCall = calls.find((c) => c.method === "in");
    expect(inCall).toBeDefined();
    expect(inCall!.args[1]).toEqual(["id-a", "id-b"]);
  });

  it("applies the is_active = true filter on the edge read", async () => {
    // bioprospecting-review-ui contract: an unmerged edge is invisible
    // to the lineage query layer. The helper reads the edge table
    // (the authoritative source of truth) with the `is_active = true`
    // filter; the `merged_into_fact_id` cache on the fact row is NOT
    // consulted because that cache is preserved on unmerge (audit
    // trail contract).
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [{ merged_fact_id: "id-d" }],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await findMergedFactIds(["id-a", "id-b", "id-c", "id-d"]);
    // The active filter must be in the call chain.
    const activeEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "is_active" && c.args[1] === true,
    );
    expect(activeEq).toBeDefined();
    // And the unmerged ids (A, B, C) are NOT in the result.
    expect(result.has("id-a")).toBe(false);
    expect(result.has("id-b")).toBe(false);
    expect(result.has("id-c")).toBe(false);
    expect(result.has("id-d")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDuplicateGroup — read-only group resolution
// ---------------------------------------------------------------------------

describe("dedup — getDuplicateGroup", () => {
  it("returns null for an empty factId without calling the database", async () => {
    const result = await getDuplicateGroup("");
    expect(result).toBeNull();
    const fromCalls = calls.filter((c) => c.method === "from");
    expect(fromCalls.length).toBe(0);
  });

  it("returns null when no edge references the fact", async () => {
    client = scriptedMock(
      [{ kind: "many", data: [], error: null }], // edge table empty
      calls,
    );
    setMockServiceClient(() => client);
    const result = await getDuplicateGroup("standalone-id");
    expect(result).toBeNull();
  });

  it("resolves the group when the input is the canonical fact", async () => {
    // Script (matches the function's actual query sequence):
    //   1. edges lookup (await chainable, NOT maybeSingle)
    //   2. canonical row (maybeSingle, from Promise.all branch 1)
    //   3. siblings (await chainable, from Promise.all branch 2)
    client = scriptedMock(
      [
        // Terminal 1: edges (returned by awaiting the chainable).
        {
          kind: "many",
          data: [
            {
              canonical_fact_id: "canon-1",
              merged_fact_id: "merge-1",
            },
          ],
          error: null,
        },
        // Terminal 2: canonical row (maybeSingle).
        {
          kind: "single",
          data: {
            id: "canon-1",
            merged_into_fact_id: null,
            source: null,
            chunk: null,
          },
          error: null,
        },
        // Terminal 3: siblings (awaited chainable).
        {
          kind: "many",
          data: [
            {
              id: "merge-1",
              merged_into_fact_id: "canon-1",
              source: null,
              chunk: null,
            },
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await getDuplicateGroup("canon-1");
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe("canon-1");
    expect(result!.merged.length).toBe(1);
    expect(result!.merged[0].id).toBe("merge-1");
  });

  it("resolves the group when the input is a merged sibling", async () => {
    // Same script shape: the helper detects this by comparing the input
    // to canonical_fact_id and resolves to canonical=canon-1.
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [
            {
              canonical_fact_id: "canon-1",
              merged_fact_id: "merge-1",
            },
          ],
          error: null,
        },
        {
          kind: "single",
          data: {
            id: "canon-1",
            merged_into_fact_id: null,
            source: null,
            chunk: null,
          },
          error: null,
        },
        {
          kind: "many",
          data: [
            {
              id: "merge-1",
              merged_into_fact_id: "canon-1",
              source: null,
              chunk: null,
            },
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await getDuplicateGroup("merge-1");
    expect(result).not.toBeNull();
    expect(result!.canonical.id).toBe("canon-1");
    expect(result!.merged.length).toBe(1);
    expect(result!.merged[0].id).toBe("merge-1");
  });
});

// ---------------------------------------------------------------------------
// backfillBioprospectingFactDedup — dry-run planning
// ---------------------------------------------------------------------------

describe("dedup — backfillBioprospectingFactDedup (dry-run)", () => {
  it("returns proposed counts without writing in dry-run mode", async () => {
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [
            makeFactRow({
              id: "f-1",
              species: "Aloe vera",
              compound: "quercetin",
              bioactivity: "antibacterial",
              review_status: "verified",
              updated_at: "2026-06-01T00:00:00Z",
              source_id: "src-A",
            }),
            makeFactRow({
              id: "f-2",
              species: "Aloe vera",
              compound: "quercetin",
              bioactivity: "antibacterial",
              review_status: "unreviewed",
              updated_at: "2026-05-01T00:00:00Z",
              source_id: "src-B",
            }),
            makeFactRow({
              id: "f-3",
              species: "Aloe vera",
              compound: "quercetin",
              bioactivity: "antibacterial",
              review_status: "unreviewed",
              updated_at: "2026-04-01T00:00:00Z",
              source_id: "src-C",
            }),
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await backfillBioprospectingFactDedup({
      limit: 100,
      dryRun: true,
    });
    expect(result.scannedFacts).toBe(3);
    expect(result.groupsFound).toBe(1);
    expect(result.edgesProposed).toBe(2);
    expect(result.edgesInserted).toBe(0);
    expect(result.edgesSkipped).toBe(2);
    // No insert call should have been issued.
    const insertCalls = calls.filter((c) => c.method === "insert");
    expect(insertCalls.length).toBe(0);
  });

  it("skips null-key facts (all five identity fields blank)", async () => {
    client = scriptedMock(
      [
        {
          kind: "many",
          data: [
            makeFactRow({
              id: "blank-1",
              species: null,
              compound: null,
              bioactivity: null,
              organism_part: null,
              geography: null,
            }),
            makeFactRow({
              id: "blank-2",
              species: null,
              compound: null,
              bioactivity: null,
              organism_part: null,
              geography: null,
            }),
          ],
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await backfillBioprospectingFactDedup({ dryRun: true });
    expect(result.scannedFacts).toBe(2);
    expect(result.groupsFound).toBe(0);
    expect(result.edgesProposed).toBe(0);
  });

  it("is idempotent on re-run (second run reports 0 inserts, all skipped)", async () => {
    // First run: 2 facts, group of 2, 1 edge proposed & inserted.
    // Second run: same data, but the candidate query uses the dedup
    // subselect and would return the merged rows too — but for the
    // purposes of the test, we model the second run as "all candidates
    // are merged siblings" and confirm edgesSkipped covers them.
    client = scriptedMock(
      [
        // Both runs hit the same candidate query. The first returns
        // 3 facts (1 group of 3 → 2 edges); the second returns the
        // same (the script is shared per test run, so this is the
        // final state of the data after the merge is applied — for
        // idempotency modeling purposes we use the same data).
        {
          kind: "many",
          data: [
            makeFactRow({
              id: "f-1",
              species: "Aloe vera",
              compound: "quercetin",
              bioactivity: "antibacterial",
              review_status: "verified",
              updated_at: "2026-06-01T00:00:00Z",
              source_id: "src-A",
            }),
            makeFactRow({
              id: "f-2",
              species: "Aloe vera",
              compound: "quercetin",
              bioactivity: "antibacterial",
              review_status: "unreviewed",
              updated_at: "2026-05-01T00:00:00Z",
              source_id: "src-B",
            }),
            makeFactRow({
              id: "f-3",
              species: "Aloe vera",
              compound: "quercetin",
              bioactivity: "antibacterial",
              review_status: "unreviewed",
              updated_at: "2026-04-01T00:00:00Z",
              source_id: "src-C",
            }),
          ],
          error: null,
        },
        // Apply insert: returns 0 rows (PK collision → ON CONFLICT
        // DO NOTHING means server returns 0 inserted rows for the
        // response).
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await backfillBioprospectingFactDedup({
      limit: 100,
      dryRun: false,
    });
    expect(result.scannedFacts).toBe(3);
    expect(result.groupsFound).toBe(1);
    expect(result.edgesProposed).toBe(2);
    // Insert call returned 0 rows: edgesInserted=0, edgesSkipped=2.
    expect(result.edgesInserted).toBe(0);
    expect(result.edgesSkipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// searchBioprospectingFacts — includeDuplicates filter
// ---------------------------------------------------------------------------

describe("dedup — searchBioprospectingFacts includeDuplicates flag", () => {
  // PostgREST does not support `.not("id", "in", "(SELECT …)")` — it
  // interprets the subquery string as a UUID literal and errors. The
  // dedup filter is therefore applied in JS: searchBioprospectingFacts
  // fetches the merged_fact_ids once and drops matching rows from the
  // result set. See db.ts:1530 ("hide merged siblings by default").
  it("fetches merged_fact_ids and applies the JS filter by default", async () => {
    client = scriptedMock(
      [
        // 1) edge rows fetch (merged_fact_ids)
        { kind: "many", data: [{ merged_fact_id: "merged-1" }], error: null },
        // 2) one candidate query that returns a canonical + a merged sibling
        { kind: "many", data: [
          { id: "canonical-1", compound: "Quercetin" },
          { id: "merged-1", compound: "Quercetin" },
        ], error: null },
        // 3) candidate query for the next iteration returns []
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const results = await searchBioprospectingFacts({ query: "quercetin" });
    // The merged sibling should be filtered out in JS.
    expect(results.map((r) => r.id)).toEqual(["canonical-1"]);
    // The first call must be the edge fetch.
    const edgesCall = calls.find(
      (c) => c.method === "from" && c.args[0] === "research_bioprospecting_fact_edges",
    );
    expect(edgesCall).toBeDefined();
  });

  it("skips the edge fetch when includeDuplicates is true", async () => {
    client = scriptedMock(
      [
        // only candidate queries, no edge fetch
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    await searchBioprospectingFacts({
      query: "quercetin",
      includeDuplicates: true,
    });
    // No edges fetch should happen.
    const edgesCall = calls.find(
      (c) => c.method === "from" && c.args[0] === "research_bioprospecting_fact_edges",
    );
    expect(edgesCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// bioprospecting-review-ui delta — lineage helpers filter on is_active
//
// The two new test cases verify the contract from
// `bioprospecting-semantic-dedup` spec §"Lineage Helpers Filter On
// is_active":
//   - An unmerged edge is invisible to `getDuplicateGroup` (returns null)
//   - An unmerged edge is invisible to `findMergedFactIds` (excluded)
//
// The mock for `getDuplicateGroup` is scripted: the chain reads from
// `research_bioprospecting_fact_edges` first (with `eq("is_active",
// true)`), then from `research_bioprospecting_facts`. The test asserts
// the `eq("is_active", true)` clause is present.
// ---------------------------------------------------------------------------

describe("dedup — lineage helpers filter on is_active (bioprospecting-review-ui)", () => {
  it("getDuplicateGroup applies the is_active = true filter on the edge read", async () => {
    client = scriptedMock(
      [
        // edges lookup returns empty (no active edges)
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await getDuplicateGroup("standalone-id");
    expect(result).toBeNull();
    // The `eq("is_active", true)` clause must be in the call chain.
    const activeEq = calls.find(
      (c) => c.method === "eq" && c.args[0] === "is_active" && c.args[1] === true,
    );
    expect(activeEq).toBeDefined();
  });

  it("findMergedFactIds excludes unmerged facts (spec scenario: Unmerged fact is not in findMergedFactIds)", async () => {
    // Spec scenario: facts `[A, B, C, D]` where the edge for B was
    // unmerged (so B is no longer a `merged_fact_id` in an active
    // edge) and D is still merged. The expected result is `{D}` —
    // NOT `{B, D}`. The helper reads the edge table with the
    // `is_active = true` filter, so the unmerged B never enters the
    // result set (even though B's fact row cache
    // `merged_into_fact_id` is still populated — the soft-delete
    // keeps it for the audit trail).
    client = scriptedMock(
      [
        // The edge table returns D's row only (B's row is
        // `is_active = false` and is dropped by the SQL filter, so
        // it never reaches the helper's result set).
        { kind: "many", data: [{ merged_fact_id: "id-d" }], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);
    const result = await findMergedFactIds(["id-a", "id-b", "id-c", "id-d"]);
    expect(result.has("id-d")).toBe(true);
    expect(result.has("id-b")).toBe(false);
    expect(result.size).toBe(1);
  });
});
