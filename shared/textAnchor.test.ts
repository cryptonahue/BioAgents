import { describe, it, expect } from "bun:test";

import {
  normalizeToAlnum,
  buildNeedle,
  findAlnumMatchRuns,
  matchFloorFor,
  MATCH_FLOOR_ALNUM,
  MATCH_FLOOR_MAX,
  MATCH_FLOOR_MIN,
} from "./textAnchor";

// A run only needs `str` to match; geometry belongs to the caller.
const r = (str: string) => ({ str });

// A real quote, comfortably over the 60-char alphanumeric floor.
const QUOTE =
  "Microorganisms, as catalysts of all biogeochemical cycles on our planet, are the very origin and essence of life on Earth";

describe("normalizeToAlnum", () => {
  it("lowercases and drops whitespace, punctuation and hyphens", () => {
    expect(normalizeToAlnum("The health of individual organisms")).toBe(
      "thehealthofindividualorganisms",
    );
    expect(normalizeToAlnum("host's resilience — and, resistance!")).toBe(
      "hostsresilienceandresistance",
    );
  });

  it("erases the difference a line-break hyphen makes", () => {
    // This is the whole point: the PDF splits the word, the quote does not.
    expect(normalizeToAlnum("commen- sal microbes")).toBe(
      normalizeToAlnum("commensal microbes"),
    );
  });
});

describe("buildNeedle", () => {
  it("returns a needle at least as long as the floor", () => {
    const needle = buildNeedle(QUOTE);
    expect(needle.length).toBeGreaterThanOrEqual(MATCH_FLOOR_ALNUM);
    expect(needle.startsWith("microorganismsascatalysts")).toBe(true);
  });

  it("REFUSES a quote too short to anchor — callers must not highlight", () => {
    // Anything under the floor could match anywhere. Better no highlight
    // than a confident wrong one.
    expect(buildNeedle("too short")).toBe("");
    expect(buildNeedle("")).toBe("");
  });

  it("defaults to the STRICTEST floor when the caller has not thought about scope", () => {
    // A caller that passes no floor is assumed to be searching a whole
    // document. Safe by default; opt in to less.
    expect(buildNeedle("Candidate 3 S. enterica 5 mg/mL 10 mg/mL")).toBe("");
  });
});

/**
 * THE FLOOR SCALES WITH THE HAYSTACK.
 *
 * "Too short to trust" is not a property of the text — it is a property of
 * how much text you search. Sixty characters is the right demand across a
 * 500,000-character book and an absurd one inside a table you have already
 * located, where a whole row is barely thirty.
 */
describe("matchFloorFor", () => {
  it("demands the full floor across a book-sized haystack", () => {
    // ~243 pages. A 20-char prefix DID match the wrong page here, which is
    // what calibrated this number.
    expect(matchFloorFor(500_000)).toBe(MATCH_FLOOR_MAX);
  });

  it("relaxes for a single page, and further for a located table", () => {
    const page = matchFloorFor(2_000);
    const table = matchFloorFor(300);
    expect(page).toBeLessThan(MATCH_FLOOR_MAX);
    expect(table).toBeLessThan(page);
    // A table row (~30 alphanumeric characters) must be anchorable once we
    // know which table it is in. That is the entire point.
    expect(table).toBeLessThan(30);
  });

  it("never drops below the minimum, however small the haystack", () => {
    // Below this a "match" stops meaning anything at all.
    expect(matchFloorFor(1)).toBe(MATCH_FLOOR_MIN);
    expect(matchFloorFor(0)).toBe(MATCH_FLOOR_MIN);
  });

  it("is monotonic — more text searched is never a weaker demand", () => {
    const sizes = [50, 300, 2_000, 20_000, 500_000];
    const floors = sizes.map(matchFloorFor);
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i]).toBeGreaterThanOrEqual(floors[i - 1]);
    }
  });
});

describe("findAlnumMatchRuns with a scoped floor", () => {
  // A real table row: short, and exactly what we want to highlight.
  const ROW = "Candidate 3 S. enterica 5 mg/mL 10 mg/mL";
  const runs = [
    { str: "Candidate 3" },
    { str: "S. enterica" },
    { str: "5 mg/mL" },
    { str: "10 mg/mL" },
  ];

  it("REFUSES the row at document scale", () => {
    const floor = matchFloorFor(500_000);
    expect(buildNeedle(ROW, floor)).toBe("");
  });

  it("ANCHORS the same row inside a located table", () => {
    // The haystack is now the table's own text, not the whole book.
    const haystack = runs.reduce(
      (n, r) => n + normalizeToAlnum(r.str).length,
      0,
    );
    const floor = matchFloorFor(haystack);
    const needle = buildNeedle(ROW, floor);
    expect(needle).not.toBe("");

    const match = findAlnumMatchRuns(runs, needle, floor);
    expect(match).not.toBeNull();
    expect(match!.startRun).toBe(0);
  });
});

describe("findAlnumMatchRuns", () => {
  it("matches across runs, seeing through line-break hyphenation", () => {
    const runs = [
      r("Preface"),
      r("Microorganisms, as catalysts of all biogeo-"), // hyphen splits the word
      r("chemical cycles on our planet, are the very origin"),
      r("and essence of life on Earth. The health of ..."),
    ];
    const match = findAlnumMatchRuns(runs, buildNeedle(QUOTE));
    expect(match).not.toBeNull();
    expect(match!.startRun).toBe(1); // anchors on the sentence, not the heading
    expect(match!.endRun).toBeGreaterThanOrEqual(2); // spans the hyphen break
  });

  // THE REGRESSION THAT SHIPPED. A short-prefix fallback matched an
  // unrelated page and drew an empty box over a book's preface. The floor
  // is what prevents it — this test is the floor's reason for existing.
  it("REFUSES a page that only shares a short prefix", () => {
    const runs = [
      r("Microorganisms, as catalysts of PLANKTON blooms in reef lagoons"),
    ];
    expect(findAlnumMatchRuns(runs, buildNeedle(QUOTE))).toBeNull();
  });

  it("returns null when the text is simply not there", () => {
    const runs = [r("An unrelated methods section about HPLC gradients")];
    expect(findAlnumMatchRuns(runs, buildNeedle(QUOTE))).toBeNull();
  });

  it("returns null on an empty needle or an empty page", () => {
    expect(findAlnumMatchRuns([r("anything")], "")).toBeNull();
    expect(findAlnumMatchRuns([], buildNeedle(QUOTE))).toBeNull();
  });

  it("is immune to punctuation and case differing from the page", () => {
    const runs = [
      r("MICROORGANISMS — as catalysts of all biogeochemical cycles"),
      r("on our planet — are the very origin and essence of life on Earth"),
    ];
    expect(findAlnumMatchRuns(runs, buildNeedle(QUOTE))).not.toBeNull();
  });
});
