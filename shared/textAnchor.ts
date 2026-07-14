/**
 * textAnchor — the shared text-matching core behind every PDF highlight.
 *
 * ONE source of truth, imported by BOTH sides:
 *   - client/src/hooks/useTextChunkSearch.ts  (runs in canvas pixels)
 *   - src/services/pdf/textAnchor.ts          (runs in PDF points)
 *
 * Only the MATCH lives here. Geometry does not: the two callers work in
 * different coordinate spaces, and pretending otherwise is how the
 * y-axis got flipped once already. What they must never diverge on is
 * *which text matched* — that is the subtle part, and it lives here.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A quote stored by the extractor and the same sentence as PDF.js reports
 * it never match literally. The PDF text layer differs in whitespace
 * (runs are split at arbitrary layout breaks), in punctuation (curly
 * quotes, ligatures), and — worst — in line-break hyphenation, where
 * "commensal" is emitted as two runs, "commen-" and "sal".
 *
 * An earlier version matched raw text and, when that failed, fell back to
 * ever-shorter prefixes — down to 20 characters. In a 243-page book a
 * 20-character prefix matches almost anywhere, so the highlight landed on
 * an unrelated early page, over blank space. Confidently wrong.
 *
 * THE FIX
 *
 * Reduce BOTH sides to a lowercase alphanumeric-only stream. Whitespace,
 * punctuation, case and hyphenation simply cease to exist, so
 * "commen-\nsal microbes" and "commensal microbes" become the same
 * string. Then require a LONG match (60 chars). A 60-character verbatim
 * alphanumeric run is effectively unique in a document, so the first page
 * containing it IS the right page — which makes an early-exit scan safe.
 *
 * The floor is the whole design. Lower it and spurious matches return.
 */

/**
 * How many alphanumeric characters of the quote we match on. Long enough
 * to be distinctive, short enough that a quote whose tail diverges from
 * the page text still anchors.
 */
export const NEEDLE_MAX_ALNUM = 140;

/**
 * The minimum contiguous match we accept. This is what kills spurious
 * matches — do not lower it without re-reading the note above.
 */
export const MATCH_FLOOR_ALNUM = 60;

/** Step down by this much when the longest prefix does not match. */
const PREFIX_STEP = 8;

/**
 * Reduce text to a lowercase alphanumeric-only stream. Strips
 * whitespace, punctuation, hyphens and case, so the PDF text layer and
 * the stored quote compare on letters and digits alone.
 */
export function normalizeToAlnum(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      out += String.fromCharCode(code + 32); // A-Z -> a-z
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      out += text[i]; // a-z, 0-9
    }
    // everything else (space, punctuation, hyphen, ligature) is dropped
  }
  return out;
}

/**
 * Build the needle to search for from a raw quote: the first
 * NEEDLE_MAX_ALNUM alphanumeric characters. Draws from a generous raw
 * prefix so punctuation and spaces cannot starve it.
 *
 * Returns "" when the quote carries too little text to anchor
 * confidently — callers MUST treat that as "do not highlight", never as
 * "match anything".
 */
export function buildNeedle(text: string): string {
  const needle = normalizeToAlnum(text.slice(0, NEEDLE_MAX_ALNUM * 3)).slice(
    0,
    NEEDLE_MAX_ALNUM,
  );
  return needle.length >= MATCH_FLOOR_ALNUM ? needle : "";
}

/**
 * A text run as PDF.js reports it. Only `str` is needed to match; the
 * caller keeps whatever geometry it needs alongside, in its own space.
 */
export interface MatchableRun {
  str: string;
}

/** The inclusive run-index range a match spans. */
export interface RunRange {
  startRun: number;
  endRun: number;
}

/**
 * Locate `needleAlnum` (already normalized via `buildNeedle`) across a
 * page's runs and return the inclusive run range it spans, or null on a
 * miss.
 *
 * Pure over `runs[i].str` — no PDF, no DOM, no geometry. That is what
 * makes it unit-testable with synthetic runs, and what lets both sides
 * share it.
 *
 * The longest prefix that still matches wins, down to the floor. This
 * tolerates a quote whose tail diverges from the page text while still
 * demanding a long, unambiguous anchor.
 */
export function findAlnumMatchRuns(
  runs: MatchableRun[],
  needleAlnum: string,
): RunRange | null {
  if (!needleAlnum) return null;

  // Alphanumeric stream over every run, plus a map from each position in
  // that stream back to the run it came from. Crossing run boundaries is
  // exactly what makes hyphenation and layout breaks invisible.
  let fullAlnum = "";
  const alnumToRun: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    const s = runs[i].str;
    for (let k = 0; k < s.length; k++) {
      const code = s.charCodeAt(k);
      let ch = "";
      if (code >= 65 && code <= 90) ch = String.fromCharCode(code + 32);
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57))
        ch = s[k];
      if (ch) {
        fullAlnum += ch;
        alnumToRun.push(i);
      }
    }
  }
  if (!fullAlnum) return null;

  const floor = Math.min(MATCH_FLOOR_ALNUM, needleAlnum.length);
  const maxLen = Math.min(NEEDLE_MAX_ALNUM, needleAlnum.length);
  if (maxLen < floor) return null;

  let matchIdx = -1;
  let matchedLen = 0;
  for (let len = maxLen; len >= floor; len -= PREFIX_STEP) {
    const idx = fullAlnum.indexOf(needleAlnum.slice(0, len));
    if (idx !== -1) {
      matchIdx = idx;
      matchedLen = len;
      break;
    }
  }
  if (matchIdx === -1) return null;

  const startRun = alnumToRun[matchIdx];
  const endRun =
    alnumToRun[Math.min(matchIdx + matchedLen - 1, alnumToRun.length - 1)];
  if (startRun == null || endRun == null) return null;
  return { startRun, endRun };
}
