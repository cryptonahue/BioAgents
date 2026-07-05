-- Migration: Add external API cost tracking for Mistral OCR + PubChem
-- Creates daily_api_usage (accumulator table) + record_api_call RPC (atomic
-- cap check + increment under FOR UPDATE row lock) and adds two columns
-- to research_ingestion_runs for inline spend visibility.
--
-- Mirrors the proven record_llm_call pattern from
-- 20260609000000_add_llm_cost_calls.sql, but generalized for arbitrary
-- external providers (Mistral OCR, PubChem) and per-(day, provider) caps.

-- ===========================================================================
-- 1. daily_api_usage — authoritative per-(day, provider) accumulator
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.daily_api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day DATE NOT NULL,
  provider TEXT NOT NULL,
  units NUMERIC(20,6) NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  calls_count INTEGER NOT NULL DEFAULT 0,
  last_cap_warn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day, provider)
);

CREATE INDEX IF NOT EXISTS idx_daily_api_usage_provider_day
  ON public.daily_api_usage (provider, day DESC);

-- ===========================================================================
-- 2. research_ingestion_runs — add ext_api_cost + ext_api_calls columns
-- ===========================================================================

ALTER TABLE public.research_ingestion_runs
  ADD COLUMN IF NOT EXISTS ext_api_cost NUMERIC(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ext_api_calls JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ===========================================================================
-- 3. record_api_call — atomic cap check + increment RPC
-- ===========================================================================
--
-- The RPC:
--   1. seeds the (day, provider) row via INSERT ... ON CONFLICT DO NOTHING
--   2. locks the row with SELECT ... FOR UPDATE so concurrent workers
--      serialize before comparing totals
--   3. increments units / cost_usd / calls_count in one UPDATE
--   4. sets last_cap_warn_at idempotently (only the first crossing of
--      v_daily * COST_ALERT_SOFT_THRESHOLD per UTC day)
--   5. computes new daily, monthly (rolling 30d), per-source, per-run
--      totals and returns the highest cap hit, if any, in
--      cap-hit precedence order: source > run > day > month
--
-- The caller (costService.recordApiCall) is responsible for throwing
-- CostCapExceededError based on cap_hit. The RPC records the call
-- regardless so best-effort visibility is preserved.

CREATE OR REPLACE FUNCTION record_api_call(
  p_run_id UUID,
  p_source_id UUID,
  p_provider TEXT,
  p_units NUMERIC,
  p_cost_usd NUMERIC,
  p_metadata JSONB
) RETURNS TABLE(
  cap_hit TEXT,
  current_daily_cost NUMERIC,
  current_monthly_cost NUMERIC,
  current_source_cost NUMERIC,
  current_run_cost NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_daily_cap NUMERIC := COALESCE(
    NULLIF(current_setting('app.mistral_ocr_daily_cap', true), '')::NUMERIC,
    0
  );
  v_monthly_cap NUMERIC := COALESCE(
    NULLIF(current_setting('app.mistral_ocr_monthly_cap', true), '')::NUMERIC,
    0
  );
  v_source_cap NUMERIC := COALESCE(
    NULLIF(current_setting('app.mistral_ocr_per_source_cap', true), '')::NUMERIC,
    0
  );
  v_run_cap NUMERIC := COALESCE(
    NULLIF(current_setting('app.mistral_ocr_per_run_cap', true), '')::NUMERIC,
    0
  );
  v_soft_threshold NUMERIC := COALESCE(
    NULLIF(current_setting('app.cost_alert_soft_threshold', true), '')::NUMERIC,
    0.8
  );
  v_day DATE := CURRENT_DATE;
  v_new_daily NUMERIC;
  v_new_monthly NUMERIC;
  v_source_cost NUMERIC := 0;
  v_run_cost NUMERIC := 0;
  v_existing_warn_at TIMESTAMPTZ;
  v_hit TEXT := NULL;
BEGIN
  -- Seed the row for the (day, provider) pair if it doesn't exist.
  INSERT INTO public.daily_api_usage (day, provider)
  VALUES (v_day, p_provider)
  ON CONFLICT (day, provider) DO NOTHING;

  -- Lock the row so concurrent calls serialize. This is the gate that
  -- prevents the day cap from being raced past by parallel workers.
  PERFORM 1
    FROM public.daily_api_usage
   WHERE day = v_day AND provider = p_provider
   FOR UPDATE;

  -- Update accumulated values. last_cap_warn_at is set idempotently:
  -- only the first crossing of v_daily_cap * v_soft_threshold on a
  -- given UTC day. Subsequent calls that remain above the threshold
  -- do not update the column.
  SELECT last_cap_warn_at INTO v_existing_warn_at
    FROM public.daily_api_usage
   WHERE day = v_day AND provider = p_provider
   FOR UPDATE;

  UPDATE public.daily_api_usage
     SET units = units + p_units,
         cost_usd = cost_usd + p_cost_usd,
         calls_count = calls_count + 1,
         updated_at = NOW(),
         last_cap_warn_at = CASE
           WHEN v_daily_cap > 0
                AND cost_usd + p_cost_usd >= v_daily_cap * v_soft_threshold
                AND (last_cap_warn_at IS NULL OR last_cap_warn_at::date < v_day)
           THEN NOW()
           ELSE last_cap_warn_at
         END
   WHERE day = v_day AND provider = p_provider;

  -- New daily cost.
  SELECT cost_usd INTO v_new_daily
    FROM public.daily_api_usage
   WHERE day = v_day AND provider = p_provider;

  -- New monthly cost (rolling 30-day sum of cost_usd for this provider).
  SELECT COALESCE(SUM(cost_usd), 0) INTO v_new_monthly
    FROM public.daily_api_usage
   WHERE provider = p_provider
     AND day >= v_day - INTERVAL '30 days';

  -- Per-source cost from research_ingestion_runs.ext_api_calls JSONB.
  -- Sum of costUsd across all entries in ext_api_calls for this
  -- source_id, regardless of provider (per-source cap is provider-
  -- agnostic in v1).
  IF p_source_id IS NOT NULL THEN
    SELECT COALESCE(SUM((entry.value->>'costUsd')::NUMERIC), 0)
      INTO v_source_cost
      FROM research_ingestion_runs run,
           LATERAL jsonb_each(COALESCE(run.ext_api_calls, '{}'::jsonb)) AS entry(key, value)
     WHERE (entry.value->>'sourceId')::UUID = p_source_id;
  END IF;
  v_source_cost := v_source_cost + p_cost_usd;

  -- Per-run cost from the active run's ext_api_calls JSONB.
  IF p_run_id IS NOT NULL THEN
    SELECT COALESCE(SUM((entry.value->>'costUsd')::NUMERIC), 0)
      INTO v_run_cost
      FROM research_ingestion_runs run,
           LATERAL jsonb_each(COALESCE(run.ext_api_calls, '{}'::jsonb)) AS entry(key, value)
     WHERE run.id = p_run_id;
  END IF;
  v_run_cost := v_run_cost + p_cost_usd;

  -- Determine the highest-precedence cap hit. Order: source > run > day > month.
  IF v_source_cap > 0 AND v_source_cost > v_source_cap THEN
    v_hit := 'source';
  ELSIF v_run_cap > 0 AND p_run_id IS NOT NULL AND v_run_cost > v_run_cap THEN
    v_hit := 'run';
  ELSIF v_daily_cap > 0 AND v_new_daily > v_daily_cap THEN
    v_hit := 'day';
  ELSIF v_monthly_cap > 0 AND v_new_monthly > v_monthly_cap THEN
    v_hit := 'month';
  END IF;

  RETURN QUERY SELECT v_hit, v_new_daily, v_new_monthly, v_source_cost, v_run_cost;
END $$;
