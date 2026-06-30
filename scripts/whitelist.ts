/**
 * Whitelist management CLI.
 *
 * CoralGPT gates access via users.access_type === "whitelisted" (checked in
 * src/routes/auth.ts). New Privy users are created with access_type = null and
 * land on the "Access pending" screen. This script is the supported way to
 * grant/revoke that access without hand-editing the database.
 *
 * Usage:
 *   bun scripts/whitelist.ts --list                 # list users not yet whitelisted
 *   bun scripts/whitelist.ts <email|id|privyDID>    # grant access (-> "whitelisted")
 *   bun scripts/whitelist.ts --revoke <ident>       # revoke access (-> null)
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment (Bun
 * auto-loads .env; falls back to SUPABASE_ANON_KEY but the service key is
 * needed to bypass RLS). Uses the service role.
 */
import { getServiceClient } from "../src/db/client";

const WHITELISTED = "whitelisted";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  user_id: string | null;
  access_type: string | null;
  created_at?: string | null;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  bun scripts/whitelist.ts --list                 list users not yet whitelisted",
      "  bun scripts/whitelist.ts <email|id|privyDID>    grant access",
      "  bun scripts/whitelist.ts --revoke <ident>       revoke access",
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
    const { data, error } = await supabase
      .from("users")
      .select("id, email, username, user_id, access_type, created_at")
      .ilike("email", ident);
    if (error) throw new Error(error.message);
    rows = (data as UserRow[]) || [];
  } else {
    // Try Privy DID / external id (text column) first.
    const byPrivy = await supabase
      .from("users")
      .select("id, email, username, user_id, access_type, created_at")
      .eq("user_id", ident);
    if (byPrivy.error) throw new Error(byPrivy.error.message);
    rows = (byPrivy.data as UserRow[]) || [];

    // Fall back to the internal uuid id only when the input is a valid uuid.
    if (rows.length === 0 && UUID_REGEX.test(ident)) {
      const byId = await supabase
        .from("users")
        .select("id, email, username, user_id, access_type, created_at")
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

async function setAccess(ident: string, value: string | null): Promise<void> {
  const supabase = getServiceClient();
  const user = await findUser(ident);

  if (user.access_type === value) {
    console.log(
      `${label(user)} already ${value ?? "not whitelisted"} — no change.`,
    );
    return;
  }

  const { error } = await supabase
    .from("users")
    .update({ access_type: value })
    .eq("id", user.id);
  if (error) throw new Error(error.message);

  const verb = value === WHITELISTED ? "whitelisted" : "revoked (null)";
  console.log(`✓ ${label(user)} -> ${verb}`);
}

async function list(): Promise<void> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, email, username, user_id, access_type, created_at")
    .or(`access_type.is.null,access_type.neq.${WHITELISTED}`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const rows = (data as UserRow[]) || [];
  if (rows.length === 0) {
    console.log("No users pending — everyone is whitelisted.");
    return;
  }

  console.log(`pending (not whitelisted): ${rows.length}`);
  for (const u of rows) {
    const when = u.created_at ? ` (${u.created_at.slice(0, 10)})` : "";
    const at = u.access_type ? ` [access_type=${u.access_type}]` : "";
    console.log(`  - ${label(u)}${at}${when}`);
  }
}

async function main(): Promise<void> {
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
      await setAccess(ident, null);
    } else if (cmd.startsWith("-")) {
      console.error(`Unknown option: ${cmd}\n`);
      printUsage();
      process.exit(1);
    } else {
      await setAccess(cmd, WHITELISTED);
    }
  } catch (err: any) {
    console.error(`Error: ${err?.message || err}`);
    process.exit(1);
  }
}

main();
