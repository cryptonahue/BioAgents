import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { indexPdfText, type PdfTextIndex } from "./textAnchor";
import {
  detectCaptions,
  uniqueCaptions,
  resolveCaption,
  type Caption,
} from "./captions";

const PAPER = path.resolve(
  import.meta.dir,
  "../../../docs/marinedrugs/marinedrugs-24-00137.pdf",
);
const hasPaper = existsSync(PAPER);
const withPaper = hasPaper ? it : it.skip;

let cached: PdfTextIndex | null = null;
async function index(): Promise<PdfTextIndex> {
  if (!cached) {
    cached = await indexPdfText(new Uint8Array(await readFile(PAPER)));
  }
  return cached;
}

/**
 * GROUND TRUTH, read off the real paper.
 *
 * marinedrugs-24-00137 declares exactly three tables and five figures.
 * The layout-heuristic detector this replaces reported THIRTY-TWO tables
 * for the same document — one of them the paper's own title — and rated
 * them at a median confidence of 0.988.
 *
 * These numbers are the whole argument: the paper labels its own tables,
 * so we do not have to guess, and a guess cannot be graded.
 */
const EXPECTED_TABLES = [
  { label: "Table 1", page: 6 },
  { label: "Table 2", page: 6 },
  { label: "Table 3", page: 7 },
];
const EXPECTED_FIGURES = [
  { label: "Figure 1", page: 3 },
  { label: "Figure 2", page: 3 },
  { label: "Figure 3", page: 4 },
  { label: "Figure 4", page: 5 },
  { label: "Figure 5", page: 8 },
];

describe("detectCaptions (real paper)", () => {
  withPaper("finds exactly the tables the paper declares — three, not 32", async () => {
    const tables = uniqueCaptions(detectCaptions(await index())).filter(
      (c) => c.kind === "table",
    );
    expect(tables.map((c) => ({ label: c.label, page: c.page }))).toEqual(
      EXPECTED_TABLES,
    );
  }, 60_000);

  withPaper("finds exactly the figures the paper declares", async () => {
    const figures = uniqueCaptions(detectCaptions(await index())).filter(
      (c) => c.kind === "figure",
    );
    expect(figures.map((c) => ({ label: c.label, page: c.page }))).toEqual(
      EXPECTED_FIGURES,
    );
  }, 60_000);

  // Body text refers to tables and figures constantly — "the MIC values in
  // Table 1", "(Figure 3a)". Those are references, not captions. Detecting
  // them would resurrect the false positives we just killed.
  withPaper("does NOT mistake an in-text reference for a caption", async () => {
    const captions = detectCaptions(await index());
    // Page 5 says "…in Table 1, the MIC values of candidates 1–3…" and
    // page 2 says "…(Figure 1a). At the order level…". Neither page
    // carries the corresponding caption.
    expect(captions.some((c) => c.label === "Table 1" && c.page === 5)).toBe(
      false,
    );
    expect(captions.some((c) => c.label === "Figure 1" && c.page === 2)).toBe(
      false,
    );
  }, 60_000);

  // "Table S4", "Figure S1" are supplementary material, published
  // elsewhere. There is nothing in THIS pdf to point at.
  withPaper("ignores supplementary items (Table S4, Figure S1)", async () => {
    const captions = await index().then(detectCaptions);
    // Every detected number is one the paper prints for an item it
    // contains — digits (and dots), never an "S" prefix.
    expect(captions.every((c) => /^\d+(\.\d+)*$/.test(c.number))).toBe(true);
    expect(captions.some((c) => /^(Table|Figure)\s+S/.test(c.text))).toBe(
      false,
    );
  }, 60_000);

  withPaper("boxes the caption label somewhere real on its page", async () => {
    const t1 = uniqueCaptions(detectCaptions(await index())).find(
      (c) => c.label === "Table 1",
    )!;
    expect(t1.bbox.page).toBe(6);
    expect(t1.bbox.w).toBeGreaterThan(0);
    expect(t1.bbox.h).toBeGreaterThan(0);
    // Left margin of the text column, not pinned to the page edge.
    expect(t1.bbox.x).toBeGreaterThan(50);
    expect(t1.bbox.y).toBeGreaterThan(0);
  }, 60_000);
});

describe("resolveCaption", () => {
  withPaper("resolves a citation against what the paper actually declares", async () => {
    const captions = detectCaptions(await index());
    const t3 = resolveCaption(captions, "table", 3);
    expect(t3).not.toBeNull();
    expect(t3!.page).toBe(7);
  }, 60_000);

  // The reason this function returns null instead of throwing or guessing:
  // a model that cites "Table 7" in a three-table paper has hallucinated.
  // Dropping the link is honest. Inventing a target for it is not.
  withPaper("returns null for a table the paper does not have", async () => {
    const captions = detectCaptions(await index());
    expect(resolveCaption(captions, "table", 7)).toBeNull();
  }, 60_000);
});

describe("detectCaptions (synthetic — the rules, without a PDF)", () => {
  const idx = (strs: string[]): PdfTextIndex => ({
    numPages: 1,
    pages: [strs.map((str) => ({ str, x: 166, yTop: 100, w: 40, h: 9 }))],
  });

  it("matches a label-only run", () => {
    expect(detectCaptions(idx(["Table 1."])).map((c) => c.label)).toEqual([
      "Table 1",
    ]);
  });

  it("matches a label followed by its caption text in one run", () => {
    const found = detectCaptions(
      idx(["Figure 3. Broth microdilution assay of crude extracts."]),
    );
    expect(found.map((c) => c.label)).toEqual(["Figure 3"]);
  });

  it("refuses a reference buried in prose", () => {
    expect(
      detectCaptions(idx(["the MIC values in Table 1, measured at 37 C"])),
    ).toEqual([] as Caption[]);
  });

  // FOUND BY SWEEPING THE REAL CORPUS. A line-wrapped reference can START a
  // run, so "begins with a label" is not enough on its own — and this exact
  // string made a 243-page book report one table it does not have. The
  // separator after the number is what rejects it: prose never has one.
  it("refuses a line-wrapped reference that begins a run", () => {
    expect(
      detectCaptions(
        idx(["Table 1 in Ushijima et al. 2022). Interestingly, only a subset"]),
      ),
    ).toEqual([] as Caption[]);
  });

  it("refuses a run that starts with the word but carries no number", () => {
    expect(
      detectCaptions(idx(["Table encompasses the functions and benefits"])),
    ).toEqual([] as Caption[]);
  });

  // A book numbers its captions by chapter. Missing these is a false
  // NEGATIVE — safe, but it left a 243-page book with zero figures.
  it("matches chapter-numbered captions (Table 2.1)", () => {
    const found = detectCaptions(idx(["Table 2.1", "Figure 9.3. Coral reefs"]));
    expect(found.map((c) => c.label)).toEqual(["Table 2.1", "Figure 9.3"]);
    // The number is kept as printed — "2.1" is not an integer, and
    // rewriting it would break the citation it has to match.
    expect(found[0].number).toBe("2.1");
  });

  it("refuses supplementary labels", () => {
    expect(detectCaptions(idx(["Table S4", "Figure S1: Protease"]))).toEqual(
      [] as Caption[],
    );
  });
});
