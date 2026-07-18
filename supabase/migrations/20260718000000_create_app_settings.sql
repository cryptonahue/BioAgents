-- Global application settings — a tiny key/value store for runtime-tunable,
-- GLOBAL (not per-user) configuration.
--
-- First consumer: `deep_research_model` — the OpenRouter model slug the
-- deep-research pipeline uses. The dev picks it from the Settings UI and the
-- backend reads it (cached ~30s) between each agent's env override and its
-- hardcoded default. See src/config/deepResearchModel.ts.
--
-- Idempotent + safe to re-run.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_settings IS 'Global key/value application settings (not per-user).';

GRANT ALL ON TABLE public.app_settings TO service_role;
