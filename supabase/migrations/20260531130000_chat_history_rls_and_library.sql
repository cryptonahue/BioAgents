-- Chat history: allow the browser (anon key) to read conversation history,
-- and add per-paper library chat support.
--
-- Background: the frontend reads conversations/messages/states directly from
-- Supabase using the anon key (see client/src/lib/supabase.ts). Writes happen
-- on the server with the service_role key, which bypasses RLS. Without a SELECT
-- policy for anon, RLS returns zero rows and the history always looks empty.

-- 1) Per-paper library chat: tag conversations that belong to a paper chat.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS library_doc_id text;
CREATE INDEX IF NOT EXISTS idx_conversations_library
  ON conversations(user_id, library_doc_id);

-- 2) Ensure base table privileges for the API roles.
GRANT SELECT ON conversations TO anon, authenticated;
GRANT SELECT ON messages TO anon, authenticated;
GRANT SELECT ON states TO anon, authenticated;
GRANT SELECT ON conversation_states TO anon, authenticated;

-- 3) Enable RLS (idempotent) and grant read access.
--    These are read-only policies; all writes go through the service role.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE states ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_states ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_conversations_anon" ON conversations;
CREATE POLICY "read_conversations_anon" ON conversations
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "read_messages_anon" ON messages;
CREATE POLICY "read_messages_anon" ON messages
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "read_states_anon" ON states;
CREATE POLICY "read_states_anon" ON states
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "read_conversation_states_anon" ON conversation_states;
CREATE POLICY "read_conversation_states_anon" ON conversation_states
  FOR SELECT TO anon, authenticated USING (true);
