# Proposal: Bioprospecting Contradiction Detection

## Intent

Detect logical contradictions across bioassay data sources to prevent downstream analysis errors and improve data reliability. When multiple sources describe the same biological system with conflicting findings, the system will surface those conflicts for human review before conclusions are drawn.

## Scope

### In Scope
- **New `contradictions` table** — stores detected contradictions with evidence references, source types, and resolution status
- **Rule-based detection** — Phase 1 covers `measurement_direction` conflicts (e.g., agonist vs antagonist) and `relation_type` conflicts (e.g., activates vs inhibits same target)
- **Cross-source detection** — runs automatically when corpus ingestion completes (triggered by a job queue event)
- **Evidence pack** — contradictions are displayed with supporting evidence (both sources, conflicting values, provenance)
- **Feature flag** — `BIOPROSPECTING_CONTRADICTION_DETECTION=true` enables BOTH rule-based AND LLM-assisted passes

### Out of Scope
- Geographic conflict detection (deferred to Phase 2)
- Modification of the existing `fact` schema
- Real-time streaming contradiction detection

## Capabilities

### New Capabilities
- `bioprospecting-contradiction-detection`: Detect and surface logical conflicts between bioassay data sources

### Modified Capabilities
- None (new capability only; fact schema unchanged)

## Approach

**Storage**: New `contradictions` table with `source_fact_id`, `conflicting_fact_id`, `contradiction_type`, `evidence_pack` (JSON), `rule_version`, `llm_version`, `resolution_status`, `resolved_by`, `resolved_at`.

**Detection Pipeline** (triggered on corpus ingestion job completion):
1. **Rule-based pass** — deterministic conflict rules (measurement_direction, relation_type). Runs always when flag is on.
2. **LLM-assisted pass** — contextual contradiction detection using LLM. Runs in addition to rules when flag is on.
3. Results written to `contradictions` table with evidence pack.

**Evidence Pack structure**:
```json
{
  "source_a": { "fact_id": "...", "source": "...", "value": "...", "provenance": "..." },
  "source_b": { "fact_id": "...", "source": "...", "value": "...", "provenance": "..." },
  "conflict_summary": "..."
}
```

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/db/schema.sql` | New | `contradictions` table |
| `src/services/queue/workers/` | Modified | Add contradiction detection job on corpus ingestion complete |
| `src/agents/analysis/` | New | Rule-based + LLM contradiction detection agents |
| `src/routes/deep-research/` | Modified | Expose contradiction evidence via existing result endpoints |
| `src/types/` | Modified | Add `Contradiction` type |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| LLM pass adds latency to corpus ingestion | Medium | Runs async; flag defaults to `false`; user opts in explicitly |
| Rule conflicts with existing fact relationships | Low | Rule-based pass is additive only; `fact` table untouched |
| Too many false positives from Phase 1 rules | Medium | Rule version tracked per detection; easy to tune |

## Rollback Plan

1. Set `BIOPROSPECTING_CONTRADICTION_DETECTION=false` — stops new detection, existing rows remain but are ignored by query layer
2. Remove trigger from corpus ingestion job queue
3. Drop `contradictions` table if needed (no downstream schema dependencies)

## Dependencies

- OpenScholar/BioAgents corpus ingestion completion (job queue event)
- LLM provider (for LLM pass only; rule-based works without it)

## Success Criteria

- [ ] `contradictions` table created with correct schema
- [ ] Rule-based detection fires on corpus ingestion completion
- [ ] Contradictions visible in evidence pack via existing result API
- [ ] `BIOPROSPECTING_CONTRADICTION_DETECTION=true` enables both passes
- [ ] `BIOPROSPECTING_CONTRADICTION_DETECTION=false` disables both passes
- [ ] Phase 1 covers `measurement_direction` and `relation_type` only
- [ ] Geographic conflict detection NOT implemented in Phase 1