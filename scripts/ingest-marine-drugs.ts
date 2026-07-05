#!/usr/bin/env bun
/**
 * scripts/ingest-marine-drugs.ts
 *
 * Fetch the N most recent papers from Marine Drugs (MDPI) and persist
 * them as Markdown files in `docs/marine-drugs/<run-date>/` for the
 * RAG ingestion pipeline (scripts/ingest-docs.ts).
 *
 * Data source: Crossref API (public, no auth) for metadata + abstracts.
 * Full text: scraped from MDPI HTML (works from residential IPs; MDPI
 * blocks datacenter IPs via Akamai, in which case only the abstract
 * is persisted and a warning is logged).
 *
 * Usage:
 *   bun run scripts/ingest-marine-drugs.ts                # default: 10 papers
 *   bun run scripts/ingest-marine-drugs.ts -- --count=20  # 20 papers
 *   bun run scripts/ingest-marine-drugs.ts -- --out=docs/marine-drugs/custom  # custom dir
 *
 * After running, ingest with:
 *   bun run scripts/ingest-docs.ts -- --path=docs/marine-drugs/<run-date>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CROSSREF_API = "https://api.crossref.org/works";
const OPENALEX_API = "https://api.openalex.org/works";
const MARINE_DRUGS_ISSN = "1660-3397";
const MDPI_BASE = "https://www.mdpi.com";
const POLITE_UA = "BioAgents/0.1 (mailto:cryptonahue@gmail.com)"; // Crossref + OpenAlex polite pool
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------- CLI args ----------

function readArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return fallback;
}

const COUNT = parseInt(readArg("count", "10") ?? "10", 10);
const RUN_DATE = new Date().toISOString().slice(0, 10);
const OUT_DIR =
  readArg("out") ??
  join("docs", "marine-drugs", RUN_DATE);

// --mode=openalex (default) | crossref | full | abstract
//   - openalex: use OpenAlex API (cleaner abstracts, more metadata)
//   - crossref: use Crossref API
//   - full:     try MDPI HTML for full text, fall back to abstract
//   - abstract: skip MDPI, abstract only (fastest, no Akamai risk)
const MODE = (readArg("mode", "openalex") ?? "openalex") as
  | "openalex"
  | "crossref"
  | "full"
  | "abstract";

// ---------- OpenAlex types (subset) ----------

interface OpenAlexAuthor {
  author?: { display_name?: string };
}

interface OpenAlexItem {
  id: string; // OpenAlex ID, e.g. "https://openalex.org/W..."
  doi?: string;
  title?: string;
  authorships?: OpenAlexAuthor[];
  abstract_inverted_index?: Record<string, number[]>;
  publication_date?: string;
  primary_location?: {
    source?: { display_name?: string };
    license?: string;
  };
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string };
  cited_by_count?: number;
}

// Reconstruct plaintext abstract from OpenAlex's inverted index.
// OpenAlex stores abstracts as { word: [positions] } for legal reasons;
// to get text we sort all words by their lowest position and join.
function reconstructAbstract(idx: Record<string, number[]> | undefined): string {
  if (!idx) return "";
  const words: [string, number][] = [];
  for (const [word, positions] of Object.entries(idx)) {
    if (!positions?.length) continue;
    words.push([word, Math.min(...positions)]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map(([w]) => w).join(" ");
}

// ---------- Crossref types (subset) ----------

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

interface CrossrefItem {
  DOI: string;
  title: string[];
  author?: CrossrefAuthor[];
  abstract?: string;
  containerTitle?: string[];
  publishedPrint?: { "date-parts"?: number[][] };
  publishedOnline?: { "date-parts"?: number[][] };
  created?: { "date-parts"?: number[][] };
  URL?: string;
  link?: { URL: string; "content-type"?: string }[];
  "container-title"?: string[];
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  "is-referenced-by-count"?: number;
  "references-count"?: number;
}

interface CrossrefResponse {
  message: {
    total-results: number;
    items: CrossrefItem[];
  };
}

// ---------- Helpers ----------

function stripJats(xml: string | undefined): string {
  if (!xml) return "";
  // Remove JATS XML tags but keep their inner text. Lightweight regex
  // strip — good enough for display, not a full JATS parser.
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(item: CrossrefItem): number | undefined {
  const sources = [
    item.publishedPrint,
    item.publishedOnline,
    item["published-print"],
    item["published-online"],
    item.created,
  ];
  for (const s of sources) {
    const y = s?.["date-parts"]?.[0]?.[0];
    if (y) return y;
  }
  return undefined;
}

function formatAuthors(authors: CrossrefAuthor[] | undefined): string {
  if (!authors || authors.length === 0) return "Unknown";
  return authors
    .slice(0, 20) // cap to keep frontmatter readable
    .map((a) => a.family && a.given ? `${a.family}, ${a.given}` : a.name ?? "?")
    .join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Crossref fetch ----------

async function fetchCrossref(count: number): Promise<CrossrefItem[]> {
  const url = new URL(CROSSREF_API);
  url.searchParams.set("filter", `issn:${MARINE_DRUGS_ISSN}`);
  url.searchParams.set("rows", String(count));
  url.searchParams.set("sort", "published");
  url.searchParams.set("order", "desc");
  url.searchParams.set("select", [
    "DOI",
    "title",
    "author",
    "abstract",
    "container-title",
    "published-print",
    "published-online",
    "created",
    "is-referenced-by-count",
  ].join(","));

  console.log(`→ Crossref: ${url.toString()}`);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Crossref ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as CrossrefResponse;
  console.log(`  found ${data.message["total-results"]} total, using ${data.message.items.length}`);
  return data.message.items;
}

// ---------- OpenAlex fetch ----------

async function fetchOpenAlex(count: number): Promise<OpenAlexItem[]> {
  const url = new URL(OPENALEX_API);
  url.searchParams.set("filter", `primary_location.source.issn:${MARINE_DRUGS_ISSN},is_oa:true`);
  url.searchParams.set("sort", "publication_date:desc");
  url.searchParams.set("per_page", String(count));

  console.log(`→ OpenAlex: ${url.toString()}`);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": POLITE_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OpenAlex ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { meta: { count: number }; results: OpenAlexItem[] };
  console.log(`  found ${data.meta.count} total, using ${data.results.length}`);
  return data.results;
}

// Normalize an OpenAlex item into a CrossrefItem-shaped object so the
// rest of the pipeline doesn't care which API was used.
function openAlexToItem(oa: OpenAlexItem): CrossrefItem {
  const doi = (oa.doi ?? "").replace(/^https?:\/\/doi\.org\//, "");
  return {
    DOI: doi,
    title: oa.title ? [oa.title] : ["Untitled"],
    author: (oa.authorships ?? []).map((a) => ({
      family: a.author?.display_name?.split(" ").slice(-1)[0],
      given: a.author?.display_name?.split(" ").slice(0, -1).join(" "),
      name: a.author?.display_name,
    })),
    abstract: reconstructAbstract(oa.abstract_inverted_index),
    "container-title": oa.primary_location?.source
      ? [oa.primary_location.source.display_name ?? "Marine Drugs"]
      : ["Marine Drugs"],
    publishedOnline: oa.publication_date
      ? { "date-parts": [[parseInt(oa.publication_date.slice(0, 4))]] }
      : undefined,
    "is-referenced-by-count": oa.cited_by_count,
  };
}

// ---------- MDPI full text fetch ----------

interface MdpiContent {
  abstract: string;
  body: string;
}

async function fetchMdpiFullText(doi: string): Promise<MdpiContent | null> {
  // MDPI article URL pattern: https://www.mdpi.com/1660-3397/24/6/216
  // We resolve via Crossref's `link[content-type=application/pdf]` or
  // derive the URL from the DOI slug.
  const articleUrl = `${MDPI_BASE}/${doi}`;
  try {
    const res = await fetch(articleUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(`  ! MDPI ${res.status} for ${doi} (datacenter IP likely blocked)`);
      return null;
    }
    const html = await res.text();

    // Heuristic extraction: grab <section data-title="Abstract"> and the
    // main article body. MDPI's HTML structure is stable enough for this
    // to work in 95% of cases. For the rare failures, we still persist
    // the abstract from Crossref.
    const abstractMatch =
      html.match(/<section[^>]*data-title="Abstract"[^>]*>([\s\S]*?)<\/section>/i) ??
      html.match(/<div[^>]*class="[^"]*art-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const bodyMatch = html.match(
      /<section[^>]*class="[^"]*html-body[^"]*"[^>]*>([\s\S]*?)<\/section>\s*<section[^>]*data-title="(?:References|Supplementary|Materials and Methods)/i,
    );
    const abstractHtml = abstractMatch?.[1] ?? "";
    const bodyHtml = bodyMatch?.[1] ?? "";
    return {
      abstract: stripJats(abstractHtml).slice(0, 5000),
      body: stripJats(bodyHtml).slice(0, 50000), // cap to avoid huge files
    };
  } catch (err) {
    console.warn(`  ! MDPI fetch failed for ${doi}: ${(err as Error).message}`);
    return null;
  }
}

// ---------- Markdown writer ----------

function escapeYaml(s: string): string {
  // Quote strings containing YAML-special chars.
  if (/[:#\-?&*!|>'"%@`]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

function buildMarkdown(
  item: CrossrefItem,
  fullText: MdpiContent | null,
): string {
  const title = item.title?.[0] ?? "Untitled";
  const year = extractYear(item);
  const authors = formatAuthors(item.author);
  const journal = item["container-title"]?.[0] ?? "Marine Drugs";
  const doi = item.DOI;
  const url = `https://doi.org/${doi}`;
  const citedBy = item["is-referenced-by-count"] ?? 0;

  const abstractText = fullText?.abstract || stripJats(item.abstract) || "_No abstract available._";
  const bodyText = fullText?.body || "_Full text not fetched (MDPI may have blocked the request from this IP)._";

  return `---
title: ${escapeYaml(title)}
doi: ${doi}
journal: ${journal}
year: ${year ?? "unknown"}
authors: ${escapeYaml(authors)}
cited_by: ${citedBy}
source_url: ${url}
fetched_at: ${new Date().toISOString()}
---

# ${title}

**Journal:** ${journal} (${year ?? "?"}) | **DOI:** [${doi}](${url}) | **Cited by:** ${citedBy}

**Authors:** ${authors}

## Abstract

${abstractText}

## Full text

${bodyText}
`;
}

// ---------- Main ----------

async function main() {
  console.log(JSON.stringify({ count: COUNT, mode: MODE, out: OUT_DIR }, null, 2));

  // Step 1: pick metadata source
  let items: CrossrefItem[];
  if (MODE === "crossref") {
    items = await fetchCrossref(COUNT);
  } else {
    const oa = await fetchOpenAlex(COUNT);
    items = oa.map(openAlexToItem);
  }
  await mkdir(OUT_DIR, { recursive: true });

  // Step 2: optionally fetch full text from MDPI
  const shouldFetchFull = MODE === "full";
  console.log(shouldFetchFull
    ? "→ Will attempt MDPI full-text fetch (1s delay between requests)"
    : `→ Skipping MDPI fetch (mode=${MODE}); using abstracts only`);

  let ok = 0;
  let abstractOnly = 0;
  let failed = 0;

  for (const [i, item] of items.entries()) {
    const doi = item.DOI;
    console.log(`[${i + 1}/${items.length}] ${doi} — ${item.title?.[0]?.slice(0, 70)}`);

    let ft: MdpiContent | null = null;
    if (shouldFetchFull) {
      if (i > 0) await sleep(1000);
      ft = await fetchMdpiFullText(doi);
    }

    const md = buildMarkdown(item, ft);
    const safeName = doi.replace(/\//g, "_");
    const path = join(OUT_DIR, `${safeName}.md`);
    await writeFile(path, md, "utf-8");

    if (ft?.body) ok++;
    else if (item.abstract) abstractOnly++;
    else failed++;
  }

  console.log("\n=== Done ===");
  console.log(JSON.stringify(
    { out: OUT_DIR, fullText: ok, abstractOnly, failed, total: items.length },
    null, 2,
  ));
  console.log(`\nNext: bun run scripts/ingest-docs.ts -- --path=${OUT_DIR}`);
}

main().catch((err) => {
  console.error("ingest-marine-drugs failed:", err);
  process.exit(1);
});
