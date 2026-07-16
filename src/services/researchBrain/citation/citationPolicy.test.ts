import { describe, it, expect } from "bun:test";
import {
  cleanTokenIdLabels,
  collapseDuplicateCitations,
  collectAllowedDois,
  INTERNAL_CITATION_RULE,
  passageToken,
  renderPassageBlock,
  resolvePassageTokens,
  rewriteDoiToPaperLink,
  stripUngroundedDois,
} from "./citationPolicy";
import type { EvidencePackPassage } from "../types";

const LINK1 =
  "/library/bWFyaW5lZHJ1Z3MtMjQtMDAyNDMucGRm/viewer#bbox=1,2,3,4&page=20&type=chunk";
const LINK2 =
  "/library/bWFyaW5lZHJ1Z3MtMjQtMDAyNDMucGRm/viewer#bbox=5,6,7,8&page=18&type=chunk";

const passages: EvidencePackPassage[] = [
  { content: "rearing water harbored the highest richness", citation: LINK1, page: 20 },
  { content: "candidate patterns rather than confirmed", citation: LINK2, page: 18 },
  // Third passage did NOT anchor — no citation, so no token.
  { content: "some passage that never anchored", citation: null, page: null },
];

describe("resolvePassageTokens", () => {
  it("swaps a token for the real link — the model never types the base64", () => {
    const out = resolvePassageTokens("[riqueza]{P1} y [predictivo]{P2}", passages);
    expect(out).toBe(`[riqueza]{${LINK1}} y [predictivo]{${LINK2}}`);
  });

  it("tolerates the shapes a model actually emits: {p1}, { P2 }", () => {
    expect(resolvePassageTokens("[a]{p1}", passages)).toBe(`[a]{${LINK1}}`);
    expect(resolvePassageTokens("[b]{ P2 }", passages)).toBe(`[b]{${LINK2}}`);
  });

  it("leaves an out-of-range token untouched rather than inventing a target", () => {
    expect(resolvePassageTokens("[x]{P9}", passages)).toBe("[x]{P9}");
  });

  it("leaves a token for a non-anchored passage untouched (it has no link)", () => {
    expect(resolvePassageTokens("[x]{P3}", passages)).toBe("[x]{P3}");
  });

  it("is a no-op when there are no passages", () => {
    expect(resolvePassageTokens("[x]{P1}", [])).toBe("[x]{P1}");
    expect(resolvePassageTokens("[x]{P1}", undefined)).toBe("[x]{P1}");
  });

  it("never leaks a corruptible base64 into resolution — the link is verbatim", () => {
    const out = resolvePassageTokens("{P1}", passages);
    expect(out).toContain("bWFyaW5lZHJ1Z3MtMjQtMDAyNDMucGRm");
    expect(out).not.toContain("marinindugs");
  });
});

describe("collapseDuplicateCitations", () => {
  it("collapses a link repeated immediately after itself", () => {
    expect(collapseDuplicateCitations(`{${LINK1}}{${LINK1}}`)).toBe(`{${LINK1}}`);
  });

  it("collapses a run of three or more", () => {
    expect(
      collapseDuplicateCitations(`{${LINK1}}{${LINK1}}{${LINK1}}`),
    ).toBe(`{${LINK1}}`);
  });

  it("tolerates whitespace between the duplicates", () => {
    expect(collapseDuplicateCitations(`{${LINK1}} {${LINK1}}`)).toBe(`{${LINK1}}`);
  });

  it("leaves two DIFFERENT links alone", () => {
    expect(collapseDuplicateCitations(`{${LINK1}}{${LINK2}}`)).toBe(
      `{${LINK1}}{${LINK2}}`,
    );
  });

  it("collapses a repeated [label]{link} unit with a space between", () => {
    expect(
      collapseDuplicateCitations(`[potencial KO]{${LINK1}} [potencial KO]{${LINK1}}`),
    ).toBe(`[potencial KO]{${LINK1}}`);
  });

  it("leaves labelled citations with different labels alone", () => {
    const s = `[a]{${LINK1}} [b]{${LINK1}}`;
    expect(collapseDuplicateCitations(s)).toBe(s);
  });

  it("runs as part of resolvePassageTokens: {P1}{P1} -> one link", () => {
    expect(resolvePassageTokens("[a]{P1}{P1}", passages)).toBe(`[a]{${LINK1}}`);
  });
});

describe("rewriteDoiToPaperLink", () => {
  const DOC = "bWFyaW5lZHJ1Z3MtMjQtMDAyNDMucGRm";

  it("rewrites a bare [doi] citation to an internal paper-level link", () => {
    const out = rewriteDoiToPaperLink(
      "El agua de cría tuvo la mayor riqueza[https://doi.org/10.3390/md24070243]",
      DOC,
    );
    expect(out).toBe(
      `El agua de cría tuvo la mayor riqueza[fuente]{/library/${DOC}/viewer}`,
    );
  });

  it("rewrites the (label)[doi] shape keeping the label", () => {
    const out = rewriteDoiToPaperLink(
      "(mayor riqueza)[https://doi.org/10.3390/md24070243]",
      DOC,
    );
    expect(out).toBe(`[mayor riqueza]{/library/${DOC}/viewer}`);
  });

  it("rewrites a DOI wrapped in plain parentheses (Key Insights shape)", () => {
    const out = rewriteDoiToPaperLink(
      "AW mostró la mayor riqueza (https://doi.org/10.3390/md24070243).",
      DOC,
    );
    expect(out).toBe(`AW mostró la mayor riqueza [fuente]{/library/${DOC}/viewer}.`);
  });

  it("is a no-op without a docId (unscoped: DOI stays)", () => {
    const s = "algo[https://doi.org/10.3390/md24070243]";
    expect(rewriteDoiToPaperLink(s, null)).toBe(s);
    expect(rewriteDoiToPaperLink(s, undefined)).toBe(s);
  });

  it("leaves text without a DOI untouched", () => {
    expect(rewriteDoiToPaperLink("sin cita", DOC)).toBe("sin cita");
  });
});

describe("cleanTokenIdLabels", () => {
  it("rewrites a bare [P9] label to a page reference from the link", () => {
    expect(cleanTokenIdLabels(`[P9]{${LINK2}}`)).toBe(`[fuente, p.18]{${LINK2}}`);
  });

  it("leaves a descriptive label untouched", () => {
    expect(cleanTokenIdLabels(`[mayor riqueza]{${LINK1}}`)).toBe(
      `[mayor riqueza]{${LINK1}}`,
    );
  });

  it("runs inside resolvePassageTokens: [P1]{P1} -> page-labelled link", () => {
    expect(resolvePassageTokens("[P1]{P1}", passages)).toBe(
      `[fuente, p.20]{${LINK1}}`,
    );
  });
});

describe("renderPassageBlock", () => {
  it("shows the token but NEVER the raw link — the model cannot corrupt what it cannot see", () => {
    const block = renderPassageBlock(passages).join("\n");
    expect(block).toContain(passageToken(1));
    expect(block).toContain(passageToken(2));
    // The opaque, corruptible parts of the link — the base64 title and the
    // bbox coordinates — must not appear anywhere in the prompt block. (The
    // rule text mentions the words "/library/" and "bbox" while forbidding
    // them; what must never leak is the real base64 and the "bbox=" payload.)
    expect(block).not.toContain("bWFyaW5lZHJ1Z3MtMjQtMDAyNDMucGRm");
    expect(block).not.toContain("bbox=");
  });

  it("marks a non-anchored passage as DOI-only, with no token", () => {
    const block = renderPassageBlock(passages).join("\n");
    expect(block).toContain("did not anchor");
  });

  it("returns nothing when there are no passages", () => {
    expect(renderPassageBlock([])).toEqual([]);
    expect(renderPassageBlock(undefined)).toEqual([]);
  });
});

describe("stripUngroundedDois", () => {
  // The DOI the loaded reference list actually contains.
  const allowed = collectAllowedDois(
    "Santoro et al. 2021. Sci Adv 7:eabg3088. https://doi.org/10.1126/sciadv.abg3088",
  );

  it("collects the DOI out of a reference-list passage", () => {
    expect(allowed.has("10.1126/sciadv.abg3088")).toBe(true);
  });

  it("keeps a DOI that IS in the evidence", () => {
    const s = "(Santoro et al. 2021)[https://doi.org/10.1126/sciadv.abg3088]";
    expect(stripUngroundedDois(s, allowed)).toBe(s);
  });

  // The real regression: the model invented a Coral Reefs DOI for a paper it
  // had cited as brv.13042 the run before. The attribution stays; the id goes.
  it("drops a fabricated DOI but keeps the attribution", () => {
    expect(
      stripUngroundedDois(
        "reviewed by (Helgoe et al. 2024)[https://doi.org/10.1111/brv.13040]",
        allowed,
      ),
    ).toBe("reviewed by (Helgoe et al. 2024)");
  });

  it("drops a bare bracketed DOI with no doi.org prefix", () => {
    expect(
      stripUngroundedDois("as shown[10.1242/jeb.009597].", allowed),
    ).toBe("as shown.");
  });

  it("drops a corrupted DOI — the transcription error we actually saw", () => {
    expect(
      stripUngroundedDois(
        "glucose[https://doi.org/10.1007/s11306-017-13006-8]",
        allowed,
      ),
    ).toBe("glucose");
  });

  it("unwraps [label]{doi} to the plain label when the DOI is invented", () => {
    expect(
      stripUngroundedDois(
        "[inositol accumulation]{https://doi.org/10.1007/s11306-017-1306-8}",
        allowed,
      ),
    ).toBe("inositol accumulation");
  });

  it("NEVER touches an internal /library link", () => {
    const s = `[riqueza]{${LINK1}}`;
    expect(stripUngroundedDois(s, allowed)).toBe(s);
  });

  it("removes a bare doi.org URL left in prose", () => {
    expect(
      stripUngroundedDois("see https://doi.org/10.9999/fake.1 for more", allowed),
    ).toBe("see for more");
  });

  it("is a no-op on text with no DOI", () => {
    expect(stripUngroundedDois("plain text", allowed)).toBe("plain text");
  });
});

describe("INTERNAL_CITATION_RULE", () => {
  it("forbids writing the URL by hand", () => {
    expect(INTERNAL_CITATION_RULE).toContain("NEVER write a URL");
  });
});
