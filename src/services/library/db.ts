/**
 * Library read model.
 *
 * The Library paper list is aggregated in POSTGRES, not in JS. See
 * `supabase/migrations/20260712000000_library_papers_view.sql`:
 * `public.library_papers` is one row per paper, and `library_list_papers()` /
 * `library_facets()` are the two read RPCs this module wraps.
 *
 * What it replaces: `VectorSearchWithDocuments.listDocuments()` + a full read
 * of `research_sources` and `research_bioprospecting_facts`, all grouped in
 * memory. That was O(CHUNKS) — a 1000-paper corpus dragged tens of thousands of
 * chunk rows across the wire to render 25 of them. This module reads ONE PAGE.
 *
 * TDZ: no module-level state, no module-level env reads (Bun workers evaluate
 * modules differently and a module-level `const` here is a TDZ hazard). The
 * Supabase client is resolved inside each function.
 */

import { getServiceClient } from "../../db/client";

/** Sort keys the RPC accepts. Anything else falls back to `year`. */
export const LIBRARY_SORTS = ["year", "evidence", "title"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const LIBRARY_DIRECTIONS = ["asc", "desc"] as const;
export type LibraryDirection = (typeof LIBRARY_DIRECTIONS)[number];

export const LIBRARY_DEFAULT_PAGE_SIZE = 25;
export const LIBRARY_MAX_PAGE_SIZE = 100;

/** One row of `public.library_papers`, as returned by the RPC (snake_case). */
export interface LibraryPaperRow {
  title: string;
  display_title: string | null;
  chunk_count: number | null;
  type: string | null;
  size: number | null;
  file_path: string | null;
  last_modified: string | null;
  research_source_id: string | null;
  doi: string | null;
  trust_tier: string | null;
  bioprospecting_fact_count: number | null;
  meta_title: string | null;
  year: number | null;
  publisher: string | null;
  evidence_count: number | null;
  taxa: string[] | null;
  geography: string[] | null;
}

export interface LibraryQuery {
  search: string;
  taxon: string;
  geography: string;
  year: number | null;
  trustTier: string;
  sort: LibrarySort;
  dir: LibraryDirection;
  page: number;
  pageSize: number;
}

export interface LibraryFacetValue<T = string> {
  value: T;
  count: number;
}

export interface LibraryFacets {
  taxa: LibraryFacetValue[];
  geography: LibraryFacetValue[];
  years: LibraryFacetValue<number>[];
  trustTiers: LibraryFacetValue[];
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : fallback;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize a raw Elysia query bag into the shape the RPC takes.
 *
 * Every value is clamped or allowlisted HERE as well as in SQL. The SQL guard
 * is the one that actually protects the database (an unknown sort key there
 * falls back to `year` rather than reaching an ORDER BY); this one exists so
 * the endpoint can ECHO the query it actually ran back to the client, which is
 * what lets the UI keep its controls in sync with the server's interpretation.
 */
export function normalizeLibraryQuery(
  raw: Record<string, unknown> | undefined,
): LibraryQuery {
  const q = raw || {};

  const sortRaw = toTrimmedString(q.sort).toLowerCase();
  const dirRaw = toTrimmedString(q.dir).toLowerCase();
  const yearRaw = Number(toTrimmedString(q.year));

  return {
    search: toTrimmedString(q.q).slice(0, 200),
    taxon: toTrimmedString(q.taxon),
    geography: toTrimmedString(q.geography),
    year:
      Number.isFinite(yearRaw) && yearRaw >= 1900 && yearRaw <= 2099
        ? Math.trunc(yearRaw)
        : null,
    trustTier: toTrimmedString(q.trustTier),
    sort: (LIBRARY_SORTS as readonly string[]).includes(sortRaw)
      ? (sortRaw as LibrarySort)
      : "year",
    dir: (LIBRARY_DIRECTIONS as readonly string[]).includes(dirRaw)
      ? (dirRaw as LibraryDirection)
      : "desc",
    page: toPositiveInt(q.page, 1),
    pageSize: Math.min(
      toPositiveInt(q.pageSize, LIBRARY_DEFAULT_PAGE_SIZE),
      LIBRARY_MAX_PAGE_SIZE,
    ),
  };
}

/**
 * One RPC call -> one page of papers plus the TOTAL count before the page
 * window (the pagination control needs both, and a plain `.range()` on the view
 * would have needed a second round trip for the count).
 */
export async function listLibraryPapers(
  query: LibraryQuery,
): Promise<{ papers: LibraryPaperRow[]; total: number }> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc("library_list_papers", {
    p_search: query.search || null,
    p_taxon: query.taxon || null,
    p_geography: query.geography || null,
    p_year: query.year,
    p_trust_tier: query.trustTier || null,
    p_sort: query.sort,
    p_dir: query.dir,
    p_limit: query.pageSize,
    p_offset: (query.page - 1) * query.pageSize,
  });

  if (error) throw error;

  const payload = (data || {}) as {
    total?: number;
    papers?: LibraryPaperRow[];
  };
  return {
    papers: Array.isArray(payload.papers) ? payload.papers : [],
    total: Number(payload.total ?? 0),
  };
}

/** The filter vocabulary (taxa, geography, years, trust tiers) with counts. */
export async function getLibraryFacets(): Promise<LibraryFacets> {
  const supabase = getServiceClient();

  const { data, error } = await supabase.rpc("library_facets");
  if (error) throw error;

  const payload = (data || {}) as Partial<LibraryFacets>;
  return {
    taxa: payload.taxa ?? [],
    geography: payload.geography ?? [],
    years: payload.years ?? [],
    trustTiers: payload.trustTiers ?? [],
  };
}
