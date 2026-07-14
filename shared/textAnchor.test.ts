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
    // Below this a "match" stops meaning anything at all — a unique hit on
    // three characters tells you nothing you can act on.
    expect(matchFloorFor(1)).toBeGreaterThanOrEqual(MATCH_FLOOR_MIN);
    expect(matchFloorFor(0)).toBeGreaterThanOrEqual(MATCH_FLOOR_MIN);
  });

  it("is monotonic — more text searched is never a weaker demand", () => {
    const sizes = [50, 300, 2_000, 20_000, 500_000];
    const floors = sizes.map(matchFloorFor);
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i]).toBeGreaterThanOrEqual(floors[i - 1]);
    }
  });
});

/**
 * UNIQUENESS IS THE REAL CRITERION; LENGTH WAS ONLY EVER A PROXY.
 *
 * We demand length because we want the match to be unambiguous — but length
 * guesses at ambiguity, and guesses wrong in both directions. "Vancomycin"
 * is ten characters and names exactly one row of a table. "5" is short and
 * appears forty times on the same page. Asking the question we actually care
 * about — does this text appear EXACTLY ONCE here? — makes the proxy stop
 * mattering.
 *
 * These runs are a REAL table from the corpus (Table 1, page 6), in the order
 * PDF.js reports them: row by row, cell by cell. A row's text is therefore
 * contiguous in the stream, which is the whole reason a row can be anchored
 * at all.
 */
describe("uniqueness, on a real table's runs", () => {
  const tableRuns = [
    { str: "Antimicrobials" }, { str: "Cut-Off Value *" },
    { str: "Candidate 1" }, { str: "Candidate 2" }, { str: "Candidate 3" },
    { str: "Vancomycin" }, { str: "4" }, { str: "0.125" }, { str: "0.125" }, { str: "0.25" },
    { str: "Gentamicin" }, { str: "4" }, { str: "0.0078" }, { str: "0.0125" }, { str: "0.0625" },
    { str: "Kanamycin" }, { str: "8" }, { str: "0.01563" }, { str: "1" }, { str: "0.5" },
  ];
  const scoped = MATCH_FLOOR_MIN;

  it("anchors a row by its label — unique, though only ten characters", () => {
    const match = findAlnumMatchRuns(
      tableRuns,
      buildNeedle("Vancomycin", scoped),
      scoped,
    );
    expect(match).not.toBeNull();
    expect(tableRuns[match!.startRun].str).toBe("Vancomycin");
  });

  it("anchors a whole row, whose cells are contiguous in the stream", () => {
    const row = "Vancomycin 4 0.125 0.125 0.25";
    const match = findAlnumMatchRuns(
      tableRuns,
      buildNeedle(row, scoped),
      scoped,
    );
    expect(match).not.toBeNull();
    expect(tableRuns[match!.startRun].str).toBe("Vancomycin");
    // It spans the row's cells, not just the label.
    expect(match!.endRun).toBeGreaterThan(match!.startRun);
  });

  // "4" appears in the Vancomycin row AND the Gentamicin row. A length floor
  // would have let it through if it were long enough; uniqueness will not,
  // because it cannot tell you WHICH four you meant.
  it("REFUSES an ambiguous cell, however the floor is set", () => {
    // Bypass buildNeedle's floor to prove the matcher itself refuses.
    expect(findAlnumMatchRuns(tableRuns, "4", 1)).toBeNull();
    expect(findAlnumMatchRuns(tableRuns, "0125", 1)).toBeNull(); // 0.125 twice
  });

  it("still refuses text that is not there at all", () => {
    expect(
      findAlnumMatchRuns(tableRuns, buildNeedle("Ciprofloxacin", scoped), scoped),
    ).toBeNull();
  });
});

describe("scale still governs what a caller may even attempt", () => {
  const ROW = "Candidate 3 S. enterica 5 mg/mL 10 mg/mL";

  it("REFUSES the row at document scale — it is too short to trust there", () => {
    expect(buildNeedle(ROW, matchFloorFor(500_000))).toBe("");
  });

  it("ACCEPTS it once the search is scoped to a located table", () => {
    expect(buildNeedle(ROW, MATCH_FLOOR_MIN)).not.toBe("");
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
