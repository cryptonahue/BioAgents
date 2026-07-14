/**
 * Caption detection: let the paper tell us what its tables and figures are.
 *
 * WHY THIS REPLACES A DETECTOR
 *
 * The previous approach guessed. A layout heuristic clustered text runs
 * into grid-like shapes and called them tables — and on a 14-page paper
 * with three tables it found THIRTY-TWO, including the paper's own title.
 * Worse, it reported a median confidence of 0.988 over that garbage,
 * because "confidence" measured character density per cell, not whether
 * the thing was a table at all. Nothing in the system could tell the
 * difference, and nothing did, until a human opened the viewer and looked.
 *
 * So stop guessing. A scientific paper LABELS its own tables and figures:
 * "Table 1.", "Figure 3.". That label is ground truth, published by the
 * authors. Reading it is free, and it cannot produce a false positive —
 * a title never announces itself as "Table 3".
 *
 * HOW A CAPTION IS TOLD APART FROM A REFERENCE
 *
 * Body text refers to tables constantly ("the MIC values in Table 1",
 * "as shown in Figure 3a"). Those are NOT captions and must not be
 * detected. The discriminator, taken from the real text layer:
 *
 *   - A caption is emitted as its OWN run whose entire text is the label
 *     ("Table 1."), typically in the caption font at the left margin. The
 *     typesetter sets the bold label as a separate run from the caption
 *     body.
 *   - A reference always lives INSIDE a longer run of prose. It never
 *     starts one.
 *
 * We therefore require the run to BEGIN with the label. That single rule
 * separates the two cleanly, and it degrades safely: a publisher that
 * emits "Table 1. Antimicrobial activity of…" as one run still matches,
 * while "…values in Table 1, the MIC…" does not.
 *
 * Supplementary items ("Table S4", "Figure S1") are excluded by
 * construction: the pattern requires digits, and "S4" has none.
 *
 * KNOWN LIMIT, MEASURED ON THE REAL CORPUS
 *
 * Some typesetters split the label across runs, emitting "Figure" and its
 * number separately — one 243-page book in the corpus does this, and we
 * find none of its figures as a result. That is a false NEGATIVE, and it
 * is the failure we choose: the paper loses a highlight it could have had,
 * rather than gaining one it should not. Widening the pattern to stitch
 * adjacent runs would buy those figures back at the cost of re-admitting
 * prose, which is the trade that produced 32 tables in a 14-page paper.
 * If a corpus of such books ever matters, handle it explicitly — do not
 * loosen this.
 */
import type { AnchorBBox, PdfTextIndex, PositionedRun } from "./textAnchor";

export type CaptionKind = "table" | "figure";

export interface Caption {
  kind: CaptionKind;
  /**
   * The number exactly as the paper prints it: "1", "3", or "2.1" for a
   * book that numbers by chapter. Kept as a STRING because "2.1" is not
   * an integer and rewriting it would break the citation it has to match.
   */
  number: string;
  /** The label as the paper writes it, e.g. "Table 3" or "Table 2.1".
   *  This is what an LLM should cite, so a citation resolves against the
   *  paper's own vocabulary instead of an opaque array index. */
  label: string;
  page: number;
  /** Box around the caption LABEL itself — not the table. The table's
   *  geometry comes later, from anchoring its cells; see the note below. */
  bbox: AnchorBBox;
  /** The full run text the label was found in, for debugging. */
  text: string;
}

/**
 * Matches a run that BEGINS with a table/figure label AND closes it with a
 * separator.
 *
 *   "Table 1."                        -> caption (label-only run)
 *   "Figure 3. Broth microdilution…"  -> caption (label + body, one run)
 *   "Table 2.1"                       -> caption (a book numbers by chapter)
 *   "…the MIC values in Table 1, …"   -> NOT a caption (does not begin it)
 *   "Table 1 in Ushijima et al. …"    -> NOT a caption (prose follows the
 *                                        number, no separator) ← REAL CASE
 *   "Table encompasses the functions" -> NOT a caption (no number)
 *   "Table S4"                        -> NOT a caption (supplementary)
 *
 * THE SEPARATOR IS LOAD-BEARING. Without it, a line-wrapped reference that
 * happens to start a run — "Table 1 in Ushijima et al. 2022)…" — is read as
 * a caption. That exact string is why a 243-page book reported one table it
 * does not have. A caption always closes its label with a period, a colon,
 * or the end of the run; prose never does.
 */
const CAPTION_RE = /^(Table|Figure)\s+(\d{1,3}(?:\.\d{1,3})*)\s*(?:[.:)]|$)/;

function bboxFromRun(run: PositionedRun, page: number): AnchorBBox {
  return {
    x: run.x,
    y: run.yTop,
    w: run.w,
    h: run.h,
    page,
    units: "pt",
  };
}

/**
 * Find every caption the paper declares.
 *
 * Returns each OCCURRENCE, in document order — a continued table prints
 * its label again ("Table 1. Cont."), and the caller may care. Use
 * `uniqueCaptions` when you want one entry per label.
 *
 * NOTE ON GEOMETRY: the bbox here is the caption LABEL's box, which is
 * where the table announces itself — enough to jump to, not enough to
 * highlight a cell. We deliberately do NOT try to infer the table's
 * outline from it: guessing "the region below the caption" is the same
 * class of mistake as the old detector. The table's real geometry falls
 * out for free later, as the union of its anchored cells.
 */
export function detectCaptions(index: PdfTextIndex): Caption[] {
  const found: Caption[] = [];

  for (let pageIdx = 0; pageIdx < index.pages.length; pageIdx++) {
    const page = pageIdx + 1;
    for (const run of index.pages[pageIdx]) {
      const text = run.str.trim();
      const m = CAPTION_RE.exec(text);
      if (!m) continue;

      const kind: CaptionKind = m[1] === "Table" ? "table" : "figure";
      const number = m[2];

      found.push({
        kind,
        number,
        label: `${m[1]} ${number}`,
        page,
        bbox: bboxFromRun(run, page),
        text,
      });
    }
  }

  return found;
}

/**
 * One entry per label, keeping the FIRST occurrence — the caption proper,
 * as opposed to a "Cont." repeat on a following page.
 */
export function uniqueCaptions(captions: Caption[]): Caption[] {
  const seen = new Set<string>();
  const out: Caption[] = [];
  for (const c of captions) {
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
  }
  return out;
}

/**
 * Resolve a citation the LLM emitted ("Table 3") against what the paper
 * actually declares.
 *
 * Returns null when the paper has no such table — which is the point.
 * A model that cites "Table 7" in a paper with three tables has
 * hallucinated, and the honest response is to drop the link, not to
 * invent a target for it.
 */
export function resolveCaption(
  captions: Caption[],
  kind: CaptionKind,
  number: string | number,
): Caption | null {
  const want = String(number).trim();
  return (
    uniqueCaptions(captions).find(
      (c) => c.kind === kind && c.number === want,
    ) ?? null
  );
}
