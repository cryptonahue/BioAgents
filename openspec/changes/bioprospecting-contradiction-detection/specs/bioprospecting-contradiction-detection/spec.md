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
- AND LLM-assisted detection runs (if LLM provider available)

### Requirement: research_bioprospecting_contradictions Table

The system MUST create a `research_bioprospecting_contradictions` table with the following schema:

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Columns:**
- `id`: Primary key
- `source_id`: Parent source this contradiction belongs to
- `source_fact_id`: First conflicting fact (FK to `research_bioprospecting_facts`)
- `conflicting_fact_id`: Second conflicting fact (FK to `research_bioprospecting_facts`)
- `contradiction_type`: Type of conflict (e.g., `measurement_direction`, `relation_type`)
- `evidence_pack`: JSON object containing both facts' evidence (see below)
- `rule_version`: Version of rule set that detected this (null if LLM-only)
- `llm_version`: Version of LLM prompt that detected this (null if rule-only)
- `resolution_status`: `unresolved`, `resolved`, `dismissed`
- `resolved_by`: User ID who resolved (null if unresolved)
- `resolved_at`: Timestamp of resolution (null if unresolved)
- `created_at`: Creation timestamp
- `updated_at`: Last update timestamp

**Indexes:**
```sql
CREATE INDEX IF NOT EXISTS idx_contradictions_source ON public.research_bioprospecting_contradictions (source_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_a ON public.research_bioprospecting_contradictions (source_fact_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_fact_b ON public.research_bioprospecting_contradictions (conflicting_fact_id);
CREATE INDEX IF NOT EXISTS idx_contradictions_type ON public.research_bioprospecting_contradictions (contradiction_type);
CREATE INDEX IF NOT EXISTS idx_contradictions_status ON public.research_bioprospecting_contradictions (resolution_status);
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
