/**
 * Admin role management CLI.
 *
 * BioAgents gates admin-only routes via a `role: "admin"` JWT claim (checked by
 * authResolver({ role: "admin" })). That claim is minted at login only for
 * users whose `users.role` column is "admin" (see src/routes/auth.ts). This
 * script is the supported, service-role way to grant/revoke that role without
 * hand-editing the database.
 *
 * Being an admin also implies app access: the login flow treats an admin as
 * whitelisted even if their access_type is still pending.
 *
 * Usage:
 *   bun scripts/grant-admin.ts --list                 # list current admins
 *   bun scripts/grant-admin.ts <email|id|privyDID>    # grant admin (role -> "admin")
 *   bun scripts/grant-admin.ts --revoke <ident>       # revoke admin (role -> "user")
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment (Bun
 * auto-loads .env; falls back to SUPABASE_ANON_KEY but the service key is
 * needed to bypass RLS). Uses the service role.
 */
import { getServiceClient } from "../src/db/client";

const ADMIN = "admin";
const USER = "user";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  user_id: string | null;
  role: string | null;
  created_at?: string | null;
};

const SELECT_COLS = "id, email, username, user_id, role, created_at";

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  bun scripts/grant-admin.ts --list                 list current admins",
      "  bun scripts/grant-admin.ts <email|id|privyDID>    grant admin",
      "  bun scripts/grant-admin.ts --revoke <ident>       revoke admin",
    ].join("\n"),
  );
}

function label(u: UserRow): string {
  return u.email || u.username || u.user_id || u.id;
}

/**
 * Resolve a single user by email, internal id, or Privy DID.
 * Returns the row, or throws a descriptive error on no/ambiguous match.
 */
async function findUser(ident: string): Promise<UserRow> {
  const supabase = getServiceClient();

  // Build the lookup query. Keep uuid and text columns separate so we never
  // cast a Privy DID (text) into the uuid `id` column.
  let rows: UserRow[] = [];

  if (ident.includes("@")) {
    // Case-insensitive exact match: escape LIKE wildcards so an operator
    // passing "adm%@x.com" can't accidentally match (and grant) a wrong user.
    const escaped = ident.replace(/([\\%_])/g, "\\$1");
    const { data, error } = await supabase
      .from("users")
      .select(SELECT_COLS)
      .ilike("email", escaped);
    if (error) throw new Error(error.message);
    rows = (data as UserRow[]) || [];
  } else {
    // Try Privy DID / external id (text column) first.
    const byPrivy = await supabase
      .from("users")
      .select(SELECT_COLS)
      .eq("user_id", ident);
    if (byPrivy.error) throw new Error(byPrivy.error.message);
    rows = (byPrivy.data as UserRow[]) || [];

    // Fall back to the internal uuid id only when the input is a valid uuid.
    if (rows.length === 0 && UUID_REGEX.test(ident)) {
      const byId = await supabase
        .from("users")
        .select(SELECT_COLS)
        .eq("id", ident);
      if (byId.error) throw new Error(byId.error.message);
      rows = (byId.data as UserRow[]) || [];
    }
  }

  if (rows.length === 0) {
    throw new Error(`No user found matching "${ident}".`);
  }
  if (rows.length > 1) {
    const list = rows.map((r) => `  - ${label(r)} (${r.id})`).join("\n");
    throw new Error(
      `Ambiguous: ${rows.length} users match "${ident}":\n${list}\n` +
        "Re-run with the exact id.",
    );
  }
  return rows[0];
}

/**
 * Set a user's role to one of the allowlisted values ("admin" | "user").
 * The value is a fixed literal from this script — never user input — so it can
 * never violate the users_role_check constraint.
 */
async function setRole(ident: string, value: typeof ADMIN | typeof USER): Promise<void> {
  const supabase = getServiceClient();
  const user = await findUser(ident);

  // Treat a null/absent role as the default "user".
  const current = user.role ?? USER;
  if (current === value) {
    console.log(`${label(user)} already role=${value} — no change.`);
    return;
  }

  const { data, error } = await supabase
    .from("users")
    .update({ role: value })
    .eq("id", user.id)
    .select("id");
  if (error) throw new Error(error.message);

  // Assert the write actually landed. An RLS-blocked update (e.g. running with
  // the anon key instead of the service key) returns no error but zero rows —
  // without this check the CLI would falsely report success.
  if (!data || data.length === 0) {
    throw new Error(
      `Update affected 0 rows for ${label(user)} — check SUPABASE_SERVICE_KEY (RLS may have blocked the write).`,
    );
  }

  const verb = value === ADMIN ? "granted admin" : "revoked (role=user)";
  console.log(`✓ ${label(user)} -> ${verb} (was ${current})`);
}

async function list(): Promise<void> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select(SELECT_COLS)
    .eq("role", ADMIN)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const rows = (data as UserRow[]) || [];
  if (rows.length === 0) {
    console.log("No admins yet.");
    return;
  }

  console.log(`admins: ${rows.length}`);
  for (const u of rows) {
    const when = u.created_at ? ` (${u.created_at.slice(0, 10)})` : "";
    console.log(`  - ${label(u)}${when}`);
  }
}

async function main(): Promise<void> {
  // This is a privilege tool: refuse to run against the anon key, whose RLS
  // policies would silently no-op writes. Fail loudly instead of misleading.
  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error(
      "Error: SUPABASE_SERVICE_KEY is required to manage admin roles (the anon key cannot bypass RLS).",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage();
    process.exit(cmd ? 0 : 1);
  }

  try {
    if (cmd === "--list" || cmd === "-l") {
      await list();
    } else if (cmd === "--revoke") {
      const ident = args[1];
      if (!ident) {
        printUsage();
        process.exit(1);
      }
      await setRole(ident, USER);
    } else if (cmd.startsWith("-")) {
      console.error(`Unknown option: ${cmd}\n`);
      printUsage();
      process.exit(1);
    } else {
      await setRole(cmd, ADMIN);
    }
  } catch (err: any) {
    console.error(`Error: ${err?.message || err}`);
    process.exit(1);
  }
}

main();
