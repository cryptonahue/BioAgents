-- Migration: Add LLM cost tracking and cancellation support to research_ingestion_runs
-- Adds llm_cost, llm_calls, cancelled_at columns and status index
-- Creates record_llm_call RPC for atomic cost accumulation

ALTER TABLE public.research_ingestion_runs
  ADD COLUMN IF NOT EXISTS llm_cost NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS llm_calls JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON public.research_ingestion_runs (status);

-- RPC for atomic LLM call recording
-- Appends call entry to llm_calls JSONB and increments llm_cost in one transaction
CREATE OR REPLACE FUNCTION record_llm_call(
  p_run_id UUID,
  p_provider TEXT,
  p_model TEXT,
  p_input_tokens INT,
  p_output_tokens INT,
  p_cost_usd NUMERIC(10,6),
  p_latency_ms INT
) RETURNS VOID AS $$
  UPDATE research_ingestion_runs
  SET
    llm_cost = llm_cost + p_cost_usd,
    llm_calls = llm_calls || jsonb_build_object(
      'provider', p_provider,
      'model', p_model,
      'inputTokens', p_input_tokens,
      'outputTokens', p_output_tokens,
      'costUsd', p_cost_usd,
      'latencyMs', p_latency_ms,
      'timestamp', now()
    )
  WHERE id = p_run_id;
$$ LANGUAGE sql SECURITY DEFINER;
