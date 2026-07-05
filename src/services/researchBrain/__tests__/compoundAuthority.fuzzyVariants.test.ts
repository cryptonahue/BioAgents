/**
 * Unit tests for the pure fuzzy helpers used by the PubChem backfill
 * path. The goal: cover the surface cases of
 * `buildCompoundNameVariants` (the recovery candidate generator for
 * facts that came back 404 from PubChem) without any IO.
 *
 * Coverage:
 *
 *   1.  Empty / null input -> empty array
 *   2.  Single-word name with no descriptors -> one entry (the input)
 *   3.  Greek-letter prefix: alpha-mangostin -> mangostin
 *   4.  D/L sugar prefix: D-glucose -> glucose
 *   5.  Stereochemistry prefix: (E)-resveratrol -> resveratrol
 *   6.  Parenthetical chunk: "curcumin (from Curcuma longa)" -> curcumin
 *   7.  Token-strip: "marine compound 12B" -> [marine compound, marine]
 *   8.  Token-strip is applied AFTER paren removal (not on raw input)
 *   9.  Compound-kind word: "n-butanol" / "iso-leucine" -> stripped
 *   10. Multi-word compound keeps sub-prefixes; the original is always first
 *   11. Deduplication: same lowercase key appears once
 *   12. Returns an empty array, never a single empty string
 */

import { describe, it, expect } from "bun:test";

import { buildCompoundNameVariants } from "../compoundAuthority";

describe("buildCompoundNameVariants — null/empty", () => {
  it("returns [] for null", () => {
    expect(buildCompoundNameVariants(null)).toEqual([]);
  });
  it("returns [] for undefined", () => {
    expect(buildCompoundNameVariants(undefined)).toEqual([]);
  });
  it("returns [] for an empty string", () => {
    expect(buildCompoundNameVariants("")).toEqual([]);
  });
  it("returns [] for whitespace-only", () => {
    expect(buildCompoundNameVariants("   ")).toEqual([]);
  });
});

describe("buildCompoundNameVariants — single-word identity", () => {
  it("returns a single-entry array when no descriptors are present", () => {
    expect(buildCompoundNameVariants("quercetin")).toEqual(["quercetin"]);
  });
  it("preserves the original case of the input", () => {
    expect(buildCompoundNameVariants("Curcumin")).toEqual(["Curcumin"]);
  });
});

describe("buildCompoundNameVariants — Greek-letter prefix", () => {
  it("strips alpha- prefix", () => {
    expect(buildCompoundNameVariants("alpha-mangostin")).toEqual([
      "alpha-mangostin",
      "mangostin",
    ]);
  });
  it("strips beta- prefix (case-insensitive)", () => {
    expect(buildCompoundNameVariants("BETA-carotene")).toEqual([
      "BETA-carotene",
      "carotene",
    ]);
  });
  it("does NOT strip a Greek word that is not a hyphen prefix", () => {
    // "alpha tocopherol" (space-joined) is a different compound;
    // the function only strips HYPHEN-prefixed descriptors.
    expect(buildCompoundNameVariants("alpha tocopherol")).toEqual([
      "alpha tocopherol",
    ]);
  });
});

describe("buildCompoundNameVariants — D/L prefix", () => {
  it("strips D-", () => {
    expect(buildCompoundNameVariants("D-glucose")).toEqual([
      "D-glucose",
      "glucose",
    ]);
  });
  it("strips L-", () => {
    expect(buildCompoundNameVariants("L-arginine")).toEqual([
      "L-arginine",
      "arginine",
    ]);
  });
  it("strips lowercase d-", () => {
    expect(buildCompoundNameVariants("d-glucose")).toEqual([
      "d-glucose",
      "glucose",
    ]);
  });
});

describe("buildCompoundNameVariants — stereochemistry prefix", () => {
  it("strips (E)-", () => {
    const variants = buildCompoundNameVariants("(E)-resveratrol");
    expect(variants[0]).toBe("(E)-resveratrol");
    // The functional hit is the second-or-third entry (the
    // hyphenated intermediate is acceptable noise — PubChem will
    // 404 it and the caller proceeds to the next candidate).
    expect(variants).toContain("resveratrol");
  });
  it("strips (+)- and (-)-", () => {
    const pos = buildCompoundNameVariants("(+)-catechin");
    const neg = buildCompoundNameVariants("(-)-epicatechin");
    expect(pos).toContain("catechin");
    expect(neg).toContain("epicatechin");
  });
  it("strips (R)- / (S)-", () => {
    expect(buildCompoundNameVariants("(R)-limonene")).toContain("limonene");
    expect(buildCompoundNameVariants("(S)-limonene")).toContain("limonene");
  });
});

describe("buildCompoundNameVariants — parenthetical chunks", () => {
  it("strips a single parenthetical", () => {
    expect(buildCompoundNameVariants("curcumin (from Curcuma longa)")).toEqual([
      "curcumin (from Curcuma longa)",
      "curcumin",
    ]);
  });
  it("strips a code-like parenthetical (NAR)", () => {
    const variants = buildCompoundNameVariants("kaempferol-3-O-rutinoside (NAR)");
    expect(variants).toContain("kaempferol-3-O-rutinoside");
  });
});

describe("buildCompoundNameVariants — token-strip", () => {
  it("generates word-prefixes for multi-word names", () => {
    expect(buildCompoundNameVariants("marine compound 12B")).toEqual([
      "marine compound 12B",
      "marine compound",
      "marine",
    ]);
  });
  it("applies token-strip AFTER paren removal, not on the raw input", () => {
    // The parenthetical is stripped first; the token-strip then
    // walks the cleaned string. Critically, we do NOT see fragments
    // like "curcumin (from" or "curcumin (from Curcuma".
    const variants = buildCompoundNameVariants("curcumin (from Curcuma longa)");
    expect(variants).not.toContain("curcumin (from Curcuma");
    expect(variants).not.toContain("curcumin (from");
  });
  it("does not include a bare descriptor as a candidate", () => {
    // Token-strip would otherwise yield "alpha" as the final
    // candidate, which is not a compound. The function refuses
    // standalone descriptor words.
    const variants = buildCompoundNameVariants("alpha compound");
    expect(variants).not.toContain("alpha");
  });
});

describe("buildCompoundNameVariants — chain descriptors", () => {
  it("strips n- prefix", () => {
    expect(buildCompoundNameVariants("n-butanol")).toContain("butanol");
  });
  it("strips iso- prefix", () => {
    expect(buildCompoundNameVariants("iso-leucine")).toContain("leucine");
  });
  it("strips sec- / tert-", () => {
    expect(buildCompoundNameVariants("sec-butanol")).toContain("butanol");
    expect(buildCompoundNameVariants("tert-butanol")).toContain("butanol");
  });
});

describe("buildCompoundNameVariants — invariants", () => {
  it("always includes the original (case preserved) as the first entry", () => {
    const variants = buildCompoundNameVariants("(E)-Resveratrol");
    expect(variants[0]).toBe("(E)-Resveratrol");
  });
  it("does not return empty strings", () => {
    const variants = buildCompoundNameVariants("   (E)-   ");
    for (const v of variants) {
      expect(v.length).toBeGreaterThan(0);
    }
  });
  it("deduplicates (case-insensitive)", () => {
    const variants = buildCompoundNameVariants("Mangostin");
    // "mangostin" would otherwise appear twice (once from the raw
    // and once from the cleaned form); the lowercase-keyed Set
    // collapses them.
    const mangostinOccurrences = variants.filter(
      (v) => v.toLowerCase() === "mangostin",
    );
    expect(mangostinOccurrences).toHaveLength(1);
  });
  it("is bounded: returns at most ~10 candidates for typical inputs", () => {
    const variants = buildCompoundNameVariants(
      "alpha-mangostin (from Garcinia mangostana, ethanolic extract)",
    );
    expect(variants.length).toBeLessThanOrEqual(10);
  });
});
