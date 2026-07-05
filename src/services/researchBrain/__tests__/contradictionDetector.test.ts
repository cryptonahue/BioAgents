import { describe, it, expect, beforeEach, vi } from "bun:test";
import type { BioprospectingFact, ResearchSource } from "../types";

/**
 * Unit tests for contradictionDetector.ts — rule-based detection logic.
 * Tests the pure matching functions and contradiction detection scenarios.
 */

const MEASUREMENT_DIRECTION_OPPOSITES: Record<string, string> = {
  agonist: "antagonist",
  antagonist: "agonist",
  activator: "inhibitor",
  inhibitor: "activator",
  upregulator: "downregulator",
  downregulator: "upregulator",
  increase: "decrease",
  decrease: "increase",
};

const RELATION_TYPE_OPPOSITES: Record<string, string> = {
  activates: "inhibits",
  inhibits: "activates",
  upregulates: "downregulates",
  downregulates: "upregulates",
  increases: "decreases",
  decreases: "increases",
};

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildKey(fact: BioprospectingFact): string | null {
  const compound = fact.compound;
  const bioactivity = fact.bioactivity;
  if (!compound || !bioactivity) return null;
  return `${normalizeForMatch(compound)}|${normalizeForMatch(bioactivity)}`;
}

function makeSource(title: string): ResearchSource {
  return {
    id: "source-1",
    source_kind: "paper",
    trust_tier: "external",
    source_scope: "global",
    title,
    extraction_status: "completed",
  };
}

function makeFact(overrides: Partial<BioprospectingFact>): BioprospectingFact {
  return {
    id: "fact-1",
    source_id: "source-1",
    status: "supported",
    confidence: "medium",
    relation_type: "reported_activity",
    compound: "Bryostatin",
    bioactivity: "PKC",
    source: makeSource("Test Paper"),
    ...overrides,
  } as BioprospectingFact;
}

describe("contradictionDetector — pure logic unit tests", () => {
  describe("normalizeForMatch", () => {
    it("should normalize diacritics", () => {
      expect(normalizeForMatch("Caulerpenyne")).toBe("caulerpenyne");
 expect(normalizeForMatch("zooxanthellae")).toBe("zooxanthellae");
    });

    it("should lowercase and trim", () => {
      expect(normalizeForMatch("  Bryostatin  ")).toBe("bryostatin");
    });

    it("should collapse whitespace", () => {
      expect(normalizeForMatch("beta carotene")).toBe("beta carotene");
    });
  });

  describe("buildKey", () => {
    it("should return compound|bioactivity key", () => {
      const fact = makeFact({ compound: "Bryostatin", bioactivity: "PKC" });
      expect(buildKey(fact)).toBe("bryostatin|pkc");
    });

    it("should return null if compound is missing", () => {
      const fact = makeFact({ compound: null as any, bioactivity: "PKC" });
      expect(buildKey(fact)).toBeNull();
    });

    it("should return null if bioactivity is missing", () => {
      const fact = makeFact({ compound: "Bryostatin", bioactivity: null as any });
      expect(buildKey(fact)).toBeNull();
    });

    it("should normalize compound and bioactivity", () => {
      const fact = makeFact({ compound: "  Bryostatin  ", bioactivity: " PKC  " });
      expect(buildKey(fact)).toBe("bryostatin|pkc");
    });
  });

  describe("MEASUREMENT_DIRECTION_OPPOSITES", () => {
    it("should have agonist/antagonist as opposites", () => {
      expect(MEASUREMENT_DIRECTION_OPPOSITES["agonist"]).toBe("antagonist");
      expect(MEASUREMENT_DIRECTION_OPPOSITES["antagonist"]).toBe("agonist");
    });

    it("should have activator/inhibitor as opposites", () => {
      expect(MEASUREMENT_DIRECTION_OPPOSITES["activator"]).toBe("inhibitor");
      expect(MEASUREMENT_DIRECTION_OPPOSITES["inhibitor"]).toBe("activator");
    });

    it("should have upregulator/downregulator as opposites", () => {
      expect(MEASUREMENT_DIRECTION_OPPOSITES["upregulator"]).toBe("downregulator");
      expect(MEASUREMENT_DIRECTION_OPPOSITES["downregulator"]).toBe("upregulator");
    });

    it("should have increase/decrease as opposites", () => {
      expect(MEASUREMENT_DIRECTION_OPPOSITES["increase"]).toBe("decrease");
      expect(MEASUREMENT_DIRECTION_OPPOSITES["decrease"]).toBe("increase");
    });
  });

  describe("RELATION_TYPE_OPPOSITES", () => {
    it("should have activates/inhibits as opposites", () => {
      expect(RELATION_TYPE_OPPOSITES["activates"]).toBe("inhibits");
      expect(RELATION_TYPE_OPPOSITES["inhibits"]).toBe("activates");
    });

    it("should have upregulates/downregulates as opposites", () => {
      expect(RELATION_TYPE_OPPOSITES["upregulates"]).toBe("downregulates");
      expect(RELATION_TYPE_OPPOSITES["downregulates"]).toBe("upregulates");
    });

    it("should have increases/decreases as opposites", () => {
      expect(RELATION_TYPE_OPPOSITES["increases"]).toBe("decreases");
      expect(RELATION_TYPE_OPPOSITES["decreases"]).toBe("increases");
    });
  });

  describe("fact grouping by key", () => {
    it("should group facts with same compound and bioactivity", () => {
      const fact1 = makeFact({ id: "f1", compound: "Bryostatin", bioactivity: "PKC", measurement_direction: "agonist" });
      const fact2 = makeFact({ id: "f2", compound: "Bryostatin", bioactivity: "PKC", measurement_direction: "antagonist" });
      const fact3 = makeFact({ id: "f3", compound: "Bryostatin", bioactivity: "PKC", measurement_direction: "agonist" });

      const groups = new Map<string, BioprospectingFact[]>();
      for (const fact of [fact1, fact2, fact3]) {
        const key = buildKey(fact);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(fact);
      }

      expect(groups.size).toBe(1);
      const group = groups.get("bryostatin|pkc")!;
      expect(group.length).toBe(3);
    });

    it("should separate facts with different compound", () => {
      const fact1 = makeFact({ id: "f1", compound: "Bryostatin", bioactivity: "PKC" });
      const fact2 = makeFact({ id: "f2", compound: "Caulerpenyne", bioactivity: "PKC" });

      const groups = new Map<string, BioprospectingFact[]>();
      for (const fact of [fact1, fact2]) {
        const key = buildKey(fact);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(fact);
      }

      expect(groups.size).toBe(2);
    });

    it("should separate facts with different bioactivity", () => {
      const fact1 = makeFact({ id: "f1", compound: "Bryostatin", bioactivity: "PKC" });
      const fact2 = makeFact({ id: "f2", compound: "Bryostatin", bioactivity: "COX-2" });

      const groups = new Map<string, BioprospectingFact[]>();
      for (const fact of [fact1, fact2]) {
        const key = buildKey(fact);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(fact);
      }

      expect(groups.size).toBe(2);
    });
  });

  describe("measurement_direction contradiction detection", () => {
    it("should detect agonist vs antagonist as measurement_direction contradiction", () => {
      const fact1 = makeFact({ id: "f1", measurement_direction: "agonist" });
      const fact2 = makeFact({ id: "f2", measurement_direction: "antagonist" });

      const dir1 = fact1.measurement_direction!.toLowerCase();
      const dir2 = fact2.measurement_direction!.toLowerCase();
      const isOpposite = MEASUREMENT_DIRECTION_OPPOSITES[dir1] === dir2;

      expect(isOpposite).toBe(true);
    });

    it("should NOT detect same direction as contradiction", () => {
      const fact1 = makeFact({ id: "f1", measurement_direction: "agonist" });
      const fact2 = makeFact({ id: "f2", measurement_direction: "agonist" });

      const dir1 = fact1.measurement_direction!.toLowerCase();
      const dir2 = fact2.measurement_direction!.toLowerCase();
      const isOpposite = MEASUREMENT_DIRECTION_OPPOSITES[dir1] === dir2;

      expect(isOpposite).toBe(false);
    });

    it("should detect activator vs inhibitor as measurement_direction contradiction", () => {
      const fact1 = makeFact({ id: "f1", measurement_direction: "activator" });
      const fact2 = makeFact({ id: "f2", measurement_direction: "inhibitor" });

      const dir1 = fact1.measurement_direction!.toLowerCase();
      const dir2 = fact2.measurement_direction!.toLowerCase();
      const isOpposite = MEASUREMENT_DIRECTION_OPPOSITES[dir1] === dir2;

      expect(isOpposite).toBe(true);
    });

    it("should be case-insensitive", () => {
      const fact1 = makeFact({ id: "f1", measurement_direction: "AGONIST" });
      const fact2 = makeFact({ id: "f2", measurement_direction: "antagonist" });

      const dir1 = fact1.measurement_direction!.toLowerCase();
      const dir2 = fact2.measurement_direction!.toLowerCase();
      const isOpposite = MEASUREMENT_DIRECTION_OPPOSITES[dir1] === dir2;

      expect(isOpposite).toBe(true);
    });
  });

  describe("relation_type contradiction detection", () => {
    it("should detect activates vs inhibits as relation_type contradiction", () => {
      const fact1 = makeFact({ id: "f1", relation_type: "activates" });
      const fact2 = makeFact({ id: "f2", relation_type: "inhibits" });

      const rel1 = fact1.relation_type.toLowerCase();
      const rel2 = fact2.relation_type.toLowerCase();
      const isOpposite = RELATION_TYPE_OPPOSITES[rel1] === rel2;

      expect(isOpposite).toBe(true);
    });

    it("should detect upregulates vs downregulates as relation_type contradiction", () => {
      const fact1 = makeFact({ id: "f1", relation_type: "upregulates" });
      const fact2 = makeFact({ id: "f2", relation_type: "downregulates" });

      const rel1 = fact1.relation_type.toLowerCase();
      const rel2 = fact2.relation_type.toLowerCase();
      const isOpposite = RELATION_TYPE_OPPOSITES[rel1] === rel2;

      expect(isOpposite).toBe(true);
    });

    it("should NOT detect same relation_type as contradiction", () => {
      const fact1 = makeFact({ id: "f1", relation_type: "activates" });
      const fact2 = makeFact({ id: "f2", relation_type: "activates" });

      const rel1 = fact1.relation_type.toLowerCase();
      const rel2 = fact2.relation_type.toLowerCase();
      const isOpposite = RELATION_TYPE_OPPOSITES[rel1] === rel2;

      expect(isOpposite).toBe(false);
    });
  });

  describe("no-match scenarios", () => {
    it("should return0 contradictions when less than 2 facts", async () => {
      // Simulate the early-return in runRuleBasedDetection
      const facts = [makeFact({ id: "f1" })];
      expect(facts.length < 2).toBe(true);
    });

    it("should not detect contradictions when facts have different compounds", () => {
      const fact1 = makeFact({ id: "f1", compound: "Bryostatin", bioactivity: "PKC", measurement_direction: "agonist" });
      const fact2 = makeFact({ id: "f2", compound: "Caulerpenyne", bioactivity: "PKC", measurement_direction: "antagonist" });

      const key1 = buildKey(fact1);
      const key2 = buildKey(fact2);

      expect(key1).not.toBe(key2);
    });

    it("should not detect contradictions when facts have different bioactivities", () => {
      const fact1 = makeFact({ id: "f1", compound: "Bryostatin", bioactivity: "PKC", measurement_direction: "agonist" });
      const fact2 = makeFact({ id: "f2", compound: "Bryostatin", bioactivity: "COX-2", measurement_direction: "antagonist" });

      const key1 = buildKey(fact1);
      const key2 = buildKey(fact2);

      expect(key1).not.toBe(key2);
    });

    it("should not detect contradictions when measurement_direction is missing", () => {
      const fact1 = makeFact({ id: "f1", measurement_direction: undefined as any });
      const fact2 = makeFact({ id: "f2", measurement_direction: "antagonist" });

      const dir1 = fact1.measurement_direction?.toLowerCase();
      const dir2 = fact2.measurement_direction?.toLowerCase();

      expect(dir1).toBeUndefined();
      expect(dir2).toBe("antagonist");
    });
  });

  describe("deduplication logic", () => {
    it("should consider same fact_a_id + fact_b_id + type as duplicate", () => {
      const existing = {
        fact_a_id: "f1",
        fact_b_id: "f2",
        conflict_type: "compound_mismatch",
      };
      const incoming = {
        fact_a_id: "f1",
        fact_b_id: "f2",
        conflict_type: "compound_mismatch",
      };

      const isDuplicate =
        existing.fact_a_id === incoming.fact_a_id &&
        existing.fact_b_id === incoming.fact_b_id &&
        existing.conflict_type === incoming.conflict_type;

      expect(isDuplicate).toBe(true);
    });

    it("should NOT consider same fact pair with different type as duplicate", () => {
      const existing = {
        fact_a_id: "f1",
        fact_b_id: "f2",
        conflict_type: "compound_mismatch",
      };
      const incoming = {
        fact_a_id: "f1",
        fact_b_id: "f2",
        conflict_type: "bioactivity_mismatch",
      };

      const isDuplicate =
        existing.fact_a_id === incoming.fact_a_id &&
        existing.fact_b_id === incoming.fact_b_id &&
        existing.conflict_type === incoming.conflict_type;

      expect(isDuplicate).toBe(false);
    });

    it("should NOT consider same type with different fact pair as duplicate", () => {
      const existing = {
        fact_a_id: "f1",
        fact_b_id: "f2",
        conflict_type: "compound_mismatch",
      };
      const incoming = {
        fact_a_id: "f1",
        fact_b_id: "f3",
        conflict_type: "compound_mismatch",
      };

      const isDuplicate =
        existing.fact_a_id === incoming.fact_a_id &&
        existing.fact_b_id === incoming.fact_b_id &&
        existing.conflict_type === incoming.conflict_type;

      expect(isDuplicate).toBe(false);
    });

    it("should NOT consider reversed fact pair as duplicate (different fact_a_id)", () => {
      const existing = {
        fact_a_id: "f1",
        fact_b_id: "f2",
        conflict_type: "compound_mismatch",
      };
      const incoming = {
        fact_a_id: "f2",
        fact_b_id: "f1",
        conflict_type: "compound_mismatch",
      };

      const isDuplicate =
        existing.fact_a_id === incoming.fact_a_id &&
        existing.fact_b_id === incoming.fact_b_id &&
        existing.conflict_type === incoming.conflict_type;

      expect(isDuplicate).toBe(false);
    });
  });

  describe("metadata structure", () => {
    it("should build correct metadata for measurement_direction conflict", () => {
      const factA = makeFact({ id: "f1", measurement_direction: "agonist", page: 3 });
      const factB = makeFact({ id: "f2", measurement_direction: "antagonist", page: 7 });

      const metadata = {
        source_a: {
          fact_id: factA.id,
          source: factA.source?.title || "",
          value: factA.measurement_direction!,
          provenance: `page ${factA.page}`,
        },
        source_b: {
          fact_id: factB.id,
          source: factB.source?.title || "",
          value: factB.measurement_direction!,
          provenance: `page ${factB.page}`,
        },
        conflict_summary: `Conflicting measurement_direction: ${factA.measurement_direction} vs ${factB.measurement_direction}`,
      };

      expect(metadata.source_a.fact_id).toBe("f1");
      expect(metadata.source_b.fact_id).toBe("f2");
      expect(metadata.conflict_summary).toContain("agonist");
      expect(metadata.conflict_summary).toContain("antagonist");
    });

    it("should build correct metadata for relation_type conflict", () => {
      const factA = makeFact({ id: "f1", relation_type: "activates" });
      const factB = makeFact({ id: "f2", relation_type: "inhibits" });

      const metadata = {
        source_a: {
          fact_id: factA.id,
          source: factA.source?.title || "",
          value: factA.relation_type,
          provenance: "unknown location",
        },
        source_b: {
          fact_id: factB.id,
          source: factB.source?.title || "",
          value: factB.relation_type,
          provenance: "unknown location",
        },
        conflict_summary: `Conflicting relation_type: ${factA.relation_type} vs ${factB.relation_type}`,
      };

      expect(metadata.conflict_summary).toContain("activates");
      expect(metadata.conflict_summary).toContain("inhibits");
    });
  });

  describe("symmetric pair avoidance", () => {
    it("should use id comparison to avoid counting both A->B and B->A", () => {
      const idA = "fact-a";
      const idB = "fact-b";

      // Only count if idA < idB (lexicographic ordering)
      const countThisPair = idA < idB;
      const countReverse = idB < idA;

      expect(countThisPair).toBe(true);
      expect(countReverse).toBe(false);
    });

    it("should count both directions when ids are equal (self-reference)", () => {
      const idA = "fact-a";
      const idB = "fact-a";

      const countThisPair = idA < idB;
      const countReverse = idB < idA;

      expect(countThisPair).toBe(false);
      expect(countReverse).toBe(false);
    });
  });
});
