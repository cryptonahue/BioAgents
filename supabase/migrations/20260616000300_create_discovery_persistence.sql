-- Migration: research_discoveries + research_discovery_evidence +
--          research_discovery_reeval_audit
--
-- Why this migration exists:
--   The Discovery entity lives only in conversation_states.values JSONB.
--   Every deep-research cycle re-extracts from scratch; there is no
--   durable, versioned record. We need a stable, FK-addressable, versioned
--   table before re-evaluation, provenance diffing, or "discoveries for
--   this user" queries are possible.
--
-- This migration is purely additive. Existing tables are untouched. The
-- JSONB cache path stays as the source of truth for planning / reply /
-- paper generation in v1. A follow-up change migrates read consumers.
--
-- Forward-compat hooks (v1 must ship, but v1 never writes to them):
--   - last_checked_at + idx_discoveries_reeval_due (PR #2 re-eval worker)
--   - reeval_status enum + CHECK
--   - research_discovery_reeval_audit table (PR #2 re-eval writes)
--
-- Idempotency: every CREATE uses IF NOT EXISTS, every trigger drop uses
-- IF EXISTS, the extension install uses IF NOT EXISTS, and the trigger
-- function is created with CREATE OR REPLACE. A failed-then-replayed
-- migration is safe.
--
-- Spec: openspec/changes/discovery-persistence/specs/.../spec.md
-- Design: openspec/changes/discovery-persistence/design/design.md §3.1

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- updated_at trigger function.
-- The function public.update_research_brain_updated_at() is expected to
-- exist (it is created in 20260601090000_create_research_brain.sql and
-- referenced by every research_* table added since). CREATE OR REPLACE
-- makes the migration safe to run on a fresh deploy where the function
-- is absent, although the canonical contract is that the dependency
-- migration has already run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_research_brain_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 1) research_discoveries — one row per (conversation, finding-version).
--    discovery_group_id is stable across versions of "the same" finding;
--    supersedes_discovery_id points to the row being replaced.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_discoveries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_group_id       UUID NOT NULL,
  conversation_id          UUID NOT NULL
                            REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id               UUID
                            REFERENCES public.messages(id) ON DELETE SET NULL,
  supersedes_discovery_id  UUID
                            REFERENCES public.research_discoveries(id) ON DELETE SET NULL,

  is_current               BOOLEAN NOT NULL DEFAULT true,
  superseded_at            TIMESTAMPTZ,

  title                    TEXT NOT NULL,
  claim                    TEXT NOT NULL,
  summary                  TEXT NOT NULL,
  novelty                  TEXT,
  artifacts                JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Normalized (title + claim) token set, joined with '|'. Used by
  -- findMatchingDiscovery() at the TS layer (Jaccard >= 0.7).
  discovery_key            TEXT NOT NULL,

  -- Forward-compat: re-eval lifecycle. v1 NEVER writes these.
  -- PR #2 (re-evaluation) will use them.
  reeval_status            TEXT NOT NULL DEFAULT 'none'
    CHECK (reeval_status IN ('none','pending','clean','extended','contradicted')),
  reeval_notes             TEXT,
  last_checked_at          TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A discovery cannot supersede itself.
  CONSTRAINT no_self_supersede CHECK (id != supersedes_discovery_id)
);

-- Hot path: "current discoveries for this conversation"
-- Partial index because the typical read query filters on is_current=true.
CREATE INDEX IF NOT EXISTS idx_discoveries_conv_current
  ON public.research_discoveries (conversation_id)
  WHERE is_current;

-- History walk: "show all versions of this finding"
CREATE INDEX IF NOT EXISTS idx_discoveries_group
  ON public.research_discoveries (discovery_group_id);

-- Forward-compat: PR #2 worker will scan this index for
-- is_current=true AND last_checked_at IS NULL OR < NOW() - INTERVAL '24h'.
-- Partial index keeps it cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_discoveries_reeval_due
  ON public.research_discoveries (last_checked_at)
  WHERE is_current;

-- Foreign-key indexes (Postgres does NOT auto-index FKs).
CREATE INDEX IF NOT EXISTS idx_discoveries_supersedes
  ON public.research_discoveries (supersedes_discovery_id)
  WHERE supersedes_discovery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_discoveries_message
  ON public.research_discoveries (message_id)
  WHERE message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) research_discovery_evidence — 1..N evidence rows per discovery.
--    task_id references a PlanTask in JSONB (no FK).
--    source_url is forward-compat: PR #2 will populate when re-eval
--    cites a specific Lit page. v1 leaves it NULL.
--    evidence_archived is computed at READ time (see route design).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_discovery_evidence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id      UUID NOT NULL
                      REFERENCES public.research_discoveries(id) ON DELETE CASCADE,
  task_id           TEXT NOT NULL,
  job_id            TEXT,
  explanation       TEXT NOT NULL,
  source_url        TEXT,
  evidence_archived BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovery_evidence_discovery
  ON public.research_discovery_evidence (discovery_id);

CREATE INDEX IF NOT EXISTS idx_discovery_evidence_task
  ON public.research_discovery_evidence (task_id);

-- ---------------------------------------------------------------------------
-- 3) research_discovery_reeval_audit — forward-compat hook.
--    v1 MUST NOT write to this table. PR #2 (re-evaluation) will.
--    The table exists so PR #2's migration is purely additive.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_discovery_reeval_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id    UUID NOT NULL
                    REFERENCES public.research_discoveries(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('user_reeval','auto_reeval','llm_supersede','user_dismiss')),
  old_version_id  UUID
    REFERENCES public.research_discoveries(id) ON DELETE SET NULL,
  new_version_id  UUID
    REFERENCES public.research_discoveries(id) ON DELETE SET NULL,
  outcome         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovery_reeval_audit_discovery
  ON public.research_discovery_reeval_audit (discovery_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at trigger on research_discoveries (mirrors existing pattern)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_update_research_discoveries_updated_at
  ON public.research_discoveries;

CREATE TRIGGER trigger_update_research_discoveries_updated_at
  BEFORE UPDATE ON public.research_discoveries
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

-- ---------------------------------------------------------------------------
-- Grants — mirror research_bioprospecting_contradictions pattern.
-- Backend uses service client (RLS bypassed). Future v2 RLS can
-- enforce conversation_id ownership via a policy keyed on
-- auth.jwt()->>sub.
-- ---------------------------------------------------------------------------
GRANT ALL ON TABLE public.research_discoveries
  TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_discovery_evidence
  TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.research_discovery_reeval_audit
  TO anon, authenticated, service_role;

COMMIT;
