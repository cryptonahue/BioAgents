import { createClient } from "@supabase/supabase-js";

// These are injected at build time via Bun.build's define option
// They come from the .env file: SUPABASE_URL and SUPABASE_ANON_KEY
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing Supabase environment variables. Make sure SUPABASE_URL and SUPABASE_ANON_KEY are set in .env file.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------------
// Authenticated chat-history reads
//
// History (conversations/messages/states) is no longer read directly from
// Supabase with the public anon key. Those reads now go through the auth-gated
// BioAgents API, which uses the service role and scopes every query to the
// authenticated user. We carry the app JWT (when present) and the stable
// user id, matching the mechanism used by useChatAPI / useLibrary.
// ---------------------------------------------------------------------------

function getAuthToken(): string | null {
  return localStorage.getItem("bioagents_auth_token");
}

/**
 * Stable per-browser user id (same key as useSessions' getOrCreateDevUserId).
 * Sent as X-User-Id so that in AUTH_MODE=none (development) the server resolves
 * the same userId used for writes. When a JWT is present the server uses the JWT
 * identity and ignores this header.
 */
function getStableUserId(): string {
  let id = localStorage.getItem("dev_user_id");
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("dev_user_id", id);
  }
  return id;
}

function apiHeaders(userIdOverride?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  headers["X-User-Id"] = userIdOverride || getStableUserId();
  return headers;
}

async function apiGet<T>(path: string, userIdOverride?: string): Promise<T> {
  const res = await fetch(path, {
    headers: apiHeaders(userIdOverride),
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${path}`);
  }
  return (await res.json()) as T;
}

// Types matching backend schema
export interface User {
  id?: string;
  username: string;
  email: string;
  used_invite_code?: string;
  points?: number;
  has_completed_invite_flow?: boolean;
  invite_codes_remaining?: number;
}

export interface Conversation {
  id?: string;
  user_id: string;
  created_at?: string;
}

export interface Message {
  id?: string;
  conversation_id: string;
  user_id: string;
  question?: string;
  content: string;
  summary?: string; // Optional summary for agent messages
  state?: any;
  response_time?: number;
  source?: string;
  created_at?: string;
  // When the assistant's answer was written into the row. Absent on databases
  // that have not run the add_messages_updated_at migration yet.
  updated_at?: string;
  files?: any; // JSONB field for file metadata
}

// Client-side database operations (served via the auth-gated BioAgents API)
export async function getConversationsByUser(userId: string) {
  console.log("[supabase] Fetching conversations for user_id:", userId);

  const data = await apiGet<any[]>("/api/conversations", userId);

  console.log("[supabase] Found conversations for userId:", data?.length || 0);
  return data;
}

export async function getMessagesByConversation(
  conversationId: string,
  limit?: number,
  userId?: string
) {
  console.log("[supabase] Fetching messages for conversation_id:", conversationId);

  const data = await apiGet<any[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    userId,
  );

  // Preserve the previous `.limit(n)` behavior (first n in ascending order).
  const result = limit ? data.slice(0, limit) : data;

  console.log("[supabase] Found messages:", result?.length || 0);
  return result;
}

export async function createConversation(conversationData: Conversation) {
  const { data, error } = await supabase
    .from("conversations")
    .insert(conversationData)
    .select()
    .single();

  if (error) {
    // Ignore duplicate errors (code 23505)
    if (error.code === "23505") {
      return conversationData;
    }
    throw error;
  }
  return data;
}

export async function createMessage(messageData: Message) {
  const { data, error } = await supabase
    .from("messages")
    .insert(messageData)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getStatesByConversation(
  conversationId: string,
  userId?: string
) {
  // Chronological list of message-level states, scoped to the owning user.
  const data = await apiGet<any[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/states`,
    userId,
  );
  return data;
}

/**
 * Get the latest message-level state for a conversation (descending by
 * created_at). Returns null when the conversation has no states yet.
 */
export async function getLatestStateByConversation(
  conversationId: string,
  userId?: string
) {
  const states = await getStatesByConversation(conversationId, userId);
  if (!states || states.length === 0) return null;
  // States arrive in ascending order; the last one is the most recent.
  return states[states.length - 1];
}

/**
 * Get the conversation state (persistent research state) for a conversation
 * This contains the hypothesis, insights, datasets, suggested next steps, etc.
 * Returns null when the conversation has no persistent state.
 */
export async function getConversationState(
  conversationId: string,
  userId?: string
) {
  const data = await apiGet<any | null>(
    `/api/conversations/${encodeURIComponent(conversationId)}/state`,
    userId,
  );
  return data || null;
}
