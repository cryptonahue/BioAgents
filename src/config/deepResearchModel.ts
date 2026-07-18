/**
 * Global deep-research model resolver (with a short-lived cache).
 *
 * A single global setting (`app_settings` row keyed `deep_research_model`)
 * decides which LLM the deep-research pipeline uses. The agents consult
 * `getGlobalDeepResearchModel()` BETWEEN their per-agent env override and the
 * hardcoded default, so the selection applies everywhere without a redeploy.
 *
 * TDZ SAFETY (see CLAUDE.md "Known Issues"): this module runs inside Bun
 * worker processes, which initialize modules differently from the main
 * process. There are NO module-level mutable variables — the cache lives on
 * `globalThis` and all config is read INSIDE the functions.
 */

import { getGlobalSetting } from "../db/operations";
import logger from "../utils/logger";

const CACHE_KEY = "deep_research_model";
const CACHE_TTL_MS = 30_000;

type DrModelCache = { value: string | null; expiresAt: number };

/**
 * Returns the currently-selected global deep-research model id, or `null` if
 * none has been set (the caller then falls back to env/default). Never throws:
 * on a DB error it logs and returns `null` so the pipeline keeps running.
 *
 * The result is cached on `globalThis` for ~30s to avoid a DB read on every
 * LLM call.
 */
export async function getGlobalDeepResearchModel(): Promise<string | null> {
  const cache = (globalThis as any).__drModelCache as DrModelCache | undefined;
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  let value: string | null = null;
  try {
    value = await getGlobalSetting(CACHE_KEY);
  } catch (err) {
    // Never throw — the caller falls back to env/default.
    logger.error({ err }, "[deepResearchModel] failed to read global setting");
    value = null;
  }

  (globalThis as any).__drModelCache = {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  } satisfies DrModelCache;

  return value;
}

/**
 * Clears the cached global model so the next read hits the DB. Called by the
 * settings PUT route so an in-process change takes effect immediately.
 */
export function invalidateDeepResearchModelCache(): void {
  (globalThis as any).__drModelCache = undefined;
}
