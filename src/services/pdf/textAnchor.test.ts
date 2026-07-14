import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { indexPdfText, anchorInIndex, anchorTextInPdf } from "./textAnchor";

/**
 * Integration tests against a REAL paper — the same one whose highlight
 * was verified by eye in the browser.
 *
 * The claim below is stored with this verbatim quote, and the client's
 * click-time search lands it on page 8. The server-side anchor must reach
 * the SAME page and box the SAME sentence, independently. If the two ever
 * disagree, the highlight a user sees depends on which code path drew it
 * — exactly the class of bug this design exists to prevent.
 */
const PAPER = path.resolve(
  import.meta.dir,
  "../../../docs/marinedrugs/marinedrugs-24-00137.pdf",
);

/**
 * The corpus lives on the docs volume and is deliberately NOT in git, so
 * these tests skip rather than fail when it is absent (CI, a fresh clone).
 * They are the real proof this module works, though — run them with the
 * corpus present before trusting a change to the anchor or the matcher.
 */
const hasPaper = existsSync(PAPER);
const withPaper = hasPaper ? it : it.skip;

const loadPaper = async () => new Uint8Array(await readFile(PAPER));

// Verbatim from research_claims.quote — Discussion section, page 8.
const QUOTE_P8 =
  "From 67 sponge-derived isolates, three safe Bacillus strains were identified, including one with significant, selective S. enterica inhibition. This represented a 4.5% hit rate for utilising marine microorganisms for probiotic discovery.";

// A second claim from the same paper — Results, a different page.
const QUOTE_RESULTS =
  "A total of 67 sponge-derived bacterial isolates were cultivated under Bacillus favourable conditions";

/**
 * REAL QUOTES THAT THE FLOOR THREW AWAY.
 *
 * Anchoring this paper's 25 extracted facts left four unanchored. Three of
 * them quote a strain ID — short, and appearing EXACTLY ONCE in the document.
 * They could not have been more unambiguous, and the floor discarded all
 * three before uniqueness was ever consulted, because 25 characters is less
 * than the 48 a 14-page paper demanded.
 *
 * That is what a proxy costs you. These three are why the check is now the
 * real question — does this appear exactly once? — and not a guess at it.
 */
const STRAIN_IDS = [
  "BPR-16 (B. velezensis, CBS#148295)", // 25 alphanumeric chars
  "BPR-20 (B. subtilis, CBS#144669)", // 23
  "BPR-11 (Bacillus amyloliquefaciens, CBS#141692)", // 39
];

/**
 * THE FOURTH ONE, AND THE MORE IMPORTANT FINDING.
 *
 * This sentence is NOT IN THE PAPER. The extractor is told to return "a short
 * verbatim snippet", and it paraphrased instead — a fabricated citation,
 * indistinguishable from a real one at every layer of the system until the
 * text is looked for in the PDF and is not there.
 *
 * The anchor is therefore not only a locator. It is a hallucination detector,
 * and this test is what stops us from ever "fixing" it into silence.
 */
const FABRICATED_QUOTE =
  "Protease activity was determined by clear zones on milk agar";

describe("indexPdfText + anchorInIndex (real paper)", () => {
  withPaper("finds the quote on the page the browser highlights (page 8)", async () => {
    const index = await indexPdfText(await loadPaper());
    const hit = anchorInIndex(index, QUOTE_P8);

    expect(hit).not.toBeNull();
    expect(hit!.page).toBe(8);

    const { bbox } = hit!;
    expect(bbox.units).toBe("pt");
    // A real sentence has width and height and sits inside an A4-ish page
    // (595 x 842 pt). A degenerate or off-page box means the geometry is
    // wrong — which is exactly how the Mistral tables shipped {0,0,0,0}.
    expect(bbox.w).toBeGreaterThan(50);
    expect(bbox.h).toBeGreaterThan(5);
    expect(bbox.x).toBeGreaterThanOrEqual(0);
    expect(bbox.x + bbox.w).toBeLessThanOrEqual(700);
    expect(bbox.y + bbox.h).toBeLessThanOrEqual(900);
    // The sentence sits mid-page in the Discussion — not pinned to the top
    // edge, which is where a flipped y-axis would put it.
    expect(bbox.y).toBeGreaterThan(100);
  }, 60_000);

  // THE BUG THIS API SHAPE EXISTS TO PREVENT. PDF.js transfers (detaches)
  // the buffer it is handed, so a per-text call that re-opens the PDF
  // throws DataCloneError on the SECOND text. A paper has many claims; if
  // only the first could ever anchor, the failure would be silent and
  // partial — the worst kind.
  withPaper("anchors MANY texts from one parse (the reason for the index)", async () => {
    const index = await indexPdfText(await loadPaper());

    const a = anchorInIndex(index, QUOTE_P8);
    const b = anchorInIndex(index, QUOTE_RESULTS);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Different claims, different places in the paper.
    expect(a!.page).not.toBe(b!.page);
  }, 60_000);

  withPaper("honours an explicit page and misses cleanly on the wrong one", async () => {
    const index = await indexPdfText(await loadPaper());

    expect(anchorInIndex(index, QUOTE_P8, { page: 8 })).not.toBeNull();
    // Page 1 does not carry this sentence. A miss is a first-class answer:
    // the caller degrades to `text-only` rather than inventing a box.
    expect(anchorInIndex(index, QUOTE_P8, { page: 1 })).toBeNull();
  }, 60_000);

  withPaper("refuses text too short to anchor, instead of guessing", async () => {
    const index = await indexPdfText(await loadPaper());
    // "Bacillus" is the subject of the entire paper: it appears everywhere.
    // Ambiguous, so the honest answer is "I don't know which one you mean".
    expect(anchorInIndex(index, "Bacillus")).toBeNull();
  }, 60_000);

  // The three the floor discarded. Each appears EXACTLY ONCE, on page 9.
  withPaper("anchors a short strain ID that appears exactly once", async () => {
    const index = await indexPdfText(await loadPaper());
    for (const quote of STRAIN_IDS) {
      const hit = anchorInIndex(index, quote);
      expect(hit, `should anchor: ${quote}`).not.toBeNull();
      expect(hit!.page).toBe(9);
      expect(hit!.bbox.w).toBeGreaterThan(0);
    }
  }, 60_000);

  // The extractor fabricated this sentence. It is not in the paper, and the
  // anchor is the only layer of the system that can tell.
  withPaper("REFUSES a quote the extractor invented", async () => {
    const index = await indexPdfText(await loadPaper());
    expect(anchorInIndex(index, FABRICATED_QUOTE)).toBeNull();
  }, 60_000);

  // Uniqueness must hold ACROSS the document, not per page. A quote appearing
  // once on page 3 and once on page 7 is unique on each and ambiguous in the
  // paper — and a page-by-page scan taking the first hit would anchor it to
  // page 3, confidently and wrongly.
  withPaper("refuses text that recurs on different pages", async () => {
    const index = await indexPdfText(await loadPaper());
    // The journal stamps this on every page.
    expect(anchorInIndex(index, "Mar. Drugs 2026, 24, 137")).toBeNull();
  }, 60_000);

  withPaper("returns null for text that is simply not in the paper", async () => {
    const index = await indexPdfText(await loadPaper());
    const absent =
      "The mitochondrial ribosome of Saccharomyces cerevisiae was reconstituted in vitro using a cell-free translation system derived from wheat germ extract.";
    expect(anchorInIndex(index, absent)).toBeNull();
  }, 60_000);
});

describe("anchorTextInPdf (single-shot convenience)", () => {
  withPaper("does not detach the caller's buffer", async () => {
    const pdf = await loadPaper();
    const hit = await anchorTextInPdf(pdf, QUOTE_P8);
    expect(hit!.page).toBe(8);
    // The caller still owns a usable buffer: PDF.js got a copy.
    expect(pdf.byteLength).toBeGreaterThan(0);
  }, 60_000);
});
