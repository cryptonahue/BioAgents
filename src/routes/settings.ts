/**
 * Global Settings API
 *
 * Runtime-tunable, GLOBAL (not per-user) configuration. Currently exposes the
 * deep-research model selector.
 *
 * - GET  /api/settings/deep-research-model  -> { current, models }
 * - PUT  /api/settings/deep-research-model  -> { current }  (body: { model })
 *
 * The read is available to any authenticated user (the Settings page renders
 * the dropdown). The write is gated to admins via
 * `authResolver({ required: true, role: "admin" })` — the same clean admin
 * gate used by src/routes/admin/*.
 */

import { Elysia } from "elysia";
import { authResolver } from "../middleware/authResolver";
import {
  DEEP_RESEARCH_MODELS,
  DEFAULT_DEEP_RESEARCH_MODEL,
  isAllowedModel,
} from "../config/models";
import { invalidateDeepResearchModelCache } from "../config/deepResearchModel";
import { getGlobalSetting, setGlobalSetting } from "../db/operations";
import logger from "../utils/logger";

const DEEP_RESEARCH_MODEL_KEY = "deep_research_model";

export const settingsRoute = new Elysia()
  .get(
    "/api/settings/deep-research-model",
    async ({ set }) => {
      try {
        const current = await getGlobalSetting(DEEP_RESEARCH_MODEL_KEY);
        return {
          current: current ?? DEFAULT_DEEP_RESEARCH_MODEL,
          models: DEEP_RESEARCH_MODELS,
        };
      } catch (err) {
        logger.error({ err }, "settings_get_deep_research_model_failed");
        set.status = 500;
        return { error: "Failed to read deep-research model setting" };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )
  .put(
    "/api/settings/deep-research-model",
    async ({ body, set }) => {
      const model = (body as { model?: unknown } | undefined)?.model;

      if (typeof model !== "string" || !isAllowedModel(model)) {
        set.status = 400;
        return {
          error: "Invalid model",
          message: "model must be one of the allowed deep-research models",
          models: DEEP_RESEARCH_MODELS,
        };
      }

      try {
        await setGlobalSetting(DEEP_RESEARCH_MODEL_KEY, model);
        // Take effect immediately in this process; other processes pick it up
        // when their ~30s cache expires.
        invalidateDeepResearchModelCache();
        return { current: model };
      } catch (err) {
        logger.error({ err }, "settings_put_deep_research_model_failed");
        set.status = 500;
        return { error: "Failed to save deep-research model setting" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  );
