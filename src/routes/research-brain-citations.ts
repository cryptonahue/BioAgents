/**
 * Citation graph read endpoints, mounted under
 * `/api/research-brain` from `src/index.ts`.
 *
 * Companion to `src/routes/research-brain-graph.ts` (which
 * serves the compound-centric knowledge graph search). This
 * module is the paper-to-paper related-work graph.
 *
 * v1 contract:
 *   - GET /citations/:sourceId
 *       path param:  sourceId (UUID, required)
 *       query param: limit (1..100, default 20)
 *       auth:        admin-only via authResolver
 *       200 body:    { sourceId, edges: [...], totalNeighbors, elapsed }
 *       400 body:    { error: "missing path parameter sourceId" }
 *       401 body:    { error: "Authentication required" }
 *       403 body:    { error: "Forbidden", message: "Admin role required" }
 *       404 body:    { error: "source not found" }      (only when DB confirms no row)
 *       500 body:    { error: "internal_error" }
 *
 * LLM-free. The citation graph is computed from SQL joins on
 * `research_bioprospecting_facts.compound_canonical_id`,
 * `species_taxon_id`, and the source's DOI. The endpoint does
 * not invoke the LLM at any point.
 */
import { Elysia } from "elysia";
import { authResolver } from "../middleware/authResolver";
import {
  buildCitationGraph,
  CITATION_GRAPH_DEFAULT_LIMIT,
  CITATION_GRAPH_MAX_LIMIT,
} from "../services/researchBrain/citationGraph";
import logger from "../utils/logger";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const researchBrainCitationsRoute = new Elysia({
  prefix: "/api/research-brain",
})
  .get(
    "/citations/:sourceId",
    async ({ params, query, set }) => {
      const sourceId = (params as { sourceId?: string }).sourceId;
      if (!sourceId) {
        set.status = 400;
        return { error: "missing path parameter sourceId" };
      }
      if (!UUID_RE.test(sourceId)) {
        set.status = 400;
        return { error: "sourceId must be a UUID" };
      }

      const rawLimit = (query as { limit?: unknown } | undefined)?.limit;
      const limit =
        rawLimit != null && Number.isFinite(Number(rawLimit))
          ? Math.max(1, Math.min(CITATION_GRAPH_MAX_LIMIT, Math.trunc(Number(rawLimit))))
          : CITATION_GRAPH_DEFAULT_LIMIT;

      try {
        const result = await buildCitationGraph({ sourceId, limit });
        if (!result.sourceFound) {
          set.status = 404;
          return { error: "source not found" };
        }
        return result;
      } catch (error) {
        logger.error(
          { err: error, sourceId, limit },
          "research_brain_citations_failed",
        );
        set.status = 500;
        return { error: "internal_error" };
      }
    },
    { beforeHandle: authResolver({ required: true, role: "admin" }) },
  );
