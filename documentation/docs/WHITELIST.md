# Managing the CoralGPT Whitelist

CoralGPT gates access behind a manual whitelist. This guide explains how access
control works and how to grant or revoke it with the `whitelist` CLI.

## How access control works

Every CoralGPT user is a row in the `users` table with an `access_type` column.
Access is granted only when `access_type === "whitelisted"`.

```
┌──────────────┐   Privy login    ┌─────────────────────┐
│   New user   │ ───────────────▶ │ users row created   │
│ (email/wallet│                  │ access_type = null  │
│  /google)    │                  └──────────┬──────────┘
└──────────────┘                             │
                                             ▼
                          ┌──────────────────────────────────┐
                          │ POST /api/auth/privy checks        │
                          │ access_type === "whitelisted"      │
                          └───────────┬───────────┬────────────┘
                                      │           │
                              not whitelisted   whitelisted
                                      │           │
                                      ▼           ▼
                          ┌────────────────┐  ┌──────────────────┐
                          │ 403            │  │ BioAgents JWT     │
                          │ "Access        │  │ issued -> app     │
                          │  pending"      │  │ access granted    │
                          └────────────────┘  └──────────────────┘
```

New Privy users are created with `access_type = null` (see
`getOrCreatePrivyUser` in `src/db/operations.ts`) and land on the **Access
pending** screen. An operator must whitelist them before they can use the app.

The same `access_type === "whitelisted"` check also bypasses x402/b402 payment
gating (`src/middleware/x402/middleware.ts`, `src/middleware/b402/middleware.ts`),
so whitelisting both grants app access and exempts the user from payments.

## The `whitelist` CLI

`scripts/whitelist.ts` is the supported way to manage `access_type`. It uses the
Supabase service role and bypasses RLS, so run it where the service key is
available (the server host or any machine with the right env).

```bash
# List everyone who is not yet whitelisted (the onboarding queue)
bun run whitelist --list

# Grant access (sets access_type = "whitelisted")
bun run whitelist juan@example.com

# Revoke access (sets access_type = null)
bun run whitelist --revoke ana@example.com
```

You can also run it directly: `bun scripts/whitelist.ts <args>`.

### How a user is matched

The identifier you pass is resolved in this order:

| Input contains | Matched against | Notes |
|----------------|-----------------|-------|
| `@`            | `users.email`   | case-insensitive |
| anything else  | `users.user_id` (Privy DID) | exact match, e.g. `did:privy:...` |
| a valid UUID   | `users.id`      | fallback when no Privy DID matches |

The command **fails closed**: if no user matches, or more than one matches, it
prints an error and changes nothing. On an ambiguous match it lists the
candidates with their internal `id` so you can re-run with the exact id.

### Example session

```text
$ bun run whitelist --list
pending (not whitelisted): 2
  - juan@example.com (2026-06-28)
  - ana@example.com (2026-06-29)

$ bun run whitelist juan@example.com
✓ juan@example.com -> whitelisted

$ bun run whitelist --revoke ana@example.com
✓ ana@example.com -> revoked (null)
```

## Requirements

The CLI needs the Supabase service credentials in the environment (Bun
auto-loads `.env`):

```bash
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<service-role-key>
```

> **Note:** the service-role variable is `SUPABASE_SERVICE_KEY`, **not**
> `SUPABASE_SERVICE_ROLE_KEY`. If it is missing, the client falls back to
> `SUPABASE_ANON_KEY`, which is blocked by RLS and the update will fail. The CLI
> reports the error and exits non-zero rather than silently doing nothing.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No user found matching "..."` | The user has not logged in yet (no row), or the identifier is wrong | Have the user log in via Privy first, then re-run; or check the email/id |
| `Ambiguous: N users match` | Multiple rows share that email | Re-run with the exact `id` shown in the error |
| `Neither SUPABASE_SERVICE_KEY nor SUPABASE_ANON_KEY ... configured` | Env not loaded | Set `SUPABASE_SERVICE_KEY` (and `SUPABASE_URL`) |
| Update "succeeds" but access still pending | Used the anon key (RLS blocked the write) | Set `SUPABASE_SERVICE_KEY` to the service-role key |

## Admin role (`grant-admin` CLI)

A separate `users.role` column controls the **admin** privilege tier
(`'user'` by default, `'admin'` for admins). At login, an admin user is minted
a `role: "admin"` JWT claim — the exact claim that `authResolver({ role:
"admin" })` checks to gate admin-only routes. Normal users get **no** `role`
claim at all.

Admin implies access: an admin is treated as whitelisted at login even if their
`access_type` is still pending, so you do not need to whitelist someone
separately after granting them admin.

`scripts/grant-admin.ts` mirrors the `whitelist` CLI — same service-role client,
same email / id / Privy-DID resolution, same fail-closed behavior.

```bash
# List current admins
bun run grant-admin --list

# Grant admin (sets role = "admin")
bun run grant-admin juan@example.com

# Revoke admin (sets role = "user")
bun run grant-admin --revoke juan@example.com
```

You can also run it directly: `bun scripts/grant-admin.ts <args>`.

> **Re-login required:** role is baked into the JWT at login. A user granted (or
> revoked) admin must log out and log back in for the change to take effect in
> their token.

Security notes:

- The role value is allowlisted at two layers — a `users_role_check` database
  constraint (`'user' | 'admin'`) and the login only ever emitting the literal
  `"admin"`. User input is never interpolated into the role claim.
- The CLI uses the Supabase **service-role** client (server-side only), same as
  `whitelist`. It needs `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (see
  [Requirements](#requirements) above).

## Related

- [CORALGPT.md](CORALGPT.md) — CoralGPT product layer overview
- [AUTH.md](AUTH.md) — authentication (JWT, Privy, x402/b402)
