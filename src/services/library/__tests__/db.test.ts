/**
 * Unit tests for the Library query normalizer.
 *
 * `normalizeLibraryQuery()` is the boundary between an arbitrary URL query bag
 * and the read RPC. It is pure, so it is tested directly — no database, no
 * Supabase client. The SQL side has its own allowlist (an unknown sort key
 * falls back to `year` in plpgsql too); these tests lock in the HTTP-side half
 * so the endpoint can safely echo the query it ran back to the client.
 */
import { describe, expect, it } from "bun:test";

import {
  LIBRARY_DEFAULT_PAGE_SIZE,
  LIBRARY_MAX_PAGE_SIZE,
  normalizeLibraryQuery,
} from "../db";

describe("normalizeLibraryQuery", () => {
  it("defaults to the most-recent-first first page when the query is empty", () => {
    expect(normalizeLibraryQuery(undefined)).toEqual({
      search: "",
      taxon: "",
      geography: "",
      year: null,
      trustTier: "",
      sort: "year",
      dir: "desc",
      page: 1,
      pageSize: LIBRARY_DEFAULT_PAGE_SIZE,
    });
  });

  it("keeps the allowlisted sort keys and directions", () => {
    for (const sort of ["year", "evidence", "title"] as const) {
      expect(normalizeLibraryQuery({ sort }).sort).toBe(sort);
    }
    expect(normalizeLibraryQuery({ dir: "asc" }).dir).toBe("asc");
    expect(normalizeLibraryQuery({ sort: "YEAR", dir: "DESC" })).toMatchObject({
      sort: "year",
      dir: "desc",
    });
  });

  it("falls back to the default sort on an unknown or hostile sort key", () => {
    expect(normalizeLibraryQuery({ sort: "size" }).sort).toBe("year");
    expect(
      normalizeLibraryQuery({ sort: "title; DROP TABLE documents" }).sort,
    ).toBe("year");
    expect(normalizeLibraryQuery({ dir: "sideways" }).dir).toBe("desc");
  });

  it("clamps the page size and floors the page at 1", () => {
    expect(normalizeLibraryQuery({ pageSize: "9999" }).pageSize).toBe(
      LIBRARY_MAX_PAGE_SIZE,
    );
    expect(normalizeLibraryQuery({ pageSize: "10" }).pageSize).toBe(10);
    expect(normalizeLibraryQuery({ page: "0" }).page).toBe(1);
    expect(normalizeLibraryQuery({ page: "-3" }).page).toBe(1);
    expect(normalizeLibraryQuery({ page: "not-a-number" }).page).toBe(1);
    expect(normalizeLibraryQuery({ page: "7" }).page).toBe(7);
  });

  it("only accepts a plausible publication year", () => {
    expect(normalizeLibraryQuery({ year: "2018" }).year).toBe(2018);
    expect(normalizeLibraryQuery({ year: "1066" }).year).toBeNull();
    expect(normalizeLibraryQuery({ year: "abcd" }).year).toBeNull();
    expect(normalizeLibraryQuery({ year: "" }).year).toBeNull();
  });

  it("trims the free-text filters and caps the search length", () => {
    expect(
      normalizeLibraryQuery({
        q: "  caribbean coral  ",
        taxon: " Porites lobata ",
        geography: " Red Sea ",
        trustTier: " curated ",
      }),
    ).toMatchObject({
      search: "caribbean coral",
      taxon: "Porites lobata",
      geography: "Red Sea",
      trustTier: "curated",
    });

    expect(normalizeLibraryQuery({ q: "x".repeat(500) }).search.length).toBe(
      200,
    );
  });
});
