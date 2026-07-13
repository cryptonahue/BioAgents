-- Migration: link waitlist leads to real users, and give a request a lifecycle.
--
-- WHY THIS EXISTS
--
-- `waitlist_leads` (20260520000001) was a WRITE-ONLY DEAD END. Exactly one
-- statement in the codebase touched it — the INSERT in `src/routes/waitlist.ts`
-- — and NOTHING read it back. Someone who filled the form was invisible to the
-- admin, and someone who signed in through Privy was a stranger with no reason
-- attached to their wallet address. The two halves of the funnel could not see
-- each other, because there was nothing to join them ON.
--
-- Matching them after the fact means fuzzy-matching an email typed into a form
-- against an email (or a wallet, or neither) held by Privy. That heuristic is
-- exactly the thing this migration deletes: the request form now runs AFTER
-- Privy resolves, so identity is FIXED before the lead row is written, and the
-- lead can hang off a real foreign key.
--
-- WHAT THIS ADDS (additive only — no column is dropped, no column's type or
-- nullability changes, no row is deleted; the rollback at the foot restores the
-- previous schema exactly)
--
--   1. `user_id`  — FK to `public.users`, NULLABLE. Pre-existing rows were
--      captured before auth existed and have no user; they keep `NULL` and stay
--      readable. New rows always carry one.
--   2. `status`   — the request lifecycle.
--   3. Two indexes: one for the admin list's ordering, one that enforces
--      at most ONE request per user.
--
-- TWO STATES, NOT FIVE
--
-- `status` is `'pending' | 'approved'` and nothing else. The states are derived
-- from what the admin panel can actually DO, which is grant and revoke:
--
--   pending  — the user asked; an admin has not granted access.
--   approved — an admin granted access (`users.access_type = 'whitelisted'`).
--
-- There is no `rejected`, because there is no Reject button and no rejection
-- email; inventing the state would mean inventing a UI that renders it and a
-- rule for what a rejected user sees when they sign in again. Revoking sends the
-- row back to `pending`, which is the truth: they asked, and they do not have
-- access. If a real "denied, do not ask again" outcome is ever wanted, it is an
-- additive CHECK change and its own migration.
--
-- `status` is DERIVED state, not the source of truth. `users.access_type` is
-- still the ONLY thing the login gate in `src/routes/auth.ts` reads. This column
-- exists so the admin list can be filtered and ordered without a join back
-- through `users`, and so a request carries its own history. If the two ever
-- disagree, `users.access_type` wins.
--
-- THE `lower(email)` UNIQUE INDEX SURVIVES UNTOUCHED — AND SO DOES THE ORPHAN
--
-- `waitlist_leads_email_lower_idx` already exists and stays. It is why a user
-- who filled the OLD pre-auth form and then signs in with the SAME email cannot
-- simply be given a second row: the INSERT would raise 23505. The route ADOPTS
-- instead — it claims the orphan row (`user_id IS NULL`) onto the new `user_id`
-- with an UPDATE. See `src/routes/access-request.ts`; the partial unique index
-- below is what makes that adoption safe to retry.
--
-- `email` stays NOT NULL. A wallet-only Privy user genuinely has no email — but
-- the form is now POST-auth, so we ASK for one there, and we need it: it is the
-- channel the approval notification goes out on. Optional-email was only ever
-- tenable while nothing was ever sent.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) user_id — the join that did not exist.
--
-- ON DELETE SET NULL, not CASCADE: deleting a user should not silently destroy
-- the record of why they asked for access. The lead degrades back into exactly
-- what every pre-auth row already is — an orphan — which is a shape the admin
-- list and the adoption path both already handle.
-- ---------------------------------------------------------------------------
ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS user_id uuid
    REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.waitlist_leads.user_id IS
  'The authenticated user who submitted this request. NULL for rows captured by the old pre-auth waitlist form, and for rows whose user was deleted.';

-- ---------------------------------------------------------------------------
-- 2) status — pending | approved. See the header.
--
-- Backfilled to 'pending' for every existing row, which is accurate: none of
-- them were ever approved through this table, because nothing ever read it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.waitlist_leads
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'waitlist_leads_status_check'
  ) THEN
    ALTER TABLE public.waitlist_leads
      ADD CONSTRAINT waitlist_leads_status_check
      CHECK (status IN ('pending', 'approved'));
  END IF;
END
$$;

COMMENT ON COLUMN public.waitlist_leads.status IS
  'Request lifecycle: pending (asked, not granted) | approved (admin granted). Derived — users.access_type remains the authority for the login gate.';

-- ---------------------------------------------------------------------------
-- 3) Indexes.
--
-- (a) The admin list reads "pending requests, newest first" and joins each one
--     to its user. `(status, created_at DESC)` serves both the filter and the
--     ordering from one index.
--
-- (b) ONE REQUEST PER USER, enforced in the database rather than by a
--     read-then-write race in the route. PARTIAL, because `user_id` is nullable
--     and every pre-auth orphan holds NULL — a plain UNIQUE would be satisfied
--     by NULLs anyway under Postgres semantics, but stating the predicate makes
--     the intent explicit and keeps the index off the orphan rows entirely.
--
--     This is also what makes adoption idempotent: two concurrent submits from
--     the same user cannot both create a row, so the second one loses on the
--     index and the route reports "already submitted" instead of duplicating.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS waitlist_leads_status_created_idx
  ON public.waitlist_leads (status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_user_id_key
  ON public.waitlist_leads (user_id)
  WHERE user_id IS NOT NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK (nothing above is destructive — dropping these restores the previous
-- schema exactly, since no pre-existing column or index was modified):
--
--   DROP INDEX IF EXISTS public.waitlist_leads_user_id_key;
--   DROP INDEX IF EXISTS public.waitlist_leads_status_created_idx;
--   ALTER TABLE public.waitlist_leads
--     DROP CONSTRAINT IF EXISTS waitlist_leads_status_check;
--   ALTER TABLE public.waitlist_leads DROP COLUMN IF EXISTS status;
--   ALTER TABLE public.waitlist_leads DROP COLUMN IF EXISTS user_id;
-- ---------------------------------------------------------------------------
