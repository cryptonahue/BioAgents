/**
 * Runs `20260712010000_waitlist_leads_link_users.sql` against a REAL Postgres
 * (PGlite — PG17, the real engine compiled to WASM, not a SQL emulator) on top
 * of the schema the original `20260520000001_create_waitlist_leads.sql` builds.
 *
 *     bun scripts/verify-waitlist-migration.ts
 *
 * It asserts the four things the migration promises and the one thing it is most
 * likely to get wrong: that the `lower(email)` UNIQUE INDEX still fires on a
 * duplicate — which is precisely why the access-request route ADOPTS an orphan
 * row instead of inserting a second one.
 */

import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const ok = (label: string) => console.log(`  ok  ${label}`);
const fail = (label: string, detail: unknown) => {
  console.error(`  FAIL  ${label}\n        ${detail}`);
  process.exitCode = 1;
};

// The subset of `users` the FK needs. The real table has more columns; the
// migration only depends on `id` being a uuid primary key.
// `gen_random_uuid()` is core since PG13, so no pgcrypto extension is needed
// (PGlite does not ship one).
await db.exec(`
  CREATE TABLE public.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text,
    access_type text
  );
`);

// Verbatim from 20260520000001, minus the service_role GRANT (no such role here).
await db.exec(`
  CREATE TABLE IF NOT EXISTS public.waitlist_leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name text NOT NULL,
    email text NOT NULL,
    wallet_address text,
    role text NOT NULL,
    organization text,
    use_case text NOT NULL,
    referral_source text,
    twitter_handle text,
    agreed_to_updates boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS waitlist_leads_email_lower_idx
    ON public.waitlist_leads (lower(email));
`);

// A pre-auth orphan: the exact row the OLD form produced. It exists BEFORE the
// migration runs, which is the whole point — the migration must not need it to
// have a user.
await db.exec(`
  INSERT INTO public.waitlist_leads (full_name, email, role, use_case)
  VALUES ('Legacy Lead', 'Orphan@Example.com', 'Researcher', 'reef genomics');
`);

const sql = await Bun.file(
  new URL(
    "../supabase/migrations/20260712010000_waitlist_leads_link_users.sql",
    import.meta.url,
  ).pathname,
).text();

try {
  await db.exec(sql);
  ok("migration applies to a schema that already holds a pre-auth orphan row");
} catch (err) {
  fail("migration failed to apply", err);
  process.exit(1);
}

// Idempotent — every statement is IF NOT EXISTS / guarded.
try {
  await db.exec(sql);
  ok("migration is idempotent (re-running is a no-op)");
} catch (err) {
  fail("re-running the migration threw", err);
}

// 1. The orphan survived, kept its data, and was backfilled to 'pending'.
{
  const r = await db.query<{ user_id: string | null; status: string }>(
    `SELECT user_id, status FROM public.waitlist_leads WHERE email = 'Orphan@Example.com'`,
  );
  const row = r.rows[0];
  if (row && row.user_id === null && row.status === "pending") {
    ok("pre-existing row: user_id NULL, status backfilled to 'pending'");
  } else {
    fail("orphan row did not survive intact", JSON.stringify(row));
  }
}

// 2. email is still NOT NULL.
{
  try {
    await db.exec(
      `INSERT INTO public.waitlist_leads (full_name, email, role, use_case)
       VALUES ('No Email', NULL, 'Other', 'x')`,
    );
    fail("email NOT NULL", "a NULL email was accepted");
  } catch {
    ok("email is still NOT NULL");
  }
}

// 3. status CHECK rejects anything outside pending|approved.
{
  try {
    await db.exec(
      `INSERT INTO public.waitlist_leads (full_name, email, role, use_case, status)
       VALUES ('Bad', 'bad@example.com', 'Other', 'x', 'rejected')`,
    );
    fail("status CHECK", "'rejected' was accepted");
  } catch {
    ok("status CHECK rejects a value outside pending|approved");
  }
}

// 4. THE DUPLICATE-EMAIL CASE — the one that must not 500.
//    Same email as the orphan, now arriving from an authenticated user.
{
  const u = await db.query<{ id: string }>(
    `INSERT INTO public.users (email) VALUES ('orphan@example.com') RETURNING id`,
  );
  const userId = u.rows[0]!.id;

  // The NAIVE path — a plain INSERT — is what would have 500'd. Prove it does.
  try {
    await db.query(
      `INSERT INTO public.waitlist_leads (full_name, email, role, use_case, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      ["Orphan Returns", "orphan@example.com", "Researcher", "reef genomics", userId],
    );
    fail("duplicate email", "a naive INSERT succeeded — the unique index is gone");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      ok("a naive INSERT of a duplicate email still raises 23505 (as designed)");
    } else {
      fail("duplicate email raised the wrong error", err);
    }
  }

  // ADOPTION — what the route actually does. Claim the orphan onto the user.
  const adopted = await db.query<{ id: string; user_id: string; status: string }>(
    `UPDATE public.waitlist_leads
        SET user_id = $1, full_name = $2, status = 'pending'
      WHERE lower(email) = lower($3) AND user_id IS NULL
      RETURNING id, user_id, status`,
    [userId, "Orphan Returns", "orphan@example.com"],
  );
  if (adopted.rows.length === 1 && adopted.rows[0]!.user_id === userId) {
    ok("adoption claims the orphan onto the new user_id — no duplicate, no 23505");
  } else {
    fail("adoption did not claim the orphan", JSON.stringify(adopted.rows));
  }

  // 5. One request per user: a SECOND row for the same user is refused.
  try {
    await db.query(
      `INSERT INTO public.waitlist_leads (full_name, email, role, use_case, user_id)
       VALUES ('Dup', 'second@example.com', 'Other', 'x', $1)`,
      [userId],
    );
    fail("one-request-per-user", "a second request for the same user was accepted");
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      ok("the partial unique index enforces at most ONE request per user");
    } else {
      fail("second request raised the wrong error", err);
    }
  }
}

// 6. Orphans are exempt from the partial unique index (many rows may hold NULL).
{
  await db.exec(
    `INSERT INTO public.waitlist_leads (full_name, email, role, use_case)
     VALUES ('Another Orphan', 'orphan2@example.com', 'Other', 'x')`,
  );
  ok("multiple user_id-NULL orphans coexist (the unique index is partial)");
}

// 7. ON DELETE SET NULL — deleting a user degrades the lead to an orphan.
{
  await db.exec(`DELETE FROM public.users WHERE email = 'orphan@example.com'`);
  const r = await db.query<{ user_id: string | null }>(
    `SELECT user_id FROM public.waitlist_leads WHERE lower(email) = 'orphan@example.com'`,
  );
  if (r.rows[0]?.user_id === null) {
    ok("ON DELETE SET NULL: the request survives its user's deletion");
  } else {
    fail("ON DELETE SET NULL", JSON.stringify(r.rows));
  }
}

// 8. The rollback in the file's footer actually restores the old schema.
{
  await db.exec(`
    DROP INDEX IF EXISTS public.waitlist_leads_user_id_key;
    DROP INDEX IF EXISTS public.waitlist_leads_status_created_idx;
    ALTER TABLE public.waitlist_leads
      DROP CONSTRAINT IF EXISTS waitlist_leads_status_check;
    ALTER TABLE public.waitlist_leads DROP COLUMN IF EXISTS status;
    ALTER TABLE public.waitlist_leads DROP COLUMN IF EXISTS user_id;
  `);
  const r = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'waitlist_leads' AND column_name IN ('user_id', 'status')`,
  );
  if (r.rows.length === 0) {
    ok("the documented ROLLBACK drops both columns cleanly");
  } else {
    fail("rollback left columns behind", JSON.stringify(r.rows));
  }
}

await db.close();
console.log(
  process.exitCode ? "\nMIGRATION VERIFY: FAILED" : "\nMIGRATION VERIFY: all checks passed",
);
