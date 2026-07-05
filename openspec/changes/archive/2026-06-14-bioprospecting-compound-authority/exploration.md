# Exploration: Compound Authority Table for Bioprospecting

## 1. Summary of how compounds are currently handled (and the gap)

### What exists today

**Extraction (producer side)**
- `src/services/researchBrain/bioprospectingExtractor.ts` asks an LLM to extract free-text `compound`, `compoundClass`, `moleculeType` per fact. The prompt gives no canonical vocabulary — the LLM emits whatever the chunk says ("curcumin", "Curcuma longa extract", "diferuloylmethane", "turmeric extract", "extract", etc.).
- `asString` (line 34) trims and collapses whitespace; **no chemistry-aware normalization is applied** before insertion.

**Storage (`BioprospectingFact`, `types.ts:218-304`)**
- The fact row has three raw text columns: `compound`, `compound_class`, `molecule_type`.
- Five FK columns already exist for species: `species_taxon_id`, `genus_taxon_id`, `family_taxon_id` (set by `taxonomy.ts`). There is **no equivalent FK for compound** — `compound` is a free text column.
- Partial btree indexes exist on `lower(compound)` for search (`20260606090000_prepare_bioprospecting_ingestion.sql`).

**Dedup (`normalize.ts` + `db.ts`)**
- `buildIdentityKey` (`normalize.ts:56`) builds a 5-tuple key: `species|compound|bioactivity|organism_part|geography`, where each field runs through `normalizeForIdentity` (NFKD + diacritic strip + non-alnum → space + collapse + lowercase).
- The PG `identity_key` generated column (`20260610060000_bioprospecting_dedup.sql:60-85`) replicates the same transform in SQL.
- The partial unique index `idx_bioprospecting_facts_identity_key_unique` (line 97) collapses cross-source duplicates at insert time, with `merged_into_fact_id` + `research_bioprospecting_fact_edges` capturing the lineage.
- The transform is **deliberately conservative** (per the dedup spec and the comment in `normalize.ts:8-12`): "no taxonomy lookups, no chemistry-aware transforms, no plural/suffix folding."

**Species authority (the pattern to mirror)**
- `taxonomy.ts` implements the same shape we need for compounds:
  - `research_taxa` table (rank + canonical_name + normalized_name + parent_id + external_ids + status).
  - `research_taxon_aliases` table (alias + normalized_alias + source + FK to taxon).
  - Optional WoRMS resolution on demand (`fetchWoRMSRecordsByName`, `taxonomy.ts:535-559`).
  - Backfill script `normalizeBioprospectingTaxonomy` that walks pending facts and creates taxa + aliases.
  - Two routes already wired: `GET /api/research-brain/taxonomy` and `POST /api/research-brain/taxonomy/normalize`.
  - `BioprospectingFact` carries `taxonomy_status` (`pending|normalized|skipped|failed`) so backfill is idempotent.

### The gap

The conservative `normalizeForIdentity` collapses "Curcumin" and "curcumin," into the same key — good. But it does **not** collapse:
- "curcumin" (the polyphenol, PubChem CID 969516) vs "diferuloylmethane" (synonym) vs "(1E,6E)-1,7-bis(4-hydroxy-3-methoxyphenyl)hepta-1,6-diene-3,5-dione" (IUPAC) — all are **the same compound** under different names.
- "DHA" vs "docosahexaenoic acid" vs "(4Z,7Z,10Z,13Z,16Z,19Z)-docosa-4,7,10,13,16,19-hexaenoic acid" vs "22:6n-3" — same.
- "EPA" vs "eicosapentaenoic acid" vs "20:5n-3" — same.

And it **also doesn't help us distinguish "curcumin" (single molecule) from "Curcuma longa extract" (mixture of many compounds including curcumin, demethoxycurcumin, bisdemethoxycurcumin, ar-turmerone, etc.)** — these are commonly conflated in LLM extraction, and conflating them produces false positives that are scientifically wrong (an IC50 measured on the pure compound is not the same as one measured on a crude extract).

A species authority doesn't help here — that's a different problem (binomial nomenclature, WoRMS authority). We need a chemistry authority that maps aliases to a canonical molecule and explicitly excludes mixtures from dedup-eligible rows.

## 2. Recommended data sources — top 3 with tradeoffs

| Source | Free? | Strengths | Weaknesses | Verdict |
|---|---|---|---|---|
| **PubChem** (NIH) | Yes, no key, REST + PUG-REST | 90M+ compounds; `synonyms` endpoint returns hundreds of aliases per CID (including IUPAC, INN, trivial, brand, systematic); InChIKey included; molecular formula; SMILES. The "alias table" is already built by NIH curators. | 5 req/s anonymous (1000/day); heavy synonyms pages need paging; mixture entries (`CompoundType` flag) are mixed with pure compounds in the same namespace. | **Primary** — best alias coverage, no auth, machine-friendly. |
| **ChEBI** (EBI) | Yes, REST + OBO ontology | Curated, ontology-structured (has explicit "is_a" relations); strong for natural products; has `RELATED`/`IS_A` synonym relationships (`hasExactSynonym`, `hasRelatedSynonym`). | Smaller (~200K compounds); natural-product coverage good but not exhaustive; ontology overhead. | **Secondary for natural products** — fallback when PubChem misses, and for natural-product relationship context. |
| **ChEMBL** (EBI) | Yes | Bioactivity-rich: links compound → target → assay → activity value. Same InChIKey space as PubChem (cross-linkable). | Heavier payload; bioactivity focus means a compound must have been assayed to be present; many "non-drug" natural products absent. | **Tertiary** — only relevant if we later want to cross-link facts to bioactivity data. Skip for v1. |

**Verdict:** PubChem first, ChEBI as a fallback for "PubChem miss" recovery and for human curation hints. Reject DrugBank (commercial, restricted), HMDB (metabolome-specific, biased toward human metabolites, weaker for marine), LOTUS/COCONUT (bulk download only, not queryable on demand), Wikidata (no curated synonym table for chemicals, quality varies).

### Alias strategy for "curcumin" vs "Curcuma longa extract" (the same/different question)

This is the critical design call. Two cases to keep distinct:

- **Same compound, different name** → MUST dedup. Curcumin / diferuloylmethane / IUPAC name / InChIKey all map to one canonical row. PubChem's `synonyms` endpoint is the authority.
- **Whole extract vs single molecule** → MUST NOT dedup. "Curcuma longa extract" is a mixture; "curcumin" is a single polyphenol. They are *related* but not *identical*. Folding them is a false positive that destroys the IC50-vs-extract-concentration distinction the lab depends on.

**Rule (encode it in the spec, not the code):** The authority table ONLY holds **single-molecule entries**. When the LLM extractor emits a value that does not resolve to a single PubChem CID (because the substring "extract" / "oil" / "fraction" / "powder" / "TME" / "juice" is present, or the lookup returns 0 hits, or returns a CID whose `CompoundType` is a mixture/extract record), the fact gets:
1. A `compound_canonical_id = NULL` (we keep `compound` as raw text, so the fact is still searchable and reviewable).
2. The fact is **excluded from identity-key dedup** that requires compound resolution. The existing 5-tuple key still applies to the `compound` text as-is, so two facts that both say "Curcuma longa extract" will still dedup against each other — but neither will dedup against a "curcumin" fact.

We achieve this by computing an `identity_key` variant that uses the canonical id when present and the raw normalized text when not, so the key stays a single column and the dedup machinery in `db.ts` doesn't need to change shape (see §4 below).

## 3. Recommended schema (2-3 tables)

Mirror `research_taxa` / `research_taxon_aliases` exactly. New migration `20260613XXXXXX_create_compound_authority.sql`:

### `research_compounds` (canonical compounds)

```sql
CREATE TABLE public.research_compounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,           -- display name (e.g. "Curcumin")
  normalized_name TEXT NOT NULL,          -- NFKD + diacritic strip + lower + collapse
  inchi_key TEXT,                          -- standard chemical hash, key to PubChem
  pubchem_cid INTEGER,                     -- nullable: compounds PubChem doesn't know
  chebi_id INTEGER,                        -- nullable, future ChEBI cross-link
  molecular_formula TEXT,
  iupac_name TEXT,
  compound_kind TEXT NOT NULL DEFAULT 'small_molecule'
    CHECK (compound_kind IN ('small_molecule', 'peptide', 'protein', 'lipid', 'other')),
  status TEXT NOT NULL DEFAULT 'local'
    CHECK (status IN ('local', 'pubchem', 'chebi', 'manual', 'curated')),
  external_ids JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (normalized_name)
);

CREATE INDEX idx_research_compounds_inchi_key ON public.research_compounds (inchi_key)
  WHERE inchi_key IS NOT NULL;
CREATE INDEX idx_research_compounds_pubchem_cid ON public.research_compounds (pubchem_cid)
  WHERE pubchem_cid IS NOT NULL;
```

### `research_compound_aliases`

```sql
CREATE TABLE public.research_compound_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compound_id UUID NOT NULL REFERENCES public.research_compounds(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local_extraction'
    CHECK (source IN ('local_extraction', 'pubchem', 'chebi', 'manual', 'curated')),
  confidence TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (compound_id, normalized_alias)
);

CREATE INDEX idx_research_compound_aliases_normalized
  ON public.research_compound_aliases (normalized_alias);
```

### FK on the fact table

```sql
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN compound_canonical_id UUID
    REFERENCES public.research_compounds(id) ON DELETE SET NULL,
  ADD COLUMN compound_authority_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (compound_authority_status IN ('pending', 'resolved', 'skipped', 'failed')),
  ADD COLUMN compound_authority_at TIMESTAMPTZ,
  ADD COLUMN compound_authority_error TEXT;

CREATE INDEX idx_research_bioprospecting_compound_canonical
  ON public.research_bioprospecting_facts (compound_canonical_id)
  WHERE compound_canonical_id IS NOT NULL;
```

### Why this shape (tradeoffs)

- **Two tables (not three):** Merging `external_ids` into the canonical row saves a join and matches the taxonomy pattern. We can add a third `research_compound_relationships` table later for "curcumin ⊂ turmeric extract" (a separate, bigger change).
- **`inchi_key` unique-by-row (not table-level UNIQUE):** The column is nullable; table-level UNIQUE on a nullable allows multiple NULLs in PG, but explicit partial index makes the intent obvious.
- **`compound_kind` is mandatory:** A single-row enum captures the "is this a small molecule" decision the dedup logic depends on, without forcing a separate `is_mixture` boolean that could lie.
- **NO `identity_key` change in this PR:** the existing 5-tuple key is kept; we add a `compound_canonical_id` companion. See §4.

## 4. Integration with existing dedup — how does `compound_canonical_id` flow?

**Decision: keep the existing 5-tuple `identity_key` unchanged. Add `compound_canonical_id` as a parallel signal that strengthens dedup, doesn't replace it.**

Rationale:
- The dedup spec is shipped (`bioprospecting-semantic-dedup`). Changing the key shape retroactively means re-running every existing merge and re-issuing every lineage edge. Not worth it.
- The 5-tuple already collapses "Quercetin" and "quercetin" (case). It does NOT collapse "Quercetin" and "quercetin-3-O-glucoside" — correct. We want the same precision for chemistry: collapse true synonyms, keep distinct molecules distinct.

### What changes in the code path

1. **After LLM extraction**, before insert, in `replaceBioprospectingFactsForSource`:
   - For each fact with non-null `compound`, look up `compound_canonical_id` via the alias table (in-memory `Map<normalizedAlias, compoundId>` built per source).
   - On miss, **synchronously skip resolution during extraction** (PubChem is slow + rate-limited). Insert the fact with `compound_authority_status = 'pending'`, `compound_canonical_id = NULL`. The backfill script handles async resolution.
   - On hit, set `compound_canonical_id` and `compound_authority_status = 'resolved'`.

2. **At identity-key build time** (both TS in `normalize.ts` and SQL generated column): **no change.** The 5-tuple keeps using raw `compound` text. Rationale: when a fact has `compound_canonical_id = NULL` (extract case or pending resolution), we want it to dedup with other "Curcuma longa extract" facts. The text-based key does that. When it IS resolved, we want it to dedup with all facts that share the alias — and since the extractor already ran the alias lookup, those facts will all have the same `compound` text variant that mapped to the same canonical id, so the text-based key still matches.

3. **A new backfill script** (mirrors `normalizeBioprospectingTaxonomy`):
   - `normalizeBioprospectingCompounds({ limit, dryRun, usePubChem })` in `src/services/researchBrain/compoundAuthority.ts`.
   - Reads facts where `compound_authority_status = 'pending'`, queries PubChem on demand, upserts the canonical row + alias, sets `compound_canonical_id` + `compound_authority_status = 'resolved'`.
   - Idempotent, additive, runs alongside the taxonomy backfill in the same scheduled job.

4. **Search ranker** (`db.ts:1522-1539` `prioritizeCompoundMatches`): unchanged. The compound column still drives the match-priority heuristic.

5. **`merged_into_fact_id` / edge table**: unchanged. Two facts dedup via the 5-tuple key still get the same lineage treatment. The canonical-id FK is orthogonal.

### What we LOSE by not folding canonical_id into identity_key

- We don't get to dedup "Quercetin" + "quercetin" across all cases where one of them was extracted from a paper that used the InChIKey as the column value. This is a real but small loss — papers almost never write InChIKeys in the prose; the LLM normalizes them down to common names anyway. We can re-evaluate if the backfill shows a measurable false-negative rate.

### "Weak vs strong dedup" mode

Defer to a follow-up. The architecture supports it: add a `match_rule = 'canonical_id'` value to the `research_bioprospecting_fact_edges` CHECK constraint (the migration already reserves `'embedding'` for this), and a future "strong dedup" mode that groups by canonical id across the whole table. Not in v1 — adds a second-tier dedup pass that complicates the inline merge in `db.ts`. We have shippable value from the resolution + backfill alone.

## 5. Alias strategy — same vs different

Encode the rule in a `isExtractLike(value)` predicate in `compoundAuthority.ts` (or a small helper module):

```ts
const EXTRACT_LIKE = /\b(extract|oil|fraction|tincture|juice|powder|infusion|decoction|TME|essential oil|resin)\b/i;
const MIXTURE_HINT = /\b(formulation|preparation|solution|suspension|emulsion|blend|mixture|combination)\b/i;

export function looksLikeExtract(value: string | null | undefined): boolean {
  if (!value) return false;
  return EXTRACT_LIKE.test(value) || MIXTURE_HINT.test(value);
}
```

When `looksLikeExtract(compound)` is true:
- Skip the alias lookup entirely.
- Set `compound_authority_status = 'skipped'` with `compound_authority_error = 'extract_or_mixture'`.
- `compound_canonical_id` stays NULL.
- The fact still participates in the existing 5-tuple dedup on the raw text.

When `looksLikeExtract` is false:
- Normalize, look up the alias table.
- On hit: set `compound_canonical_id`, mark `resolved`.
- On miss: leave `pending`; backfill queries PubChem asynchronously.

## 6. Loading strategy (on-demand vs backfill)

**Hybrid: synchronous alias-table hit during extraction + asynchronous PubChem backfill for misses.**

Phase 1 (ship in this PR):
- The alias table is pre-loaded by a **one-time admin seed script** with the ~500 most common marine bioprospecting compounds (curcumin, DHA, EPA, paclitaxel, bryostatin, etc.) and their PubChem synonym list. This is a 2-3 MB JSON file maintained in the repo, versioned, loaded on first deploy. The script is idempotent (skip existing rows by `pubchem_cid`).
- During extraction: alias-table hit, no network.
- Miss: leave `pending`, log, move on.
- Backfill script `normalizeBioprospectingCompounds` runs on a schedule (same cron as `normalizeBioprospectingTaxonomy`) and hits PubChem for misses at 4 req/s (under the 5 req/s limit). Each iteration: GET `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/cids/JSON` → on hit, GET `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{cid}/property/InChIKey,MolecularFormula,IUPACName/JSON` → upsert.

Phase 2 (out of scope): opportunistic pre-fetching using the LLM — when the LLM extracts "curcumin", run a background PubChem resolve during the same request lifecycle and cache. Only worth it if the backfill lag becomes a problem.

**Backfill safety:**
- Cap the fact scan at 500 per run (same as taxonomy).
- PubChem has a global 5 req/s limit; we use 4 to be safe. Backfill of 500 facts = ~125 s + per-CID property fetch. Acceptable for a scheduled job.
- Wrap each PubChem fetch with the same `withTimeout` + `AbortController` pattern from `taxonomy.ts:547-558`.
- Manual override: a curator (admin role) can pre-insert a `research_compounds` row + alias with `status = 'curated'` to short-circuit PubChem for a name the team has decided on.

## 7. Estimated complexity and rough LOC

| Layer | What | LOC | Complexity |
|---|---|---|---|
| Migration | 1 SQL file, 3 tables + 1 FK + 3 indexes + trigger | ~80 | Low (mirrors `20260606110000_create_taxonomy_normalization.sql`) |
| `compoundAuthority.ts` (new) | PubChem fetch + alias lookup + upsert + backfill script | ~450 | Medium (mirror `taxonomy.ts`, simpler: no parent ranks, no WoRMS-style ranking) |
| `types.ts` additions | `ResearchCompound`, `ResearchCompoundAlias` | ~30 | Low |
| `db.ts` integration | Build alias map, attach `compound_canonical_id` in `replaceBioprospectingFactsForSource` | ~80 | Medium (touches the hot path) |
| Routes | `GET /api/research-brain/compounds`, `POST /api/research-brain/compounds/normalize`, `POST /api/research-brain/compounds/:id/aliases` | ~120 | Low (mirror taxonomy routes) |
| Seed script | JSON load + idempotent upsert | ~80 | Low |
| Tests | Unit (alias table hit, extract skip, PubChem fetch mocking) + integration (backfill) | ~250 | Medium |
| Docs (OpenSpec) | `proposal.md`, `specs/compound-authority/spec.md`, `design.md`, `tasks.md` | ~400 | Low |
| **Total** | | **~1490** | **Medium** |

The new code is **mostly mechanical**: the hard work (PubChem URL patterns, alias-match rules, extract-skip predicate) is straightforward once the design call in §2/§5 is made. The taxonomy module is the right reference; we are copying its structure with one fewer dimension (no parent ranks).

## 8. Key files to modify / create

### New
- `src/services/researchBrain/compoundAuthority.ts` — the new module
- `src/services/researchBrain/__tests__/compoundAuthority.test.ts`
- `supabase/migrations/20260613000000_create_compound_authority.sql`
- `scripts/seed/compound-authority-seed.json` (curated ~500 most common compounds + PubChem CIDs; tracked in repo)
- `scripts/seed/load-compound-authority.ts` (idempotent loader)
- `openspec/changes/bioprospecting-compound-authority/{proposal,specs/compound-authority/spec,design,tasks}.md`

### Modified
- `src/services/researchBrain/types.ts` — add `ResearchCompound`, `ResearchCompoundAlias`, and the three new columns on `BioprospectingFact` (`compound_canonical_id`, `compound_authority_status`, `compound_authority_at`, `compound_authority_error`).
- `src/services/researchBrain/db.ts` — in `replaceBioprospectingFactsForSource`, build the per-source alias `Map<normalizedAlias, compoundId>` and stamp `compound_canonical_id` on each payload row. The hot-path change is small.
- `src/services/researchBrain/index.ts` — re-export `compoundAuthority`.
- `src/routes/research-brain.ts` — three new routes, mirroring the taxonomy trio (`/taxonomy`, `/taxonomy/normalize`).
- `src/services/researchBrain/db.ts` `EDITABLE_BIOPROSPECTING_ENTITY_FIELDS` — do NOT add `compound` here. Editing `compound` should re-trigger `compound_authority_status = 'pending'`, which is a separate UI concern. Defer to a follow-up; the existing taxonomy patch already shows the pattern.
- `openspec/config.yaml` — no change (schema-driven mode).

## 9. Risks and open questions

### Risks

1. **PubChem rate limits in production.** 5 req/s anonymous is fine for a backfill but a synchronous lookup during LLM extraction would blow it. Mitigated by: alias-table-first lookup, async backfill, 4 req/s cap. Document the 429 retry strategy in design.md.
2. **InChIKey collisions across stereoisomers.** Curcumin has an InChIKey that *does* differ between E,E and Z,Z isomers. We store the InChIKey we got from PubChem and accept that a fact mentioning "cis-curcumin" will map to the same canonical as "trans-curcumin" if PubChem has only one entry. Acceptable for v1; document the limitation in the spec.
3. **The dedup spec's "fuera de scope" note** explicitly carves out alias resolution. This change is a SEPARATE project per that note — make sure the change folder name (`bioprospecting-compound-authority`) and the proposal.md explicitly call out that this is the long-promised follow-up.
4. **Mixture detection is regex-based.** "Ethanolic extract" matches, but a sentence-level extraction that returns "Curcuma longa lipid fraction" with "fraction" present will be skipped. "Crude methanol extract" will be skipped. Good. But "terpene-rich fraction" — is "terpene" a single compound or a class? The regex only catches "fraction"; "terpene" will be looked up and likely miss PubChem → marked pending → resolved to a generic entry or backfill-failed. This is the right behavior: it surfaces ambiguity to the reviewer.
5. **LLM hallucination of compound names.** The LLM already sometimes emits "peptide" / "protein" / "polysaccharide" as compound values (see `bioprospectingExtractor.ts:184`). These are chemical classes, not compounds. The authority table will rightly fail to resolve them. The fact gets `compound_authority_status = 'failed'`; we should add a UI affordance or a small LLM re-prompt to clarify. Defer UI; the metadata column will capture the failure for review.
6. **`compound` is a free text column AND we're adding a FK.** The risk: editorial flow lets a curator change `compound` text without re-running authority. Mitigated by the existing `updateBioprospectingFactEntities` patch flow — we add a small hook that resets `compound_authority_status = 'pending'` when `compound` changes. Low effort.

### Open questions for the proposal phase

1. **What happens to the existing `compound` text when a canonical is resolved?** Option A: leave the raw text untouched (the LLM's original word). Option B: overwrite with `canonical_name`. **Recommendation: A.** It preserves the source's wording for the quote/provenance view, and the raw text is what reviewers expect to see. The canonical id is the dedup signal, not the display.
2. **Should we also handle `compound_class` (the WHOLE-class field, e.g. "alkaloid")?** No — different code path. Compound classes don't have InChIKeys; they map to ChEBI ontology entries, which is a Phase 3 problem. Out of scope for v1.
3. **Do we expose compound authority in the provenance viewer (PR #3)?** The viewer already shows evidence tables; showing the canonical compound name as a sidecar would be a small win. Defer to design phase — not blocking.
4. **Admin role for manual curation.** The codebase has `authResolver` but no documented role names I can find. Need to confirm the role/scope model before designing the `POST /aliases` route. Check `src/middleware/authResolver.ts` during the design phase.

### Bottom line

The pattern is well-established (`taxonomy.ts` is the template), the data source is clear (PubChem, with ChEBI as a future enrichment), the scope question is settled (single molecules only; extracts and fractions are a different code path), and the integration is conservative (no change to the shipped dedup key). Estimated effort: **medium**, ~1500 LOC across 1 PR with maybe 2 reviewable slices (schema+seed → service+backfill → routes).
