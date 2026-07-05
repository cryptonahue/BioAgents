# Delta for research-brain-evidence-pack

## ADDED Requirements

### Requirement: Contradiction Warnings in Evidence Pack

The system MUST include detected contradictions in the evidence pack returned by `GET /api/research-brain/search` and related endpoints.

**New evidence pack field:**
```typescript
contradictionWarnings: EvidencePackContradiction[];
```

**New type:**
```typescript
type EvidencePackContradiction = {
  id: string;
  contradictionType: string;
  sourceA: {
    factId: string;
    claim: string;
    sourceTitle: string | null;
    doi: string | null;
    value: string;
    provenance: string;
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

#### Scenario: Evidence pack includes contradiction warnings

- GIVEN a search that returns facts with detected contradictions
- WHEN the evidence pack is built
- THEN `contradictionWarnings` array contains all unresolved contradictions linking those facts
- AND each warning includes both conflicting values and provenance

#### Scenario: Empty contradiction warnings when no conflicts

- GIVEN a search that returns facts with no contradictions
- WHEN the evidence pack is built
- THEN `contradictionWarnings` is an empty array `[]`

### Requirement: Contradiction Resolution Status Display

The system MUST surface contradiction resolution status in the evidence pack.

**Behavior:**
- `resolution_status: "unresolved"` — contradictions awaiting human review
- `resolution_status: "resolved"` — contradictions reviewed and resolved
- `resolution_status: "dismissed"` — contradictions reviewed and dismissed as false positives

#### Scenario: Show unresolved contradictions for review

- GIVEN facts with unresolved contradictions exist
- WHEN the evidence pack is returned
- THEN `contradictionWarnings` includes those with `resolution_status: "unresolved"`
- AND frontend can surface these for human review

### Requirement: Contradiction Evidence Linkage

Each contradiction warning in the evidence pack MUST include fragment-level provenance links to enable navigation to the specific evidence.

**Fields provided:**
- `sourceA.doi` and `sourceA.provenance` — link to source A's evidence fragment
- `sourceB.doi` and `sourceB.provenance` — link to source B's evidence fragment

#### Scenario: Contradiction links to conflicting evidence fragments

- GIVEN a contradiction between fact A and fact B
- WHEN the evidence pack is built
- THEN each source includes DOI URL and internal fragment link
- AND users can navigate directly to the conflicting evidence

## MODIFIED Requirements

### Requirement: Evidence Pack Structure

The `EvidencePack` type SHALL be extended to include `contradictionWarnings`:

```typescript
export type EvidencePack = {
  question: string;
  queryPlan: EvidencePackQueryPlan;
  bioprospectingFacts: EvidencePackBioprospectingFact[];
  supportedClaims: EvidencePackClaim[];
  partialClaims: EvidencePackClaim[];
  contradictions: EvidencePackClaim[];     // existing — claims with status=contradicted
  contradictionWarnings: EvidencePackContradiction[];  // NEW — bioprospecting contradictions
  openQuestions: EvidencePackClaim[];
  sources: EvidencePackSource[];
};
```

(Previously: `contradictionWarnings` field did not exist)

#### Scenario: Evidence pack v2 includes contradiction warnings

- GIVEN a search request
- WHEN the evidence pack is constructed
- THEN the response includes `contradictionWarnings: []` (empty if none)
- AND field is always present (never omitted)

### Requirement: Evidence Pack API Response

The `GET /api/research-brain/search` endpoint and related endpoints MUST include `contradictionWarnings` in the response.

**Response includes:**
```json
{
  "question": "...",
  "queryPlan": {...},
  "bioprospectingFacts": [...],
  "supportedClaims": [...],
  "partialClaims": [...],
  "contradictions": [...],
  "contradictionWarnings": [
    {
      "id": "uuid",
      "contradictionType": "measurement_direction",
      "sourceA": {
        "factId": "uuid",
        "claim": "Compound X is an agonist at target Y",
        "sourceTitle": "Study on Compound X",
        "doi": "10.xxxx/xxxxx",
        "value": "agonist",
        "provenance": "page 3, chunk uuid"
      },
      "sourceB": {...},
      "conflictSummary": "Conflicting measurement_direction: agonist vs antagonist",
      "resolutionStatus": "unresolved"
    }
  ],
  "openQuestions": [...],
  "sources": [...]
}
```

(Previously: `contradictionWarnings` field was not included in API responses)

#### Scenario: API returns contradiction warnings

- GIVEN a search request that matches facts with contradictions
- WHEN the API responds
- THEN `contradictionWarnings` array is populated with relevant contradictions

## REMOVED Requirements

None.
