import { describe, it, expect } from "bun:test";
import {
  collapseDuplicateCitations,
  INTERNAL_CITATION_RULE,
  passageToken,
  renderPassageBlock,
  resolvePassageTokens,
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

  it("runs as part of resolvePassageTokens: {P1}{P1} -> one link", () => {
    expect(resolvePassageTokens("[a]{P1}{P1}", passages)).toBe(`[a]{${LINK1}}`);
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

describe("INTERNAL_CITATION_RULE", () => {
  it("forbids writing the URL by hand", () => {
    expect(INTERNAL_CITATION_RULE).toContain("NEVER write a URL");
  });
});
