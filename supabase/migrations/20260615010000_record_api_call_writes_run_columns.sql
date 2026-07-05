-- Migration: Extend `record_api_call` RPC to write to
-- research_ingestion_runs.ext_api_cost and ext_api_calls.
--
-- Fixes sdd-verify WARNING #1 from the cost-guard-rails change:
-- the original RPC only updated daily_api_usage, so the run-level
-- columns stayed at 0 forever and the per-source / per-run cap
-- reads returned zeros. The dashboard "extApiCost" column and the
-- WebSocket "apiCost" push were therefore always 0.
--
-- This migration is additive and idempotent:
--   - It does NOT change the RPC signature (same args, same return shape)
--   - It does NOT touch daily_api_usage semantics
--   - It DOES extend the same transaction to:
--       1. SELECT ... FOR UPDATE on research_ingestion_runs.id
--          (serializes concurrent API calls for the same run)
--       2. Increment ext_api_cost = ext_api_cost + p_cost_usd
--       3. Update ext_api_calls[provider] = {
--            calls: +1,
--            costUsd: +p_cost_usd,
--            units:   +p_units
--          }
--          (provider-keyed accumulator; matches the
--          research-brain.runsExtApiCost.test.ts contract and the
--          costService.getPerSourceTotals reader.)
--
-- Shape of ext_api_calls BEFORE: { "mistral_ocr": { "calls": 5, "costUsd": 2.5, "units": 50 } }
-- Shape of ext_api_calls AFTER:  { "mistral_ocr": { "calls": 6, "costUsd": 2.6, "units": 51 } }
--
-- Backward compatibility:
--   - New readers (costService.readRunExtApiTotals,
--     research-brain.runsExtApiCost route) already assume the
--     provider-keyed shape. No reader change required.
--   - Old rows (ext_api_calls = '{}'::jsonb) degrade to the empty
--     object and the jsonb_set | merge handles them correctly.
--
-- This is a CREATE OR REPLACE FUNCTION — no DROP required, no
-- permissions change, no schema migration. The original
-- 20260615000000_add_api_cost_tracking.sql migration is preserved
-- for history; this file layers the run-column writes on top.

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
  v_existing_provider_entry JSONB;
  v_new_provider_entry JSONB;
  v_existing_calls_count NUMERIC := 0;
  v_existing_units NUMERIC := 0;
  v_existing_cost NUMERIC := 0;
BEGIN
  -- Seed the row for the (day, provider) pair if it doesn't exist.
  INSERT INTO public.daily_api_usage (day, provider)
  VALUES (v_day, p_provider)
  ON CONFLICT (day, provider) DO NOTHING;

  -- Lock the (day, provider) row so concurrent calls serialize.
  -- This is the gate that prevents the day cap from being raced
  -- past by parallel workers.
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

  -- ========================================================================
  -- Run-row update: ext_api_cost + ext_api_calls[provider]
  -- ========================================================================
  -- Lock the run row (if a runId was supplied) so concurrent calls for
  -- the same run do not race past the per-run cap. This block is
  -- additive to the daily_api_usage lock above: the two locks are
  -- independent and are both released at function return.
  IF p_run_id IS NOT NULL THEN
    -- FOR UPDATE on the run row so concurrent calls for the same run
    -- serialize. The lock is released at function return. A SELECT
    -- (without INTO) is the idiomatic plpgsql pattern for "lock if
    -- exists, no-op if not". If the runId does not exist, the row
    -- count is 0 and we fall through to the per-run cost read
    -- (which also returns 0 rows for a missing run, so v_run_cost
    -- stays at 0 + p_cost_usd).
    PERFORM 1
      FROM public.research_ingestion_runs
     WHERE id = p_run_id
     FOR UPDATE;

    -- Read the existing provider entry (if any) so we can accumulate
    -- instead of overwrite. A missing key means fresh start at 0/0/0.
    SELECT ext_api_calls -> p_provider
      INTO v_existing_provider_entry
      FROM public.research_ingestion_runs
     WHERE id = p_run_id;

    IF v_existing_provider_entry IS NULL THEN
      v_existing_calls_count := 0;
      v_existing_units := 0;
      v_existing_cost := 0;
    ELSE
      v_existing_calls_count := COALESCE(
        (v_existing_provider_entry ->> 'calls')::NUMERIC,
        0
      );
      v_existing_units := COALESCE(
        (v_existing_provider_entry ->> 'units')::NUMERIC,
        0
      );
      v_existing_cost := COALESCE(
        (v_existing_provider_entry ->> 'costUsd')::NUMERIC,
        0
      );
    END IF;

    v_new_provider_entry := jsonb_build_object(
      'calls', v_existing_calls_count + 1,
      'units', v_existing_units + COALESCE(p_units, 0),
      'costUsd', v_existing_cost + COALESCE(p_cost_usd, 0)
    );

    UPDATE public.research_ingestion_runs
       SET ext_api_cost = COALESCE(ext_api_cost, 0) + COALESCE(p_cost_usd, 0),
           ext_api_calls = COALESCE(ext_api_calls, '{}'::jsonb)
                           || jsonb_build_object(p_provider, v_new_provider_entry),
           updated_at = NOW()
     WHERE id = p_run_id;
  END IF;

  -- Per-source cost: aggregate from research_ingestion_runs.ext_api_calls
  -- for the supplied source_id.
  --
  -- NOTE: the per-source aggregation has a pre-existing limitation —
  -- `research_ingestion_runs` has no `source_id` column, and the
  -- ext_api_calls JSONB is keyed by provider (not by entry), so the
  -- original `(entry.value->>'sourceId')::UUID = p_source_id` filter
  -- never matched. We preserve the original query shape here to keep
  -- this migration a pure additive fix for WARNING #1; the per-source
  -- cost still resolves to 0 in v1. A follow-up change will need to
  -- (a) add source_id to research_ingestion_runs, or (b) join via
  -- research_bioprospecting_facts.source_id. Tracking: cost-guard-rails
  -- follow-up #2 (WARNING #1 follow-up).
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
    SELECT COALESCE(SUM(provider_entry.cost_usd), 0)
      INTO v_run_cost
      FROM public.research_ingestion_runs run,
           LATERAL jsonb_each(COALESCE(run.ext_api_calls, '{}'::jsonb)) AS provider_key(entry_key, entry_value),
           LATERAL (
             SELECT COALESCE((entry_value ->> 'costUsd')::NUMERIC, 0) AS cost_usd
           ) AS provider_entry
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

-- ===========================================================================
-- Notes on the per-source computation (not changed in this migration)
-- ===========================================================================
-- The original implementation read `(entry.value->>'sourceId')::UUID = p_source_id`
-- from ext_api_calls, but the established JSONB shape (per the spec and
-- per the research-brain.runsExtApiCost.test.ts contract) is keyed by
-- provider, not by entry. That meant the per-source aggregate was always
-- 0, and the source cap could never be hit.
--
-- This migration does NOT change that behavior — WARNING #1 is the
-- run-row write (ext_api_cost + ext_api_calls), which is the fix
-- shipped here. The per-source cost computation needs a follow-up
-- migration that either (a) adds source_id to
-- research_ingestion_runs, or (b) joins via
-- research_bioprospecting_facts.source_id.
