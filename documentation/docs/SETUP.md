## Quick Start

### Prerequisites

- [bun](https://bun.sh/docs/installation) (required package manager)
- Node.js v23.3.0
- PostgreSQL database (we recommend Supabase for easy setup)

### 1. Install Dependencies

```bash
git clone https://github.com/bio-xyz/BioAgents.git
cd BioAgents
bun install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and configure the following:

#### Required: Core Configuration

**LLM Providers:**
Configure which LLM provider to use for each agent:

```bash
# Choose provider for each agent
REPLY_LLM_PROVIDER=openai          # or google, anthropic, openrouter
REPLY_LLM_MODEL=gpt-5.4

HYP_LLM_PROVIDER=openai
HYP_LLM_MODEL=gpt-5.4

PLANNING_LLM_PROVIDER=openai
PLANNING_LLM_MODEL=gpt-5.4

STRUCTURED_LLM_PROVIDER=openai
STRUCTURED_LLM_MODEL=gpt-5.4

# Add API keys for your chosen providers
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...              # If using Google
ANTHROPIC_API_KEY=...           # If using Anthropic
OPENROUTER_API_KEY=...          # If using OpenRouter
```

Deep Research agent selection is provider/model env-driven. The separate `/api/chat`
agent loop currently uses the Anthropic SDK directly via `CHAT_AGENT_MODEL`, so moving
that path to OpenAI requires code changes in addition to env changes.

**Database:**

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key  # Required for production with RLS
```

Get these from your [Supabase project settings](https://supabase.com/dashboard):
- `SUPABASE_URL` - Under Settings > API > Project URL
- `SUPABASE_ANON_KEY` - Under Settings > API > anon/public key
- `SUPABASE_SERVICE_KEY` - Under Settings > API > service_role key (keep this secret!)

**Important:** The `SUPABASE_SERVICE_KEY` is required when Row Level Security (RLS) is enabled on your database. The backend uses this key to bypass RLS since authentication is already verified by the auth middleware.

### 3. Set up the Database

**Run database migrations:**

```bash
bun run migrate
```

This will apply all schema migrations from `supabase/migrations/` including:
- Core tables (users, conversations, messages, states)
- Vector database setup (pgvector extension)
- x402 payment tracking
- All indexes, functions, and triggers

**Note:** Migrations run automatically in Docker on startup.

---

## Literature Agents Setup

Literature agents search and synthesize scientific literature. You can start with the basic KNOWLEDGE agent and add more advanced options later.

### KNOWLEDGE Agent (MVP - Easiest to Setup)

**Start here!** This is the easiest literature backend to set up and works with your own documents.

**Configuration:**

```bash
# Embedding provider for document vectorization
EMBEDDING_PROVIDER=openai
TEXT_EMBEDDING_MODEL=text-embedding-3-large

# Cohere reranker for better search results (optional but recommended)
COHERE_API_KEY=your-cohere-api-key
USE_RERANKING=true

# Vector search settings
VECTOR_SEARCH_LIMIT=20
RERANK_FINAL_LIMIT=5
SIMILARITY_THRESHOLD=0.45

# Document processing
KNOWLEDGE_DOCS_PATH=docs
CHUNK_SIZE=2000
CHUNK_OVERLAP=200
```

**Setup Steps:**

1. Get an OpenAI API key for embeddings (or use another embedding provider)
2. (Optional) Get a Cohere API key for reranking - improves results significantly
3. Place your knowledge base documents in the `docs/` directory
   - Supported formats: PDF, Markdown (.md), DOCX, TXT
4. Documents are automatically processed on server startup
5. Embeddings are stored in PostgreSQL with pgvector

**What you can do:** Search through your custom documentation, research papers, or domain-specific knowledge.

### OpenScholar Agent (Good Add-on)

Adds high-quality scientific literature search with peer-reviewed citations.

**Configuration:**

```bash
OPENSCHOLAR_API_URL=https://your-openscholar-deployment.com
OPENSCHOLAR_API_KEY=your-api-key
```

**Setup:**

1. Deploy OpenScholar: https://github.com/bio-xyz/bio-openscholar
2. Add API URL and key to `.env`

**What you gain:** Access to peer-reviewed scientific literature with proper citations.

**Research:** Based on https://arxiv.org/abs/2411.14199

### BioLiterature Agent (New)

Adds Bio's in-house scientific literature API search with rich answer (see `src/agents/literature/bio.ts`).

**Configuration:**

```bash
BIOLIT_API_URL=https://your-bioliterature-deployment.com
BIOLIT_API_KEY=your-api-key
PRIMARY_LITERATURE_AGENT=BIO  # optional; set to use BioLiterature as the primary deep-research agent
```

**Setup:**

1. Point the URL to your BioLiterature API instance
2. Add the URL and key to `.env`

**What you gain:** Direct access to the synthesized `answer` plus references/context for traceability.

### Edison Literature Agent (Amazing Add-on)

The most advanced literature search option with deep synthesis capabilities.

**Configuration:**

```bash
EDISON_API_URL=https://your-edison-deployment.com
EDISON_API_KEY=your-api-key
```

**Setup:**

1. Deploy Edison API: https://github.com/bio-xyz/bio-edison-api
2. Add API URL and key to `.env`

**What you gain:**

- Advanced literature synthesis
- Used in deep research mode for iterative investigation
- Best-in-class citation quality

---

## Analysis Agents Setup

⚠️ **Required for dataset processing:** You MUST configure at least one analysis agent (EDISON or BIO) to process uploaded datasets.

Both options are optional to configure, but if you want to upload and analyze datasets (CSV, Excel, etc.), you need one of them.

### Storage Setup (Required for Dataset Upload)

**Before configuring analysis agents, you need S3-compatible storage:**

```bash
STORAGE_PROVIDER=s3

# AWS S3
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
S3_BUCKET=your-bucket-name

# For S3-compatible services (DigitalOcean Spaces, MinIO, etc.)
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com  # Optional
```

**Setup Options:**

**Option 1: AWS S3**

1. Create an S3 bucket in AWS Console
2. Create IAM user with S3 access
3. Add credentials to `.env`

**Option 2: DigitalOcean Spaces**

1. Create a Space in DigitalOcean
2. Generate Spaces access key
3. Set `S3_ENDPOINT` to your region (e.g., `https://nyc3.digitaloceanspaces.com`)
4. Add credentials to `.env`

**Option 3: MinIO (Self-hosted)**

1. Deploy MinIO server
2. Create bucket
3. Set `S3_ENDPOINT` to your MinIO URL
4. Add credentials to `.env`

**Why you need this:** Uploaded datasets are stored in S3, then fetched and sent to analysis agents for processing.

> **For detailed documentation:** See [FILE_UPLOAD.md](./FILE_UPLOAD.md) for the complete file upload API, integration examples, and troubleshooting.

### Edison Analysis Agent (Default)

The default analysis backend with advanced capabilities.

**Configuration:**

```bash
EDISON_API_URL=https://your-edison-deployment.com
EDISON_API_KEY=your-api-key
```

**Setup:**

1. Deploy Edison API: https://github.com/bio-xyz/bio-edison-api
2. Add API URL and key to `.env`
3. Edison is used by default (no `PRIMARY_ANALYSIS_AGENT` setting needed)

**What it does:**

- Deep analysis of uploaded datasets
- Automatic file upload to Edison storage
- Code execution in secure sandbox
- Returns detailed analysis results with visualizations

### BIO Data Analysis Agent (Alternative)

Alternative analysis backend if not using Edison.

**Configuration:**

```bash
PRIMARY_ANALYSIS_AGENT=bio
DATA_ANALYSIS_API_URL=https://your-bio-analysis-deployment.com
DATA_ANALYSIS_API_KEY=your-api-key
```

**Setup:**

1. Deploy BIO analysis agent: https://github.com/bio-xyz/bio-data-analysis
2. Set `PRIMARY_ANALYSIS_AGENT=bio` in `.env`
3. Add API URL and key to `.env`

**What it does:**

- Basic data analysis capabilities
- Code execution in secure sandbox
- Returns analysis results

**Choose one:** You only need either Edison OR BIO for analysis - not both.

---

## Character Configuration

Your agent's personality and behavior are defined in `src/character.ts`. This is a simple system prompt that guides how your agent responds.

**Configuration:**

```typescript
const character = {
  name: "YourAgentName",
  system: `Your system prompt here...`,
};
```

**What to customize:**

- `name`: Your agent's name
- `system`: The system prompt that defines your agent's personality, expertise, and response style

The system prompt is automatically included in LLM calls for planning, hypothesis generation, and replies, ensuring consistent behavior throughout the research workflow.

**Example use cases:**

- Scientific research assistant with specific domain expertise
- Medical literature reviewer
- Data analysis expert
- Domain-specific research agent

---

## Authentication Setup

BioAgents supports multiple authentication methods:

| Mode | Use Case |
|------|----------|
| `AUTH_MODE=none` | Development (no auth required) |
| `AUTH_MODE=jwt` | Production (JWT tokens required) |
| `X402_ENABLED=true` | Pay-per-request with USDC |

### Quick Setup

**Development (no auth):**
```bash
AUTH_MODE=none
```

**Production (JWT):**
```bash
AUTH_MODE=jwt
BIOAGENTS_SECRET=your-secure-secret  # openssl rand -hex 32
```

**Pay-per-request (x402):**
```bash
X402_ENABLED=true
X402_PAYMENT_ADDRESS=0xYourWalletAddress
```

> **For detailed documentation:** See [AUTH.md](./AUTH.md) for JWT implementation examples, x402 payment protocol, and troubleshooting.

---

## Job Queue Setup (Production)

For production deployments, use the job queue for reliable async processing.

| Feature | In-Process (Default) | Job Queue |
|---------|---------------------|-----------|
| Setup | Simple | Requires Redis |
| Scaling | Single process | Horizontal scaling |
| Reliability | Request lost on crash | Jobs persist in Redis |
| Monitoring | Logs only | Bull Board dashboard |

### Quick Setup

```bash
# Enable job queue
USE_JOB_QUEUE=true
REDIS_URL=redis://localhost:6379
```

### Running with Job Queue

```bash
# Terminal 1: API Server
USE_JOB_QUEUE=true bun run dev

# Terminal 2: Worker
USE_JOB_QUEUE=true bun run worker
```

### Docker Deployment

```bash
# Start all services (API + Worker + Redis)
docker compose up -d

# Scale workers
docker compose up -d --scale worker=3
```

> **For detailed documentation:** See [JOB_QUEUE.md](./JOB_QUEUE.md) for architecture overview, WebSocket notifications, monitoring, scaling, and troubleshooting.

---

## Cost Guard Rails

External API spend (Mistral OCR, PubChem) is tracked in the
`daily_api_usage` Postgres table and capped via the
`record_api_call` RPC. Caps are env-driven; all default values
are safe for development. Per the spec, the cap-reader fails
closed: a missing env var defaults to `0`, which immediately
blocks any positive spend on that scope.

### Cap scope table

| Variable | Default | Provider | Scope | Reset |
| --- | --- | --- | --- | --- |
| `MISTRAL_OCR_DAILY_COST_CAP_USD` | `50` | mistral_ocr | per UTC day | UTC midnight |
| `MISTRAL_OCR_MONTHLY_COST_CAP_USD` | `1000` | mistral_ocr | rolling 30d | continuous |
| `MISTRAL_OCR_PER_SOURCE_COST_CAP_USD` | `2` | mistral_ocr | per `source_id` | per source |
| `MISTRAL_OCR_COST_PER_PAGE_USD` | `0.05` | mistral_ocr | per-page cost (USD) | n/a |
| `MISTRAL_OCR_COST_GUARD` | `true` | mistral_ocr | feature flag (kill switch for cost guard) | n/a |
| `PUBCHEM_DAILY_REQUEST_CAP` | `200000` | pubchem | per UTC day (units) | UTC midnight |
| `PUBCHEM_COST_GUARD` | `true` | pubchem | feature flag (kill switch for cost guard) | n/a |
| `COST_ALERT_HARD_BLOCK` | `true` | all | toggles hard-block on cap hit | n/a |
| `COST_ALERT_SOFT_THRESHOLD` | `0.8` | all | fraction of cap that triggers WARN | n/a |
| `MISTRAL_OCR_ENABLED` | `true` | mistral_ocr | global kill switch (short-circuits at module init) | n/a |
| `PUBCHEM_ENABLED` | `true` | pubchem | global kill switch (short-circuits at module init) | n/a |

### Behavior on cap hit

When a cap is hit, the orchestrator transparently falls back to
the `local` table extraction provider. The run continues; the
`extraction_provider='local'` column is set on the persisted rows
and a `mistral_disabled_today` WARN is logged. The
`globalThis.__mistralOcrDisabledToday__` flag short-circuits
subsequent calls in the same process until UTC midnight resets
the daily cap.

When `COST_ALERT_HARD_BLOCK=false`, a cap hit is logged but the
caller does NOT throw — useful for soft-cap operation.

### Soft-threshold WARN

A structured WARN (`event=cost_alert_soft_hit`) is emitted the
first time cumulative spend crosses
`COST_ALERT_SOFT_THRESHOLD` of the daily cap. The WARN is
idempotent within a UTC day via the
`daily_api_usage.last_cap_warn_at` column.

### PubChem day-cap behavior

PubChem is free in dollars but rate-limited; an IP ban is
triggered when the per-day request cap is exceeded. The
`PUBCHEM_DAILY_REQUEST_CAP` env var bounds the daily volume in
addition to the existing `RateGate` (per-second RPS). When the
day cap is hit, the `compoundAuthority` worker aborts the
current pass cleanly and persists
`summary.capHit='day'` on the run summary; the next scheduler
tick re-picks the same `pending` facts.

### Reading current spend

The `costService` module exposes read-side helpers:

- `getCurrentSpend({ provider, dayOrMonth })` — single
  provider's current day or rolling 30-day cost in USD.
- `getDailyTotals('24h' | '7d' | '30d', provider?)` — per-day,
  per-provider rows (admin surface).
- `getPerSourceTotals(sourceId)` — total USD and call count
  for a single source.
- `isProviderDisabled(provider)` — boolean state of the
  TDZ-safe `globalThis` provider-disabled flag.

These helpers soft-fail (return zeros / empty list) on DB
errors so they are safe to call from any code path.

### Admin drill-down

`GET /api/admin/cost-totals?since=24h|7d|30d&provider=mistral_ocr|pubchem|all`
returns per-(day, provider) totals with cap utilization columns
(`pctOfDailyCap`, `pctOfMonthlyCap`, `lastCapWarnAt`) and an
aggregate `capUtilization` block per provider (`peakDay`,
`averageDay`, `daysAt80pct`, `daysAt100pct`). The route is
gated by `authResolver({ required: true, role: 'admin' })`.

### WebSocket payload

The `run:api_call` notification carries `apiCost` and
`apiCallsCount`; the `ingestion:progress` notification gains
the same optional fields (omitted when no external spend has
been recorded). The bioprospecting extractor / worker fires
`notifyApiCallDelta` after each call so the dashboard updates
in near-real-time.

### Nightly GC

The worker process runs `DELETE FROM daily_api_usage WHERE
day < CURRENT_DATE - INTERVAL '35 days'` every 24 hours
(starting 30s after worker boot). The 35-day window preserves
two 30-day cap windows plus a 5-day clock-skew buffer. Set
`COST_GUARD_GC_ENABLED=false` to disable in environments where
`pg_cron` is doing the same job. Failures log
`cost_guard_gc_failed` and never crash the worker.

---

## Running the Application

### Development

**Simple mode (no job queue):**

```bash
bun run dev
```

**With job queue:**

```bash
# Terminal 1: API server
USE_JOB_QUEUE=true bun run dev

# Terminal 2: Worker
USE_JOB_QUEUE=true bun run worker:dev
```

### Production

**Simple mode:**

```bash
bun run start
```

**With job queue:**

```bash
# Using Docker (recommended)
docker compose up -d

# Or manually
USE_JOB_QUEUE=true bun run start    # Terminal 1
USE_JOB_QUEUE=true bun run worker   # Terminal 2
```

### Build UI

You need to rebuild the UI after making changes:

```bash
bun run build:client
```

The app will be available at `http://localhost:3000`

### Version Metadata

Every build injects the current version into both the backend and the frontend:

- **Backend** exposes `GET /api/version` (no auth) returning `{ version, sha, buildDate }`
- **Frontend Footer** shows `BioAgents v0.1.0 · abc1234 · 2026-06-16` at the bottom of the app
- The Footer fetches `/api/version` on load and falls back to build-time values if the server is unreachable
- If the bundled and server versions differ, the Footer shows a "⚠ version mismatch" badge

**For local dev** (no Docker): `client/build.ts` reads `package.json` and `git rev-parse --short HEAD` at build time automatically.

**For Docker rebuilds**: the `redeploy` script auto-injects `GIT_SHA` and `BUILD_DATE` as compose args:

```bash
bun run redeploy
# = GIT_SHA=$(git rev-parse --short HEAD) BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
#   docker compose build bioagents && docker compose up -d --force-recreate bioagents
```

To bump the version, edit the `"version"` field in `package.json` and rebuild.

---

## UI Development

The client is built with Preact and uses Bun for bundling.

**Watch mode (auto-rebuild):**

```bash
bun run client/build.ts --watch
```
