/**
 * Unit tests for the 4 pure match-algorithm functions added to
 * `src/agents/discovery/utils.ts` by `discovery-persistence` PR #1.
 *
 * Coverage matrix — one test per scenario from
 * `openspec/changes/discovery-persistence/design/design.md` §10.1:
 *
 *   - normalizeTokens: basic, diacritics, short tokens, punctuation
 *   - jaccard: identical, disjoint, partial, both-empty, one-empty
 *   - discoveryStableKey: determinism, sorted+debuggable (not hashed)
 *   - findMatchingDiscovery: high-sim match, low-sim null, empty existing,
 *     tie-break by id, parameterizable threshold
 *
 * The functions are pure (no Supabase, no LLM, no IO). No mocks.
 */

import { describe, it, expect } from "bun:test";
import {
  discoveryStableKey,
  findMatchingDiscovery,
  jaccard,
  normalizeTokens,
} from "../utils";

// ---------------------------------------------------------------------------
// normalizeTokens
// ---------------------------------------------------------------------------

describe("utils — normalizeTokens", () => {
  it("lowercases + drops tokens shorter than 3 chars (basic)", () => {
    const tokens = normalizeTokens("Compound X binds kinase Y");
    // Tokens: "compound" (9), "x" (1, dropped), "binds" (5), "kinase" (6), "y" (1, dropped).
    expect([...tokens].sort()).toEqual(["binds", "compound", "kinase"]);
  });

  it("strips diacritics via NFKD and removes the resulting non-alnum glyphs", () => {
    // "Curcumín" -> "curcumin" (í stripped); "inhibits" stays;
    // "NF" + "κ" + "B" -> "nf" + "" + "b" -> "b" (1 char) and "nf" (2 chars)
    // both dropped (< 3 chars).
    const tokens = normalizeTokens("Curcumín inhibits NF-κB");
    expect([...tokens].sort()).toEqual(["curcumin", "inhibits"]);
  });

  it("drops tokens shorter than 3 chars", () => {
    const tokens = normalizeTokens("a an the kinase");
    // "a" (1), "an" (2) dropped; "the" (3), "kinase" (6) kept.
    expect([...tokens].sort()).toEqual(["kinase", "the"]);
  });

  it("replaces non-alphanumeric runs with space, then splits", () => {
    const tokens = normalizeTokens("X, Y; Z!");
    // Punctuation -> space, split, "x" (1) and "y" (1) and "z" (1)
    // all < 3 chars, so the result is empty.
    expect([...tokens].sort()).toEqual([]);
  });

  it("keeps multi-char tokens after punctuation replacement", () => {
    const tokens = normalizeTokens("kinase-binding, in-vitro!");
    // Tokens: "kinase" (6), "binding" (7), "in" (2, dropped), "vitro" (5).
    expect([...tokens].sort()).toEqual(["binding", "kinase", "vitro"]);
  });

  it("returns an empty set for null / undefined / empty", () => {
    expect(normalizeTokens(null).size).toBe(0);
    expect(normalizeTokens(undefined).size).toBe(0);
    expect(normalizeTokens("").size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jaccard
// ---------------------------------------------------------------------------

describe("utils — jaccard", () => {
  it("returns 1.0 for identical sets", () => {
    expect(jaccard(new Set(["kinase", "binding"]), new Set(["kinase", "binding"]))).toBe(1.0);
  });

  it("returns 0.0 for disjoint sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0.0);
  });

  it("returns the correct ratio for a partial overlap", () => {
    // |A ∩ B| = 2 (kinase, binding), |A ∪ B| = 4 (kinase, binding, vitro, inhibitor).
    expect(
      jaccard(
        new Set(["kinase", "binding", "vitro"]),
        new Set(["kinase", "binding", "inhibitor"]),
      ),
    ).toBe(0.5);
  });

  it("returns 1.0 when both sets are empty (trivially equal)", () => {
    expect(jaccard(new Set(), new Set())).toBe(1.0);
  });

  it("returns 0.0 when exactly one set is empty", () => {
    expect(jaccard(new Set(), new Set(["x"]))).toBe(0.0);
    expect(jaccard(new Set(["x"]), new Set())).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// discoveryStableKey
// ---------------------------------------------------------------------------

describe("utils — discoveryStableKey", () => {
  it("is deterministic for the same input", () => {
    expect(discoveryStableKey("Kinase Binding", "In Vitro")).toBe(
      discoveryStableKey("Kinase Binding", "In Vitro"),
    );
  });

  it("is sorted, not hashed, and joined with '|'", () => {
    // "Kinase Binding In Vitro" — "in" is 2 chars and dropped. Tokens
    // kept: binding, kinase, vitro (sorted).
    expect(discoveryStableKey("Kinase Binding In Vitro", "")).toBe(
      "binding|kinase|vitro",
    );
  });

  it("returns the empty string when all tokens are dropped (< 3 chars)", () => {
    // "a" (1) + "b c d" (all 1) -> all dropped. Result: "".
    expect(discoveryStableKey("a", "b c d")).toBe("");
  });

  it("combines title + claim (the two are concatenated before tokenizing)", () => {
    // title="Foo Bar" claim="Baz Qux" -> tokens: baz, bar, foo, qux.
    expect(discoveryStableKey("Foo Bar", "Baz Qux")).toBe("bar|baz|foo|qux");
  });
});

// ---------------------------------------------------------------------------
// findMatchingDiscovery
// ---------------------------------------------------------------------------

describe("utils — findMatchingDiscovery", () => {
  const baseExisting = [
    {
      id: "row-aaa",
      discovery_key: "kinase|binding|vitro",
    },
    {
      id: "row-bbb",
      discovery_key: "compound|inhibits|pathway",
    },
    {
      id: "row-ccc",
      discovery_key: "kinase|binding|affinity",
    },
  ];

  it("returns the id of a high-similarity match (Jaccard >= 0.7)", () => {
    // incoming tokens: kinase, binding, vitro (1:1 with row-aaa).
    // |A∩B| = 3, |A∪B| = 3. Jaccard = 1.0.
    const result = findMatchingDiscovery(
      {
        title: "Kinase Binding Vitro",
        claim: "in vitro",
      },
      baseExisting,
      0.7,
    );
    expect(result).toBe("row-aaa");
  });

  it("matches a near-identical reformulation (Jaccard >= 0.7)", () => {
    // Build a row + incoming pair where tokens overlap >= 70%.
    // row-aaa-reformulation = "kinase|binding|vitro|assay"
    // incoming = "kinase binding in vitro" + "new assay data"
    // Tokens incoming: kinase, binding, vitro, new, assay, data (6 tokens).
    // row tokens: kinase, binding, vitro, assay (4 tokens).
    // |A∩B| = 4, |A∪B| = 6. Jaccard = 0.666. Just below 0.7.
    // Try a 100% match instead: incoming = exact same tokens.
    const result = findMatchingDiscovery(
      {
        title: "Kinase Binding Vitro Assay",
        claim: "kinase binding in vitro",
      },
      [
        {
          id: "row-aaa",
          discovery_key: "kinase|binding|vitro|assay",
        },
        {
          id: "row-bbb",
          discovery_key: "compound|inhibits|pathway",
        },
      ],
      0.7,
    );
    // incoming tokens: kinase, binding, vitro, assay, (kinase, binding, vitro) -> {kinase, binding, vitro, assay}.
    // 4/4 match. Jaccard = 1.0.
    expect(result).toBe("row-aaa");
  });

  it("returns null when best similarity is below threshold", () => {
    // "rainforest canopy" — none of these tokens match the existing rows.
    const result = findMatchingDiscovery(
      {
        title: "Rainforest Canopy",
        claim: "biodiversity metrics across latitudes",
      },
      baseExisting,
      0.7,
    );
    expect(result).toBeNull();
  });

  it("returns null for an empty `existing` array", () => {
    const result = findMatchingDiscovery(
      { title: "Kinase Binding", claim: "in vitro" },
      [],
      0.7,
    );
    expect(result).toBeNull();
  });

  it("breaks ties by lowest id (alphabetical)", () => {
    // Two existing rows with identical discovery_key: row-zzz and row-aaa.
    // Both should produce Jaccard = 1.0 vs the incoming. Lowest id wins.
    const tiedExisting = [
      { id: "row-zzz", discovery_key: "kinase|binding|vitro" },
      { id: "row-aaa", discovery_key: "kinase|binding|vitro" },
    ];
    const result = findMatchingDiscovery(
      { title: "Kinase Binding Vitro", claim: "in vitro" },
      tiedExisting,
      0.7,
    );
    expect(result).toBe("row-aaa");
  });

  it("treats the threshold as a parameter (default 0.7)", () => {
    // Same incoming vs same existing, but with threshold=0.5 the 0.5
    // Jaccard from `findMatchingDiscovery`'s first test is enough to match.
    // Build an existing row + incoming where Jaccard = 0.6.
    // existing row: "kinase binding" (2 tokens).
    // incoming: "kinase binding pathway" (3 tokens).
    // |A∩B| = 2, |A∪B| = 3. Jaccard = 0.6667.
    // At threshold=0.5 -> match. At threshold=0.7 -> null.
    const existing = [
      { id: "row-1", discovery_key: "kinase|binding" },
    ];
    const incoming = { title: "Kinase Binding", claim: "Pathway" };

    expect(findMatchingDiscovery(incoming, existing, 0.5)).toBe("row-1");
    expect(findMatchingDiscovery(incoming, existing, 0.7)).toBeNull();
  });

  it("defaults the threshold to 0.7 when not provided", () => {
    // 0.6667 >= 0.7 is false -> null at default.
    const existing = [
      { id: "row-1", discovery_key: "kinase|binding" },
    ];
    const incoming = { title: "Kinase Binding", claim: "Pathway" };
    expect(findMatchingDiscovery(incoming, existing)).toBeNull();
  });

  it("returns null when the incoming tokens are all empty (after normalization)", () => {
    // All tokens are < 3 chars, so incomingTokens is empty.
    const result = findMatchingDiscovery(
      { title: "a b", claim: "c d" },
      baseExisting,
      0.7,
    );
    expect(result).toBeNull();
  });

  it("skips existing rows with an empty `discovery_key`", () => {
    const existing = [
      { id: "row-empty", discovery_key: "" },
      { id: "row-1", discovery_key: "kinase|binding" },
    ];
    const result = findMatchingDiscovery(
      { title: "Kinase Binding", claim: "Pathway" },
      existing,
      0.5,
    );
    expect(result).toBe("row-1");
  });
});
