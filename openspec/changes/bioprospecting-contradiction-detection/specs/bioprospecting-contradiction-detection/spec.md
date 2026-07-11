# Delta for bioprospecting-contradiction-detection

## ADDED Requirements

### Requirement: Contradiction Detection Capability

The system MUST provide a `bioprospecting-contradiction-detection` capability that detects logical contradictions across bioassay data sources to prevent downstream analysis errors and improve data reliability.

**Trigger**: Automatic after corpus ingestion completes (triggered by job queue event `bioprospecting:extraction:completed`).

**Feature Flag**: `BIOPROSPECTING_CONTRADICTION_DETECTION=true` enables BOTH rule-based AND LLM-assisted passes. When `false`, no contradiction detection runs.

#### Scenario: Contradiction detection disabled

- GIVEN `BIOPROSPECTING_CONTRADICTION_DETECTION=false`
- WHEN corpus ingestion completes
- THEN no contradiction detection jobs are enqueued
- AND no rows are written to `research_bioprospecting_contradictions`

#### Scenario: Contradiction detection enabled via flag

- GIVEN `BIOPROSPECTING_CONTRADICTION_DETECTION=true`
- WHEN corpus ingestion completes for a source
- THEN a `ContradictionDetectionJobData` job is enqueued to the `bioprospecting` queue
- AND rule-based detection runs
- AND LLM-assisted detection runs ONLY IF `BIOPROSPECTING_CONTRADICTION_LLM=true`
  (a separate, default-OFF flag, AMENDED by `contradiction-detection-fix` PR1) and an
  LLM provider is available. The free rule-based tier therefore runs without spending.

### Requirement: research_bioprospecting_contradictions Table

> **AMENDED by `contradiction-detection-fix` (PR1).** The column names below are the
> LIVE schema. The names originally specified here (`source_fact_id`,
> `conflicting_fact_id`, `contradiction_type`, `evidence_pack`, `resolution_status`,
> `created_at`) were never the ones the database ended up with, and the divergence was
> only visible in `20260617000000_fix_get_contradiction_stats_rpc.sql`. That migration
> now performs the rename idempotently, so the migration chain reproduces this schema
> from scratch. Every backend module (`contradictionDb.ts`, `reviewService.ts`,
> `types.ts:ResearchBioprospectingContradiction`) already speaks this shape; the admin
> client now does too.

The system MUST create a `research_bioprospecting_contradictions` table with the following schema:

```sql
CREATE TABLE IF NOT EXISTS public.research_bioprospecting_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES public.research_sources(id) ON DELETE CASCADE,
  fact_a_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  fact_b_id UUID REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  conflict_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high')),
  explanation TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Columns:**
- `id`: Primary key
- `source_id`: Parent source this contradiction belongs to
- `fact_a_id`: First conflicting fact (FK to `research_bioprospecting_facts`)
- `fact_b_id`: Second conflicting fact (FK to `research_bioprospecting_facts`)
- `conflict_type`: Type of conflict — the check-constraint values are
  `compound_mismatch`, `bioactivity_mismatch`, `organism_mismatch`,
  `measurement_mismatch` (NOTE: the detector currently stores a
  `measurement_direction` conflict as `compound_mismatch` and a `relation_type`
  conflict as `bioactivity_mismatch`; correcting those labels is a tracked follow-up)
- `severity`: `low` | `medium` | `high` (defaults to `medium`)
- `explanation`: Human-readable conflict explanation (LLM tier writes it; the rule
  tier leaves it NULL and puts its summary in `metadata.conflict_summary`)
- `metadata`: JSON evidence pack for both facts (see below)
- `status`: `open` (the unresolved state) | `resolved` | `dismissed`. The admin route
  accepts the caller-facing filter value `unresolved` and maps it to `open`.
- `resolved_by`: User ID who resolved (null while `open`)
- `resolved_at`: Timestamp of resolution (null while `open`)
- `resolution_note`: Optional operator note recorded on resolve/dismiss
- `detected_at`: Creation timestamp (the admin feed orders by `detected_at DESC`)

**Indexes:**
```sql
CREATE INDEX IF NOT EXISTS idx_contradictions_source ON public.research_bioprospecting_contradictions (source_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_a_id ON public.research_bioprospecting_contradictions (fact_a_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_b_id ON public.research_bioprospecting_contradictions (fact_b_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_status_col ON public.research_bioprospecting_contradictions (status);
CREATE INDEX IF NOT EXISTS idx_contradictions_detected_at ON public.research_bioprospecting_contradictions (detected_at DESC);
```

**Evidence Pack Structure:**
```json
{
  "source_a": {
    "fact_id": "uuid",
    "source": "source title",
    "value": "agonist at 10uM",
    "provenance": "page 3, chunk uuid"
  },
  "source_b": {
    "fact_id": "uuid",
    "source": "source title",
    "value": "antagonist at 10uM",
    "provenance": "page 7, chunk uuid"
  },
  "conflict_summary": "Conflicting measurement_direction: agonist vs antagonist"
}
```

#### Scenario: Store measurement_direction contradiction

- GIVEN two facts from different sources describing the same compound-target interaction
- WHEN fact A has `measurement_direction: agonist` and fact B has `measurement_direction: antagonist`
- THEN a row is inserted with `contradiction_type: measurement_direction`
- AND `evidence_pack` contains both facts' values and provenance

#### Scenario: Store relation_type contradiction

- GIVEN two facts from different sources describing the same compound-target interaction
- WHEN fact A has `relation_type: activates` and fact B has `relation_type: inhibits`
- THEN a row is inserted with `contradiction_type: relation_type`
- AND `evidence_pack` contains both facts' values and provenance

### Requirement: Rule-Based Detection Pass

The system MUST run a deterministic rule-based detection pass whenever `BIOPROSPECTING_CONTRADICTION_DETECTION=true`.

**Phase 1 covers exactly two contradiction types:**
1. `measurement_direction` — e.g., agonist vs antagonist, activator vs inhibitor
2. `relation_type` — e.g., activates vs inhibits, upregulates vs downregulates

**Rule Logic:**
- Match facts by: same `compound` (normalized) AND same `bioactivity` target
- Conflict detection for `measurement_direction`: opposites (agonist/antagonist, activator/inhibitor, upregulator/downregulator)
- Conflict detection for `relation_type`: opposites (activates/inhibits, increases/decreases)

**Rule Version**: Tracked as `rule_version: "1.0"` in each detection row.

#### Scenario: Detect agonist vs antagonist conflict

- GIVEN two facts with same compound and target
- WHEN fact A has `measurement_direction: agonist` and fact B has `measurement_direction: antagonist`
- THEN a contradiction is recorded with `contradiction_type: measurement_direction`

#### Scenario: Detect activates vs inhibits conflict

- GIVEN two facts with same compound and target
- WHEN fact A has `relation_type: activates` and fact B has `relation_type: inhibits`
- THEN a contradiction is recorded with `contradiction_type: relation_type`

#### Scenario: No conflict for unrelated facts

- GIVEN two facts with different compounds
- WHEN rule-based detection runs
- THEN no contradiction is recorded

### Requirement: LLM-Assisted Detection Pass

The system MUST run an LLM-assisted detection pass when `BIOPROSPECTING_CONTRADICTION_DETECTION=true` AND an LLM provider is available.

**LLM Version**: Tracked as `llm_version: "1.0"` in each detection row.

**Behavior:**
- LLM pass runs AFTER rule-based pass completes
- LLM analyzes facts that passed rule-based dedup but may have contextual conflicts
- LLM pass is additive — it finds additional contradictions beyond rules, not replaces them
- If LLM provider unavailable, rule-based pass still runs and system continues

#### Scenario: LLM finds contextual contradiction missed by rules

- GIVEN `BIOPROSPECTING_CONTRADICTION_DETECTION=true` and LLM provider available
- WHEN LLM pass runs on facts
- THEN LLM may identify contradictions based on contextual interpretation
- AND any new contradictions are added to `research_bioprospecting_contradictions`

### Requirement: Contradiction Detection Job Data

The system MUST use the following job data structure for contradiction detection:

```typescript
interface ContradictionDetectionJobData {
  runId: string;
  sourceId: string;
  options?: {
    force?: boolean;
  };
}
```

### Requirement: Queue Configuration for Contradiction Detection

The contradiction detection job MUST be enqueued to the existing `bioprospecting` queue after bioprospecting extraction completes.

**Trigger event**: `bioprospecting:extraction:completed` published via Redis Pub/Sub when a source's bioprospecting extraction finishes.

```typescript
// In bioprospecting worker after extraction completes:
await publishNotification({
  type: "bioprospecting:extraction:completed",
  sourceId: sourceId,
  runId: runId,
  factCount: extractedFacts.length
});
```

#### Scenario: Auto-enqueue contradiction detection after extraction

- GIVEN a source's bioprospecting extraction completes
- WHEN the `bioprospecting:extraction:completed` notification is published
- THEN a `ContradictionDetectionJobData` job is enqueued to the `bioprospecting` queue
- AND the job references the sourceId

### Requirement: Geographic Conflict Detection — NOT IMPLEMENTED

Geographic conflict detection is OUT OF SCOPE for Phase 1.

- GIVEN any request for geographic contradiction detection
- THEN the system MUST NOT implement this feature in Phase 1
- AND it MUST be documented as deferred to Phase 2

#### Scenario: Geographic detection not implemented

- GIVEN `BIOPROSPECTING_CONTRADICTION_DETECTION=true`
- WHEN contradiction detection runs
- THEN no geographic conflict detection is performed
- AND no `geographic` contradiction_type rows are created

## REMOVED Requirements

None.
