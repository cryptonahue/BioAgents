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
 * THE FLOOR SCALES WITH THE HAYSTACK.
 *
 * The floor exists to stop a short match from landing somewhere it does
 * not belong. But how short is "too short" is not a property of the text —
 * it is a property of HOW MUCH TEXT YOU SEARCH. Sixty characters is the
 * right demand when scanning a 500,000-character book, and it is an absurd
 * one when scanning the 300 characters of a table you have already
 * located: a table row is barely 30 alphanumeric characters, so a fixed
 * floor of 60 refuses to anchor the very thing we most want to highlight.
 *
 * Risk of a spurious hit grows with the size of the haystack, so the floor
 * grows with it too — logarithmically, calibrated against what we have
 * actually observed:
 *
 *   ~500,000 chars (a 243-page book)  -> 60   a 20-char prefix DID match
 *                                             the wrong page here; 60 does
 *                                             not. This is the anchor point.
 *   ~2,000 chars (one page)           -> ~35
 *   ~300 chars (a located table)      -> ~26  a table row now anchors
 *
 * The floor NEVER goes below MATCH_FLOOR_MIN, however small the haystack:
 * below that a match stops meaning anything at all.
 *
 * Callers pass the haystack they are about to search — the sum over every
 * page in scope, NOT the size of one page. The match runs per page, but the
 * risk comes from trying two hundred of them.
 */
export const MATCH_FLOOR_MAX = 60;
/**
 * The absolute minimum, used by callers that have SCOPED their search (to a
 * page, or to a table they have already located) and therefore lean on the
 * uniqueness check in `findAlnumMatchRuns` rather than on length.
 *
 * Ten characters names a table row ("Vancomycin") without naming a cell
 * ("5"), which is exactly the line we want: long enough for a unique hit to
 * MEAN something, short enough that a real row can anchor.
 */
export const MATCH_FLOOR_MIN = 10;
// Calibrated so that log10(500_000) * SLOPE ≈ MATCH_FLOOR_MAX.
const FLOOR_SLOPE = 10.5;

/** @deprecated Use `matchFloorFor`. Kept as the document-scale default. */
export const MATCH_FLOOR_ALNUM = MATCH_FLOOR_MAX;

/**
 * The minimum contiguous match to accept when searching `haystackAlnum`
 * alphanumeric characters of text.
 */
export function matchFloorFor(haystackAlnum: number): number {
  const n = Math.max(haystackAlnum, 10);
  const floor = Math.round(FLOOR_SLOPE * Math.log10(n));
  return Math.min(MATCH_FLOOR_MAX, Math.max(MATCH_FLOOR_MIN, floor));
}

/** Step down by this much when the longest prefix does not match. */
/** Step down by this much when the longest prefix does not match. */
export const PREFIX_STEP = 8;

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
 * Returns "" when the quote carries less text than `floor` — too little to
 * anchor confidently AT THAT SEARCH SCALE. Callers MUST treat "" as "do not
 * highlight", never as "match anything".
 *
 * `floor` defaults to the document scale, which is the safe assumption: a
 * caller that has not thought about its search space gets the strictest
 * demand. Pass a floor from `matchFloorFor` when you know how much text you
 * are actually searching.
 */
export function buildNeedle(
  text: string,
  floor: number = MATCH_FLOOR_MAX,
): string {
  const needle = normalizeToAlnum(text.slice(0, NEEDLE_MAX_ALNUM * 3)).slice(
    0,
    NEEDLE_MAX_ALNUM,
  );
  return needle.length >= floor ? needle : "";
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
  floor: number = MATCH_FLOOR_MAX,
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

  // Never accept less than the caller's floor, and never demand more than
  // the needle can offer.
  const effectiveFloor = Math.min(
    Math.max(floor, MATCH_FLOOR_MIN),
    needleAlnum.length,
  );
  const maxLen = Math.min(NEEDLE_MAX_ALNUM, needleAlnum.length);
  if (maxLen < effectiveFloor) return null;

  // UNIQUENESS IS THE REAL CRITERION; LENGTH WAS ONLY EVER A PROXY FOR IT.
  //
  // We demand length because we want the match to be unambiguous. But length
  // is a guess at ambiguity, and a poor one in both directions: "Vancomycin"
  // is ten characters and names exactly one row of a table, while "5" is
  // short and appears forty times on the same page. So ask the question we
  // actually care about — does this text appear EXACTLY ONCE here? — and the
  // proxy stops mattering.
  //
  // Shortening a prefix can only ever find MORE places, never fewer. So once
  // a prefix is ambiguous, every shorter one is too, and there is nothing
  // left to try:
  //
  //     1 occurrence   -> that is where it is. Take it.
  //     0 occurrences  -> not here at this length; try a shorter prefix.
  //     2+ occurrences -> ambiguous, and shortening cannot help. Refuse.
  //
  // Refusing is not a failure. It is the honest answer, and the caller has a
  // `text-only` badge to say it with.
  let matchIdx = -1;
  let matchedLen = 0;
  for (let len = maxLen; len >= effectiveFloor; len -= PREFIX_STEP) {
    const candidate = needleAlnum.slice(0, len);
    const first = fullAlnum.indexOf(candidate);
    if (first === -1) continue; // not here — a shorter prefix may be
    const second = fullAlnum.indexOf(candidate, first + 1);
    if (second !== -1) return null; // ambiguous, and shortening only worsens it
    matchIdx = first;
    matchedLen = len;
    break;
  }
  if (matchIdx === -1) return null;

  const startRun = alnumToRun[matchIdx];
  const endRun =
    alnumToRun[Math.min(matchIdx + matchedLen - 1, alnumToRun.length - 1)];
  if (startRun == null || endRun == null) return null;
  return { startRun, endRun };
}
