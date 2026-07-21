# CoralGPT

CoralGPT is a product layer built on top of the BioAgents deep-research framework, living on the `dev` branch. It adds an authentication gate (Privy login + whitelist), a public waitlist, and a paper Library with per-paper grounded RAG chat, while reusing the existing BioAgents infrastructure (auth middleware, database, queue, LLM adapters, embeddings). It is NOT a fork of the engine: there is no separate runtime, no duplicated server, and no rewritten agent pipeline. CoralGPT is a product skin and a set of additive routes that sit alongside the research engine.

---

## Architecture at a glance

The codebase now contains TWO separate agent systems. Understanding that they are distinct — and where they touch — is the key mental model for working in this repo.

**Deep-research system (`src/agents/*`)** — the original, fixed, hand-orchestrated pipeline: `planning -> literature -> hypothesis -> reflection -> reply`. Each mini-agent reads the world state and updates specific fields. These agents call LLMs through the shared `src/llm/provider.ts` `LLM` abstraction, which dispatches to provider adapters in `src/llm/adapters/` (`anthropic`, `google`, `openai`, `openrouter`).

**chat-agent system (`src/chat-agent/*`)** — a newer, self-contained tool-calling loop. The model is given a set of tools (registered in `src/chat-agent/registry.ts`) and decides which to call across iterations until it produces a final answer. This system is decoupled from `src/llm/*` and talks to providers directly.

> IMPORTANT and counter-intuitive: the chat-agent loop is hand-rolled. It is NOT built on the OpenAI Agents SDK. The unused `@openai/agents` dependency has been removed from `package.json` (it was declared but never imported). A single control loop (`src/chat-agent/agent-loop.ts`) drives both providers through a `ChatProvider` adapter (`src/chat-agent/providers/`: `anthropic-provider.ts` for the Anthropic SDK, `openai-provider.ts` for the OpenRouter/OpenAI-compatible wire format).

The two systems intersect at exactly ONE seam: the `literature_search` tool (`src/chat-agent/tools/literature-search.ts`), which wraps `literatureAgent` from `src/agents/literature`. That is the only place the tool-calling loop reaches back into the deep-research engine.

```
┌──────────────────────────────────────────────────────────────────────┐
│                         BioAgents runtime                             │
│                                                                        │
│  Deep-research system (src/agents/*)                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ planning │─▶│literature│─▶│hypothesis│─▶│reflection│─▶│ reply  │  │
│  └──────────┘  └────┬─────┘  └──────────┘  └──────────┘  └────────┘  │
│                     │ uses src/llm/provider.ts (LLM)                  │
│                     │   adapters: anthropic·google·openai·openrouter  │
│                     │                                                  │
│                     ▲  shared seam: literature_search tool            │
│                     │  (src/chat-agent/tools/literature-search.ts     │
│                     │   wraps literatureAgent)                         │
│  chat-agent system  │  (src/chat-agent/*)                             │
│  ┌──────────────────┴───────────────────────────────────────────┐    │
│  │ tool-calling loop  ── runner.ts                               │    │
│  │   ├─ agent-loop.ts      (single control loop)                 │    │
│  │   └─ providers/         (Anthropic / OpenAI adapters)         │    │
│  │ hand-rolled (NOT the OpenAI Agents SDK)                       │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Authentication (Privy)

CoralGPT adds Privy as a third authentication path, coexisting with the existing JWT and password/none modes. All three are reconciled in `src/routes/auth.ts`.

| Mode | Endpoint | Trigger | Result |
|------|----------|---------|--------|
| Privy | `POST /api/auth/privy` | `PRIVY_APP_ID` + `PRIVY_APP_SECRET` set | Whitelist check → 24h BioAgents JWT or 403 |
| Password / none | `POST /api/auth/login` | legacy dev mode | JWT for shared dev user, or no-auth passthrough |

### Privy flow (`POST /api/auth/privy`)

1. Verifies the Privy access token via `src/services/privy-auth.ts` (`verifyPrivyAccessToken`, backed by `@privy-io/server-auth`'s `PrivyClient.verifyAuthToken`).
2. Fetches the full Privy user (`fetchPrivyUser`) and extracts email and wallet address from `linkedAccounts`.
3. Calls `getOrCreatePrivyUser` (`src/db/operations.ts`) to upsert the local user row.
4. Checks `user.access_type === "whitelisted"`.
   - Whitelisted → mints an HS256 BioAgents JWT (`type: "ui_session"`, 24h expiry) signed with `BIOAGENTS_SECRET`, returned to the client.
   - Not whitelisted → `403` with `{ whitelisted: false, message: "Access pending approval" }`.

The minted token is the SAME kind of JWT the rest of the API already validates, so once issued the user flows through `authResolver` like any other authenticated caller.

### Password / none flow (`POST /api/auth/login`)

Legacy dev convenience. If `UI_PASSWORD` is unset, the endpoint issues a JWT for a hardcoded shared dev user id `550e8400-e29b-41d4-a716-446655440000` (so conversation history persists in development). If `UI_PASSWORD` is set, the supplied password must match before a token is issued.

### Enable flag

There is no explicit `CORALGPT_ENABLED` flag. `isCoralGptEnabled()` is implicitly `isPrivyConfigured()` — it returns true whenever both `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are present. Presence of the Privy credentials is what turns the product gate on.

```
┌────────┐   getAccessToken()   ┌────────────────────────┐
│ Client │ ───────────────────▶ │ Privy (hosted login)   │
└───┬────┘                       └────────────────────────┘
    │  accessToken
    │  POST /api/auth/privy
    ▼
┌──────────────────────────────────────────────┐
│ BioAgents /api/auth/privy                     │
│  verifyPrivyAccessToken → fetchPrivyUser      │
│  getOrCreatePrivyUser                          │
│  access_type === "whitelisted" ?               │
└───┬───────────────────────────────┬───────────┘
    │ yes                           │ no
    ▼                               ▼
 BioAgents JWT (ui_session, 24h)  403 "Access pending approval"
 signed with BIOAGENTS_SECRET
```

### Whitelist reality

`access_type='whitelisted'` is READ to grant access and is WRITTEN by the `whitelist` CLI (`scripts/whitelist.ts`): `bun run whitelist <email>` to grant, `--list` to see pending users, `--revoke` to remove access. There is no admin HTTP endpoint or UI for this — the CLI was chosen because the `/admin` basic-auth guard only registers in job-queue mode. See [WHITELIST.md](WHITELIST.md) for the full guide.

---

## Access flow — one door

There is ONE entry point. The landing's `Get started` runs Privy; the system then decides what you see. There is no separate "Sign in", and no pre-auth waitlist form.

```
[Get started] -> Privy (email | wallet | google) -> users row (identity FIXED here)
                                                          |
                    +-------------------------------------+---------------------+
               whitelisted?                        already requested?       no request
                    |                                      |                     |
                   YES                                    YES                   NO
                    |                                      |                     |
                  /chat                        "Request under review"     3-step request form,
                                                                          PREFILLED from Privy
                                                                                 |
                                                                          waitlist_leads
                                                                           (user_id FK)
                                                                                 |
                                                              Admin panel -> [Grant]
                                                                                 |
                                                                access_type='whitelisted'
                                                                     + approval email
```

**Why identity comes first.** The old flow had two disconnected halves: a public form writing `waitlist_leads` (a table NOTHING read) and a Privy sign-in that 403'd into a dead end. Joining them after the fact would mean fuzzy-matching a typed email against a Privy email/wallet. Establishing identity BEFORE the form deletes that problem: the request hangs off a real `user_id` foreign key, and the form is prefilled from the Privy identity.

### `POST /api/access-request`

Replaces the old public `POST /api/waitlist`. Same nine form fields, plus an `accessToken`.

**It is deliberately NOT behind `authResolver`.** A pending user holds no JWT — `/api/auth/privy` refuses to mint one for them. Issuing a limited "pending" JWT would be a privilege escalation: `authResolver({ required: true })` accepts ANY token that verifies against `BIOAGENTS_SECRET` and does not inspect a `type` claim, so such a token would be honoured by `/api/chat`, `/api/library` and every other guarded route. So the route verifies the **Privy token directly** (`verifyPrivyAccessToken`) — a cryptographic identity with no BioAgents session credential minted before approval. The user is resolved from the token and nothing else; a `userId` in the body is never read.

**The duplicate-email case is handled by ADOPTION.** `waitlist_leads` still carries `UNIQUE INDEX ON (lower(email))`, so a user who filled the OLD pre-auth form and then signs in with the same address is a live collision. An orphan row (`user_id IS NULL`) with a matching email is CLAIMED onto the authenticated user via `UPDATE ... WHERE email = ? AND user_id IS NULL` — the `user_id IS NULL` predicate is what stops it stealing a row from another account. The row keeps its original `created_at`. A row owned by a *different* user is a `409`, never a `500`.

`/api/auth/privy` reports `{ whitelisted: false, hasRequest, email, walletAddress }` on its 403, so the client knows in one call whether to render the form or the review notice.

### Approval email

Granting access does three things, in this order, and the order is the design:

1. `UPDATE users SET access_type = 'whitelisted'` — the grant. **Commits.**
2. `UPDATE waitlist_leads SET status = 'approved'` — derived state.
3. `POST https://api.resend.com/emails` — the notification.

Steps 2 and 3 run **after** step 1 has already committed. Neither can roll it back, and `sendApprovalEmail()` never throws (`src/services/mailer.ts`) — an unconfigured key, a 429, a 500, or a dead network all come back as a value. **An approval that rolls back because a mail server hiccuped is strictly worse than an approval with no email.** If the mail fails, the admin is told (`email: { sent: false, reason }` in the response, rendered in the panel) so they can follow up by hand.

The mailer calls the Resend REST API with plain `fetch` — no SDK, no SMTP transport, and therefore no module-scope client to trip Bun's worker TDZ hazard. With `RESEND_API_KEY` unset it degrades to a logged no-op; nothing about mail is required for the app to boot.

| Env var | Required | Purpose |
|---------|----------|---------|
| `RESEND_API_KEY` | no | **The feature switch.** Unset -> mailer disabled, every send is a logged no-op. Never logged. |
| `RESEND_FROM` | no | The **verified** sender, e.g. `CoralGPT <no-reply@yourdomain>`. Resend rejects an unverified domain, so the mailer stays off until this is set too. |
| `CORALGPT_APP_URL` | no | Sign-in link in the email. Defaults to `https://coralgpt.xyz`. |

---

## Library feature

The Library is the largest new piece of CoralGPT (`src/routes/library.ts`, ~588 lines). It is a read-only paper library plus per-paper grounded RAG chat. Papers are sourced from files in `KNOWLEDGE_DOCS_PATH` (default `docs`) that have already been chunked and embedded into the `documents` table by the ingestion pipeline.

All Library endpoints use `authResolver({ required: false })`, so they respond to both authenticated and unauthenticated callers. The `docId` for a paper is `base64url(title)`, where the title equals the original filename.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/library` | ONE PAGE of papers, searched/filtered/sorted in Postgres. See the contract below. |
| `GET /api/library/facets` | The filter vocabulary: `{ taxa, geography, years, trustTiers }`, each `{ value, count }`. Global (not cross-filtered), so the client fetches it once per page load. |
| `GET /api/library/:docId` | Single-paper metadata: reconstructs full text from chunks, estimates tokens (`len / 4`), regex-scrapes a DOI from the first 20k chars, uses the first 600 chars as an abstract. |
| `GET /api/library/:docId/file` | Streams the original file for the iframe PDF viewer. Path-traversal guarded by `resolveDocFilePath` (basename + root-prefix check). Overrides `X-Frame-Options` to `SAMEORIGIN` so the SPA viewer can embed it. |
| `POST /api/library/:docId/ask` | RAG core (grounded Q&A). See modes below. |
| `GET /api/library/:docId/history` | Per-user persisted chat for a paper. |

### `GET /api/library` — the paged list

```
GET /api/library
  ?q=          free text; token-AND across title, structured title, publisher, taxa, geography
  &taxon=      exact organism   (values from /api/library/facets)
  &geography=  exact place      (values from /api/library/facets)
  &year=       exact publication year
  &trustTier=  exact trust tier
  &sort=       year | evidence | title     (default: year)
  &dir=        asc | desc                  (default: desc)
  &page=       1-based                     (default: 1)
  &pageSize=   1-100                       (default: 25)

200 -> {
  papers: [{ docId, title, type, size, chunkCount, evidenceCount, researchSourceId,
             doi, doiUrl, year, publisher, metaTitle, trustTier,
             bioprospectingFactCount, taxa[], geography[] }],
  total, page, pageSize, totalPages,
  query: { q, taxon, geography, year, trustTier, sort, dir }   // what the server ACTUALLY ran
}
```

Optional fields are **omitted, not nulled**. `evidenceCount: 0` is a real, meaningful state: the paper is ingested but the Research Brain extracted no citable claim from it, so the agent cannot cite it. The UI renders that differently from a rich paper.

**The aggregation is in the database.** `GET /api/library` used to call `VectorSearchWithDocuments.listDocuments()`, which read **every chunk row in the corpus** (paging around PostgREST's 1000-row `db-max-rows` cap) and rebuilt the paper list in memory, then read every `research_sources` and `research_bioprospecting_facts` row to enrich it — O(chunks), not O(papers). A 1000-paper corpus moved tens of thousands of rows to render 25.

It now reads one page of `public.library_papers`, a live view with one row per paper (chunk aggregate ⋈ research source ⋈ claim count ⋈ bioprospecting taxa/geography), through the `library_list_papers()` RPC. See `supabase/migrations/20260712000000_library_papers_view.sql` and `src/services/library/db.ts`. The view is **live, not materialized**, deliberately: a matview would need a refresh hook on every ingest / upload / extract / delete path, and missing one would hide a freshly uploaded paper. If the corpus outgrows the live aggregate, promote it to a matview with a refresh hook (precedent: `research_graph_compound_aggregates`) — the JSON contract does not change.

### `POST /api/library/:docId/ask` modes

- **`full`** — used when the client passes `fullContext: true` AND the whole document fits under `LIBRARY_FULL_CONTEXT_MAX_TOKENS` (default `120000`). The entire document text is sent as context.
- **`rag`** — the default, and the fallback when a full-context document is too large. Runs `vs.search(question, { filterTitle, matchThreshold })` scoped to the single paper. `matchThreshold` defaults to `0` (via `LIBRARY_RAG_MIN_SIMILARITY`) so the best top-k chunks are returned regardless of absolute similarity — this deliberately keeps cross-lingual queries (e.g. a Spanish question against an English paper) from being dropped.

In both modes a strict grounded system prompt instructs the model to answer ONLY from the provided paper content and to emit inline `[n]` citations referencing the retrieved fragments. The LLM provider/model is chosen at request time by `resolveLibraryLLM`, which picks the first provider that has an API key configured (honoring `LIBRARY_LLM_PROVIDER` / `CHAT_AGENT_LLM_PROVIDER` if set), falling back across `anthropic`, `openrouter`, `openai`, `google`.

### History persistence

Per-paper chat reuses the existing `conversations` / `messages` tables, tagged with the new `conversations.library_doc_id` column (migration `20260531130000`). The `GET /history` endpoint returns turns for the calling user only. The user id comes from `request.auth?.userId`; if absent, history is returned empty and writes are skipped.

---

## Embeddings (OpenRouter + Qwen)

The embeddings layer lives in `src/embeddings/`. A factory, `createEmbeddingProvider()` (`src/embeddings/provider.ts`), selects the active provider from `EMBEDDING_PROVIDER`:

- `openai` (default) → `OpenAIEmbeddingProvider`
- `openrouter` → `OpenRouterEmbeddingProvider`, which is the same OpenAI client with the base URL swapped to `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), since OpenRouter exposes an OpenAI-compatible `/embeddings` API.

Both subclass `BaseOpenAIEmbeddingProvider`. Cohere is NOT an embedding provider here — it is rerank-only (`rerank-english-v3.0`).

`EMBEDDING_DIMENSIONS` is now env-configurable (it was previously hardcoded to `1536`; default remains `1536`). The base provider performs runtime dimension validation: it throws if the model returns a vector whose length does not equal `EMBEDDING_DIMENSIONS`, with a message telling you to update both the env var and the Supabase `documents.embedding` column.

### Optional Qwen 2560-dimension path

To run `qwen/qwen3-embedding-4b` via OpenRouter, the SQL helper `src/embeddings/setup-qwen-2560.sql` recreates `documents.embedding` as `vector(2560)` (and the matching RPC). Required env:

```bash
EMBEDDING_PROVIDER=openrouter
TEXT_EMBEDDING_MODEL=qwen/qwen3-embedding-4b
EMBEDDING_DIMENSIONS=2560
```

> WARNING: `setup-qwen-2560.sql` is DESTRUCTIVE. Its first statement is `DROP TABLE IF EXISTS documents CASCADE;` — running it wipes all ingested documents and dependent objects. Re-ingest after running it.

### Retrieval vs ingestion engines

- `src/embeddings/vectorSearch.ts` — the retrieval / rerank engine. It gained `filterTitle` and `matchThreshold` support, backed by the `match_documents_filtered` Postgres RPC (migration `20260531120000`) with an in-memory filtering fallback when the RPC is unavailable.
- `src/embeddings/vectorSearchWithDocs.ts` — ingestion plus library browsing. Provides `listDocuments`, `getDocumentChunks`, and `getFullDocument`, which the Library routes consume.

---

## The dual-engine flag matrix

A single chat request can be answered by two completely different engines depending on two independent env flags. This is critical to document because the behavior is asymmetric.

- **`USE_JOB_QUEUE`** chooses the delivery mode: queue mode (returns `202` + a `pollUrl`, processed by a worker) vs in-process mode (handled inline in the request). Read through `isJobQueueEnabled()` in `src/services/queue/connection.ts`.
- **`CHAT_AGENT_QUEUE_ENABLED`** only matters INSIDE the worker. It chooses the agent loop vs the legacy `planning / hypothesis / reflection` pipeline.

The asymmetry: in-process mode ALWAYS uses the chat-agent loop — `src/routes/chat.ts` calls `runChatAgent` unconditionally (line ~598). Queue mode uses the agent loop ONLY if `CHAT_AGENT_QUEUE_ENABLED=true` (`src/services/queue/workers/chat.worker.ts`, `useAgentLoop = process.env.CHAT_AGENT_QUEUE_ENABLED === "true"`); otherwise it runs the legacy pipeline.

| `JOB_QUEUE_ENABLED` | `CHAT_AGENT_QUEUE_ENABLED` | Engine that answers |
|---------------------|---------------------------|---------------------|
| `false` (in-process) | `false` | chat-agent loop |
| `false` (in-process) | `true` | chat-agent loop |
| `true` (queue) | `false` | legacy planning/hypothesis/reflection pipeline |
| `true` (queue) | `true` | chat-agent loop (in worker) |

> QA hazard: `CHAT_AGENT_QUEUE_ENABLED` is silently ignored in in-process mode, and in-process mode behaves like queue-mode-with-the-flag-on. Two deployments with identical `CHAT_AGENT_QUEUE_ENABLED` values can answer with different engines purely because of `JOB_QUEUE_ENABLED`. Always reason about both flags together when reproducing chat behavior.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PRIVY_APP_ID` | Privy app id. Presence (with secret) implicitly enables CoralGPT auth. |
| `PRIVY_APP_SECRET` | Privy app secret. Required for server-side token verification. |
| `BIOAGENTS_SECRET` | HS256 signing key for the BioAgents JWT minted after a successful Privy/whitelist check. |
| `UI_PASSWORD` | Legacy dev password gate for `POST /api/auth/login`. Unset → no-password dev token. |
| `CHAT_AGENT_LLM_PROVIDER` | Provider for the chat-agent loop (`anthropic` default, or `openrouter`). Also consulted by the Library LLM resolver. |
| `CHAT_AGENT_QUEUE_ENABLED` | Inside the worker: `true` → chat-agent loop, else legacy pipeline. Ignored in in-process mode. |
| `USE_JOB_QUEUE` | `true` → queue mode (`202` + pollUrl), else in-process inline handling. |
| `OPENROUTER_API_KEY` | API key for OpenRouter (chat-agent OpenRouter loop and OpenRouter embeddings). |
| `OPENROUTER_BASE_URL` | OpenRouter base URL (default `https://openrouter.ai/api/v1`). |
| `EMBEDDING_PROVIDER` | `openai` (default) or `openrouter`. |
| `TEXT_EMBEDDING_MODEL` | Embedding model id (default `text-embedding-3-small`). |
| `EMBEDDING_DIMENSIONS` | Expected embedding vector length (default `1536`; `2560` for the Qwen path). Validated at runtime. |
| `EMBEDDING_SEND_DIMENSIONS` | Whether to send the `dimensions` request param. Default: on for every provider except `openrouter`. Override `true`/`false`. |
| `KNOWLEDGE_DOCS_PATH` | Folder containing the original Library files (default `docs`). |
| `LIBRARY_FULL_CONTEXT_MAX_TOKENS` | Max estimated tokens before `full` mode falls back to `rag` (default `120000`). |
| `LIBRARY_MAX_TOKENS` | Max output tokens for a Library answer (default `2048`). |
| `CHAT_TOOL_TIMEOUT_MS` | Timeout for chat-agent tool execution. |

---

## Current state & known limitations

This is an honest, team-facing hardening backlog for the CoralGPT layer.

- **Data exposure (RLS) — RESOLVED.** Migration `20260531130000` had added `FOR SELECT TO anon, authenticated USING (true)` policies on `conversations`, `messages`, `states`, and `conversation_states`, letting any holder of the public anon key read all users' history. Migration `20260630120000` drops those policies and revokes all privileges from `anon`/`authenticated`; history is now served by authenticated, user-scoped endpoints in `src/routes/conversations.ts`. Note: under `AUTH_MODE=none` the userId still comes from a client `X-User-Id` header, so this is a real boundary only under `AUTH_MODE=jwt`.
- **Cost exposure (Library ask) — RESOLVED.** `POST /api/library/:docId/ask` now uses `authResolver({ required: true })` plus a per-user rate limit (`library` bucket), mirroring the main chat endpoint. Caveat: rate limiting is a no-op when the job queue (Redis) is disabled; the auth requirement is the protection that always applies.
- **Access granting — CLI only.** `access_type='whitelisted'` is written by `scripts/whitelist.ts` (see [WHITELIST.md](WHITELIST.md)). There is no admin HTTP endpoint or UI; granting requires shell/DB access to run the CLI.
- **History impersonation / silent loss.** Library history keys on `request.auth.userId`, which in dev modes can be a client-controlled `X-User-Id`, allowing one user to read another's paper chat. Conversely, in strict `jwt` mode an unauthenticated call receives a random UUID, so history silently never persists across requests.
- **Code duplication.** `src/chat-agent/loop.ts` and `src/chat-agent/loop-openrouter.ts` are ~90% duplicate. Provider/model resolution logic is duplicated across `src/chat-agent/runner.ts`, `src/services/queue/workers/chat.worker.ts`, and `src/routes/library.ts` (`resolveLibraryLLM`).
- **Missing fetch timeout.** The Anthropic loop (`loop.ts`) sets a `120_000` ms client timeout; `loop-openrouter.ts` has none, so an OpenRouter call can hang indefinitely.
- **Unverified hardcoded model ids.** `qwen/qwen3.6-plus` and `claude-sonnet-4-6` appear as fallback defaults in `runner.ts` and `resolveLibraryLLM`. Confirm these are real, current model ids before relying on the fallbacks.
- **Hardcoded Spanish copy.** `src/routes/library.ts` contains Spanish user-facing strings and a Spanish system prompt, even though the prompt also instructs the model to "respond in the same language as the question." The fixed-language copy should be localized or neutralized.
- **Embedding `dimensions` — RESOLVED.** The `dimensions` request param is now gated by `EMBEDDING_SEND_DIMENSIONS` (default: sent for every provider except `openrouter`, since OpenRouter does not document it and Qwen returns its native size). Override via the env var. The runtime length validation against `EMBEDDING_DIMENSIONS` is unchanged.
- **Public unthrottled waitlist write.** `POST /api/waitlist` has no rate limiting or CAPTCHA.

### Strengths

- The client UI is the most complete and polished part of CoralGPT: `coralgpt.css`, `library.css`, the Privy auth provider integration, and the Library split-pane viewer (PDF iframe + chat).
- The Library file route has a clean, defensible path-traversal guard (`resolveDocFilePath`: basename strip + root-prefix check).
- Retrieval degrades gracefully: `vectorSearch` falls back to in-memory filtering when the `match_documents_filtered` RPC is unavailable.
