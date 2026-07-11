import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import logger from "../../../utils/logger";
import type { BioprospectingFact, ResearchSource } from "../types";
import type { ContradictionInsert } from "../contradictionDb";

/**
 * Tests for the REAL `contradictionCrossSource` module.
 *
 * The lesson from PR1: `contradictionDetector.test.ts` COPY-PASTED the
 * detector's grouping, its opposites tables and its dedup predicate into the
 * test file and asserted against the copies. Tests that duplicate the
 * implementation cannot catch a contract mismatch — which is exactly how an
 * entire dead code path shipped and survived.
 *
 * So: everything below imports the module under test and drives its REAL entry
 * point, `runCrossSourceContradictionDetection`. The only thing injected is the
 * IO boundary (`deps`), so no Supabase client is ever constructed and no
 * process-wide `mock.module` is installed (bun's module mocks leak across test
 * files — PR1 got bitten by exactly that).
 */

import {
  runCrossSourceContradictionDetection,
  groupFactsAcrossSources,
  findCrossSourceConflicts,
  buildCrossSourceGroupKey,
  resolveCrossSourceBounds,
  DEFAULT_MAX_GROUP_SIZE,
  DEFAULT_MAX_ROWS_PER_RUN,
  type CrossSourceDeps,
} from "../contradictionCrossSource";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL_LUPINACIDIN = "aaaaaaaa-0000-0000-0000-000000000001";
const CANONICAL_FUCOIDAN = "aaaaaaaa-0000-0000-0000-000000000002";

const SOURCE_X = "5001";
const SOURCE_Y = "5002";
const SOURCE_Z = "5003";

function makeSource(id: string, title: string): ResearchSource {
  return {
    id,
    source_kind: "paper",
    trust_tier: "external",
    source_scope: "global",
    title,
    extraction_status: "completed",
  } as ResearchSource;
}

const SOURCES: Record<string, ResearchSource> = {
  [SOURCE_X]: makeSource(SOURCE_X, "Paper X"),
  [SOURCE_Y]: makeSource(SOURCE_Y, "Paper Y"),
  [SOURCE_Z]: makeSource(SOURCE_Z, "Paper Z"),
};

function makeFact(overrides: Partial<BioprospectingFact> & { id: string }): BioprospectingFact {
  const sourceId = overrides.source_id ?? SOURCE_X;
  return {
    source_id: sourceId,
    source: SOURCES[sourceId],
    status: "supported",
    confidence: "medium",
    relation_type: "reported_activity",
    compound: "Lupinacidin A",
    compound_canonical_id: CANONICAL_LUPINACIDIN,
    bioactivity: "Antitumor",
    ...overrides,
  } as BioprospectingFact;
}

/** The Lupinacidin A / antitumor group: agonist in Paper X, antagonist in Paper Y. */
function oppositeDirectionAcrossTwoPapers(): BioprospectingFact[] {
  return [
    makeFact({ id: "f-001", source_id: SOURCE_X, measurement_direction: "agonist", page: 3 }),
    makeFact({ id: "f-002", source_id: SOURCE_Y, measurement_direction: "antagonist", page: 7 }),
  ];
}

// ---------------------------------------------------------------------------
// Fake IO boundary — a Map keyed by the natural key the unique index enforces.
// ---------------------------------------------------------------------------

type StoredRow = ContradictionInsert & { writes: number };

class FakeContradictionStore {
  rows = new Map<string, StoredRow>();
  upsertCalls: ContradictionInsert[] = [];

  key(p: ContradictionInsert) {
    return `${p.factAId}|${p.factBId}|${p.conflictType}`;
  }

  upsert = async (params: ContradictionInsert): Promise<{ created: boolean }> => {
    this.upsertCalls.push(params);
    const key = this.key(params);
    const existing = this.rows.get(key);
    if (existing) {
      this.rows.set(key, { ...params, writes: existing.writes + 1 });
      return { created: false };
    }
    this.rows.set(key, { ...params, writes: 1 });
    return { created: true };
  };
}

function makeDeps(facts: BioprospectingFact[], store: FakeContradictionStore): CrossSourceDeps {
  return {
    fetchFacts: async () => facts,
    upsert: store.upsert,
  };
}

// ---------------------------------------------------------------------------

let originalFlag: string | undefined;
let errorLogs: Array<{ payload: unknown; message?: string }> = [];
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  originalFlag = process.env.BIOPROSPECTING_CONTRADICTION_DETECTION;
  process.env.BIOPROSPECTING_CONTRADICTION_DETECTION = "true";
  errorLogs = [];
  errorSpy = spyOn(logger, "error").mockImplementation(((payload: any, message?: string) => {
    errorLogs.push({ payload, message });
  }) as any);
});

afterEach(() => {
  errorSpy?.mockRestore();
  if (originalFlag === undefined) delete process.env.BIOPROSPECTING_CONTRADICTION_DETECTION;
  else process.env.BIOPROSPECTING_CONTRADICTION_DETECTION = originalFlag;
});

describe("contradictionCrossSource — grouping", () => {
  it("keys a group on canonical compound id + normalized bioactivity", () => {
    const fact = makeFact({ id: "f-1", bioactivity: "  Anti-Tumor  " });
    expect(buildCrossSourceGroupKey(fact)).toBe(`${CANONICAL_LUPINACIDIN}|anti tumor`);
  });

  it("refuses to group a fact with no canonical compound id", () => {
    const fact = makeFact({ id: "f-1", compound_canonical_id: null });
    expect(buildCrossSourceGroupKey(fact)).toBeNull();
  });

  it("only returns groups that span >= 2 distinct sources", () => {
    const facts = [
      // Single-source group: intra-source tier's job, must NOT appear here.
      makeFact({ id: "f-1", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-2", source_id: SOURCE_X, measurement_direction: "antagonist" }),
      // Cross-source group.
      makeFact({
        id: "f-3",
        source_id: SOURCE_X,
        compound_canonical_id: CANONICAL_FUCOIDAN,
        compound: "Fucoidan",
        bioactivity: "Antioxidant",
        measurement_direction: "increase",
      }),
      makeFact({
        id: "f-4",
        source_id: SOURCE_Y,
        compound_canonical_id: CANONICAL_FUCOIDAN,
        compound: "Fucoidan",
        bioactivity: "Antioxidant",
        measurement_direction: "decrease",
      }),
    ];

    const { groups, totalGroups } = groupFactsAcrossSources(facts);

    expect(totalGroups).toBe(2);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.compoundCanonicalId).toBe(CANONICAL_FUCOIDAN);
    expect(groups[0]!.sourceIds).toEqual([SOURCE_X, SOURCE_Y]);
  });

  it("counts facts that carry no canonical id instead of silently dropping them", () => {
    const facts = [
      makeFact({ id: "f-1", compound_canonical_id: null }),
      makeFact({ id: "f-2", compound_canonical_id: null }),
      makeFact({ id: "f-3", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-4", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
    ];
    const { factsWithoutCanonicalId, groups } = groupFactsAcrossSources(facts);
    expect(factsWithoutCanonicalId).toBe(2);
    expect(groups).toHaveLength(1);
  });
});

describe("contradictionCrossSource — conflict detection", () => {
  it("does NOT flag opposite values that live inside a single paper", () => {
    // The group spans 2 sources (so it IS a cross-source candidate), but the
    // agonist/antagonist disagreement is entirely within Paper X — Paper Y's
    // fact takes no side on this axis. That contradiction belongs to the
    // intra-source tier; re-flagging it here would duplicate its row.
    const facts = [
      makeFact({ id: "f-1", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-2", source_id: SOURCE_X, measurement_direction: "antagonist" }),
      makeFact({ id: "f-3", source_id: SOURCE_Y, measurement_direction: null }),
    ];
    const { groups } = groupFactsAcrossSources(facts);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sourceIds).toEqual([SOURCE_X, SOURCE_Y]);
    expect(findCrossSourceConflicts(groups[0]!)).toHaveLength(0);
  });

  it("DOES flag an opposite value asserted by another paper, even when one paper also disagrees with itself", () => {
    // Paper X holds both agonist and antagonist; Paper Y holds agonist. The
    // X-antagonist vs Y-agonist pair genuinely spans two papers, so it is ours.
    const facts = [
      makeFact({ id: "f-1", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-2", source_id: SOURCE_X, measurement_direction: "antagonist" }),
      makeFact({ id: "f-3", source_id: SOURCE_Y, measurement_direction: "agonist" }),
    ];
    const { groups } = groupFactsAcrossSources(facts);
    const conflicts = findCrossSourceConflicts(groups[0]!);

    expect(conflicts).toHaveLength(1);
    // The representative must be the CROSS-source pair, never the two facts
    // that share a source.
    expect(conflicts[0]!.representative).toEqual({ factAId: "f-2", factBId: "f-3" });
  });

  it("flags one conflict per axis, not one per pair", () => {
    // 3 agonist facts vs 3 antagonist facts across two papers would be 9
    // pairwise rows. Group-level detection emits exactly ONE.
    const facts = [
      makeFact({ id: "f-1", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-2", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-3", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-4", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
      makeFact({ id: "f-5", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
      makeFact({ id: "f-6", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
    ];
    const { groups } = groupFactsAcrossSources(facts);
    const conflicts = findCrossSourceConflicts(groups[0]!);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.axis).toBe("measurement_direction");
    expect(conflicts[0]!.factIds).toHaveLength(6);
    expect(conflicts[0]!.representative).toEqual({ factAId: "f-1", factBId: "f-4" });
  });

  it("detects both axes independently in the same group", () => {
    const facts = [
      makeFact({
        id: "f-1",
        source_id: SOURCE_X,
        measurement_direction: "agonist",
        relation_type: "activates",
      }),
      makeFact({
        id: "f-2",
        source_id: SOURCE_Y,
        measurement_direction: "antagonist",
        relation_type: "inhibits",
      }),
    ];
    const { groups } = groupFactsAcrossSources(facts);
    const conflicts = findCrossSourceConflicts(groups[0]!);

    expect(conflicts.map((c) => c.axis).sort()).toEqual([
      "measurement_direction",
      "relation_type",
    ]);
    expect(conflicts.map((c) => c.conflictType).sort()).toEqual([
      "bioactivity_mismatch",
      "measurement_mismatch",
    ]);
  });

  it("raises severity when three or more papers disagree", () => {
    const facts = [
      makeFact({ id: "f-1", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-2", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
      makeFact({ id: "f-3", source_id: SOURCE_Z, measurement_direction: "antagonist" }),
    ];
    const { groups } = groupFactsAcrossSources(facts);
    const [conflict] = findCrossSourceConflicts(groups[0]!);
    expect(conflict!.severity).toBe("high");
    expect(conflict!.sourceIds).toEqual([SOURCE_X, SOURCE_Y, SOURCE_Z]);
  });

  it("picks a deterministic representative pair regardless of input order", () => {
    const facts = oppositeDirectionAcrossTwoPapers();
    const forwards = findCrossSourceConflicts(groupFactsAcrossSources(facts).groups[0]!);
    const backwards = findCrossSourceConflicts(
      groupFactsAcrossSources([...facts].reverse()).groups[0]!,
    );
    expect(forwards[0]!.representative).toEqual(backwards[0]!.representative);
    expect(forwards[0]!.representative).toEqual({ factAId: "f-001", factBId: "f-002" });
  });
});

describe("runCrossSourceContradictionDetection — group-level rows", () => {
  it("emits ONE group-level row with the FULL group in metadata", async () => {
    const store = new FakeContradictionStore();
    const facts = [
      ...oppositeDirectionAcrossTwoPapers(),
      makeFact({ id: "f-003", source_id: SOURCE_Z, measurement_direction: "antagonist", page: 2 }),
    ];

    const summary = await runCrossSourceContradictionDetection({
      deps: makeDeps(facts, store),
    });

    expect(summary.crossSourceGroups).toBe(1);
    expect(summary.conflictsFound).toBe(1);
    expect(summary.rowsCreated).toBe(1);
    expect(store.upsertCalls).toHaveLength(1);

    const [row] = store.upsertCalls;
    // The pair-shaped schema still gets a real, deterministic pair...
    expect(row!.factAId).toBe("f-001");
    expect(row!.factBId).toBe("f-002");
    expect(row!.conflictType).toBe("measurement_mismatch");

    // ...and metadata carries the whole picture an operator needs.
    const meta = row!.metadata as any;
    expect(meta.detection).toBe("cross_source_rule_based");
    expect(meta.conflict_axis).toBe("measurement_direction");
    expect(meta.conflicting_fact_ids).toEqual(["f-001", "f-002", "f-003"]);
    expect(meta.source_count).toBe(3);
    expect(meta.sources.map((s: any) => s.title).sort()).toEqual([
      "Paper X",
      "Paper Y",
      "Paper Z",
    ]);
    expect(meta.sides.map((s: any) => s.value).sort()).toEqual(["agonist", "antagonist"]);
    const antagonist = meta.sides.find((s: any) => s.value === "antagonist");
    expect(antagonist.fact_ids).toEqual(["f-002", "f-003"]);
    expect(antagonist.source_ids).toEqual([SOURCE_Y, SOURCE_Z]);
  });

  it("writes nothing on --dry-run but still reports the conflicts", async () => {
    const store = new FakeContradictionStore();
    const summary = await runCrossSourceContradictionDetection({
      dryRun: true,
      deps: makeDeps(oppositeDirectionAcrossTwoPapers(), store),
    });

    expect(summary.conflictsFound).toBe(1);
    expect(summary.rowsCreated).toBe(0);
    expect(store.upsertCalls).toHaveLength(0);
  });

  it("is a no-op when BIOPROSPECTING_CONTRADICTION_DETECTION is off", async () => {
    process.env.BIOPROSPECTING_CONTRADICTION_DETECTION = "false";
    const store = new FakeContradictionStore();
    const summary = await runCrossSourceContradictionDetection({
      deps: makeDeps(oppositeDirectionAcrossTwoPapers(), store),
    });

    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("flag_disabled");
    expect(store.upsertCalls).toHaveLength(0);
  });
});

describe("runCrossSourceContradictionDetection — idempotent re-runs", () => {
  it("does not duplicate rows when re-run against an unchanged corpus", async () => {
    const store = new FakeContradictionStore();
    const facts = oppositeDirectionAcrossTwoPapers();

    const first = await runCrossSourceContradictionDetection({ deps: makeDeps(facts, store) });
    const second = await runCrossSourceContradictionDetection({ deps: makeDeps(facts, store) });
    const third = await runCrossSourceContradictionDetection({ deps: makeDeps(facts, store) });

    expect(first.rowsCreated).toBe(1);
    expect(second.rowsCreated).toBe(0);
    expect(second.rowsExisting).toBe(1);
    expect(third.rowsCreated).toBe(0);

    // Three sweeps, ONE row: the natural key (fact_a_id, fact_b_id,
    // conflict_type) is stable, which is exactly what the unique index in
    // migration 20260711030000 enforces in Postgres.
    expect(store.rows.size).toBe(1);
    const [stored] = [...store.rows.values()];
    expect(stored!.writes).toBe(3);
  });

  it("keeps the same natural key when a new paper joins the conflict", async () => {
    const store = new FakeContradictionStore();
    const facts = oppositeDirectionAcrossTwoPapers();
    await runCrossSourceContradictionDetection({ deps: makeDeps(facts, store) });

    const grown = [
      ...facts,
      makeFact({ id: "f-999", source_id: SOURCE_Z, measurement_direction: "antagonist" }),
    ];
    const second = await runCrossSourceContradictionDetection({ deps: makeDeps(grown, store) });

    expect(second.rowsCreated).toBe(0);
    expect(store.rows.size).toBe(1);

    // The row is REFRESHED, not duplicated: the new paper shows up in metadata.
    const stored = [...store.rows.values()][0]!;
    expect((stored.metadata as any).source_count).toBe(3);
    expect((stored.metadata as any).conflicting_fact_ids).toContain("f-999");
    expect(stored.severity).toBe("high");
  });
});

describe("runCrossSourceContradictionDetection — bounds", () => {
  it("defaults to 200 / 500 and reads env overrides", () => {
    expect(DEFAULT_MAX_GROUP_SIZE).toBe(200);
    expect(DEFAULT_MAX_ROWS_PER_RUN).toBe(500);

    expect(resolveCrossSourceBounds({}, {} as NodeJS.ProcessEnv)).toEqual({
      maxGroupSize: 200,
      maxRowsPerRun: 500,
    });
    expect(
      resolveCrossSourceBounds({}, {
        BIOPROSPECTING_CONTRADICTION_MAX_GROUP_SIZE: "12",
        BIOPROSPECTING_CONTRADICTION_MAX_ROWS_PER_RUN: "34",
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxGroupSize: 12, maxRowsPerRun: 34 });

    // Garbage falls back to the default rather than disabling the bound.
    expect(
      resolveCrossSourceBounds({}, {
        BIOPROSPECTING_CONTRADICTION_MAX_GROUP_SIZE: "-1",
      } as NodeJS.ProcessEnv).maxGroupSize,
    ).toBe(200);
  });

  it("SKIPS an oversized group LOUDLY — no silent truncation", async () => {
    const store = new FakeContradictionStore();
    const facts = [
      makeFact({ id: "f-01", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-02", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
      makeFact({ id: "f-03", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
    ];

    const summary = await runCrossSourceContradictionDetection({
      maxGroupSize: 2,
      deps: makeDeps(facts, store),
    });

    expect(summary.groupsSkippedTooLarge).toBe(1);
    expect(summary.groupsProcessed).toBe(0);
    expect(summary.conflictsFound).toBe(0);
    expect(store.upsertCalls).toHaveLength(0);

    // LOUD: an ERROR log naming the group, its size and the bound it broke.
    const skipLog = errorLogs.find(
      (l) => l.message === "runCrossSourceContradictionDetection_group_too_large_skipped",
    );
    expect(skipLog).toBeDefined();
    expect((skipLog!.payload as any).factCount).toBe(3);
    expect((skipLog!.payload as any).maxGroupSize).toBe(2);

    // And structured in the summary, so the CLI can shout too.
    expect(summary.skippedGroups[0]!.reason).toBe("group_too_large");
    expect(summary.skippedGroups[0]!.factCount).toBe(3);
  });

  it("stops at MAX_ROWS_PER_RUN and reports truncation at ERROR", async () => {
    const store = new FakeContradictionStore();
    // Two independent cross-source groups, each with one conflict.
    const facts = [
      makeFact({ id: "f-1", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-2", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
      makeFact({
        id: "f-3",
        source_id: SOURCE_X,
        compound_canonical_id: CANONICAL_FUCOIDAN,
        compound: "Fucoidan",
        bioactivity: "Antioxidant",
        measurement_direction: "increase",
      }),
      makeFact({
        id: "f-4",
        source_id: SOURCE_Y,
        compound_canonical_id: CANONICAL_FUCOIDAN,
        compound: "Fucoidan",
        bioactivity: "Antioxidant",
        measurement_direction: "decrease",
      }),
    ];

    const summary = await runCrossSourceContradictionDetection({
      maxRowsPerRun: 1,
      deps: makeDeps(facts, store),
    });

    expect(summary.rowsCreated).toBe(1);
    expect(summary.truncated).toBe(true);
    expect(store.upsertCalls).toHaveLength(1);
    expect(
      errorLogs.some(
        (l) => l.message === "runCrossSourceContradictionDetection_row_cap_reached",
      ),
    ).toBe(true);
  });

  it("honours --limit by capping the number of groups processed", async () => {
    const store = new FakeContradictionStore();
    const facts = [
      makeFact({ id: "f-1", source_id: SOURCE_X, measurement_direction: "agonist" }),
      makeFact({ id: "f-2", source_id: SOURCE_Y, measurement_direction: "antagonist" }),
      makeFact({
        id: "f-3",
        source_id: SOURCE_X,
        compound_canonical_id: CANONICAL_FUCOIDAN,
        compound: "Fucoidan",
        bioactivity: "Antioxidant",
        measurement_direction: "increase",
      }),
      makeFact({
        id: "f-4",
        source_id: SOURCE_Y,
        compound_canonical_id: CANONICAL_FUCOIDAN,
        compound: "Fucoidan",
        bioactivity: "Antioxidant",
        measurement_direction: "decrease",
      }),
    ];

    const summary = await runCrossSourceContradictionDetection({
      limit: 1,
      deps: makeDeps(facts, store),
    });

    expect(summary.crossSourceGroups).toBe(2);
    expect(summary.groupsProcessed).toBe(1);
    expect(summary.rowsCreated).toBe(1);
  });
});

describe("runCrossSourceContradictionDetection — ZERO LLM calls", () => {
  it("never reaches the network during a full sweep", async () => {
    const store = new FakeContradictionStore();
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls++;
      throw new Error(`Unexpected network call from a deterministic sweep: ${String(args[0])}`);
    }) as unknown as typeof fetch;

    try {
      const summary = await runCrossSourceContradictionDetection({
        deps: makeDeps(oppositeDirectionAcrossTwoPapers(), store),
      });
      expect(summary.rowsCreated).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(fetchCalls).toBe(0);
  });

  it("has no LLM module anywhere in its transitive import graph", async () => {
    // A static guarantee, stronger than a runtime spy: PR2 is 100%
    // deterministic, so the cross-source module must not even be ABLE to reach
    // an LLM. Walk the WHOLE relative-import graph from the entry module and
    // assert that neither `contradictionLlM` nor any `llm*` module appears. If
    // someone later wires an LLM tier into this path, this test fails.
    const entry = "src/services/researchBrain/contradictionCrossSource.ts";
    const seen = new Set<string>();
    const queue = [entry];
    const offenders: string[] = [];

    const resolve = async (fromFile: string, spec: string): Promise<string | null> => {
      const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
      const parts = `${dir}/${spec}`.split("/");
      const stack: string[] = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      const base = stack.join("/");
      for (const candidate of [`${base}.ts`, `${base}/index.ts`, `${base}.tsx`]) {
        if (await Bun.file(candidate).exists()) return candidate;
      }
      return null;
    };

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);

      const source = await Bun.file(file).text();
      // Type-only imports are erased at runtime, so they cannot execute an LLM
      // call — but nothing in this graph should reference an LLM at all.
      const specs = [
        ...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm),
      ].map((m) => m[1]!);

      for (const spec of specs) {
        if (/contradictionLlM/i.test(spec) || /(^|\/)llm(-|\/|$)/i.test(spec)) {
          offenders.push(`${file} -> ${spec}`);
        }
        if (!spec.startsWith(".")) continue;
        const resolved = await resolve(file, spec);
        if (resolved) queue.push(resolved);
      }
    }

    expect(offenders).toEqual([]);
    // Sanity: the walk actually traversed the graph (it did not silently
    // resolve nothing and pass vacuously).
    expect(seen.size).toBeGreaterThan(3);
  });
});
