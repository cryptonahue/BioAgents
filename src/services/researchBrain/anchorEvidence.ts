/**
 * Anchor a source's evidence: find WHERE each claim's and each fact's
 * verbatim quote actually is in the PDF, and store it.
 *
 * WHY AT INGESTION, NOT AT CLICK TIME
 *
 * The viewer can already do this in the browser, and does. But a click-time
 * search costs a second on a paper and fifteen on a 243-page book, repeats
 * that work on every click, and — being ephemeral — can never be MEASURED.
 * Nobody can ask "how many of this paper's facts can we actually point at?"
 * until a user clicks one and finds out.
 *
 * Anchoring here answers it once, for every claim and fact, before anyone is
 * watching. The result is the first honest quality signal this system has
 * had: not a confidence score that measures character density and reports
 * 0.988 over garbage, but a fact about the document —
 *
 *     did the text we claim to have extracted actually turn up in the PDF?
 *
 * A miss is a first-class answer. It stores NULL, the viewer shows its
 * `text-only` badge, and we know the number. What we never do is invent a
 * box: a highlight in the wrong place does not cost you that highlight, it
 * costs the credibility of every highlight you draw.
 */
import { getServiceClient } from "../../db/client";
import { loadSourcePdf } from "../pdf/loadSourcePdf";
import { anchorInIndex, indexPdfText } from "../pdf/textAnchor";
import logger from "../../utils/logger";

/**
 * `anchored` — the quote was found in the PDF and has a box.
 * `verbatim` — it was found IN FULL, character for character.
 *
 * The gap between them is the number that matters. The extractor is told to
 * return a verbatim snippet; when `verbatim < anchored`, it is paraphrasing,
 * and when a quote does not anchor at all it may simply have been invented —
 * as one on this corpus was. Nothing else in the system can see that.
 */
export interface AnchorStats {
  total: number;
  anchored: number;
  verbatim: number;
}

export interface AnchorEvidenceResult {
  sourceId: string;
  status: "anchored" | "no_pdf" | "nothing_to_anchor" | "failed";
  claims: AnchorStats;
  facts: AnchorStats;
  error?: string;
}

interface Quoted {
  id: string;
  quote?: string | null;
}

/**
 * Anchor every quoted claim and fact of one source.
 *
 * The PDF is parsed ONCE and matched against many times — PDF.js detaches the
 * buffer it is handed, so a per-quote call would anchor the first item and
 * throw on every one after it, and re-parsing per quote would be absurd
 * anyway when a paper carries dozens.
 */
export async function anchorEvidenceForSource(
  sourceId: string,
): Promise<AnchorEvidenceResult> {
  const empty: AnchorStats = { total: 0, anchored: 0, verbatim: 0 };
  const sb = getServiceClient();

  try {
    const { data: source, error: srcErr } = await sb
      .from("research_sources")
      .select("id,file_path")
      .eq("id", sourceId)
      .maybeSingle();
    if (srcErr) throw srcErr;
    if (!source) {
      return {
        sourceId,
        status: "failed",
        claims: empty,
        facts: empty,
        error: "source not found",
      };
    }

    const [{ data: claims }, { data: facts }] = await Promise.all([
      sb
        .from("research_claims")
        .select("id,quote")
        .eq("source_id", sourceId)
        .not("quote", "is", null),
      sb
        .from("research_bioprospecting_facts")
        .select("id,quote")
        .eq("source_id", sourceId)
        .not("quote", "is", null),
    ]);

    const quotedClaims = (claims ?? []) as Quoted[];
    const quotedFacts = (facts ?? []) as Quoted[];
    if (quotedClaims.length === 0 && quotedFacts.length === 0) {
      return {
        sourceId,
        status: "nothing_to_anchor",
        claims: empty,
        facts: empty,
      };
    }

    const pdf = await loadSourcePdf(source);
    if (!pdf) {
      // No PDF, no geometry. Everything degrades to text-only, honestly.
      return {
        sourceId,
        status: "no_pdf",
        claims: { total: quotedClaims.length, anchored: 0, verbatim: 0 },
        facts: { total: quotedFacts.length, anchored: 0, verbatim: 0 },
      };
    }

    // Parse once; match many.
    const index = await indexPdfText(pdf);

    const anchorAll = async (
      table: string,
      rows: Quoted[],
    ): Promise<AnchorStats> => {
      let anchored = 0;
      let verbatim = 0;
      for (const row of rows) {
        const hit = row.quote ? anchorInIndex(index, row.quote) : null;
        // Found IN FULL, not merely found. The UI shows these as different
        // things because they ARE different things: one is a quotation, the
        // other is a paraphrase pointing at the right passage.
        const isVerbatim = hit
          ? hit.matchedChars >= hit.needleChars
          : null;
        // Write the miss too: NULL is the answer "we could not find this",
        // and a stale value from a previous run would be worse than none.
        const { error } = await sb
          .from(table)
          .update({
            anchor_page: hit?.page ?? null,
            anchor_bbox: hit?.bbox ?? null,
            anchor_verbatim: isVerbatim,
          })
          .eq("id", row.id);
        if (error) {
          logger.warn(
            { err: error, table, rowId: row.id },
            "anchor_evidence_update_failed",
          );
          continue;
        }
        if (hit) {
          anchored++;
          // The gap between these two counts is the extractor paraphrasing
          // when it was told not to.
          if (isVerbatim) verbatim++;
        }
      }
      return { total: rows.length, anchored, verbatim };
    };

    const claimStats = await anchorAll("research_claims", quotedClaims);
    const factStats = await anchorAll(
      "research_bioprospecting_facts",
      quotedFacts,
    );

    const result: AnchorEvidenceResult = {
      sourceId,
      status: "anchored",
      claims: claimStats,
      facts: factStats,
    };
    logger.info(result, "anchor_evidence_completed");
    return result;
  } catch (error: any) {
    logger.error({ err: error, sourceId }, "anchor_evidence_failed");
    return {
      sourceId,
      status: "failed",
      claims: empty,
      facts: empty,
      error: error?.message ?? String(error),
    };
  }
}
