import { Elysia } from "elysia";
import { authResolver } from "../middleware/authResolver";
import { getServiceClient } from "../db/client";
import logger from "../utils/logger";

/**
 * Conversations Route - Authenticated, user-scoped chat history reads.
 *
 * These endpoints replace the browser's previous direct Supabase reads (which
 * relied on permissive `USING (true)` RLS policies and the public anon key,
 * exposing every user's history). Reads now go through the service role
 * (getServiceClient, bypasses RLS) and are ALWAYS scoped to the authenticated
 * userId resolved by authResolver.
 *
 * Endpoints:
 * - GET /api/conversations                          -> list the user's conversations (excludes per-paper library chats)
 * - GET /api/conversations/:conversationId/messages -> messages for a conversation owned by the user
 * - GET /api/conversations/:conversationId/states   -> message-level states for a conversation owned by the user
 * - GET /api/conversations/:conversationId/state    -> persistent conversation_states row for a conversation owned by the user
 *
 * SECURITY: messages carry user_id and are filtered by it directly. states /
 * conversation_states have no user_id column, so ownership is verified against
 * the parent conversation (user_id = userId) before any state data is returned.
 */

// Reject malformed ids before they reach Postgres (an invalid uuid otherwise
// surfaces as a 500 with a raw DB error message).
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Verify that a conversation belongs to the given user.
 * Returns the conversation row (including conversation_state_id) when owned,
 * or null otherwise.
 */
async function getOwnedConversation(
  conversationId: string,
  userId: string,
): Promise<{ id: string; conversation_state_id: string | null } | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, conversation_state_id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    logger.warn(
      { err: error, conversationId },
      "conversation_ownership_check_failed",
    );
    return null;
  }

  return (data as { id: string; conversation_state_id: string | null }) || null;
}

export const conversationsRoute = new Elysia()
  // -------------------------------------------------------------------------
  // List the authenticated user's conversations (general sidebar)
  // -------------------------------------------------------------------------
  .get(
    "/api/conversations",
    async ({ request, set }) => {
      const userId = (request as any).auth?.userId as string | undefined;
      if (!userId) {
        set.status = 401;
        return { error: "Authentication required" };
      }

      try {
        const supabase = getServiceClient();
        const { data, error } = await supabase
          .from("conversations")
          .select("*")
          .eq("user_id", userId)
          .is("library_doc_id", null) // exclude per-paper library chats from the general sidebar
          .order("created_at", { ascending: false });

        if (error) throw error;
        return data || [];
      } catch (err: any) {
        logger.error({ err }, "list_conversations_failed");
        set.status = 500;
        return { error: "Failed to list conversations" };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )

  // -------------------------------------------------------------------------
  // Messages for a conversation owned by the user
  // -------------------------------------------------------------------------
  .get(
    "/api/conversations/:conversationId/messages",
    async ({ params, request, set }) => {
      const userId = (request as any).auth?.userId as string | undefined;
      if (!userId) {
        set.status = 401;
        return { error: "Authentication required" };
      }

      if (!isUuid(params.conversationId)) {
        set.status = 400;
        return { error: "Invalid conversation id" };
      }

      try {
        const supabase = getServiceClient();
        const { data, error } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", params.conversationId)
          .eq("user_id", userId)
          .order("created_at", { ascending: true }); // ascending for chat display

        if (error) throw error;
        return data || [];
      } catch (err: any) {
        logger.error(
          { err, conversationId: params.conversationId },
          "list_messages_failed",
        );
        set.status = 500;
        return { error: "Failed to list messages" };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )

  // -------------------------------------------------------------------------
  // Message-level states for a conversation owned by the user
  // -------------------------------------------------------------------------
  .get(
    "/api/conversations/:conversationId/states",
    async ({ params, request, set }) => {
      const userId = (request as any).auth?.userId as string | undefined;
      if (!userId) {
        set.status = 401;
        return { error: "Authentication required" };
      }

      if (!isUuid(params.conversationId)) {
        set.status = 400;
        return { error: "Invalid conversation id" };
      }

      // states has no user_id; verify ownership via the parent conversation.
      const conversation = await getOwnedConversation(
        params.conversationId,
        userId,
      );
      if (!conversation) {
        set.status = 404;
        return { error: "Conversation not found" };
      }

      try {
        const supabase = getServiceClient();
        const { data, error } = await supabase
          .from("states")
          .select("*")
          .eq("values->>conversationId", params.conversationId)
          .order("created_at", { ascending: true }); // chronological order

        if (error) throw error;
        return data || [];
      } catch (err: any) {
        logger.error(
          { err, conversationId: params.conversationId },
          "list_states_failed",
        );
        set.status = 500;
        return { error: "Failed to list states" };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  )

  // -------------------------------------------------------------------------
  // Persistent conversation_states row for a conversation owned by the user
  // -------------------------------------------------------------------------
  .get(
    "/api/conversations/:conversationId/state",
    async ({ params, request, set }) => {
      const userId = (request as any).auth?.userId as string | undefined;
      if (!userId) {
        set.status = 401;
        return { error: "Authentication required" };
      }

      if (!isUuid(params.conversationId)) {
        set.status = 400;
        return { error: "Invalid conversation id" };
      }

      // conversation_states has no user_id; verify ownership via the parent
      // conversation and reach the state only through conversation_state_id.
      const conversation = await getOwnedConversation(
        params.conversationId,
        userId,
      );
      if (!conversation) {
        set.status = 404;
        return { error: "Conversation not found" };
      }

      if (!conversation.conversation_state_id) {
        return null;
      }

      try {
        const supabase = getServiceClient();
        const { data, error } = await supabase
          .from("conversation_states")
          .select("*")
          .eq("id", conversation.conversation_state_id)
          .maybeSingle();

        if (error) throw error;
        return data || null;
      } catch (err: any) {
        logger.error(
          { err, conversationId: params.conversationId },
          "get_conversation_state_failed",
        );
        set.status = 500;
        return { error: "Failed to get conversation state" };
      }
    },
    { beforeHandle: authResolver({ required: true }) },
  );

export default conversationsRoute;
