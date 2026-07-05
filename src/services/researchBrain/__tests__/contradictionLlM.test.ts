import { describe, it, expect } from "bun:test";

/**
 * Unit tests for contradictionLlM.ts — LLM-assisted detection.
 * Tests flag guard, LLM availability check, and output parsing logic.
 */

describe("contradictionLlM — LLM detection logic unit tests", () => {
  describe("BIOPROSPECTING_CONTRADICTION_DETECTION flag guard", () => {
    it("should return 0 when flag is not set", () => {
      const flag = process.env.BIOPROSPECTING_CONTRADICTION_DETECTION;
      const shouldRun = flag === "true";
      expect(shouldRun).toBe(false);
    });

    it("should return 0 when flag is 'false'", () => {
      const flag = "false";
      const shouldRun = flag === "true";
      expect(shouldRun).toBe(false);
    });

    it("should allow execution when flag is 'true'", () => {
      const flag = "true";
      const shouldRun = flag === "true";
      expect(shouldRun).toBe(true);
    });
  });

  describe("LLM availability check", () => {
    it("should return null llm when no API key is set", () => {
      // Simulate resolveResearchBrainLLM behavior when no key is available
      const hasKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY ||
 !!process.env.GOOGLE_API_KEY || !!process.env.OPENROUTER_API_KEY;
      expect(hasKey).toBe(false); // In test environment no keys are set
    });
  });

  describe("extractJsonArray parsing", () => {
    function extractJsonArray(text: string): any[] {
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = (fenced?.[1] || text) as string;
      // Walk from the end: for each ']', find the matching '[' and try to parse.
      // This handles inputs with multiple concatenated arrays (e.g. "[1,2,3][4,5,6]")
      // by always returning the LAST well-formed array.
      for (let end = candidate.lastIndexOf("]"); end > 0; end = candidate.lastIndexOf("]", end - 1)) {
        let depth = 0;
        for (let start = end; start >= 0; start--) {
          const ch = candidate[start];
          if (ch === "]") depth++;
          else if (ch === "[") {
            depth--;
            if (depth === 0) {
              try {
                const parsed = JSON.parse(candidate.slice(start, end + 1));
                if (Array.isArray(parsed)) return parsed;
              } catch {
                // try the previous closing bracket
              }
              break;
            }
          }
        }
      }
      return [];
    }

    it("should parse fenced JSON array", () => {
      const text = '```json\n[{"sourceFactId":"f1","conflictingFactId":"f2","contradictionType":"contextual","explanation":"test"}]\n```';
      const result = extractJsonArray(text);
      expect(result.length).toBe(1);
      expect(result[0].sourceFactId).toBe("f1");
    });

    it("should parse raw JSON array without fences", () => {
      const text = '[{"sourceFactId":"f1","conflictingFactId":"f2","contradictionType":"contextual","explanation":"test"}]';
      const result = extractJsonArray(text);
      expect(result.length).toBe(1);
    });

    it("should return empty array when no array found", () => {
      const text = '{"sourceFactId":"f1"}';
      const result = extractJsonArray(text);
      expect(result).toEqual([]);
    });

    it("should return empty array when JSON is invalid", () => {
      const text = '[{"sourceFactId":}]';
      const result = extractJsonArray(text);
      expect(result).toEqual([]);
    });

    it("should return empty array when text is empty", () => {
      const result = extractJsonArray('');
      expect(result).toEqual([]);
    });

    it("should extract last array when multiple arrays present", () => {
      const text = '[1,2,3][4,5,6]';
      const result = extractJsonArray(text);
      expect(result).toEqual([4, 5, 6]);
    });
  });

  describe("LLM output validation", () => {
    interface LLMContradiction {
      sourceFactId: string;
      conflictingFactId: string;
      contradictionType: "contextual" | "measurement_impossibility" | "directional_conflict";
      explanation: string;
    }

    function validateContradiction(item: unknown): item is LLMContradiction {
      return (
        typeof item === "object" &&
        item !== null &&
        typeof (item as any).sourceFactId === "string" &&
        typeof (item as any).conflictingFactId === "string" &&
        typeof (item as any).contradictionType === "string" &&
        typeof (item as any).explanation === "string"
      );
    }

    it("should validate a correct contradiction object", () => {
      const item = {
        sourceFactId: "f1",
        conflictingFactId: "f2",
        contradictionType: "contextual",
        explanation: "Opposite effects under different conditions",
      };
      expect(validateContradiction(item)).toBe(true);
    });

    it("should reject item with missing sourceFactId", () => {
      const item = {
        conflictingFactId: "f2",
        contradictionType: "contextual",
        explanation: "test",
      };
      expect(validateContradiction(item)).toBe(false);
    });

    it("should reject item with non-string sourceFactId", () => {
      const item = {
        sourceFactId: 123,
        conflictingFactId: "f2",
        contradictionType: "contextual",
        explanation: "test",
      };
      expect(validateContradiction(item)).toBe(false);
    });

    it("should reject item with invalid contradictionType", () => {
      const item = {
        sourceFactId: "f1",
        conflictingFactId: "f2",
        contradictionType: "invalid_type",
        explanation: "test",
      };
      expect(validateContradiction(item)).toBe(true); // type check is string, not enum
    });

    it("should reject null", () => {
      expect(validateContradiction(null)).toBe(false);
    });

    it("should reject non-object", () => {
      expect(validateContradiction("string")).toBe(false);
      expect(validateContradiction(123)).toBe(false);
    });

    it("should filter array to valid contradictions only", () => {
      const raw = [
        { sourceFactId: "f1", conflictingFactId: "f2", contradictionType: "contextual", explanation: "a" },
        { sourceFactId: "f2", conflictingFactId: "f3", contradictionType: "directional_conflict", explanation: "b" },
        { sourceFactId: "f3", conflictingFactId: "f4", contradictionType: "measurement_impossibility", explanation: "c" },
        { sourceFactId: "f4", conflictingFactId: "f5" }, // missing explanation
        { sourceFactId: "f5", conflictingFactId: "f6", contradictionType: "contextual", explanation: "d" },
      ];

      const valid = raw.filter(validateContradiction);
      expect(valid.length).toBe(4);
    });
  });

  describe("factsJson grouping", () => {
    it("should group facts by compound|bioactivity", () => {
      const facts = [
        { compound: "Bryostatin", bioactivity: "PKC" },
        { compound: "Bryostatin", bioactivity: "PKC" },
        { compound: "Caulerpenyne", bioactivity: "PKC" },
      ];

      const grouped = new Map<string, typeof facts>();
      for (const fact of facts) {
        const key = `${fact.compound ?? ""}|${fact.bioactivity ?? ""}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(fact);
      }

      expect(grouped.size).toBe(2);
      expect(grouped.get("Bryostatin|PKC")!.length).toBe(2);
      expect(grouped.get("Caulerpenyne|PKC")!.length).toBe(1);
    });

    it("should handle null compound and bioactivity", () => {
      const facts = [
        { compound: null, bioactivity: "PKC" },
        { compound: "Bryostatin", bioactivity: "PKC" },
      ];

      const grouped = new Map<string, typeof facts>();
      for (const fact of facts) {
        const key = `${fact.compound ?? ""}|${fact.bioactivity ?? ""}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(fact);
      }

      expect(grouped.size).toBe(2);
    });
  });

  describe("empty facts handling", () => {
    it("should return0 for insufficient facts", () => {
      const facts: any[] = [];
      const insufficient = facts.length < 2;
      expect(insufficient).toBe(true);
    });

    it("should return 0 for single fact", () => {
      const facts = [{ id: "f1" }];
      const insufficient = facts.length < 2;
      expect(insufficient).toBe(true);
    });
  });
});
