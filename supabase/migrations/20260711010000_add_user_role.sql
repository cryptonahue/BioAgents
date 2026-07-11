-- Add a role column to public.users to support an admin privilege tier.
--
-- The login flow (src/routes/auth.ts) mints a `role: "admin"` JWT claim only
-- for users whose role is 'admin'. That claim is what authResolver({ role:
-- "admin" }) checks to gate admin-only routes. Until this column existed, no
-- user could ever be an admin because the claim was never set.
--
-- Idempotent + safe to re-run: the column add is guarded with IF NOT EXISTS
-- and the CHECK constraint is only created when it does not already exist.

BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

-- Allowlist the role values. Guarded so re-running the migration does not fail
-- on an already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_role_check'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_role_check
      CHECK (role IN ('user', 'admin'));
  END IF;
END
$$;

COMMENT ON COLUMN public.users.role IS
  'Privilege tier: ''user'' (default) or ''admin''. Admins receive a role="admin" JWT claim at login which gates admin-only routes via authResolver.';

COMMIT;
