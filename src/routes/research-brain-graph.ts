import { Elysia } from "elysia";
import { authResolver } from "../middleware/authResolver";
import {
  composeNeighborhood,
  ENTITY_KINDS,
  expandEntity,
  FocusNotFoundError,
  isEntityKind,
  NEIGHBORHOOD_DEFAULT_FANOUT,
  NEIGHBORHOOD_DEFAULT_LIMIT,
  NEIGHBORHOOD_MAX_FANOUT,
  NEIGHBORHOOD_MAX_LIMIT,
  searchCompounds,
  searchEntities,
  UnknownEntityKindError,
} from "../services/researchBrain/graphService";
import logger from "../utils/logger";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Focus discriminants accepted by `/graph/neighborhood`. */
const FOCUS_TYPES = ["entity", "compound", "source"] as const;
type FocusType = (typeof FOCUS_TYPES)[number];

function isFocusType(value: unknown): value is FocusType {
  return (
    typeof value === "string" && (FOCUS_TYPES as readonly string[]).includes(value)
  );
}

/** Parse an integer query param, clamped to `[1, max]`, `def` when absent. */
function parseBoundedInt(raw: unknown, def: number, max: number): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

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
 *       auth:         any authenticated caller (read-only)
 *       200 body:     { query, limit, expand, compounds: [...] }
 *       400 body:     { error: "missing query parameter q" }
 *                     { error: "q must be 1-100 characters" }
 *       401 body:     { error: "Authentication required" }   (authResolver)
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
    // READ-ONLY aggregate graph data — open to any authenticated caller
    // (was admin-only). This file must stay read-only (no mutations).
    { beforeHandle: authResolver({ required: true }) },
  )
  /**
   * KG v2 — entity mention graph read endpoints (PR #2 of
   * bioprospecting-knowledge-graph). Read-only, LLM-free, gated to any
 * authenticated caller.
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
    // READ-ONLY aggregate graph data — open to any authenticated caller
    // (was admin-only). This file must stay read-only (no mutations).
    { beforeHandle: authResolver({ required: true }) },
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
    // READ-ONLY aggregate graph data — open to any authenticated caller
    // (was admin-only). This file must stay read-only (no mutations).
    { beforeHandle: authResolver({ required: true }) },
  )
  /**
   * KG v3 — neighborhood endpoint (`graph-neighborhood-edges`).
   *
   *   - GET /graph/neighborhood
   *       query: type   (entity | compound | source, required)
   *              kind   (required iff type=entity; ENTITY_KINDS allowlist)
   *              value  (required iff type=entity; normalized entity key,
   *                      passed to expandEntity VERBATIM)
   *              id     (required iff type=compound|source; UUID)
   *              limit  (1-100, default 20)  — neighbors per class
   *              fanout (1-5,  default 3)    — neighbor expansions used for
   *                                            the induced edges
   *       auth:  any authenticated caller (read-only)
   *       200:   { focus, nodes, edges, meta }
   *       200:   focus node + zero edges when an entity value matches nothing
   *              (empty-not-error, mirrors /expand)
   *       400:   { error: "unknown focus type", allowed: [...] }
   *              { error: "unknown entity kind", allowed: [...] }
   *              { error: "missing query parameter value" }
   *              { error: "id must be a UUID" }
   *       404:   { error: "compound not found" | "source not found" }
   *       500:   { error: "internal_error" }
   *
   * The payload is composed ON THE FLY from `expandEntity`,
   * `getTopCoOccurring` and `buildCitationGraph`. No new table, no stored
   * edge, no refresh hook, no LLM, no write.
   */
  .get(
    "/graph/neighborhood",
    async ({ query, set }) => {
      const q = (query ?? {}) as Record<string, unknown>;

      const type = (q.type ?? "").toString().trim();
      if (!isFocusType(type)) {
        set.status = 400;
        return { error: "unknown focus type", allowed: FOCUS_TYPES };
      }

      const limit = parseBoundedInt(
        q.limit,
        NEIGHBORHOOD_DEFAULT_LIMIT,
        NEIGHBORHOOD_MAX_LIMIT,
      );
      const fanout = parseBoundedInt(
        q.fanout,
        NEIGHBORHOOD_DEFAULT_FANOUT,
        NEIGHBORHOOD_MAX_FANOUT,
      );

      // Discriminated param set: (kind, value) for an entity, (id) otherwise.
      if (type === "entity") {
        const kind = (q.kind ?? "").toString().trim();
        if (!isEntityKind(kind)) {
          set.status = 400;
          return { error: "unknown entity kind", allowed: ENTITY_KINDS };
        }
        const rawValue = (q.value ?? "").toString();
        let value: string;
        try {
          value = decodeURIComponent(rawValue);
        } catch {
          // Malformed percent-encoding — fall back to the raw param.
          value = rawValue;
        }
        if (!value.trim()) {
          set.status = 400;
          return { error: "missing query parameter value" };
        }

        try {
          return await composeNeighborhood({
            type: "entity",
            kind,
            value,
            limit,
            fanout,
          });
        } catch (error) {
          if (error instanceof UnknownEntityKindError) {
            set.status = 400;
            return { error: "unknown entity kind", allowed: ENTITY_KINDS };
          }
          logger.error(
            { err: error, type, kind, value, limit, fanout },
            "research_brain_graph_neighborhood_failed",
          );
          set.status = 500;
          return { error: "internal_error" };
        }
      }

      const id = (q.id ?? "").toString().trim();
      if (!id) {
        set.status = 400;
        return { error: "missing query parameter id" };
      }
      if (!UUID_RE.test(id)) {
        set.status = 400;
        return { error: "id must be a UUID" };
      }

      try {
        return await composeNeighborhood({
          type,
          id,
          limit,
          fanout,
        });
      } catch (error) {
        if (error instanceof FocusNotFoundError) {
          set.status = 404;
          return { error: `${error.focusType} not found` };
        }
        logger.error(
          { err: error, type, id, limit, fanout },
          "research_brain_graph_neighborhood_failed",
        );
        set.status = 500;
        return { error: "internal_error" };
      }
    },
    // READ-ONLY aggregate graph data — open to any authenticated caller.
    // This file must stay read-only (no mutations).
    { beforeHandle: authResolver({ required: true }) },
  );
