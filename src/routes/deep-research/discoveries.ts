/**
 * Discoveries Routes for Deep Research (discovery-persistence v1, PR #2)
 *
 * GET /api/deep-research/conversations/:conversationId/discoveries
 *   - Returns the current (`is_current = true`) discoveries for a
 *     conversation, joined with their `research_discovery_evidence` rows.
 *   - Auth: `authResolver({ required: true })`. 401 on missing auth.
 *   - Ownership: returns 404 (not 403) on unknown / unowned conversation.
 *   - v1 ships `evidence[]` as `[]` for every row (PR #2 read migration
 *     will compute the real `evidence_archived` badge from the plan tree).
 *   - v1 does NOT expose `?versions=`, `?since=`, or `?group=`.
 *
 * Spec:     openspec/changes/discovery-persistence/specs/.../spec.md
 * Design:   openspec/changes/discovery-persistence/design/design.md §8
 */

import { Elysia } from "elysia";
import { getServiceClient } from "../../db/client";
import { getConversation } from "../../db/operations";
import { authResolver } from "../../middleware/authResolver";
import { getDiscoveriesForConversation } from "../../services/researchBrain/discoveryPersistence";
import type { AuthContext } from "../../types/auth";
import logger from "../../utils/logger";

// Use service client to bypass RLS - auth is verified by middleware.
const supabase = getServiceClient();

/**
 * Auth-gated discoveries route. Mounted in `src/index.ts` as
 * `.use(deepResearchDiscoveriesRoute)`.
 */
export const deepResearchDiscoveriesRoute = new Elysia().guard(
  {
    beforeHandle: [
      authResolver({
        required: true,
      }),
    ],
  },
  (app) =>
    app.get(
      "/api/deep-research/conversations/:conversationId/discoveries",
      discoveriesHandler,
    ),
);

/**
 * GET handler — read current discoveries for a conversation.
 *
 * v1 documented limitations (design.md §8.2):
 *   - `evidence[]` is always `[]` for every row. The route does not
 *     read the plan tree, so `evidence_archived` is left at its DB
 *     default (`false`).
 *   - No `?versions=`, `?since=`, `?group=` filters.
 */
async function discoveriesHandler(ctx: any) {
  const { params, set, request } = ctx;
  const { conversationId } = params;

  // Get authenticated user from auth context.
  const auth = (request as any).auth as AuthContext | undefined;
  const userId = auth?.userId;

  if (!userId) {
    set.status = 401;
    return {
      error: "Authentication required",
      message: "Valid authentication is required to read discoveries",
    };
  }

  if (!conversationId) {
    set.status = 400;
    return {
      error: "Missing conversationId",
      message: "conversationId must be provided in the route",
    };
  }

  // Ownership check: 404 (not 403) on unknown / unowned conversation.
  // This mirrors the pattern in /paper endpoints.
  let conversation;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    logger.warn(
      { err, conversationId },
      "discoveries_get_conversation_failed",
    );
    set.status = 404;
    return { error: "Conversation not found" };
  }

  if (conversation.user_id !== userId) {
    logger.info(
      { conversationId, userId, ownerId: conversation.user_id },
      "discoveries_get_unowned_conversation",
    );
    set.status = 404;
    return { error: "Conversation not found" };
  }

  // Fetch current discoveries + joined evidence.
  let rows;
  try {
    rows = await getDiscoveriesForConversation({ conversationId });
  } catch (err) {
    logger.error(
      { err, conversationId, userId },
      "discoveries_get_db_query_failed",
    );
    set.status = 500;
    return { error: "Failed to fetch discoveries" };
  }

  // Build task-id presence map for the orphan-archived badge.
  // The plan tree is in JSONB; we don't load it here (out of scope for
  // v1 verification). v1 returns `evidence_archived: false` always.
  // PR #2 (read migration) will compute the actual flag from the
  // plan tree at the route layer.
  const response = {
    discoveries: rows.map((row) => ({
      id: row.id,
      discoveryGroupId: row.discovery_group_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      supersedesDiscoveryId: row.supersedes_discovery_id,
      isCurrent: row.is_current,
      supersededAt: row.superseded_at,
      title: row.title,
      claim: row.claim,
      summary: row.summary,
      novelty: row.novelty,
      artifacts: row.artifacts,
      discoveryKey: row.discovery_key,
      reevalStatus: row.reeval_status,
      reevalNotes: row.reeval_notes,
      lastCheckedAt: row.last_checked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // PR #2 (read migration) will populate this from the plan tree in
      // JSONB. v1 returns [].
      evidence: [] as Array<{
        id: string;
        taskId: string;
        jobId: string | null;
        explanation: string;
        sourceUrl: string | null;
        evidenceArchived: boolean;
        createdAt: string;
      }>,
    })),
  };

  return response;
}

export default deepResearchDiscoveriesRoute;
