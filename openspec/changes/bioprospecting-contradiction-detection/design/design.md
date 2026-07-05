# Technical Design: bioprospecting-contradiction-detection

## 1. Architecture Decision: Contradiction Detection Lives in the Existing `bioprospecting` Worker

**Decision**: Contradiction detection runs as a step inside the bioprospecting worker after `extractBioprospectingFactsForSource()` completes, NOT as a separate worker.

**Rationale**:
- The spec says the trigger is `bioprospecting:extraction:completed` — this is an internal event, not a job queue event. Publishing a new Redis pub/sub event and then enqueueing a new job adds unnecessary latency and failure points for something that is a post-processing step of the same logical operation.
- Contradiction detection is a lightweight read-then-write operation (query facts → detect → insert rows). It does not need the lock-duration or concurrency model of a separate worker.
- Running it as a step in the same worker keeps the flow atomic: if extraction succeeds but contradiction detection fails, the extraction result is still valid (contradiction detection can be re-run via `force: true`).
- The `ContradictionDetectionJobData` job type still exists in the spec — it is how the API can trigger a manual re-run (e.g., after a user resolves a contradiction and wants to re-check). The job enqueues to the same `bioprospecting` queue and is handled by the same worker.

**Alternative rejected (separate worker)**: Would require a new worker process, new queue registration, and inter-worker coordination via pub/sub for something that is essentially a post-processing step.

## 2. Trigger Mechanism: Internal Function Call + Optional Manual Job

The contradiction detection is triggered in two ways:

### A. Automatic (post-extraction step inside bioprospecting worker)

```typescript
// Inside bioprospecting.worker.ts — processBioprospectingJob()
const result = await extractBioprospectingFactsForSource(sourceId);

if (process.env.BIOPROSPECTING_CONTRADICTION_DETECTION === "true") {
  await runContradictionDetection({ sourceId, runId });
}
```

No Redis pub/sub required for the automatic path — the worker simply calls the detection function directly after extraction.

### B. Manual re-run via queue

```typescript
// ContradictionDetectionJobData enqueued when:
// - User triggers manual re-check from API
// - Flag BIOPROSPECTING_CONTRADICTION_DETECTION was set before extraction
//   but we want to re-run on existing facts
// - force: true to re-check even if already run for a source

interface ContradictionDetectionJobData {
  runId: string;
  sourceId: string;
  options?: {
    force?: boolean; // re-run even if already done for this source
  };
}
```

The `ContradictionDetectionJobData` is handled by the same bioprospecting worker — it detects the job type by shape (no `maxChunks`/`batchSize` fields) and routes accordingly.

## 3. Data Model: `research_bioprospecting_contradictions` Table

New migration file: `supabase/migrations/YYYYMMDDHHMMSS_create_bioprospecting_contradictions.sql`

```sql
CREATE TABLE IF NOT EXISTS public.research_bioprospecting_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES public.research_sources(id) ON DELETE CASCADE,
  source_fact_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  conflicting_fact_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  contradiction_type TEXT NOT NULL,
  evidence_pack JSONB NOT NULL DEFAULT '{}',
  rule_version TEXT,
  llm_version TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'unresolved',
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT no_self_reference CHECK (
    source_fact_id != conflicting_fact_id
  )
);

CREATE INDEX IF NOT EXISTS idx_contradictions_source
  ON public.research_bioprospecting_contradictions (source_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_fact_a
  ON public.research_bioprospecting_contradictions (source_fact_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_fact_b
  ON public.research_bioprospecting_contradictions (conflicting_fact_id);

CREATE INDEX IF NOT EXISTS idx_contradictions_type
  ON public.research_bioprospecting_contradictions (contradiction_type);

CREATE INDEX IF NOT EXISTS idx_contradictions_status
  ON public.research_bioprospecting_contradictions (resolution_status);

DROP TRIGGER IF EXISTS trigger_update_research_bioprospecting_contradictions_updated_at
  ON public.research_bioprospecting_contradictions;

CREATE TRIGGER trigger_update_research_bioprospecting_contradictions_updated_at
  BEFORE UPDATE ON public.research_bioprospecting_contradictions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_research_brain_updated_at();

GRANT ALL ON TABLE public.research_bioprospecting_contradictions
  TO anon, authenticated, service_role;
```

**Note on `source_id`**: Each contradiction row belongs to a `source_id` (the parent source of the extraction run). This enables listing contradictions per source. The row may contain facts from multiple sources — `source_id` is the context/source of the detection run, not a constraint on which sources the facts come from.

**Note on self-reference constraint**: The `no_self_reference` CHECK prevents inserting a row where both FKs point to the same fact.

## 4. Rule-Based Detection Logic

Implemented in `src/services/researchBrain/contradictionDetector.ts` — a pure function with no side effects, called by the worker.

### Matching Logic

Facts are matched on: `normalized(compound) == normalized(compound)` AND `normalized(bioactivity) == normalized(bioactivity)`.

Both fields must be non-null. Compound normalization uses the same `normalizeForMatch()` from `search.ts`.

### Contradiction Type: `measurement_direction`

Opposites defined as:

```typescript
const MEASUREMENT_DIRECTION_OPPOSITES: Record<string, string> = {
  agonist: "antagonist",
  antagonist: "agonist",
  activator: "inhibitor",
  inhibitor: "activator",
  upregulator: "downregulator",
  downregulator: "upregulator",
  increase: "decrease",
  decrease: "increase",
};
```

Two facts conflict if they have the same compound+target but `measurement_direction` values are opposites. Case-insensitive matching.

### Contradiction Type: `relation_type`

Opposites defined as:

```typescript
const RELATION_TYPE_OPPOSITES: Record<string, string> = {
  activates: "inhibits",
  inhibits: "activates",
  upregulates: "downregulates",
  downregulates: "upregulates",
  increases: "decreases",
  decreases: "increases",
};
```

Two facts conflict if they have the same compound+target but `relation_type` values are opposites. Case-insensitive matching.

### Deduplication

Before inserting, check if an identical contradiction already exists (same `source_fact_id`, `conflicting_fact_id`, `contradiction_type`). If exists, skip — do not create duplicate rows.

### Rule Version

Set `rule_version: "1.0"` on all rule-based detections.

## 5. LLM-Assisted Detection Pass

Runs **after** rule-based pass completes. Additive only — it does not replace rules.

### When it runs

- `BIOPROSPECTING_CONTRADICTION_DETECTION=true` AND
- LLM provider is available (checked via `resolveResearchBrainLLM()`)

If LLM unavailable, rule-based pass runs and system continues without LLM pass.

### Prompt Design

Facts are grouped by compound+bioactivity pair. For each group with 2+ facts:

```typescript
const prompt = `You are a scientific fact consistency checker for marine bioprospecting research.

Given a set of facts about the same compound-target interaction extracted from different sources,
identify any contradictions that are not detectable by simple string matching.

For each fact, you receive:
- compound: the molecule name
- bioactivity: the biological target/activity
- measurement_direction: e.g. agonist, antagonist, activator, inhibitor, increase, decrease
- relation_type: e.g. activates, inhibits, upregulates, downregulates
- result_summary: human-readable summary of the finding
- source_title: title of the paper
- page: page number in source

Check for contextual contradictions that rule-based detection would miss, such as:
- The same compound described as having opposite effects in different assay conditions
- Conflicting claims about whether a compound activates or inhibits the same target
- Numbers that are physically impossible or mutually exclusive (e.g., 1000% increase vs 5% decrease)

Return a JSON array of contradictions found. Each object:
{
  "sourceFactId": "uuid of first fact",
  "conflictingFactId": "uuid of second fact",
  "contradictionType": "contextual" | "measurement_impossibility" | "directional_conflict",
  "explanation": "why these two facts contradict each other"
}

If no contradictions, return [].

Facts:
${factsJson}

Respond only with the JSON array.`;
```

### Output Parsing

Parse JSON from LLM response using `extractJsonArray()`. For each returned contradiction, insert a row with:
- `llm_version: "1.0"`
- `rule_version: null`

### Async/Non-blocking Design

LLM calls are the slowest part. To avoid blocking the worker:
- LLM pass runs synchronously after rule-based pass within the same job handler
- Lock duration for bioprospecting worker is already 5 minutes (300s), which comfortably covers LLM-assisted detection for typical source sizes
- If LLM call times out, the rule-based results are already committed — the LLM pass failure is logged and does not roll back rule-based work
- Future enhancement: move LLM pass to a separate job enqueued after rule-based pass completes

## 6. API: New and Modified Endpoints

### Modified: `GET /api/research-brain/search`

The `EvidencePack` type is extended to include `contradictionWarnings`:

```typescript
// In types.ts — EvidencePack extended
export type EvidencePack = {
  // ... existing fields ...
  contradictionWarnings: EvidencePackContradiction[];
};

export type EvidencePackContradiction = {
  id: string;
  contradictionType: string;
  sourceA: {
    factId: string;
    claim: string;      // derived from fact's result_summary or quote
    sourceTitle: string | null;
    doi: string | null;
    value: string;      // the conflicting value (e.g., "agonist" or "antagonist")
    provenance: string; // "page X, chunk Y"
  };
  sourceB: {
    factId: string;
    claim: string;
    sourceTitle: string | null;
    doi: string | null;
    value: string;
    provenance: string;
  };
  conflictSummary: string;
  resolutionStatus: "unresolved" | "resolved" | "dismissed";
};
```

**Implementation in `search.ts`**: When building the evidence pack, after fetching `facts`, query `research_bioprospecting_contradictions` for any contradictions whose `source_fact_id` or `conflicting_fact_id` appears in the returned fact IDs. Map to `EvidencePackContradiction[]`.

```typescript
// In researchBrainSearch(), after fetching facts:
const factIds = facts.map(f => f.id);
const contradictions = await searchBioprospectingContradictions({ factIds });

// Then in building the EvidencePack:
const pack: EvidencePack = {
  // ... existing fields ...
  contradictionWarnings: contradictions.map(contradictionToWarning),
};
```

### New DB function: `searchBioprospectingContradictions`

```typescript
// In db.ts
export async function searchBioprospectingContradictions(params: {
  factIds: string[];
}): Promise<ResearchBioprospectingContradiction[]> {
  if (factIds.length === 0) return [];

  const { data, error } = await supabase
    .from("research_bioprospecting_contradictions")
    .select(
      "*, source:research_sources(*), source_fact:research_bioprospecting_facts(*), conflicting_fact:research_bioprospecting_facts(*)",
    )
    .or(`source_fact_id.in.(${factIds.join(",")}),conflicting_fact_id.in.(${factIds.join(",")})`)
    .eq("resolution_status", "unresolved");

  if (error) throw error;
  return (data || []) as ResearchBioprospectingContradiction[];
}
```

### New type: `ResearchBioprospectingContradiction`

```typescript
// In types.ts
export type ResearchBioprospectingContradiction = {
  id: string;
  source_id: string;
  source_fact_id: string;
  conflicting_fact_id: string;
  contradiction_type: string;
  evidence_pack: {
    source_a: { fact_id: string; source: string; value: string; provenance: string };
    source_b: { fact_id: string; source: string; value: string; provenance: string };
    conflict_summary: string;
  };
  rule_version: string | null;
  llm_version: string | null;
  resolution_status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};
```

### New endpoint: `POST /api/research-brain/contradictions/:id/resolve`

```typescript
// Route: POST /api/research-brain/contradictions/:id/resolve
// Body: { resolutionStatus: "resolved" | "dismissed", resolvedBy?: string }
// Updates resolution_status, resolved_by, resolved_at
```

### New endpoint: `GET /api/research-brain/sources/:sourceId/contradictions`

```typescript
// Route: GET /api/research-brain/sources/:sourceId/contradictions
// Returns all contradictions for a given source
// Query params: ?status=unresolved|resolved|dismissed|all (default: all)
```

## 7. Evidence Pack Response Changes

The `GET /api/research-brain/search` response now always includes `contradictionWarnings: []` (empty array if none). This field is never omitted.

Example response fragment:
```json
{
  "question": "...",
  "bioprospectingFacts": [...],
  "contradictionWarnings": [
    {
      "id": "uuid",
      "contradictionType": "measurement_direction",
      "sourceA": {
        "factId": "uuid",
        "claim": "Compound X activates target Y",
        "sourceTitle": "Study on Compound X",
        "doi": "10.xxxx/xxxxx",
        "value": "activator",
        "provenance": "page 3, chunk 12"
      },
      "sourceB": {
        "factId": "uuid",
        "claim": "Compound X inhibits target Y",
        "sourceTitle": "Comparative Study",
        "doi": "10.yyyy/yyyyy",
        "value": "inhibitor",
        "provenance": "page 7, chunk 3"
      },
      "conflictSummary": "Conflicting measurement_direction: activator vs inhibitor",
      "resolutionStatus": "unresolved"
    }
  ],
  "sources": [...]
}
```

## 8. Worker Job Routing

The bioprospecting worker handles two job shapes:

```typescript
// BioprospectingJobData — has maxChunks/batchSize
interface BioprospectingJobData {
  runId: string;
  sourceId: string;
  options?: { maxChunks?: number; batchSize?: number };
}

// ContradictionDetectionJobData — no extraction options, has runId
interface ContradictionDetectionJobData {
  runId: string;
  sourceId: string;
  options?: { force?: boolean };
}
```

Detection: if `job.data.maxChunks === undefined && job.data.batchSize === undefined`, route to contradiction detection handler. Otherwise route to extraction handler.

## 9. File Structure

```
src/services/researchBrain/
  contradictionDetector.ts   # Rule-based + LLM detection logic (pure functions)
  contradictionDb.ts         # DB operations for contradictions (upsert, search, resolve)
  types.ts                  # Extended with ResearchBioprospectingContradiction, EvidencePackContradiction

src/services/queue/workers/
  bioprospecting.worker.ts  # Extended: handle ContradictionDetectionJobData, call runContradictionDetection after extraction

supabase/migrations/
  YYYYMMDDHHMMSS_create_bioprospecting_contradictions.sql  # New table + indexes

src/routes/
  research-brain/            # New or extended routes for contradiction resolution
```

## 10. Key Design Decisions Summary

| Decision | Choice | Reason |
|---|---|---|
| Where detection lives | Step inside bioprospecting worker | Atomic with extraction; no inter-worker coordination needed |
| Trigger | Direct function call post-extraction; optional manual job | No pub/sub needed for automatic path |
| New table | `research_bioprospecting_contradictions` with FKs to facts | Enables per-contradiction tracking, resolution workflow |
| Rule matching | compound + bioactivity normalized match | Matches spec requirement exactly |
| LLM pass | Additive after rules, same job, same worker | Simplicity; lock duration accommodates it |
| Evidence pack integration | Query contradictions by returned fact IDs | Non-invasive; only modifies `buildEvidencePack` |
| Job routing | Shape-based (maxChunks present = extraction job) | No new job type registration needed |