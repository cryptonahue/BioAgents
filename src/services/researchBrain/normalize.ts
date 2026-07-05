/**
 * Identity-key normalization for bioprospecting fact deduplication.
 *
 * Phase 1 of bioprospecting-semantic-dedup. Provides the string transforms
 * used to (a) pre-group incoming facts in memory before insert and (b) match
 * the database-generated `identity_key` column on `research_bioprospecting_facts`.
 *
 * The algorithm is deliberately conservative: no taxonomy lookups, no
 * chemistry-aware transforms, no plural/suffix folding. The two
 * implementations (TS and SQL GENERATED column) MUST agree on the
 * normalization contract.
 */

import { normalizeForMatch } from "./search";
import type { BioprospectingFact } from "./types";

/**
 * Normalize a single string for identity-key construction.
 *
 * Steps (applied in order):
 *   1. Unicode NFKD normalization
 *   2. Strip combining diacritics (\p{Diacritic})
 *   3. Replace any non-letter, non-digit run with a single space
 *   4. Collapse consecutive whitespace
 *   5. Trim leading and trailing whitespace
 *   6. Lowercase
 *
 * Steps 1–3 delegate to `normalizeForMatch` from `./search` so both
 * normalizers share the same primitive behavior; this function adds the
 * whitespace collapse and the final trim/lowercase tail.
 */
export function normalizeForIdentity(value: string): string {
  if (!value) return "";
  // normalizeForMatch already performs the full six-step pipeline
  // (NFKD, diacritic strip, non-alnum -> space, collapse, trim, lower).
  // We delegate to it directly so the two normalizers share one
  // primitive implementation; the only addition is the empty-input
  // guard above.
  return normalizeForMatch(value);
}

/**
 * Build the deterministic identity key for a bioprospecting fact.
 *
 * The key is a 5-tuple joined by '|':
 *   species | compound | bioactivity | organism_part | geography
 *
 * High-cardinality fields are excluded by design (result_summary, quote,
 * measurement_*, p_value, sample_size, timepoint, condition,
 * application_area): they absorb LLM drift and would prevent legitimate
 * merges. See design.md decision table.
 *
 * Returns `null` when all five contributing fields are null/empty —
 * the fact is then NOT eligible for identity-key-based dedup.
 */
export function buildIdentityKey(fact: BioprospectingFact): string | null {
  const tuple = [
    normalizeForIdentity(fact.species),
    normalizeForIdentity(fact.compound),
    normalizeForIdentity(fact.bioactivity),
    normalizeForIdentity(fact.organism_part),
    normalizeForIdentity(fact.geography),
  ];

  if (tuple.every((segment) => segment.length === 0)) {
    return null;
  }

  return tuple.join("|");
}
