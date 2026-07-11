import { Elysia } from "elysia";
import { authResolver } from "../middleware/authResolver";
import {
  ENTITY_KINDS,
  expandEntity,
  isEntityKind,
  searchCompounds,
  searchEntities,
} from "../services/researchBrain/graphService";
import logger from "../utils/logger";

/**
 * v1 knowledge-graph read endpoints, mounted under
 * `/api/research-brain` from `src/index.ts`.
 *
 * This module is a separate Elysia plugin (not folded into
 * `src/routes/research-brain.ts`) so the 32-endpoint research-brain
 * file is left untouched and the new graph surface ships
 * independently. The mount prefix mirrors
 * `src/routes/research-brain.ts:54`.
 *
 * v1 contract:
 *   - GET /graph/compounds/search
 *       query params: q (1-100, required), limit (1-100, default 20),
 *                     expand ("true" -> 3 expand arrays; default false)
 *       auth:         admin-only via authResolver
 *       200 body:     { query, limit, expand, compounds: [...] }
 *       400 body:     { error: "missing query parameter q" }
 *                     { error: "q must be 1-100 characters" }
 *       401 body:     { error: "Authentication required" }   (authResolver)
 *       403 body:     { error: "Forbidden", message: "Admin role required" }
 *       500 body:     { error: "internal_error" }
 */
export const researchBrainGraphRoute = new Elysia({
  prefix: "/api/research-brain",
})
  .get(
    "/graph/compounds/search",
    async ({ query, set }) => {
      const q = ((query as { q?: unknown } | undefined)?.q ?? "")
        .toString()
        .trim();
      if (!q) {
        set.status = 400;
        return { error: "missing query parameter q" };
      }
      if (q.length > 100) {
        set.status = 400;
        return { error: "q must be 1-100 characters" };
      }

      const rawLimit = (query as { limit?: unknown } | undefined)?.limit;
      const limit =
        rawLimit != null && Number.isFinite(Number(rawLimit))
          ? Math.max(1, Math.min(100, Math.trunc(Number(rawLimit))))
          : 20;

      const rawExpand = (query as { expand?: unknown } | undefined)?.expand;
      const expand = rawExpand != null && rawExpand.toString() === "true";

      try {
        const compounds = await searchCompounds({
          query: q,
          limit,
          expand,
        });
        return { query: q, limit, expand, compounds };
      } catch (error) {
        logger.error(
          { err: error, q, limit, expand },
          "research_brain_graph_compounds_search_failed",
        );
        set.status = 500;
        return { error: "internal_error" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  /**
   * KG v2 — entity mention graph read endpoints (PR #2 of
   * bioprospecting-knowledge-graph). Read-only, LLM-free, admin-gated.
   *
   *   - GET /graph/entities/:kind/search
   *       path:   :kind (bioactivity | application_area | assay_model)
   *       query:  q (optional; empty -> top nodes), limit (1-100, default 20)
   *       200:    { kind, query, limit, entities: EntityNode[] }
   *       400:    { error: "unknown entity kind", allowed: [...] }
   *       500:    { error: "internal_error" }
   *   - GET /graph/entities/:kind/:value/expand
   *       path:   :kind (allowlisted), :value (URL-decoded normalized key)
   *       query:  limit (1-100, default 20)
   *       200:    { kind, value, limit, expansion: EntityExpansion }
   *       200:    empty arrays when the value matches nothing (empty-not-error)
   *       400:    { error: "unknown entity kind", allowed: [...] }
   *       500:    { error: "internal_error" }
   */
  .get(
    "/graph/entities/:kind/search",
    async ({ params, query, set }) => {
      const kind = (params as { kind?: string }).kind ?? "";
      if (!isEntityKind(kind)) {
        set.status = 400;
        return { error: "unknown entity kind", allowed: ENTITY_KINDS };
      }

      const q = ((query as { q?: unknown } | undefined)?.q ?? "")
        .toString()
        .trim();

      const rawLimit = (query as { limit?: unknown } | undefined)?.limit;
      const limit =
        rawLimit != null && Number.isFinite(Number(rawLimit))
          ? Math.max(1, Math.min(100, Math.trunc(Number(rawLimit))))
          : 20;

      try {
        const entities = await searchEntities({ kind, query: q, limit });
        return { kind, query: q, limit, entities };
      } catch (error) {
        logger.error(
          { err: error, kind, q, limit },
          "research_brain_graph_entities_search_failed",
        );
        set.status = 500;
        return { error: "internal_error" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  )
  .get(
    "/graph/entities/:kind/:value/expand",
    async ({ params, query, set }) => {
      const kind = (params as { kind?: string }).kind ?? "";
      if (!isEntityKind(kind)) {
        set.status = 400;
        return { error: "unknown entity kind", allowed: ENTITY_KINDS };
      }

      const rawValue = (params as { value?: string }).value ?? "";
      let value: string;
      try {
        value = decodeURIComponent(rawValue);
      } catch {
        // Malformed percent-encoding — fall back to the raw segment.
        value = rawValue;
      }

      const rawLimit = (query as { limit?: unknown } | undefined)?.limit;
      const limit =
        rawLimit != null && Number.isFinite(Number(rawLimit))
          ? Math.max(1, Math.min(100, Math.trunc(Number(rawLimit))))
          : 20;

      try {
        const expansion = await expandEntity({ kind, value, limit });
        return { kind, value, limit, expansion };
      } catch (error) {
        logger.error(
          { err: error, kind, value, limit },
          "research_brain_graph_entities_expand_failed",
        );
        set.status = 500;
        return { error: "internal_error" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  );
