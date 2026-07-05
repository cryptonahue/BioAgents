import { describe, it, expect } from "bun:test";
import { normalizeForIdentity, buildIdentityKey } from "../normalize";
import type { BioprospectingFact } from "../types";

/**
 * Unit tests for identity-key normalization (Phase 1) and 5-tuple key
 * construction. These cover the pure transforms — no database.
 *
 * Mirrors the style of `contradictionDetector.test.ts` (pure-logic
 * scenarios). Scenarios are taken directly from the spec
 * (`specs/bioprospecting-fact-dedup/spec.md`).
 */

function makeFact(overrides: Partial<BioprospectingFact>): BioprospectingFact {
  return {
    id: "fact-x",
    relation_type: "reported_activity",
    status: "supported",
    confidence: "medium",
    species: null,
    compound: null,
    bioactivity: null,
    organism_part: null,
    geography: null,
    ...overrides,
  } as BioprospectingFact;
}

describe("normalize.ts — normalizeForIdentity", () => {
  it("folds diacritics to ASCII (NFKD + diacritic strip)", () => {
    expect(normalizeForIdentity("Quercetin")).toBe("quercetin");
    expect(normalizeForIdentity("zooxanthellae")).toBe("zooxanthellae");
  });

  it("strips combining diacritics and lowercases the result", () => {
    // The spec's reference scenario: "  Árból  marítimum  " -> "arbol maritimum"
    expect(normalizeForIdentity("  Árból  marítimum  ")).toBe("arbol maritimum");
  });

  it("collapses whitespace runs to a single space", () => {
    expect(normalizeForIdentity("  beta   carotene  ")).toBe("beta carotene");
  });

  it("replaces non-alphanumeric runs with a single space (dash becomes space)", () => {
    // Spec: "querce-tin" -> "querce tin" (NOT "quercetin")
    expect(normalizeForIdentity("querce-tin")).toBe("querce tin");
  });

  it("keeps chemically distinct compounds distinct after normalization", () => {
    // Spec: "quercetin" vs "quercetin-3-O-glucoside" must differ
    expect(normalizeForIdentity("quercetin")).toBe("quercetin");
    expect(normalizeForIdentity("quercetin-3-O-glucoside")).toBe(
      "quercetin 3 o glucoside",
    );
    expect(normalizeForIdentity("quercetin")).not.toBe(
      normalizeForIdentity("quercetin-3-O-glucoside"),
    );
  });

  it("treats casing and trailing punctuation as equivalent", () => {
    // Spec: "Quercetin", "  quercetin ", "QUERCETIN," all collapse to
    // the same "quercetin"
    expect(normalizeForIdentity("Quercetin")).toBe("quercetin");
    expect(normalizeForIdentity("  quercetin ")).toBe("quercetin");
    expect(normalizeForIdentity("QUERCETIN,")).toBe("quercetin");
    // And these all share the same key
    expect(normalizeForIdentity("Quercetin")).toBe(
      normalizeForIdentity("QUERCETIN,"),
    );
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeForIdentity("")).toBe("");
    expect(normalizeForIdentity("   ")).toBe("");
  });
});

describe("normalize.ts — buildIdentityKey", () => {
  it("returns the 5-tuple shape (species|compound|bioactivity|organism_part|geography)", () => {
    const key = buildIdentityKey(
      makeFact({
        species: "Aloe vera",
        compound: "quercetin",
        bioactivity: "antibacterial",
        organism_part: "leaf",
        geography: "Mexico",
      }),
    );
    expect(key).toBe("aloe vera|quercetin|antibacterial|leaf|mexico");
  });

  it("is stable across re-runs on the same input", () => {
    const fact = makeFact({
      species: "Aloe vera",
      compound: "quercetin",
      bioactivity: "antibacterial",
      organism_part: "leaf",
      geography: "Mexico",
    });
    expect(buildIdentityKey(fact)).toBe(buildIdentityKey(fact));
  });

  it("treats casing, whitespace, and punctuation in identity fields as equivalent", () => {
    const factA = makeFact({
      compound: "Quercetin",
      bioactivity: "antibacterial",
    });
    const factB = makeFact({
      compound: "  quercetin ",
      bioactivity: "ANTIBACTERIAL,",
    });
    expect(buildIdentityKey(factA)).toBe(buildIdentityKey(factB));
  });

  it("returns null when all five identity fields are null/empty", () => {
    expect(
      buildIdentityKey(
        makeFact({
          species: null,
          compound: null,
          bioactivity: null,
          organism_part: null,
          geography: null,
        }),
      ),
    ).toBeNull();
    expect(
      buildIdentityKey(
        makeFact({
          species: "",
          compound: "   ",
          bioactivity: null,
          organism_part: null,
          geography: undefined,
        }),
      ),
    ).toBeNull();
  });

  it("excludes high-cardinality fields from the key (result_summary, quote, measurement_*)", () => {
    const factA = makeFact({
      compound: "quercetin",
      bioactivity: "PKC inhibition",
      result_summary: "IC50 of 12 uM observed in vitro",
      quote: "Bryostatin-like activity was not observed",
      measurement_value: 12.5,
      measurement_unit: "uM",
    });
    const factB = makeFact({
      compound: "quercetin",
      bioactivity: "PKC inhibition",
      result_summary: "IC50 of 87 uM in cell-based assay",
      quote: "Completely different wording for the same finding",
      measurement_value: 87.0,
      measurement_unit: "nM",
    });
    // Identical identity fields → identical key, regardless of
    // result_summary / quote / measurement drift.
    expect(buildIdentityKey(factA)).toBe(buildIdentityKey(factB));
  });

  it("produces distinct keys for chemically distinct compounds", () => {
    const factQ = makeFact({
      species: "Aloe vera",
      compound: "quercetin",
      bioactivity: "antibacterial",
    });
    const factQG = makeFact({
      species: "Aloe vera",
      compound: "quercetin-3-O-glucoside",
      bioactivity: "antibacterial",
    });
    expect(buildIdentityKey(factQ)).not.toBe(buildIdentityKey(factQG));
  });

  it("treats a partial identity tuple (some fields null) as a non-null key when at least one field has content", () => {
    const fact = makeFact({
      species: "Aloe vera",
      compound: null,
      bioactivity: null,
      organism_part: null,
      geography: null,
    });
    // Should produce a key like "aloe vera||||" (or similar) — null is
    // the all-blank case only. A single non-null field is enough.
    expect(buildIdentityKey(fact)).not.toBeNull();
    expect(buildIdentityKey(fact)).toContain("aloe vera");
  });
});
