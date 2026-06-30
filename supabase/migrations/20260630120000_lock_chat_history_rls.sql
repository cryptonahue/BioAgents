-- Lock down chat history: stop the public anon key from reading every user's data.
--
-- Background: migration 20260531130000_chat_history_rls_and_library.sql added
-- `USING (true)` SELECT policies and `GRANT SELECT` for the anon + authenticated
-- roles on conversations/messages/states/conversation_states. Because the browser
-- uses the public anon key with no auth token attached, auth.uid() is always NULL
-- and the `USING (true)` policies effectively exposed ALL users' chat history to
-- anyone holding the public anon key.
--
-- This migration reverses that exposure. History reads are now served exclusively
-- through the authenticated BioAgents API (see src/routes/conversations.ts), which
-- uses the Supabase service role (getServiceClient, bypasses RLS) and scopes every
-- query to the authenticated userId resolved by the auth middleware.
--
-- RLS stays ENABLED on the tables. The service_role bypasses RLS, so server-side
-- reads/writes keep working; revoking the anon/authenticated grants plus dropping
-- the permissive policies closes the hole for the public key. The library_doc_id
-- column and its index (added by the prior migration) are intentionally left intact.
--
-- Note: the base schema (20251217123219_remote_schema.sql) issued `GRANT ALL` on
-- these tables to anon/authenticated. Today writes are blocked only because RLS is
-- enabled and no write policy exists -- a single guard. The browser no longer reads
-- OR writes these tables directly (all writes go through the service role), so we
-- revoke ALL privileges from the public roles as defense-in-depth: anon/authenticated
-- get no access even if RLS is ever disabled or a permissive policy is added later.

-- 1) Drop the permissive `USING (true)` SELECT policies.
DROP POLICY IF EXISTS "read_conversations_anon" ON conversations;
DROP POLICY IF EXISTS "read_messages_anon" ON messages;
DROP POLICY IF EXISTS "read_states_anon" ON states;
DROP POLICY IF EXISTS "read_conversation_states_anon" ON conversation_states;

-- 2) Revoke ALL base-table privileges from the public API roles (SELECT/INSERT/
--    UPDATE/DELETE). service_role keeps its own GRANT ALL and is unaffected.
REVOKE ALL PRIVILEGES ON conversations FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON messages FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON states FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON conversation_states FROM anon, authenticated;

-- 3) Keep RLS enabled (idempotent). service_role bypasses RLS for API reads/writes.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE states ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_states ENABLE ROW LEVEL SECURITY;
