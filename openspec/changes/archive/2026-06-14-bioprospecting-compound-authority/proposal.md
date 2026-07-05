# Proposal: Bioprospecting Compound Authority

## Intent

Resolve the free-text `compound` field on bioprospecting facts to a canonical chemistry identity, separating single molecules from extracts/mixtures, and exposing that canonical form (alongside the raw text) to the rest of the system. This prevents false-positive dedup between "curcumin" and "Curcuma longa extract", enables cross-source aggregation on the same molecule under different names (curcumin / diferuloylmethane / IUPAC), and creates a flexible audit trail for every canonical-id change.

## Scope

### In Scope

- New capability: `bioprospecting-compound-authority` — canonical compound table, alias resolution, PubChem backfill, admin curation, audit trail.
- Modified capability: `bioprospecting-fact-dedup` — add `compound_canonical_id` as a parallel signal. The existing 5-tuple `identity_key` shape is **unchanged**.
- New tables: `research_compounds`, `research_compound_aliases`, `compound_authority_audit` (flexible audit trail for all status changes and manual edits).
- New columns on `research_bioprospecting_facts`:
  - `compound_canonical_id` (UUID, FK → `research_compounds.id`, ON DELETE SET NULL)
  - `compound_authority_status` (enum: `verified` | `pending` | `failed` | `skipped`)
  - `compound_authority_at` (TIMESTAMPTZ)
  - `compound_authority_error` (TEXT)
- New service module: `src/services/researchBrain/compoundAuthority.ts` (mirrors `taxonomy.ts`).
- New BullMQ scheduled job: `compound-authority` queue, runs every `COMPOUND_AUTHORITY_INTERVAL_HOURS` (default 6h).
- New seed: `seeds/compounds-top-50.json` + idempotent loader (hand-curated top compounds + PubChem CID map).
- 3 new API routes: `GET /api/research-brain/compounds`, `GET /api/research-brain/compounds/:id`, `POST /api/research-brain/compounds/:id/aliases` (admin).
- Compound display: keep raw `compound` text on the row; UI appends a "→ Curcumin" badge when `compound_canonical_id` is set. **The raw text is never overwritten by the canonical name.**
- Edit reset: when `fact.compound` is edited and the resolved `compound_canonical_id` changes, insert a row into `compound_authority_audit` with old/new canonical, timestamp, `user_id`, and `reason`. Audit is additive and flexible (JSONB `old_value` / `new_value`).
- Retry policy: 5 attempts in 24h with exponential backoff. After exhaustion, status moves to `failed`; an admin can re-promote `failed` → `pending`.
- Provenance viewer: when raw ≠ canonical, the viewer shows both ("diferuloylmethane → Curcumin"). No data loss in the evidence trail.
- Status flow: new compound → `pending`. Backfill worker → `verified` (PubChem hit) or `failed` (after 5 retries) or `skipped` (extract/mixture). Admin can re-promote `failed` → `pending`.

### Out of Scope

- Changing the existing 5-tuple `identity_key` shape (deferred; possible Phase 2 "strong dedup" by canonical id).
- Cross-linking ChEBI relationships ("curcumin ⊂ turmeric extract") — separate change.
- `compound_class` authority (alkaloid / terpenoid) — different code path, no InChIKey.
- LLM re-prompt to clarify chemical-class vs compound misclassifications — UI follow-up.
- Real-time PubChem resolution during LLM extraction (kept async to respect rate limits).

## Capabilities

### New Capabilities
- `bioprospecting-compound-authority`: Canonical compound registry, alias resolution, async PubChem backfill, admin curation, and audit trail.

### Modified Capabilities
- `bioprospecting-fact-dedup`: Add `compound_canonical_id` and `compound_authority_status` columns to the fact row. The `identity_key` is **unchanged**. The canonical id is a parallel signal that strengthens dedup evidence and supports admin views, but the existing 5-tuple key remains the sole inline dedup driver.

## Approach

### Storage (3 new tables + 4 new columns)

**`research_compounds`** — canonical registry, mirrors `research_taxa`:
```sql
CREATE TABLE public.research_compounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,        -- display name (e.g. "Curcumin")
  normalized_name TEXT NOT NULL UNIQUE,-- NFKD + diacritic strip + lower + collapse
  inchi_key TEXT,                      -- standard chemical hash
  pubchem_cid INTEGER,                 -- nullable: compounds PubChem doesn't know
  chebi_id INTEGER,                    -- nullable, future cross-link
  molecular_formula TEXT,
  iupac_name TEXT,
  compound_kind TEXT NOT NULL DEFAULT 'small_molecule'
    CHECK (compound_kind IN ('small_molecule', 'peptide', 'protein', 'lipid', 'other')),
  status TEXT NOT NULL DEFAULT 'local'
    CHECK (status IN ('local', 'pubchem', 'chebi', 'manual', 'curated')),
  external_ids JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_research_compounds_inchi_key
  ON public.research_compounds (inchi_key) WHERE inchi_key IS NOT NULL;
CREATE INDEX idx_research_compounds_pubchem_cid
  ON public.research_compounds (pubchem_cid) WHERE pubchem_cid IS NOT NULL;
```

**`research_compound_aliases`** — alias → canonical mapping:
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

**`compound_authority_audit`** — flexible audit trail for ALL canonical-id and status changes:
```sql
CREATE TABLE public.compound_authority_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('status_change', 'manual_edit', 'manual_alias_add')),
  old_value JSONB,    -- e.g. {"status": "verified", "canonical_id": "..."}
  new_value JSONB,    -- e.g. {"status": "pending", "reason": "compound_text_edited"}
  user_id UUID,       -- nullable: NULL = system/worker event
  reason TEXT,        -- free-text, e.g. "compound text edited from X to Y"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_compound_authority_audit_fact
  ON public.compound_authority_audit (fact_id, created_at DESC);
```
The JSONB payload is intentionally flexible: it captures the *minimum* needed to reconstruct who changed what, without locking the schema to specific column sets. A `status_change` event stores `{"compound_authority_status": "verified", "compound_canonical_id": "..."}`. A `manual_edit` event stores the diff on `compound` text. A `manual_alias_add` event stores the new alias and target.

**FK on the fact table:**
```sql
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN compound_canonical_id UUID
    REFERENCES public.research_compounds(id) ON DELETE SET NULL,
  ADD COLUMN compound_authority_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (compound_authority_status IN ('pending', 'verified', 'failed', 'skipped')),
  ADD COLUMN compound_authority_at TIMESTAMPTZ,
  ADD COLUMN compound_authority_error TEXT;
CREATE INDEX idx_research_bioprospecting_compound_canonical
  ON public.research_bioprospecting_facts (compound_canonical_id)
  WHERE compound_canonical_id IS NOT NULL;
```

### Compound display (decision version 4.1)

The `compound` column **stays raw text** — the LLM's original wording, the reviewer's quote, the audit anchor. The UI adds a badge: when `compound_canonical_id IS NOT NULL` and the resolved `canonical_name` differs from the raw `compound`, render the raw value followed by `→ {canonical_name}`. The provenance viewer shows both side by side ("diferuloylmethane → Curcumin") with the InChIKey and PubChem CID available on click.

### Edit reset (decision version 4.2)

When the editorial flow (`updateBioprospectingFactEntities` or equivalent) changes `fact.compound` text:
1. Re-run the alias lookup against the in-memory alias map for the new text.
2. If the new `compound_canonical_id` differs from the previous value (or the previous value was NULL and the new one is not, or vice versa), insert a `compound_authority_audit` row with `event_type = 'manual_edit'`, `old_value` = previous canonical state, `new_value` = new canonical state, `user_id` = editor, `reason` = `'compound_text_changed'`.
3. Set `compound_authority_status` to `verified` (if hit) or `pending` (if miss → backfill queue picks it up next cycle).
4. **Never** overwrite the raw `compound` text. The raw text is the audit anchor.

### Status flow (decision version 4.6)

```
new fact          → pending
alias hit         → verified (synchronous, during extraction)
extract detected  → skipped   (reason: 'extract_or_mixture')
PubChem hit       → verified  (asynchronous, during backfill)
PubChem miss      → failed    (after 5 retries in 24h)
admin re-promote  → failed → pending
edit compound     → re-resolve; audit row inserted
```

### Retry policy (decision version 4.3)

5 attempts within a 24h window with exponential backoff (e.g. 1m, 5m, 25m, 2h, 8h). After exhaustion, the fact moves to `failed` and stops being retried. The worker keeps trying other `pending` facts. An admin route (`POST /api/research-brain/compounds/:id/aliases` followed by an internal `requeueCompound` call) can re-promote a single fact from `failed` → `pending` for one more attempt cycle. Bulk requeue is a separate admin endpoint (Phase 2).

### Single-molecule rule (decision version 4.8)

A `looksLikeExtract(value)` predicate (regex on `extract|oil|fraction|tincture|juice|powder|infusion|decoction|TME|essential oil|resin|formulation|preparation|solution|suspension|emulsion|blend|mixture|combination`) decides whether the value is eligible for canonical resolution. If true, the fact gets `compound_authority_status = 'skipped'`, `compound_authority_error = 'extract_or_mixture'`, and `compound_canonical_id` stays NULL. The fact still participates in the existing 5-tuple raw-text dedup with other "extract" facts, but never merges with a single-molecule fact.

### Backfill worker (decision version 4.5)

A BullMQ `compound-authority` queue. Worker:
1. Picks facts where `compound_authority_status = 'pending'` AND `compound_authority_at` is NULL OR older than the last backoff window.
2. Cap at 500 facts per run (mirrors taxonomy).
3. Hits PubChem at 4 req/s (under the 5 req/s anonymous limit) using a token-bucket gate.
4. On hit: GET `/rest/pug/compound/name/{name}/cids/JSON` → GET `/rest/pug/compound/cid/{cid}/property/InChIKey,MolecularFormula,IUPACName/JSON` → upsert canonical + alias rows → stamp `compound_canonical_id` + `compound_authority_status = 'verified'`.
5. On miss: increment retry count; if < 5, schedule next retry with backoff; if ≥ 5, mark `failed` with `compound_authority_error` = last response excerpt.
6. Configurable via `COMPOUND_AUTHORITY_INTERVAL_HOURS` (default 6).

### Initial seed (decision version 4.7)

`seeds/compounds-top-50.json` — hand-curated list of ~50 top bioprospecting compounds (curcumin, DHA, EPA, paclitaxel, bryostatin, quercetin, resveratrol, etc.) with their PubChem CIDs, InChIKeys, and a starter alias set. The seed loader is idempotent: skip rows whose `pubchem_cid` already exists. On first deploy, run-once script `bun run seed:compounds` populates the table. After that, the seed file is the source of truth for "which compounds are guaranteed to resolve without a PubChem round-trip".

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `supabase/migrations/20260613000000_create_compound_authority.sql` | New | 3 tables + 4 fact columns + 5 indexes |
| `src/services/researchBrain/compoundAuthority.ts` | New | PubChem client, alias lookup, upsert, backfill script, retry policy |
| `src/services/researchBrain/compoundAuthority.worker.ts` | New | BullMQ worker, 4 req/s gate, exponential backoff |
| `src/services/researchBrain/types.ts` | Modified | `ResearchCompound`, `ResearchCompoundAlias`, `CompoundAuthorityAudit`, 4 new fact columns |
| `src/services/researchBrain/db.ts` | Modified | Build alias map in `replaceBioprospectingFactsForSource`; reset `compound_authority_status` on `compound` edit; insert audit row |
| `src/services/queue/queues.ts` | Modified | Register `compound-authority` queue |
| `src/services/queue/workers/index.ts` | Modified | Wire `compoundAuthority` worker |
| `src/routes/research-brain.ts` | Modified | 3 new routes: search, get-by-id, add-alias (admin) |
| `src/services/researchBrain/index.ts` | Modified | Re-export `compoundAuthority` |
| `seeds/compounds-top-50.json` | New | Curated top-50 + PubChem CIDs + InChIKeys + starter aliases |
| `scripts/seed/load-compounds.ts` | New | Idempotent loader |
| `client/src/...` (provenance viewer, fact table) | Modified | Render `→ Canonical` badge when `compound_canonical_id` set |
| `.env.example` | Modified | `COMPOUND_AUTHORITY_INTERVAL_HOURS=6` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| PubChem rate limit hit (5 req/s) | Medium | 4 req/s cap, token-bucket gate, async backfill, no synchronous PubChem calls during extraction |
| InChIKey collisions across stereoisomers | Low | Accept limitation in v1; document in spec; future "strong dedup" can disambiguate |
| `compound` edit bypasses authority reset | Medium | Audit hook in `updateBioprospectingFactEntities`; if `compound` text changes, reset status and insert audit row |
| LLM emits chemical classes ("alkaloid", "peptide") as compound values | Medium | Authority misses them → `pending` → backfill fails after 5 tries → `failed` with reason visible to reviewer. No false positive. |
| Audit table grows unbounded | Low | One row per event; partition by month if it exceeds 1M rows |
| 5 retries × 24h exceeds user's research-cycle window | Medium | Admin route re-promotes `failed` → `pending` for one more attempt cycle; bulk requeue in Phase 2 |
| Worker offline for >24h | Low | BullMQ delayed jobs persist; on restart, all due retries fire |

## Rollback Plan

1. **Stop the worker**: `COMPOUND_AUTHORITY_ENABLED=false` (new flag) halts the scheduled job; existing rows are untouched.
2. **Remove the FK from the fact table**: `ALTER TABLE research_bioprospecting_facts DROP COLUMN compound_canonical_id, compound_authority_status, compound_authority_at, compound_authority_error;` — facts keep their raw `compound` text intact.
3. **Drop the new tables** if needed: `DROP TABLE compound_authority_audit, research_compound_aliases, research_compounds;`
4. **No dependency on the canonical id from any other table** — the 5-tuple `identity_key` is unchanged, so existing dedup is unaffected.
5. **Revert the migration** in a single transaction if necessary; the migration is self-contained (no downstream schema changes that depend on these columns).

## Dependencies

- Existing `bioprospecting-fact-dedup` capability (5-tuple `identity_key` stays the same; we add a parallel signal).
- Existing `taxonomy.ts` pattern (`research_taxa` / `research_taxon_aliases`) as the structural template.
- PubChem PUG-REST API (no key, anonymous 5 req/s).
- BullMQ (already in use; new `compound-authority` queue).
- Supabase (already in use; new migration).
- The editorial flow that updates `research_bioprospecting_facts.compound` (must be patched to reset authority status and insert audit row).

## Success Criteria

- [ ] Migration creates `research_compounds`, `research_compound_aliases`, `compound_authority_audit` + 4 fact columns
- [ ] `seeds/compounds-top-50.json` loads idempotently on first deploy
- [ ] During extraction: alias-table hit stamps `compound_canonical_id` + `verified`; extract predicate sets `skipped`; miss leaves `pending`
- [ ] Backfill worker respects 4 req/s PubChem limit, retries 5× in 24h with exponential backoff, marks `failed` after exhaustion
- [ ] Editing `fact.compound` re-resolves canonical id and inserts a `compound_authority_audit` row with `event_type='manual_edit'`
- [ ] Admin route `POST /api/research-brain/compounds/:id/aliases` adds a new alias and inserts a `compound_authority_audit` row with `event_type='manual_alias_add'`
- [ ] UI shows raw + `→ Canonical` badge when canonical resolves to a different name
- [ ] Provenance viewer shows both values when raw ≠ canonical
- [ ] The 5-tuple `identity_key` column on `research_bioprospecting_facts` is **unchanged** in shape and contents
- [ ] `COMPOUND_AUTHORITY_INTERVAL_HOURS` env var controls the worker schedule (default 6h)
- [ ] All PubChem errors return gracefully; the worker never crashes a cycle on a single bad fact
- [ ] No regression: existing 5-tuple dedup continues to work for facts with and without canonical id

## Delivery

- ~1800 LOC across 1 PR with 2-3 reviewable slices.
- Slice 1: migration + types + seed loader + fact-column wiring.
- Slice 2: `compoundAuthority.ts` (PubChem client, alias lookup, upsert, extract predicate) + backfill script.
- Slice 3: BullMQ worker + 3 routes + UI badge + provenance viewer update + audit hook.
- 400-line review budget risk: Medium (mitigated by chained slices).
