import { describe, it, expect } from "bun:test";

import {
  normalizeToAlnum,
  buildNeedle,
  findAlnumMatchRuns,
  MATCH_FLOOR_ALNUM,
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
