# Exploration: kg-semantic-linker (KG PR3)

> SDD explore phase. Date: 2026-07-11.
> Goal: the deferred "LLM-driven fact↔fact / claim↔claim semantic linker" — meant
> to create the cross-node edges that turn the `/graph` ego graphs from stars
> into a real network.

## TL;DR — the premise is partly wrong

The `/graph` ego graphs look like stars, but the primary cause is **NOT missing
edges in the database**. It is:
1. A **real bug** in `citationGraph.ts` that drops nearly every neighbor, and
2. The client **never fetching** the cross-node edges that already exist server-side.

An LLM semantic linker is the *last* thing this needs, not the first.

## What already exists (PR3 must NOT duplicate)

### `research_edges` — a write-only orphan
- Migration `20260601090000_create_research_brain.sql:109` (`from_id, from_type,
  relation_type, to_id, to_type, metadata`, indexed both ways).
- **Only writer**: `createClaimEdges` (`db.ts:406`) — emits `supports`/`contradicts`/
  `derived_from`, all `claim → source`, only from the **deep-research chat** path.
- **Readers: NONE.** Nothing surfaces it. It holds **zero bioprospecting corpus data**
  and is entirely disconnected from `/graph`.
- Good generic sink for new edges, but a dead table today — not a foundation.
- ⚠️ **No unique constraint** on `(from_id, from_type, relation_type, to_id, to_type)`
  → idempotent upserts need one added.

### "semantic-dedup" is NOT semantic
- The dedup driver is a **deterministic 5-tuple `identity_key`** (normalize
  species|compound|bioactivity|organism_part|geography). Pure string transform.
- Edges go to `research_bioprospecting_fact_edges` with
  `match_rule CHECK IN ('identity_key','embedding')` — but **`'embedding'` is
  RESERVED and NEVER emitted** (spec says so).
- **There is NO existing semantic-similarity machinery over facts to reuse.**

### No embeddings on facts or claims
`src/embeddings/` targets only the **`documents`** table (CoralGPT Library RAG).
`research_bioprospecting_facts` / `research_claims` / `research_evidence_chunks`
have **no embedding column**. An embedding tier would be net-new.

### Contradiction detection — narrow, and its LLM tier is dead
- `contradictionDetector.ts` — rule-based (same compound|bioactivity, opposite
  `measurement_direction`). Own table, **intra-source only** (cross-source
  contradictions — the scientifically interesting case — are never detected).
- Feature-flagged (`BIOPROSPECTING_CONTRADICTION_DETECTION`) — the flag pattern to copy.

### `citationGraph.ts` — the LLM-free precedent (and it's broken)
`weight = sharedCompound*3 + sharedSpecies*2 + (doiMatch ? 5 : 0)`. Pure SQL,
on-the-fly, no stored edges. The right technique — applied at source↔source level.

### `graphService.getTopCoOccurring` — cross-node edges nobody renders
compound↔compound edges by shared-source count already exist (`graph_top_co_occurring`
RPC), surfaced only in `compounds/search?expand=true`. **`/graph` never fetches them
for entity-centered views.**

## 🐞 Two real bugs (prerequisites)

### Bug 1 — `citationGraph.ts` drops nearly every neighbor
`citationGraph.ts` (~line 263-271):
```ts
let q = sb.from("research_sources").select(...).neq("id", sourceId).limit(candidateLimit);
if (sourceDoiLower) {
  q = q.ilike("doi", sourceDoi);   // ← narrows candidates to SAME-DOI sources ONLY
}
```
When the source **has** a DOI (i.e. every real paper), the candidate set becomes
"other sources with the identical DOI" → **shared-compound and shared-species
neighbors are silently dropped**. The inline comment promises an EXISTS fallback
that **does not exist**.
**Net effect: the `/graph` source↔source citation overlay returns ~nothing for
DOI-bearing papers. A large chunk of the "star" complaint IS this bug.**

### Bug 2 — the LLM contradiction tier can never insert a row
`contradictionLlM.ts`: `buildFactsJson` serializes facts **without `id`**, but the
prompt asks the model for `"sourceFactId": "uuid"` and the insert path does
`facts.find((f) => f.id === c.sourceFactId)` → `if (!factA) continue;`.
The model never sees a UUID, so it can never emit a matching one.
**Every LLM-proposed contradiction is silently discarded. The tier has inserted
ZERO rows since it shipped, and nobody noticed.**

**This is the single most important lesson for PR3**: an LLM linker's payload MUST
carry stable ids, and the pipeline MUST assert on the proposed-vs-resolved join
rate instead of silently `continue`-ing.

## Approach comparison

Corpus: **14 sources, ~470 facts**. `C(470,2) = 110,215` pairs.

| # | Approach | Yield (current corpus) | LLM cost | Wrong-link risk | Effort |
|---|---|---|---|---|---|
| **A** | LLM pairwise (naive PR3) | Most pairs genuinely unrelated → model pressured to invent | **110k pairs ≈ 33M tokens/pass**. O(N²): 100 papers → 5.8M pairs | **HIGH** — hallucination, no ground truth | High |
| **B** | Embedding candidate-gen + LLM verify | Good (top-K are the plausible pairs) | Embed 470 facts ≈ cents; ~95 verify calls. O(N·K) | Medium | Med-High (**embedding tier is net-new**) |
| **C** | **Deterministic / structural (LLM-free)** — fact↔fact from shared canonical compound / taxon / normalized entity / source | **Guaranteed non-zero** via the 3 always-populated entity keys | **ZERO** | **ZERO hallucination.** Real risks: hub explosion, low information | **Low** |
| **D** | Reuse dedup/contradiction similarity | — | — | **NOT VIABLE** — no similarity machinery exists | — |
| **0** | **Composition + bug fix** — return 1-hop **plus the induced subgraph among the neighbors**, from data that already exists | **This is where most of the star shape comes from** | **ZERO** | **ZERO** | **Low** |

## The honest deterministic-vs-LLM answer

**Will an LLM linker find real links here, or hallucinate?** Mostly hallucinate:

1. **Small + diverse corpus.** The failed categorical-extraction experiment already
   proved this corpus does not cluster neatly. An LLM asked about 110k mostly-unrelated
   pairs, with no ground truth and no validation set, is *incentivized* to produce output.
2. **We have PROOF the failure mode is invisible.** The LLM contradiction tier has been
   inserting **zero** rows since it shipped and nobody noticed. A pipeline that can't
   distinguish "found nothing" from "output structurally discarded" cannot be trusted
   with 110k semantic judgments.
3. **Information-theoretic point.** A fact↔fact edge from "shares bioactivity
   `antifungal`" is *already implied* by the `antifungal` entity node — it adds density,
   not insight. The links that carry **new** information are the **cross-entity bridges**
   (same compound, *different* bioactivities) and **cross-source agreement/contradiction**
   — and both are **deterministically computable**. You need a self-join, not an LLM.
4. **The star shape is substantially a bug + a rendering gap**, not an ontological gap.
   Shipping an LLM linker on top would be a second floor on a cracked foundation — and
   would *appear* to work, because new edges would mask the missing deterministic ones.

**Verdict: deterministic structural linking (C), preceded by the composition fix (0),
is unambiguously the better first slice. The LLM tier must be gated behind (a) measured
evidence that deterministic edges are insufficient, and (b) a human review surface.**

## Recommended slicing

**Slice 0 — "de-star the graph" (LLM-free, mostly reuse, Low). SHIP THIS FIRST.**
1. **Fix the `citationGraph` DOI bug** (the `.ilike("doi", ...)` must be an OR-branch,
   not an AND-filter).
2. **Add `GET /api/research-brain/graph/neighborhood`** — already named as deferred v2
   work in the `graph-explorer-ui` spec. Returns the 1-hop neighborhood **plus the
   induced subgraph edges among those neighbors**, composed from existing helpers
   (`expandEntity` + `getTopCoOccurring` + `buildCitationGraph`). Auth: `required:true`.
3. **Measure** `compound_canonical_id` / `species_taxon_id` non-null coverage so Slice 1
   is scoped on data, not hope.

**Slice 1 — deterministic structural fact↔fact edges (LLM-free, Low-Med).**
Materialize into `research_edges` (finally giving it a reader *and* a real writer) with
new `relation_type`s (`shares_compound`, `shares_taxon`, `shares_bioactivity`,
`co_reported_in`) + a `citationGraph`-style composite weight. **Mandatory guards**:
hub suppression (IDF-style — an entity linking >N facts is low-information) and an
edge cap per node. Idempotent upsert (needs the unique constraint added).

**Slice 2 — DEFER: embedding candidate-gen + LLM verification (B).**
Only after Slice 1 shows deterministic edges are insufficient. Hard requirements:
- **An LLM cost guard** — `costService.ApiProvider` today covers only `mistral_ocr` and
  `pubchem`. **No LLM provider is cost-guarded at all**: any LLM linker is currently
  *unbounded spend*.
- Feature flag (mirror `BIOPROSPECTING_CONTRADICTION_DETECTION`).
- **Payload MUST carry fact ids** + assert the proposed-vs-resolved join rate (Bug 2's lesson).
- **Human review gate**: edges land `review_status='unreviewed'`, curator accepts
  (precedent: `bioprospecting-review-ui`).

## How new edges surface in `/graph`

Today `GraphExplorerPage` stitches the ego graph client-side from ONE `expand` payload;
`GraphEdge` is `{source, target, label?}` (no type, no weight); **facts are rendered as
EDGES (compound→source), not nodes** — and sources with no compound get a filler edge
straight to the center. **That code is literally what creates the star.**

- **Slice 0** needs the `/graph/neighborhood` payload + an extended `GraphEdge`
  (`{source, target, type, weight}`) so cross-edges can be styled/filtered. No new node types.
- **Slice 1's fact↔fact edges require promoting facts to first-class NODES** — a real UI
  model change, not an additive tweak. **This is the biggest hidden cost in PR3.**

## Open product questions (answer before sdd-propose)

1. **What is a fact↔fact link FOR?** Visual density → Slice 0 + C suffice, PR3 is basically
   done. Hypothesis generation ("two papers independently report the same compound-activity
   from different taxa") → the LLM tier has real value, and needs a curator gate.
2. **Materialized or on-the-fly?** House precedent (`citationGraph`, `graph_top_co_occurring`,
   the v2 live views) is on-the-fly, zero storage, always fresh. Materializing into
   `research_edges` breaks that precedent and adds a refresh-hook problem.
3. **Are facts NODES in `/graph`?** Today they are edges. Fact↔fact linking forces this.
4. **Hub suppression policy** — hard cap, IDF weighting, or exclude entities above a threshold?
5. **Cross-source vs intra-source?** (Contradiction detection is intra-source only; cross-source
   is the interesting case.)
6. **What corpus size are we building for — 14 papers or 1,000?** This single answer flips
   the verdict on O(N²) approaches entirely.
7. **Review gate**: auto-trust above a confidence threshold, or mandatory human acceptance?
8. **Should the 2 bugs be fixed inside this change, or split into their own bugfix change?**

## Risks

- `compound_canonical_id` coverage may be too low for shared-compound edges to yield anything
  — **must be measured** (the 3 free-text entity keys are always populated and give a floor).
- **Fact-as-node breaks the `graph-explorer-ui` "purely additive" guarantee.**
- **Hub explosion**: one popular bioactivity (80 facts) → 3,160 clique edges → *less* readable.
- `research_edges` lacks the unique constraint needed for idempotent upserts.
- **No LLM cost guard exists** — any LLM linker is unbounded spend today.
- **Silent-failure precedent**: the codebase already shipped one LLM tier that inserts zero
  rows and nobody noticed. Any new LLM path needs an explicit yield assertion.
