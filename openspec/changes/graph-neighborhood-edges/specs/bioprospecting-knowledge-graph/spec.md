# Delta for bioprospecting-knowledge-graph

## ADDED Requirements

### Requirement: Citation Candidate Selection — DOI Is A Bonus Signal, Not A Filter

The citation graph builder MUST select its candidate neighbor set by the
UNION (logical OR) of its relatedness signals: shared canonical compound,
shared canonical species, and equal DOI. DOI equality MUST NOT be applied
as an AND-filter that narrows the candidate query.

Specifically, when the focus source HAS a non-empty DOI, the builder MUST
NOT restrict candidates to sources with that same DOI. It MUST still
consider every other source and MUST still return neighbors that share a
compound or a species but have a different DOI or no DOI at all.

DOI equality MUST remain a contributing signal: when it holds, `doiMatch`
is `true`, `shared_doi` is present in the edge's `kinds`, and the DOI
bonus contributes to `weight` (compounds × 3 + species × 2 + DOI bonus).
Edges with no compound overlap, no species overlap, and no DOI match MUST
still be excluded. Edges MUST remain sorted by `weight` descending and
clamped by `limit`. The candidate scan MUST remain bounded by the
existing `candidateLimit` cap so widening the candidate set does not
remove the query's upper bound.

(This fixes a defect: `.ilike("doi", sourceDoi)` was applied to the
candidate query whenever the focus source had a DOI, silently dropping
every shared-compound and shared-species neighbor for every real paper —
the source↔source overlay returned almost nothing.)

#### Scenario: A DOI-bearing source returns its shared-compound neighbors

- GIVEN a focus source WITH a non-empty DOI
- AND another source with a DIFFERENT DOI that shares ≥1 canonical compound
- WHEN the citation graph is built for the focus source
- THEN the other source is returned as an edge
- AND that edge's `kinds` include `shared_compound`
- AND its `weight` reflects the shared-compound count
- AND (before this change the result set was empty for such a source)

#### Scenario: A DOI-bearing source returns its shared-species neighbors

- GIVEN a focus source WITH a non-empty DOI
- AND another source with NO DOI that shares ≥1 canonical species
- WHEN the citation graph is built
- THEN the other source is returned as an edge with `kinds` including
  `shared_species`

#### Scenario: DOI equality still adds its bonus weight

- GIVEN a focus source WITH a DOI
- AND another source with the SAME DOI (case-insensitive) and no shared
  compound or species
- WHEN the citation graph is built
- THEN that source is returned with `doiMatch: true`
- AND `kinds` includes `shared_doi`
- AND its `weight` equals the DOI bonus

#### Scenario: A duplicate outranks a weak-overlap neighbor

- GIVEN a same-DOI duplicate neighbor and a neighbor sharing one species only
- WHEN the citation graph is built
- THEN both are returned
- AND the same-DOI duplicate sorts above the species-only neighbor

#### Scenario: Unrelated sources are still excluded

- GIVEN a source that shares no compound, no species, and no DOI with the
  focus source
- WHEN the citation graph is built
- THEN it is NOT present in the returned edges

#### Scenario: A source with no DOI is unaffected

- GIVEN a focus source with NO DOI
- WHEN the citation graph is built
- THEN its shared-compound and shared-species neighbors are returned
- AND behavior is identical to before this change
