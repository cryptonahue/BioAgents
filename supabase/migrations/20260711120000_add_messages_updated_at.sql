-- Add updated_at to messages.
--
-- messages is the only core table without it: users, conversations, states and
-- conversation_states all carry updated_at maintained by update_updated_at_column().
-- The question and the answer share a single messages row — the answer is written
-- later by updateMessage() once the LLM finishes — so without this column there is
-- no record of when the assistant actually replied. In deep research that gap is
-- minutes.
--
-- Existing rows are backfilled to created_at rather than to the migration time, so
-- historical messages keep an honest timestamp.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE;

UPDATE public.messages
  SET updated_at = created_at
  WHERE updated_at IS NULL;

ALTER TABLE public.messages
  ALTER COLUMN updated_at SET DEFAULT NOW();

DROP TRIGGER IF EXISTS update_messages_updated_at ON public.messages;

CREATE TRIGGER update_messages_updated_at
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
