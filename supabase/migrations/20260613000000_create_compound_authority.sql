-- Migration: Compound authority tables + 5 new fact columns.
-- PR 1 of bioprospecting-compound-authority. Builds on
-- 20260606110000_create_taxonomy_normalization.sql and the
-- bioprospecting-pdf-provenance-viewer migrations (which added
-- evidence_table_id, evidence_figure_id, merged_into_fact_id).
--
-- Why this migration exists:
--   The bioprospecting compound field is free text. The same molecule
--   shows up under multiple surface forms (curcumin / diferuloylmethane /
--   IUPAC). The compound-authority capability resolves the free text
--   against a canonical chemistry identity, with a 4-status lifecycle
--   (pending -> verified / failed / skipped) and a structured JSONB
--   audit trail.
--
-- The 5-tuple `identity_key` and the existing dedup edges are
-- UNCHANGED. The new columns are a parallel signal: the raw `compound`
-- text is never overwritten.
--
-- The audit table is partitioned monthly by created_at so the
-- insert-heavy / read-rare pattern stays cheap to maintain. The
-- default partition catches stragglers from any month we have not yet
-- created a named partition for; pre-create the current month plus
-- 2 future months so a fresh deploy does not crash on month rollover.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) research_compounds — canonical chemistry identity.
--    Mirrors research_taxa structurally: one canonical row per molecule,
--    `normalized_name` is the dedup key, `status` records provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_compounds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name    TEXT NOT NULL,
  normalized_name   TEXT NOT NULL UNIQUE,
  inchi_key         TEXT,
  pubchem_cid       INTEGER,
  chebi_id          INTEGER,
  molecular_formula TEXT,
  iupac_name        TEXT,
  compound_kind     TEXT NOT NULL DEFAULT 'small_molecule'
    CHECK (compound_kind IN ('small_molecule', 'peptide', 'protein', 'lipid', 'other')),
  status            TEXT NOT NULL DEFAULT 'local'
    CHECK (status IN ('local', 'pubchem', 'chebi', 'manual', 'curated')),
  external_ids      JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_compounds_inchi_key
  ON public.research_compounds (inchi_key) WHERE inchi_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_compounds_pubchem_cid
  ON public.research_compounds (pubchem_cid) WHERE pubchem_cid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) research_compound_aliases — the fast lookup path that avoids a
--    PubChem round-trip on every extraction. Maps surface forms
--    (synonyms, trade names, IUPAC names, spelling variants) onto a
--    canonical row. UNIQUE (compound_id, normalized_alias) so the same
--    alias may exist against different canonical rows (curators may
--    disagree) but never twice against the same canonical row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_compound_aliases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compound_id      UUID NOT NULL REFERENCES public.research_compounds(id) ON DELETE CASCADE,
  alias            TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'local_extraction'
    CHECK (source IN ('local_extraction', 'pubchem', 'chebi', 'manual', 'curated')),
  confidence       TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (compound_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS idx_research_compound_aliases_normalized
  ON public.research_compound_aliases (normalized_alias);

-- ---------------------------------------------------------------------------
-- 3) compound_authority_audit — JSONB-diff audit log, partitioned by
--    month on created_at. Read-rare (admin only), insert-heavy (every
--    status change and manual edit). Monthly partitions keep the
--    indexes small; the default partition catches stragglers from
--    months we have not yet named.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compound_authority_audit (
  id         UUID NOT NULL DEFAULT gen_random_uuid(),
  fact_id    UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('status_change', 'manual_edit', 'manual_alias_add')),
  old_value  JSONB,
  new_value  JSONB,
  user_id    UUID,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- The spec defers this to design: alias-only audit events have no
-- natural fact_id; the spec author permits fact_id IS NULL in this
-- case. `manual_alias_add` rows carry the compound_id in their
-- `new_value` payload instead.

-- Default partition catches any month we have not yet created a named
-- partition for. Safe to re-create on a re-run.
CREATE TABLE IF NOT EXISTS public.compound_authority_audit_default
  PARTITION OF public.compound_authority_audit DEFAULT;

-- Pre-create the current month and 2 future months so a fresh deploy
-- does not crash on month rollover. Naming follows the
-- `compound_authority_audit_YYYY_MM` convention.
CREATE TABLE IF NOT EXISTS public.compound_authority_audit_2026_06
  PARTITION OF public.compound_authority_audit
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS public.compound_authority_audit_2026_07
  PARTITION OF public.compound_authority_audit
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS public.compound_authority_audit_2026_08
  PARTITION OF public.compound_authority_audit
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX IF NOT EXISTS idx_compound_authority_audit_fact
  ON public.compound_authority_audit (fact_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4) ALTER research_bioprospecting_facts — 4 spec'd columns + 1
--    operational column. The 5th (`compound_authority_attempts`) was
--    flagged in design as a backfill concern (worker needs a counter
--    that survives restart) and is added in the same block.
-- ---------------------------------------------------------------------------
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS compound_canonical_id UUID
    REFERENCES public.research_compounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS compound_authority_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (compound_authority_status IN ('pending', 'verified', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS compound_authority_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS compound_authority_error TEXT,
  ADD COLUMN IF NOT EXISTS compound_authority_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_compound_canonical
  ON public.research_bioprospecting_facts (compound_canonical_id)
  WHERE compound_canonical_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_compound_authority_status
  ON public.research_bioprospecting_facts (compound_authority_status, created_at);

-- ---------------------------------------------------------------------------
-- 5) updated_at trigger on research_compounds (mirrors research_taxa)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_update_research_compounds_updated_at
  ON public.research_compounds;

CREATE TRIGGER trigger_update_research_compounds_updated_at
  BEFORE UPDATE ON public.research_compounds
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

-- ---------------------------------------------------------------------------
-- Grants (mirror research_taxa)
-- ---------------------------------------------------------------------------
GRANT ALL ON TABLE public.research_compounds TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_compound_aliases TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.compound_authority_audit TO anon, authenticated, service_role;

COMMIT;
