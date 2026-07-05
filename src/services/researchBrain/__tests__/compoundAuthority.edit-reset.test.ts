/**
 * Integration test for the PR #3 edit-reset audit hook in
 * `updateBioprospectingFactEntities` (`src/services/researchBrain/db.ts`).
 *
 * The hook is triggered when the editor changes the raw `compound`
 * text on a fact that previously had a canonical id. It writes a
 * `compound_authority_audit` row with `event_type = 'manual_edit'`
 * AND resets `compound_authority_status` to `'pending'`. The
 * previous `compound_canonical_id` is intentionally NOT cleared —
 * it stays on the fact row as the audit trail anchor.
 *
 * Scenarios covered:
 *   1. Compound text change + prior canonical id → audit row written,
 *      status reset to pending, canonical id kept.
 *   2. Compound text change + no prior canonical id → no audit row
 *      (the conditional only fires when there was a prior canonical).
 *   3. Other field change (e.g. species) → no audit row, no
 *      authority reset (the hook is compound-specific).
 *
 * The Supabase service client is mocked with a chainable stub.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock infrastructure — same pattern as the other test files in this dir
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
  var __compoundAuthorityEditResetTestClient: (() => any) | undefined;
}

function setMockServiceClient(factory: () => any) {
  globalThis.__compoundAuthorityEditResetTestClient = factory;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () =>
    (globalThis.__compoundAuthorityEditResetTestClient ?? (() => null))(),
  getAnonClient: () =>
    (globalThis.__compoundAuthorityEditResetTestClient ?? (() => null))(),
  getSupabaseClient: () =>
    (globalThis.__compoundAuthorityEditResetTestClient ?? (() => null))(),
  resetClients: () => undefined,
  default: () =>
    (globalThis.__compoundAuthorityEditResetTestClient ?? (() => null))(),
}));

// SUT imports (post-mock)
import { updateBioprospectingFactEntities } from "../db";

let calls: Call[];
let client: any;

beforeEach(() => {
  calls = [];
  client = scriptedMock([], calls);
  setMockServiceClient(() => client);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FACT_ID = "00000000-0000-0000-0000-0000000000f1";
const CANONICAL_ID = "00000000-0000-0000-0000-0000000000c1";
const USER_ID = "00000000-0000-0000-0000-0000000000u1";

function makeFactWithCanonical(overrides: Record<string, unknown> = {}) {
  return {
    id: FACT_ID,
    source_id: "src-1",
    species: "Curcuma longa",
    compound: "diferuloylmethane",
    compound_canonical_id: CANONICAL_ID,
    compound_authority_status: "verified",
    compound_authority_at: "2026-06-13T00:00:00Z",
    compound_authority_error: null,
    compound_authority_attempts: 0,
    metadata: {},
    source: {
      id: "src-1",
      title: "test",
      file_path: null,
      doi: null,
      url: null,
    },
    chunk: null,
    ...overrides,
  };
}

function makeFactNoCanonical(overrides: Record<string, unknown> = {}) {
  return {
    id: FACT_ID,
    source_id: "src-1",
    species: "Curcuma longa",
    compound: "diferuloylmethane",
    compound_canonical_id: null,
    compound_authority_status: "pending",
    compound_authority_at: null,
    compound_authority_error: null,
    compound_authority_attempts: 0,
    metadata: {},
    source: {
      id: "src-1",
      title: "test",
      file_path: null,
      doi: null,
      url: null,
    },
    chunk: null,
    ...overrides,
  };
}

function findAuditInserts() {
  return calls
    .filter((c) => c.method === "insert" && c.table === "compound_authority_audit")
    .flatMap((c) => c.args as any[]);
}

function findFactUpdatePayload(): Record<string, unknown> | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (
      c.method === "update" &&
      c.table === "research_bioprospecting_facts"
    ) {
      return (c.args[0] as Record<string, unknown>) ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Compound text change + prior canonical id → audit + status reset
// ---------------------------------------------------------------------------

describe("updateBioprospectingFactEntities — edit-reset audit (compound change + prior canonical)", () => {
  it("writes a manual_edit audit row and resets compound_authority_status to pending", async () => {
    client = scriptedMock(
      [
        // 1) read existing fact row (.select().eq().single())
        { kind: "single", data: makeFactWithCanonical(), error: null },
        // 2) update fact row (.update().eq().select().single())
        {
          kind: "single",
          data: makeFactWithCanonical({ compound: "Curcuma longa extract" }),
          error: null,
        },
        // 3) manual_edit audit insert (await on the .insert() chain via .then)
        { kind: "many", data: [], error: null },
        // 4) status_change audit insert (second audit row — the spec
        //    mandates BOTH rows for an editor-driven compound change
        //    on a fact that previously had a canonical id).
        { kind: "many", data: [], error: null },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    const result = await updateBioprospectingFactEntities({
      factId: FACT_ID,
      patch: { compound: "Curcuma longa extract" },
      correctedBy: USER_ID,
    });

    // The fact row was updated.
    expect(result.compound).toBe("Curcuma longa extract");

    // The update payload should reset the authority state.
    const updatePayload = findFactUpdatePayload();
    expect(updatePayload).not.toBeNull();
    expect(updatePayload?.compound_authority_status).toBe("pending");
    expect(updatePayload?.compound_authority_at).toBeNull();
    expect(updatePayload?.compound_authority_error).toBeNull();
    // The compound_canonical_id is NOT cleared — the audit
    // anchor is preserved on the row.
    expect(updatePayload?.compound_canonical_id).toBeUndefined();

    // A manual_edit audit row was written.
    const auditInserts = findAuditInserts();
    expect(auditInserts).toHaveLength(2);
    const manualEditAudit = auditInserts.find(
      (a) => (a as Record<string, unknown>).event_type === "manual_edit",
    ) as Record<string, unknown> | undefined;
    expect(manualEditAudit).toBeDefined();
    expect(manualEditAudit?.fact_id).toBe(FACT_ID);
    expect(manualEditAudit?.user_id).toBe(USER_ID);
    expect(manualEditAudit?.reason).toBe("compound_text_changed");

    // The manual_edit row's old + new values capture the diff.
    const oldValue = manualEditAudit?.old_value as Record<string, unknown>;
    const newValue = manualEditAudit?.new_value as Record<string, unknown>;
    expect(oldValue.compound).toBe("diferuloylmethane");
    expect(oldValue.compound_canonical_id).toBe(CANONICAL_ID);
    expect(oldValue.compound_authority_status).toBe("verified");
    expect(newValue.compound).toBe("Curcuma longa extract");
    expect(newValue.compound_authority_status).toBe("pending");

    // A second status_change audit row was also written — the spec
    // (PR #3 of bioprospecting-compound-authority) requires BOTH
    // rows for an editor-driven compound text change on a fact
    // that previously had a canonical id.
    const statusChangeAudit = auditInserts.find(
      (a) => (a as Record<string, unknown>).event_type === "status_change",
    ) as Record<string, unknown> | undefined;
    expect(statusChangeAudit).toBeDefined();
    expect(statusChangeAudit?.fact_id).toBe(FACT_ID);
    expect(statusChangeAudit?.user_id).toBe(USER_ID);
    expect(statusChangeAudit?.reason).toBe("edit_reset");
    const statusOld = statusChangeAudit?.old_value as Record<string, unknown>;
    const statusNew = statusChangeAudit?.new_value as Record<string, unknown>;
    expect(statusOld.compound_authority_status).toBe("verified");
    expect(statusOld.compound_canonical_id).toBe(CANONICAL_ID);
    expect(statusNew.compound_authority_status).toBe("pending");
    // The canonical id is intentionally kept on the new side too —
    // clearing it would orphan the audit trail.
    expect(statusNew.compound_canonical_id).toBe(CANONICAL_ID);
  });
});

// ---------------------------------------------------------------------------
// 2. Compound text change + no prior canonical id → no audit row
// ---------------------------------------------------------------------------

describe("updateBioprospectingFactEntities — edit-reset audit (compound change + no prior canonical)", () => {
  it("does NOT write an audit row when there was no prior canonical id", async () => {
    client = scriptedMock(
      [
        // 1) read existing fact row (no canonical)
        { kind: "single", data: makeFactNoCanonical(), error: null },
        // 2) update fact row
        {
          kind: "single",
          data: makeFactNoCanonical({ compound: "NewCompound" }),
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    await updateBioprospectingFactEntities({
      factId: FACT_ID,
      patch: { compound: "NewCompound" },
      correctedBy: USER_ID,
    });

    // The compound was changed.
    const updatePayload = findFactUpdatePayload();
    expect(updatePayload?.compound).toBe("NewCompound");
    // But the authority state was NOT touched (no prior canonical).
    expect(updatePayload?.compound_authority_status).toBeUndefined();
    // And no audit row was written.
    expect(findAuditInserts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Other field change → no audit row, no authority reset
// ---------------------------------------------------------------------------

describe("updateBioprospectingFactEntities — edit-reset audit (non-compound change)", () => {
  it("does NOT touch the authority state or write an audit row when species changes", async () => {
    client = scriptedMock(
      [
        { kind: "single", data: makeFactWithCanonical(), error: null },
        {
          kind: "single",
          data: makeFactWithCanonical({ species: "Zingiber officinale" }),
          error: null,
        },
      ],
      calls,
    );
    setMockServiceClient(() => client);

    await updateBioprospectingFactEntities({
      factId: FACT_ID,
      patch: { species: "Zingiber officinale" },
      correctedBy: USER_ID,
    });

    const updatePayload = findFactUpdatePayload();
    expect(updatePayload?.species).toBe("Zingiber officinale");
    // Authority state untouched.
    expect(updatePayload?.compound_authority_status).toBeUndefined();
    // No audit row.
    expect(findAuditInserts()).toHaveLength(0);
  });
});
