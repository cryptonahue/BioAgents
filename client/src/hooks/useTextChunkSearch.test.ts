import { describe, it, expect } from "bun:test";

import {
  normalizeToAlnum,
  findAlnumMatchRuns,
  bboxFromRunRange,
  type TextRun,
} from "./useTextChunkSearch";

describe("normalizeToAlnum", () => {
  it("lowercases and drops whitespace/punctuation/hyphens", () => {
    expect(normalizeToAlnum("The health of individual organisms")).toBe(
      "thehealthofindividualorganisms",
    );
    expect(normalizeToAlnum("host's resilience — and, resistance!")).toBe(
      "hostsresilienceandresistance",
    );
  });
});

// A run only needs `str` for the match; geometry is irrelevant here.
const r = (str: string): { str: string } => ({ str });

describe("findAlnumMatchRuns", () => {
  const NEEDLE =
    // ~a real quote, > 60 alphanumeric chars
    "Microorganisms, as catalysts of all biogeochemical cycles on our planet, are the very origin and essence of life on Earth";

  it("matches a quote split across runs, tolerating line-break hyphenation", () => {
    const runs = [
      r("Preface"),
      r("Microorganisms, as catalysts of all biogeo-"),
      r("chemical cycles on our planet, are the very origin"),
      r("and essence of life on Earth. The health of ..."),
    ];
    const match = findAlnumMatchRuns(runs, normalizeToAlnum(NEEDLE));
    expect(match).not.toBeNull();
    // Anchor starts in run 1 (the "Microorganisms…" run).
    expect(match!.startRun).toBe(1);
    // And spans into the hyphen-broken continuation.
    expect(match!.endRun).toBeGreaterThanOrEqual(2);
  });

  it("does NOT match on a short spurious prefix (60-char floor)", () => {
    // The page shares only the first few words, then diverges.
    const runs = [r("Microorganisms, as catalysts of PLANKTON blooms in reef lagoons")];
    const match = findAlnumMatchRuns(runs, normalizeToAlnum(NEEDLE));
    expect(match).toBeNull();
  });

  it("returns null when the quote is absent", () => {
    const runs = [r("Completely unrelated methods section about HPLC gradients and columns")];
    const match = findAlnumMatchRuns(runs, normalizeToAlnum(NEEDLE));
    expect(match).toBeNull();
  });

  it("returns null for an empty needle or empty page", () => {
    expect(findAlnumMatchRuns([r("anything")], "")).toBeNull();
    expect(findAlnumMatchRuns([], normalizeToAlnum(NEEDLE))).toBeNull();
  });
});

describe("bboxFromRunRange", () => {
  const runs: TextRun[] = [
    { str: "a", x: 100, yTopCanvas: 200, fontHeight: 20, width: 50 },
    { str: "b", x: 160, yTopCanvas: 200, fontHeight: 20, width: 40 },
  ];

  it("unions runs and flips to bottom-left PDF space", () => {
    // pageHeightPt large enough that y stays positive.
    const bbox = bboxFromRunRange(runs, 1000, 0, 1, 3);
    expect(bbox).not.toBeNull();
    expect(bbox!.page).toBe(3);
    expect(bbox!.units).toBe("pt");
    // x = minX / scale ; w = (maxX-minX)/scale ; both positive.
    expect(bbox!.w).toBeGreaterThan(0);
    expect(bbox!.h).toBeGreaterThan(0);
  });

  it("rejects degenerate geometry", () => {
    const degenerate: TextRun[] = [
      { str: "a", x: 100, yTopCanvas: 200, fontHeight: 0, width: 0 },
    ];
    expect(bboxFromRunRange(degenerate, 1000, 0, 0, 1)).toBeNull();
  });
});
