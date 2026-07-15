import { describe, it, expect } from "bun:test";
import { extractEntityCandidates } from "./paperScope";

describe("extractEntityCandidates", () => {
  it("finds a latin binomial in a real question", () => {
    const q =
      "Sobre el estudio de Hemicentrotus pulcherrimus (Mar Drugs 2026, 24, 243)...";
    expect(extractEntityCandidates(q)).toContain("Hemicentrotus pulcherrimus");
  });

  it("does NOT treat common capitalized phrases as a genus", () => {
    // These would still fail the one-source distinctiveness test, but they
    // should not even be proposed as candidates.
    const out = extractEntityCandidates(
      "Marine ecosystems and Mar Drugs review of Table results",
    );
    expect(out).not.toContain("Marine ecosystems");
    expect(out).not.toContain("Mar Drugs");
    expect(out).not.toContain("Table results");
  });

  it("dedupes repeated mentions", () => {
    const q =
      "Hemicentrotus pulcherrimus ... the Hemicentrotus pulcherrimus microbiome";
    expect(
      extractEntityCandidates(q).filter(
        (e) => e === "Hemicentrotus pulcherrimus",
      ),
    ).toHaveLength(1);
  });

  it("returns nothing for a question with no binomial", () => {
    expect(
      extractEntityCandidates("What compounds inhibit biofilm formation?"),
    ).toEqual([]);
  });

  it("requires a lowercase species of at least four letters", () => {
    // "Vibrio sp" — too short a species token, not a confident binomial.
    expect(extractEntityCandidates("Vibrio sp isolates")).toEqual([]);
  });
});
