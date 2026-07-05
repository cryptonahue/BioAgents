-- Migration: Add bioprospecting semantic deduplication infrastructure
-- Phase 1 of bioprospecting-semantic-dedup. Adds:
--   1. research_bioprospecting_fact_edges table (lineage)
--   2. identity_key generated column on research_bioprospecting_facts
--   3. partial unique index on identity_key (nullable safe)
--   4. edge table FK indexes for reverse lookups
--
-- All changes are additive: no rows are mutated, no existing columns dropped.
-- Generated column uses translate() for diacritic stripping (IMMUTABLE, no extension dependency).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Edge table: research_bioprospecting_fact_edges
--    Composite PK (canonical_fact_id, merged_fact_id) is the authoritative
--    uniqueness guard. CHECK rejects self-edges. match_rule is constrained
--    to the rule set we will ever write ('identity_key' in this PR;
--    'embedding' reserved for a future pgvector tier).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_bioprospecting_fact_edges (
  canonical_fact_id UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  merged_fact_id    UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  match_rule        TEXT NOT NULL,
  merged_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canonical_fact_id, merged_fact_id),
  CONSTRAINT research_bioprospecting_fact_edges_no_self_edge
    CHECK (canonical_fact_id <> merged_fact_id),
  CONSTRAINT research_bioprospecting_fact_edges_match_rule_check
    CHECK (match_rule IN ('identity_key', 'embedding'))
);

-- Reverse-lookup indexes: "which canonical owns this merged row?" and
-- "which rows are merged into this canonical?". The composite PK already
-- covers the canonical-prefix case, but per-column indexes support
-- single-column lookups in search and lineage helpers.
CREATE INDEX IF NOT EXISTS idx_bioprospecting_fact_edges_canonical
  ON public.research_bioprospecting_fact_edges (canonical_fact_id);

CREATE INDEX IF NOT EXISTS idx_bioprospecting_fact_edges_merged
  ON public.research_bioprospecting_fact_edges (merged_fact_id);

-- ---------------------------------------------------------------------------
-- 2. Generated identity_key column on research_bioprospecting_facts
--
-- Five-tuple shape: species | compound | bioactivity | organism_part | geography
-- Each field is lower()ed, then translate()d against the diacritic map,
-- then non-alphanumeric runs collapse to a single space (with '|' preserved
-- as the tuple separator), then btrim()med, then lower()ed again (final
-- safety; translate doesn't add uppercase). The whole expression is built
-- from IMMUTABLE functions (lower, translate, coalesce, ||, regexp_replace,
-- btrim) which is required for GENERATED ALWAYS AS (...) STORED.
--
-- The column is nullable: empty/null fields resolve to empty strings, and
-- if ALL five are empty the resulting string is just '||||' after btrim.
-- Such rows are still kept; the partial unique index below skips them so
-- the all-blank key does not collide across rows. A row with all five
-- identity fields blank is not eligible for identity-key dedup (the TS
-- buildIdentityKey returns null in that case).
-- ---------------------------------------------------------------------------
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS identity_key TEXT
  GENERATED ALWAYS AS (
    lower(
      btrim(
        regexp_replace(
          translate(lower(coalesce(species, '')),
                    'áéíóúàèìòùâêîôûäëïöüçñ',
                    'aeiouaeiouaeiouaeioucn')
          || '|' || translate(lower(coalesce(compound, '')),
                              'áéíóúàèìòùâêîôûäëïöüçñ',
                              'aeiouaeiouaeiouaeioucn')
          || '|' || translate(lower(coalesce(bioactivity, '')),
                              'áéíóúàèìòùâêîôûäëïöüçñ',
                              'aeiouaeiouaeiouaeioucn')
          || '|' || translate(lower(coalesce(organism_part, '')),
                              'áéíóúàèìòùâêîôûäëïöüçñ',
                              'aeiouaeiouaeiouaeioucn')
          || '|' || translate(lower(coalesce(geography, '')),
                              'áéíóúàèìòùâêîôûäëïöüçñ',
                              'aeiouaeiouaeiouaeioucn'),
          '[^a-z0-9|]+', ' ', 'g'
        )
      )
    )
  ) STORED;

-- ---------------------------------------------------------------------------
-- 3. Partial unique index on identity_key
--    Prevents two canonical rows from sharing the same identity key.
--    WHERE clause skips the all-blank-key case ('||||' is the literal
--    tuple produced when all five identity fields are empty/null) so
--    such rows are not eligible for identity-key dedup — matching the
--    TypeScript buildIdentityKey() contract that returns null in that
--    case. The column itself is non-nullable (GENERATED STORED) so the
--    IS NOT NULL check is defensive and mirrors the spec wording.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_bioprospecting_facts_identity_key_unique
  ON public.research_bioprospecting_facts (identity_key)
  WHERE identity_key IS NOT NULL AND identity_key <> '||||';

GRANT ALL ON TABLE public.research_bioprospecting_fact_edges
  TO anon, authenticated, service_role;

COMMIT;
