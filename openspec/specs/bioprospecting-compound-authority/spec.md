# Spec: bioprospecting-compound-authority

## Purpose

Resolve the free-text `compound` field on bioprospecting facts to a
canonical chemistry identity so that the same molecule emitted under
different surface forms (curcumin / diferuloylmethane / IUPAC) is
treated as a single entity by the Research Brain. The capability
separates single molecules from extracts and mixtures, exposes a
canonical display name alongside the raw text (without overwriting
the raw text), and provides a flexible audit trail for every status
change and every manual edit.

This is a Phase 1 implementation. Resolution is asynchronous
(PubChem is hit by a scheduled worker, never synchronously during
LLM extraction). The capability mirrors the structural template of
the existing `taxonomy` subsystem (`research_taxa` +
`research_taxon_aliases`) and follows the same edge-table audit
pattern (`compound_authority_audit`).

## Requirements

### Requirement: research_compounds Schema

The system MUST create a `research_compounds` table that stores the
canonical chemistry identity for every compound the Research Brain
has resolved. The table mirrors `research_taxa` structurally and is
the single source of truth for canonical compound display.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.research_compounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name      TEXT NOT NULL,
  normalized_name     TEXT NOT NULL UNIQUE,
  inchi_key           TEXT,
  pubchem_cid         INTEGER,
  chebi_id            INTEGER,
  molecular_formula   TEXT,
  iupac_name          TEXT,
  compound_kind       TEXT NOT NULL DEFAULT 'small_molecule'
    CHECK (compound_kind IN ('small_molecule', 'peptide', 'protein', 'lipid', 'other')),
  status              TEXT NOT NULL DEFAULT 'local'
    CHECK (status IN ('local', 'pubchem', 'chebi', 'manual', 'curated')),
  external_ids        JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_compounds_inchi_key
  ON public.research_compounds (inchi_key) WHERE inchi_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_compounds_pubchem_cid
  ON public.research_compounds (pubchem_cid) WHERE pubchem_cid IS NOT NULL;
```

**Column semantics:**

- `canonical_name` is the human-display name (e.g. "Curcumin") chosen
  by the seed curator, the PubChem backfill, or an admin edit. It
  MUST be non-null.
- `normalized_name` is `canonical_name` after the same
  NFKD + diacritic-strip + non-alphanumeric-to-space + lowercase +
  whitespace-collapse transform used by `normalizeForIdentity`. It
  is UNIQUE — the table MUST NOT contain two canonical rows whose
  names collapse to the same form.
- `inchi_key` is the InChIKey (InChI v1, hashed first block) for
  stereoisomer-discriminated lookups. Nullable because compounds
  PubChem does not recognize (e.g. obscure natural products, novel
  scaffolds) MUST still be representable.
- `pubchem_cid` is the PubChem compound ID, nullable for the same
  reason. Indexed only when present.
- `chebi_id` is reserved for a future ChEBI cross-link (out of
  scope for this change; column is present but unused).
- `molecular_formula` and `iupac_name` are populated by the PubChem
  backfill when available; both nullable.
- `compound_kind` discriminates molecule classes. The default
  `'small_molecule'` covers the dominant case. `'peptide'`,
  `'protein'`, `'lipid'`, and `'other'` are reserved for future
  expansion.
- `status` records provenance of the canonical row: `'local'`
  (manually created, no external authority), `'pubchem'` (resolved
  from PubChem), `'chebi'` (resolved from ChEBI, future),
  `'manual'` (admin override of an existing row), `'curated'` (came
  from the hand-curated seed file).
- `external_ids` and `metadata` are JSONB bags for forward
  compatibility; the schema MUST NOT lock column shape to specific
  external IDs.

#### Scenario: Inserting a canonical row populates both name and normalized form

- GIVEN an admin call to `addCompound({ canonical_name: "Curcumin", status: "curated" })`
- WHEN the row is persisted
- THEN `canonical_name = "Curcumin"`
- AND `normalized_name = "curcumin"`
- AND `status = "curated"`
- AND `compound_kind = "small_molecule"`
- AND `id` is a server-generated UUID

#### Scenario: Two rows with the same normalized form are rejected

- GIVEN an existing row with `canonical_name = "Curcumin"`,
  `normalized_name = "curcumin"`
- WHEN a second insert attempts `canonical_name = "CURCUMIN"`
- THEN the insert MUST fail with a unique-constraint violation on
  `normalized_name`
- AND the second row MUST NOT exist

#### Scenario: InChIKey index only covers non-null keys

- GIVEN the migration has run and `research_compounds` is empty
- WHEN an admin inserts a row with `inchi_key = NULL`
- THEN no entry is added to `idx_research_compounds_inchi_key`
- AND the row is still queryable by `id`

### Requirement: research_compound_aliases Schema

The system MUST create a `research_compound_aliases` table that maps
alternative names (synonyms, trade names, IUPAC names, reviewer
spelling variants) onto a canonical compound row. The alias table is
the fast lookup path that avoids a PubChem round-trip on every
extraction.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.research_compound_aliases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compound_id       UUID NOT NULL REFERENCES public.research_compounds(id) ON DELETE CASCADE,
  alias             TEXT NOT NULL,
  normalized_alias  TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'local_extraction'
    CHECK (source IN ('local_extraction', 'pubchem', 'chebi', 'manual', 'curated')),
  confidence        TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (compound_id, normalized_alias)
);
CREATE INDEX IF NOT EXISTS idx_research_compound_aliases_normalized
  ON public.research_compound_aliases (normalized_alias);
```

**Column semantics:**

- `compound_id` is the FK to the canonical row; `ON DELETE CASCADE`
  ensures aliases cannot outlive their parent.
- `alias` is the surface form (preserved for display).
- `normalized_alias` is `alias` after the standard transform;
  uniqueness is enforced on `(compound_id, normalized_alias)` so the
  same alias may exist against different canonical rows (e.g. if
  curators disagree) but never twice against the same canonical row.
- `source` records how the alias was added: `'local_extraction'`
  (default, system-derived), `'pubchem'` (returned by the PubChem
  synonym endpoint), `'chebi'` (future), `'manual'` (added by an
  admin), `'curated'` (from the seed file).
- `confidence` is the curator's assessment of how safe the alias is
  to use for automated resolution. Defaults to `'medium'`.
- `metadata` is a JSONB bag for the original PubChem synonym list,
  MeSH IDs, or reviewer notes; the schema MUST NOT lock it.

#### Scenario: Alias lookup resolves a surface form to a canonical row

- GIVEN a row in `research_compound_aliases` with
  `compound_id = C`, `alias = "Diferuloylmethane"`,
  `normalized_alias = "diferuloylmethane"`
- WHEN `lookupAlias("diferuloylmethane")` runs
- THEN it returns `C.id`
- AND it does NOT issue a PubChem call

#### Scenario: Same alias for two different canonical rows is allowed

- GIVEN existing rows
  `(compound_id = C1, normalized_alias = "x")` and
  `(compound_id = C2, normalized_alias = "x")`
- WHEN a third insert attempts `(compound_id = C1, normalized_alias = "x")`
- THEN the insert MUST fail with a unique-constraint violation
  (UNIQUE on (compound_id, normalized_alias))
- AND the existing row is untouched

#### Scenario: Cascading delete removes aliases

- GIVEN a canonical row C with 3 aliases
- WHEN `DELETE FROM research_compounds WHERE id = C` runs
- THEN all 3 alias rows for C are deleted
- AND the audit table rows that reference those facts keep their
  `fact_id` (no cascade to audit)

### Requirement: compound_authority_audit Schema

The system MUST create a `compound_authority_audit` table that
records every change to a fact's compound authority state, the raw
compound text, or the manual alias set. The table is the flexible
audit trail the proposal commits to and follows the JSONB-diff
pattern: each row stores a structured snapshot of what changed,
without locking the schema to specific column sets.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS public.compound_authority_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id     UUID NOT NULL REFERENCES public.research_bioprospecting_facts(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL
    CHECK (event_type IN ('status_change', 'manual_edit', 'manual_alias_add')),
  old_value   JSONB,
  new_value   JSONB,
  user_id     UUID,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_compound_authority_audit_fact
  ON public.compound_authority_audit (fact_id, created_at DESC);
```

**Column semantics:**

- `fact_id` is the FK to the fact row whose authority state changed.
  `ON DELETE CASCADE` ensures audit rows are not orphaned by fact
  deletion. Manual alias audits MAY reference a sentinel fact id (or
  the schema MAY be relaxed in a follow-up to permit
  `fact_id = NULL` for alias-only events; the spec author defers this
  to design).
- `event_type` discriminates the kind of change.
  `'status_change'` records a transition (e.g. pending → verified,
  verified → failed, failed → pending). `'manual_edit'` records a
  human edit of `fact.compound` text. `'manual_alias_add'` records
  an admin call to add a new alias.
- `old_value` and `new_value` are JSONB snapshots. For
  `status_change`, both are objects of the shape
  `{ compound_canonical_id, compound_authority_status,
    compound_authority_error }`. For `manual_edit`, both are objects
  `{ compound, compound_canonical_id, compound_authority_status }`.
  For `manual_alias_add`, `old_value` is null and `new_value` is
  `{ compound_id, alias, normalized_alias, source, confidence }`.
- `user_id` is the actor for human-driven events. For system /
  worker events it is `null`.
- `reason` is a free-text note (e.g. "compound text edited from
  curcumin to Curcuma longa extract"). Optional for system events.
- `created_at` is the server timestamp at audit insertion.

The JSONB payload is intentionally flexible: it captures the minimum
needed to reconstruct who changed what without locking the schema to
specific column sets. Consumers MUST treat unknown JSONB keys as
forward-compatible extensions and MUST NOT fail on missing keys.

#### Scenario: Status transition records a structured diff

- GIVEN a fact F with `compound_authority_status = 'pending'`,
  `compound_canonical_id = NULL`
- WHEN the backfill worker resolves F to canonical C and stamps
  `compound_authority_status = 'verified'`,
  `compound_canonical_id = C.id`
- THEN a row exists in `compound_authority_audit` with
  `event_type = 'status_change'`,
  `old_value = { compound_authority_status: 'pending', compound_canonical_id: null }`,
  `new_value = { compound_authority_status: 'verified', compound_canonical_id: C.id }`,
  `user_id = NULL`, `reason = 'pubchem_resolved'`

#### Scenario: Manual compound edit records the text diff

- GIVEN a fact F with `compound = 'curcumin'`,
  `compound_canonical_id = C_curcumin`,
  `compound_authority_status = 'verified'`
- WHEN an editor changes F.compound to 'Curcuma longa extract'
- AND the system re-resolves the canonical id (to NULL — extract)
- AND stamps `compound_authority_status = 'skipped'`
- THEN a row exists in `compound_authority_audit` with
  `event_type = 'manual_edit'`,
  `old_value = { compound: 'curcumin', compound_canonical_id: C_curcumin, compound_authority_status: 'verified' }`,
  `new_value = { compound: 'Curcuma longa extract', compound_canonical_id: null, compound_authority_status: 'skipped' }`,
  `user_id = <editor uuid>`, `reason = 'compound_text_changed'`

#### Scenario: Manual alias add records the new alias

- GIVEN a canonical row C and an admin user U
- WHEN the admin calls `addAlias(C.id, 'turmeric-extract-curcumin', 'manual', 'high', U.id)`
- THEN a row exists in `compound_authority_audit` with
  `event_type = 'manual_alias_add'`,
  `old_value = null`,
  `new_value = { compound_id: C.id, alias: 'turmeric-extract-curcumin', normalized_alias: 'turmeric extract curcumin', source: 'manual', confidence: 'high' }`,
  `user_id = U.id`

#### Scenario: Audit index supports chronological fact history

- GIVEN a fact F with 5 audit rows spread across 30 days
- WHEN `SELECT * FROM compound_authority_audit WHERE fact_id = F ORDER BY created_at DESC` runs
- THEN the result is returned in descending chronological order
- AND the index `idx_compound_authority_audit_fact` is used

### Requirement: Fact Table Authority Columns

The system MUST add four columns to `research_bioprospecting_facts`
that link each fact to a canonical compound and record the
authority state. The four columns are additive; the existing
`identity_key` and the 5-tuple raw-text dedup are unchanged.

**Schema:**

```sql
ALTER TABLE public.research_bioprospecting_facts
  ADD COLUMN IF NOT EXISTS compound_canonical_id UUID
    REFERENCES public.research_compounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS compound_authority_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (compound_authority_status IN ('pending', 'verified', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS compound_authority_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS compound_authority_error TEXT;
CREATE INDEX IF NOT EXISTS idx_research_bioprospecting_compound_canonical
  ON public.research_bioprospecting_facts (compound_canonical_id)
  WHERE compound_canonical_id IS NOT NULL;
```

**Column semantics:**

- `compound_canonical_id` is the FK to `research_compounds.id`. Set
  to NULL when the canonical is unknown, when the value is an
  extract/mixture, or when the canonical row is deleted (`ON DELETE
  SET NULL`).
- `compound_authority_status` is the lifecycle marker.
  - `'pending'` — the fact was extracted and no canonical resolution
    has happened yet (or the resolution failed and is queued for
    retry).
  - `'verified'` — the canonical id is set and was resolved by an
    alias hit or by PubChem.
  - `'failed'` — the canonical id could not be resolved after
    `COMPOUND_AUTHORITY_MAX_RETRIES` (default 5) attempts in 24h.
  - `'skipped'` — the value matches the `looksLikeExtract` predicate;
    canonical resolution is intentionally not attempted.
  - Default for new facts inserted by the extractor is `'pending'`
    (or `'skipped'` for extracts — see the extract-detection
    requirement below).
- `compound_authority_at` is the timestamp of the last authority
  action on this fact. Nullable for facts that have never been
  resolved.
- `compound_authority_error` is the last error message (e.g. the
  PubChem response excerpt after a failed attempt). Nullable on
  success and on `skipped`.

The partial index on `compound_canonical_id` (only non-null) supports
the "show all facts for this canonical" admin query without bloating
the index with the majority of NULLs.

#### Scenario: New fact from extraction has pending status

- GIVEN a fresh extraction produces a fact F with
  `compound = 'quercetin'`
- AND no row in `research_compounds` matches `'quercetin'`
- AND the alias table has no match either
- WHEN the extractor persists F
- THEN `compound_canonical_id = NULL`
- AND `compound_authority_status = 'pending'`
- AND `compound_authority_at = NULL`
- AND `compound_authority_error = NULL`

#### Scenario: Alias hit during extraction sets verified status

- GIVEN the alias table contains
  `('diferuloylmethane', C_curcumin)`
- WHEN the extractor persists a fact F with `compound =
  'diferuloylmethane'`
- THEN `compound_canonical_id = C_curcumin.id`
- AND `compound_authority_status = 'verified'`
- AND `compound_authority_at = NOW()` (server timestamp)
- AND no PubChem call is made

#### Scenario: Extract predicate sets skipped status

- GIVEN the extractor produces a fact F with
  `compound = 'Curcuma longa extract'`
- WHEN the extractor persists F
- THEN `looksLikeExtract('Curcuma longa extract')` returns `true`
- AND `compound_canonical_id = NULL`
- AND `compound_authority_status = 'skipped'`
- AND `compound_authority_error = 'extract_or_mixture'`

#### Scenario: ON DELETE SET NULL preserves the fact row

- GIVEN a fact F with `compound_canonical_id = C.id`
- WHEN an admin deletes the canonical row C
- THEN F's row is preserved
- AND `compound_canonical_id = NULL`
- AND `compound_authority_status` is unchanged

### Requirement: looksLikeExtract Predicate

The system MUST export a `looksLikeExtract(value: string): boolean`
function from `src/services/researchBrain/compoundAuthority.ts`
that decides whether a compound value is an extract or mixture and
therefore ineligible for canonical resolution.

**Behavior:**

- The function MUST match the value against a regex covering the
  lexical cues: `extract`, `oil`, `fraction`, `tincture`, `juice`,
  `powder`, `infusion`, `decoction`, `TME`, `essential oil`,
  `resin`, `formulation`, `preparation`, `solution`, `suspension`,
  `emulsion`, `blend`, `mixture`, `combination`.
- The match MUST be case-insensitive and word-boundary-aware.
- The function MUST be pure: no IO, no LLM, no PubChem call. It is
  called inline during extraction for every fact.
- A `true` result MUST cause the caller to set
  `compound_authority_status = 'skipped'` and
  `compound_authority_error = 'extract_or_mixture'`.
- A `false` result MUST cause the caller to attempt alias lookup;
  on alias miss, the fact remains `pending` for the backfill worker.

The function is intentionally conservative. A value that is not on
the list is treated as a candidate single molecule and pushed to the
backfill queue. False positives (skipped when it should be pending)
are recoverable by an admin edit; false negatives (pending when it
should be skipped) are caught on the next backfill pass when PubChem
fails to find a CID.

#### Scenario: Common extract phrases return true

- GIVEN inputs `"Echinacea purpurea extract"`, `"turmeric essential
  oil"`, `"green tea infusion"`, `"TME-1"`, `"fish oil"`, and
  `"crude methanol fraction"`
- WHEN `looksLikeExtract` runs on each
- THEN every result is `true`

#### Scenario: Single molecule names return false

- GIVEN inputs `"curcumin"`, `"quercetin-3-O-glucoside"`,
  `"EPA"`, `"diferuloylmethane"`, and `"bryostatin-1"`
- WHEN `looksLikeExtract` runs on each
- THEN every result is `false`

#### Scenario: Predicate is case-insensitive

- GIVEN input `"COLD-PRESSED FISH OIL"`
- WHEN `looksLikeExtract` runs
- THEN the result is `true`

### Requirement: resolveCompoundStatus Initial Resolution

The system MUST export a `resolveCompoundStatus(value: string):
CompoundStatus` function from
`src/services/researchBrain/compoundAuthority.ts` that decides the
initial status for a freshly extracted fact based on the alias
table and the extract predicate.

**Behavior:**

The function MUST apply the rules in this order:

1. If `looksLikeExtract(value)` returns `true`, return
   `'skipped'`. No alias lookup is attempted.
2. Otherwise, look up `value` (after the standard normalization)
   in `research_compound_aliases`:
   - If a match is found, return the matched canonical's id and
     `'verified'`. (The id is returned alongside the status to
     avoid a second lookup.)
   - If no match is found, return `null` for the id and `'pending'`.
3. The function MUST NOT issue a PubChem call. PubChem resolution is
   the worker's job.

The function MUST be safe to call inline during extraction: it is a
single SQL query (or an in-memory alias-map lookup if the map is
preloaded at process start), bounded by the size of the alias table,
and emits no network traffic.

#### Scenario: Extract values short-circuit to skipped

- GIVEN `value = 'Curcuma longa extract'`
- WHEN `resolveCompoundStatus(value)` runs
- THEN the result is `{ canonicalId: null, status: 'skipped' }`
- AND no alias lookup is performed

#### Scenario: Alias hit returns the canonical and verified

- GIVEN the alias table has `(alias = 'diferuloylmethane', compound_id = C_curcumin)`
- WHEN `resolveCompoundStatus('diferuloylmethane')` runs
- THEN the result is `{ canonicalId: C_curcumin.id, status: 'verified' }`
- AND no PubChem call is performed

#### Scenario: Miss leaves the fact pending

- GIVEN no alias matches `'obscurenaturalproduct'`
- WHEN `resolveCompoundStatus('obscurenaturalproduct')` runs
- THEN the result is `{ canonicalId: null, status: 'pending' }`
- AND the fact is queued for the backfill worker

### Requirement: attachCanonicalToFact Fact Update

The system MUST export an
`attachCanonicalToFact(factId, canonicalId, status, error?)` function
from `src/services/researchBrain/compoundAuthority.ts` that stamps
the authority columns on a fact and writes a matching audit row in
the same transaction.

**Behavior:**

- The function MUST update `research_bioprospecting_facts` setting
  `compound_canonical_id`, `compound_authority_status`,
  `compound_authority_at = NOW()`, and (if provided)
  `compound_authority_error`.
- The function MUST insert a corresponding
  `compound_authority_audit` row with
  `event_type = 'status_change'`,
  `old_value` = the previous authority state of the fact (read in
  the same transaction), `new_value` = the new state, `user_id =
  NULL` (system/worker event), and `reason` derived from the
  transition (e.g. `'pubchem_resolved'`, `'pubchem_miss'`,
  `'extract_detected'`, `'admin_promote'`, `'admin_alias_added'`).
- The function MUST be transactional. If the audit insert fails,
  the fact update is rolled back. Audit is part of the write, not a
  post-hoc hook.
- The function MUST be idempotent on identical transitions
  (calling with the same status twice does not create duplicate
  audit rows, but a true change of state MUST always emit exactly
  one audit row).
- The function MUST be safe to call from both the synchronous
  extraction path (alias hit → verified) and the asynchronous
  backfill worker (PubChem hit → verified, or PubChem miss → retry
  / failed).

#### Scenario: Verified status writes a status_change audit row

- GIVEN a fact F in `pending` state with `compound_canonical_id = NULL`
- WHEN `attachCanonicalToFact(F.id, C.id, 'verified')` runs
- THEN F's columns are updated
- AND a single `compound_authority_audit` row exists with
  `event_type = 'status_change'`, `old_value = { compound_authority_status: 'pending', compound_canonical_id: null }`, `new_value = { compound_authority_status: 'verified', compound_canonical_id: C.id }`, `user_id = NULL`, `reason = 'pubchem_resolved'`

#### Scenario: Skipped status records the extract reason

- GIVEN a fact F in `pending` state
- WHEN `attachCanonicalToFact(F.id, null, 'skipped', 'extract_or_mixture')` runs
- THEN F's `compound_authority_error = 'extract_or_mixture'`
- AND the audit row's `reason = 'extract_detected'`

#### Scenario: Transition is transactional

- GIVEN a fact F and a stub audit insert that raises
- WHEN `attachCanonicalToFact` runs
- THEN the fact column update is rolled back
- AND F's prior state is preserved

### Requirement: searchCompounds Name Search

The system MUST export a `searchCompounds(query: string): Promise<ResearchCompound[]>` function from
`src/services/researchBrain/compoundAuthority.ts` that returns
canonical compounds matching the query by name or alias, ordered by
match quality.

**Behavior:**

- The function MUST match against `canonical_name` and
  `research_compound_aliases.alias` using a case-insensitive
  `ILIKE` (or equivalent) with the normalized form as a fallback.
- Results MUST be ordered with exact-normalized matches first,
  alias matches second, prefix matches third, and substring matches
  last. Ties break by `canonical_name` ascending.
- The function MUST apply a default limit of 25 and a maximum of
  100; the caller MAY pass an override.
- The function MUST be read-only: no insert, update, or delete on
  any table.
- The function MUST be exposed via the `GET
  /api/research-brain/compounds/search?q=` route (see the API
  requirements below).

#### Scenario: Exact name match ranks first

- GIVEN a `research_compounds` row with `canonical_name = "Curcumin"`
  and an alias `'diferuloylmethane'`
- WHEN `searchCompounds('curcumin')` runs
- THEN the first result is the Curcumin row
- AND no PubChem call is performed

#### Scenario: Alias hit is included

- GIVEN the same setup as above
- WHEN `searchCompounds('diferuloylmethane')` runs
- THEN the result set contains the Curcumin row
- AND the order places it after an exact-name match on 'curcumin'
  (if both are present)

#### Scenario: Default limit caps the result

- GIVEN 200 canonical rows that substring-match `'ine'`
- WHEN `searchCompounds('ine')` runs with default params
- THEN the result set contains at most 25 rows

### Requirement: addAlias Manual Alias

The system MUST export an
`addAlias(canonicalId, alias, source, confidence, userId)` function
from `src/services/researchBrain/compoundAuthority.ts` that adds a
new alias to a canonical compound and writes a `manual_alias_add`
audit row in the same transaction.

**Behavior:**

- The function MUST insert into `research_compound_aliases` with
  `source = 'manual'` and the caller's `confidence` value. The
  `userId` is recorded in the audit row, not on the alias itself.
- The function MUST write a `compound_authority_audit` row with
  `event_type = 'manual_alias_add'`, `old_value = null`,
  `new_value = { compound_id, alias, normalized_alias, source,
    confidence }`, `user_id = caller`, `reason = 'admin_alias_add'`.
- The function MUST be transactional. If the audit insert fails,
  the alias is rolled back.
- The function MUST be exposed via the `POST
  /api/research-brain/compounds/:canonicalId/aliases` route.
- The function MUST require admin authentication (enforced by the
  route layer; see API requirements).
- The function MUST treat duplicate `(canonical_id, normalized_alias)`
  inserts as a no-op (returns success without error) so an admin who
  re-submits the same alias does not generate spurious audit rows.

#### Scenario: Adding a new alias writes the audit row

- GIVEN a canonical row C and an admin user U
- WHEN `addAlias(C.id, 'turmeric-extract-curcumin', 'manual', 'high', U.id)` runs
- THEN `research_compound_aliases` has a new row with
  `compound_id = C.id`, `alias = 'turmeric-extract-curcumin'`,
  `normalized_alias = 'turmeric extract curcumin'`,
  `source = 'manual'`, `confidence = 'high'`
- AND `compound_authority_audit` has a new row with
  `event_type = 'manual_alias_add'`, `user_id = U.id`

#### Scenario: Re-submitting the same alias is a no-op

- GIVEN an existing alias `(C, 'turmeric-extract-curcumin')`
- WHEN `addAlias(C.id, 'turmeric-extract-curcumin', 'manual', 'high', U.id)` runs
- THEN no new row is added to `research_compound_aliases`
- AND no new audit row is added
- AND the function returns success

### Requirement: promoteToPending Admin Re-promote

The system MUST export a
`promoteToPending(factId, userId, reason)` function from
`src/services/researchBrain/compoundAuthority.ts` that moves a fact
from `failed` back to `pending` for one more attempt cycle.

**Behavior:**

- The function MUST refuse to operate on facts whose current status
  is not `'failed'`. The function MUST throw (or return an error)
  with the message "not in failed state" and MUST NOT mutate the
  fact.
- The function MUST update the fact to
  `compound_authority_status = 'pending'`,
  `compound_authority_at = NULL`,
  `compound_authority_error = NULL`.
- The function MUST insert a `compound_authority_audit` row with
  `event_type = 'status_change'`, `old_value = { compound_authority_status: 'failed', compound_canonical_id, compound_authority_error }`, `new_value = { compound_authority_status: 'pending', compound_canonical_id, compound_authority_error: null }`, `user_id = caller`, `reason = 'admin_promote'`.
- The function MUST be exposed via the `POST
  /api/research-brain/facts/:factId/authority/promote` route.
- The function MUST require admin authentication.

The single-fact scope is intentional: bulk requeue of all failed
facts is a Phase 2 admin endpoint and is out of scope for this
change.

#### Scenario: Promoting a failed fact writes the audit row

- GIVEN a fact F with `compound_authority_status = 'failed'`,
  `compound_authority_error = 'pubchem 404 not found'`
- AND an admin user U
- WHEN `promoteToPending(F.id, U.id, 'curator confirmed compound exists')` runs
- THEN F's status is `'pending'` and `compound_authority_at = NULL`
- AND the audit row records the transition with `user_id = U.id`
  and `reason = 'curator confirmed compound exists'`

#### Scenario: Promoting a non-failed fact is rejected

- GIVEN a fact F with `compound_authority_status = 'verified'`
- WHEN `promoteToPending(F.id, U.id, '...')` runs
- THEN the function throws "not in failed state"
- AND F's status is unchanged
- AND no audit row is added

### Requirement: Compound Authority BullMQ Queue and Worker

The system MUST register a scheduled BullMQ queue `compound-authority`
and a worker that periodically resolves pending facts to canonical
compounds via PubChem.

**Queue registration:**

- A new entry in `src/services/queue/queues.ts` MUST register
  `compound-authority` as a repeatable job, scheduled at
  `COMPOUND_AUTHORITY_INTERVAL_HOURS` (default 6).
- The schedule MUST be configurable via the env var
  `COMPOUND_AUTHORITY_INTERVAL_HOURS`. A value of `0` MUST disable
  the scheduled job (the queue is still registered, but no repeat
  trigger is created).
- The worker MUST be wired into `src/services/queue/workers/index.ts`
  alongside the existing `taxonomy` worker.

**Worker behavior:**

1. On each scheduled run, pick up to 500 facts where
   `compound_authority_status = 'pending'` AND
   `compound_authority_at` is NULL OR older than the backoff
   window for that fact (see Retry policy).
2. For each fact in the batch:
   a. Re-check the alias table in-memory (in case a manual alias
      was added since extraction). On hit, call
      `attachCanonicalToFact(fact.id, canonical.id, 'verified')`
      and continue.
   b. On miss, call PubChem at 4 req/s (token-bucket gate) to
      resolve the name to a CID and to fetch InChIKey /
      molecular formula / IUPAC name.
   c. On a PubChem hit, upsert a `research_compounds` row (match
      on `pubchem_cid` or `normalized_name`), insert a
      `research_compound_aliases` row with `source = 'pubchem'`,
      call `attachCanonicalToFact(fact.id, canonical.id,
      'verified')`, and continue.
   d. On a PubChem miss, increment a per-fact retry counter; if
      the counter is < `COMPOUND_AUTHORITY_MAX_RETRIES` (default
      5), schedule a delayed retry with exponential backoff (e.g.
      1m, 5m, 25m, 2h, 8h) and call
      `attachCanonicalToFact(fact.id, null, 'pending', error)`.
      If the counter is ≥ 5, call
      `attachCanonicalToFact(fact.id, null, 'failed', error)`.
   e. On HTTP 429 from PubChem, respect the `Retry-After` header
      and pause the gate for that duration before resuming.
3. The worker MUST be resilient: a single bad fact MUST NOT abort
   the run. Errors are caught per-fact, logged with structured
   context, and the worker proceeds to the next fact.
4. The worker MUST log a run summary: facts considered, alias
   hits, PubChem hits, PubChem misses, retries scheduled, and
   facts moved to `failed`.

**Rate limit:**

- The PubChem PUG-REST API allows 5 req/s for anonymous access.
  The worker MUST cap at 4 req/s (`COMPOUND_AUTHORITY_RATE_LIMIT_RPS`,
  default 4) using a token-bucket gate. The cap is a safety margin,
  not a target.

**Environment variables:**

- `COMPOUND_AUTHORITY_INTERVAL_HOURS` (default 6): the repeat
  interval for the scheduled job.
- `COMPOUND_AUTHORITY_RATE_LIMIT_RPS` (default 4): the PubChem
  cap.
- `COMPOUND_AUTHORITY_MAX_RETRIES` (default 5): the number of
  attempts before a fact is moved to `failed`.
- `COMPOUND_AUTHORITY_ENABLED` (default true): a kill switch. When
  `false`, the scheduled job is not registered and the worker does
  not start.

#### Scenario: Scheduled run resolves a batch of pending facts

- GIVEN 100 facts with `compound_authority_status = 'pending'`,
  of which 20 have aliases in the alias table and 80 do not
- AND the worker is started
- WHEN the scheduled run fires
- THEN the 20 alias-hit facts are stamped `'verified'` with their
  canonical id
- AND the 80 alias-miss facts are sent to PubChem at 4 req/s
- AND the run completes without crashing on a single bad fact

#### Scenario: PubChem miss increments retry and schedules backoff

- GIVEN a fact F with `compound_authority_status = 'pending'`,
  retry counter = 0
- WHEN the worker queries PubChem for F.compound and PubChem
  returns 404
- THEN the retry counter is incremented to 1
- AND a delayed retry is scheduled for the first backoff window
  (~1 minute)
- AND `attachCanonicalToFact(F.id, null, 'pending', 'pubchem 404 not found')` is called
- AND F's `compound_authority_at` is updated to NOW()

#### Scenario: 5 retries in 24h moves the fact to failed

- GIVEN a fact F with retry counter = 4 and a series of 4
  PubChem 404 responses
- WHEN the worker queries PubChem for F.compound and PubChem
  returns 404
- THEN the retry counter is incremented to 5
- AND `attachCanonicalToFact(F.id, null, 'failed', 'pubchem 404 not found')` is called
- AND no further delayed retry is scheduled
- AND F is excluded from the next scheduled run

#### Scenario: HTTP 429 respects Retry-After

- GIVEN a fact F in the batch and a PubChem 429 response with
  `Retry-After: 30`
- WHEN the worker handles the 429
- THEN the gate pauses for 30 seconds
- AND F is rescheduled to the back of the batch (not failed)
- AND the worker continues with the next fact only after the
  pause elapses

#### Scenario: One bad fact does not abort the run

- GIVEN a batch of 50 facts where fact 17 throws an unhandled
  exception during PubChem processing
- WHEN the worker runs
- THEN facts 1-16 are processed normally
- AND fact 17 is logged with the exception
- AND facts 18-50 are processed normally
- AND the run summary is logged at the end

#### Scenario: COMPOUND_AUTHORITY_ENABLED=false halts the worker

- GIVEN the env var `COMPOUND_AUTHORITY_ENABLED=false`
- WHEN the API server and the worker process start
- THEN the `compound-authority` queue is registered but no repeat
  job is created
- AND the worker does not start
- AND the existing data is untouched

### Requirement: Compound Authority Migration and Indexes

The system MUST ship a Supabase migration
`supabase/migrations/20260613000000_create_compound_authority.sql`
that creates the three new tables, the four new fact columns, and
all required indexes. The migration MUST be idempotent
(`IF NOT EXISTS` everywhere) so a re-run is a no-op.

**Migration contents:**

- `CREATE TABLE IF NOT EXISTS public.research_compounds` with all
  columns and CHECK constraints from the schema above.
- `CREATE TABLE IF NOT EXISTS public.research_compound_aliases`
  with all columns, FK, and UNIQUE constraint.
- `CREATE TABLE IF NOT EXISTS public.compound_authority_audit`
  with all columns, FK, and CHECK constraint.
- `ALTER TABLE public.research_bioprospecting_facts` adding the
  four new columns with FK and CHECK constraints.
- All five indexes: `idx_research_compounds_inchi_key`,
  `idx_research_compounds_pubchem_cid`,
  `idx_research_compound_aliases_normalized`,
  `idx_research_bioprospecting_compound_canonical`,
  `idx_compound_authority_audit_fact`.
- `CREATE EXTENSION IF NOT EXISTS pgcrypto` at the top of the
  migration for `gen_random_uuid()`.

The migration MUST be self-contained: no dependency on later
migrations and no FK to a not-yet-existing table. The FK from
`research_bioprospecting_facts.compound_canonical_id` to
`research_compounds.id` is created in the same migration that
creates `research_compounds`.

#### Scenario: Running the migration on an empty database

- GIVEN an empty database
- WHEN the migration runs
- THEN `research_compounds`, `research_compound_aliases`, and
  `compound_authority_audit` exist
- AND `research_bioprospecting_facts` has the four new columns
- AND all five indexes exist

#### Scenario: Re-running the migration is a no-op

- GIVEN a database where the migration has already been applied
- WHEN the migration runs again
- THEN no error is raised
- AND no duplicate tables, columns, or indexes are created

### Requirement: Seed File and Idempotent Loader

The system MUST ship a hand-curated seed file
`seeds/compounds-top-50.json` containing the top ~50
bioprospecting compounds (curcumin, DHA, EPA, paclitaxel,
bryostatin, quercetin, resveratrol, etc.) with their PubChem CIDs,
InChIKeys, and a starter alias set. The seed loader MUST be
idempotent and transaction-safe.

**Seed file shape:**

```json
[
  {
    "canonical_name": "Curcumin",
    "pubchem_cid": 969516,
    "inchi_key": "VFLDPWHFBROODJ-UHFFFAOYSA-N",
    "molecular_formula": "C21H20O6",
    "iupac_name": "(1E,6E)-1,7-bis(4-hydroxy-3-methoxyphenyl)hepta-1,6-diene-3,5-dione",
    "compound_kind": "small_molecule",
    "aliases": [
      "Diferuloylmethane",
      "Turmeric yellow",
      "Natural Yellow 3"
    ]
  }
]
```

**Loader behavior:**

- The loader is invoked by `scripts/seed/load-compounds.ts` (or a
  `bun run seed:compounds` npm script) on first deploy.
- For each entry, the loader MUST upsert a row into
  `research_compounds` (matching on `pubchem_cid` if present, then
  on `normalized_name`) with `status = 'curated'`. On a new row, a
  matching `research_compound_aliases` row is inserted for each
  alias with `source = 'curated'`, `confidence = 'high'`.
- The loader MUST be wrapped in a single transaction per file
  (or per row, with a final commit) so a mid-run failure does not
  leave a half-populated table.
- The loader MUST be idempotent: re-running the script after a
  successful deploy MUST NOT create duplicate canonical rows
  (matched on `pubchem_cid` or `normalized_name`) or duplicate
  alias rows (matched on `(compound_id, normalized_alias)`).
- The loader MUST log a summary: rows inserted, rows skipped
  (already present), aliases inserted, aliases skipped.

#### Scenario: First deploy populates the table

- GIVEN an empty `research_compounds` and an empty alias table
- WHEN `bun run seed:compounds` runs
- THEN 50 canonical rows are inserted
- AND ~150 alias rows are inserted
- AND the summary log reports the counts

#### Scenario: Re-running the seed is a no-op

- GIVEN a database where the seed has already been applied
- WHEN `bun run seed:compounds` runs again
- THEN 0 canonical rows are inserted
- AND 0 alias rows are inserted
- AND the summary log reports "skipped" for every entry

#### Scenario: Mid-run failure rolls back

- GIVEN a seed file where entry 17 has a malformed
  `pubchem_cid` (non-integer)
- WHEN the loader runs
- THEN the malformed row is rejected
- AND rows 1-16 are rolled back
- AND the database is unchanged

### Requirement: API Routes for Compound Authority

The system MUST expose three new REST routes in
`src/routes/research-brain.ts` for compound search, lookup, alias
addition, and admin re-promote. All routes MUST be registered
under the existing `/api/research-brain/compounds` and
`/api/research-brain/facts` prefixes.

**Route 1: `GET /api/research-brain/compounds/search?q=`**

- Calls `searchCompounds(q)` and returns a JSON array of
  canonical rows.
- Query string `q` is required; missing `q` returns HTTP 400.
- Response shape:
  ```json
  {
    "results": [
      { "id": "uuid", "canonical_name": "Curcumin", "pubchem_cid": 969516, "inchi_key": "VFLDPWHFBROODJ-UHFFFAOYSA-N", ... }
    ]
  }
  ```
- HTTP 200 on success, 400 on missing `q`, 500 on DB error.

**Route 2: `GET /api/research-brain/compounds/:canonicalId`**

- Returns a single canonical row with all its aliases.
- Response shape:
  ```json
  {
    "id": "uuid",
    "canonical_name": "Curcumin",
    "pubchem_cid": 969516,
    "inchi_key": "...",
    "aliases": [
      { "alias": "Diferuloylmethane", "source": "curated", "confidence": "high" }
    ]
  }
  ```
- HTTP 200 on success, 404 if not found, 500 on DB error.

**Route 3: `POST /api/research-brain/compounds/:canonicalId/aliases`**

- Body: `{ "alias": "string", "confidence": "high" | "medium" | "low" }`.
- Calls `addAlias(canonicalId, alias, 'manual', confidence, userId)`.
- Requires admin authentication (enforced by the auth middleware
  already used by the other admin routes; see
  `src/middleware/authResolver.ts`).
- Response: `{ "id": "uuid" }` (the new alias row id).
- HTTP 201 on success, 400 on missing body fields, 401 on
  unauthenticated, 403 on non-admin, 404 on missing canonical, 500
  on DB error.

**Route 4: `POST /api/research-brain/facts/:factId/authority/promote`**

- Body: `{ "reason": "string" }`.
- Calls `promoteToPending(factId, userId, reason)`.
- Requires admin authentication.
- Response: `{ "id": "uuid", "compound_authority_status": "pending" }`.
- HTTP 200 on success, 400 on missing `reason`, 401 on
  unauthenticated, 403 on non-admin, 404 on missing fact, 409 if
  the fact is not in `failed` state, 500 on DB error.

#### Scenario: Search returns the expected canonical row

- GIVEN a `research_compounds` row for "Curcumin" with
  `pubchem_cid = 969516`
- WHEN `GET /api/research-brain/compounds/search?q=curcumin` is called
- THEN the response is HTTP 200
- AND the body includes the Curcumin row
- AND no PubChem call is performed

#### Scenario: Search with missing q returns 400

- WHEN `GET /api/research-brain/compounds/search` is called
- THEN the response is HTTP 400
- AND the body is `{ "error": "missing query parameter q" }`

#### Scenario: Get-by-id returns the canonical and aliases

- GIVEN a canonical row C with 3 aliases
- WHEN `GET /api/research-brain/compounds/C.id` is called
- THEN the response is HTTP 200
- AND the body has the canonical row plus an `aliases` array of
  length 3

#### Scenario: Add-alias as admin writes a new alias and audit row

- GIVEN an admin user U and a canonical row C
- WHEN `POST /api/research-brain/compounds/C.id/aliases` is
  called with body
  `{ "alias": "turmeric-extract-curcumin", "confidence": "high" }`
- AND the request carries U's auth token
- THEN the response is HTTP 201
- AND `research_compound_aliases` has a new row
- AND `compound_authority_audit` has a new
  `manual_alias_add` row with `user_id = U.id`

#### Scenario: Add-alias without admin auth is forbidden

- GIVEN a non-admin (or unauthenticated) caller
- WHEN the same request as above is made
- THEN the response is HTTP 401 or 403 (per the auth middleware's
  contract)
- AND no alias is added

#### Scenario: Promote moves a failed fact to pending

- GIVEN a fact F in `failed` state and an admin user U
- WHEN `POST /api/research-brain/facts/F.id/authority/promote`
  is called with body `{ "reason": "curator confirmed" }`
- THEN the response is HTTP 200
- AND F's status is `'pending'`
- AND the audit row records the transition with `user_id = U.id`

#### Scenario: Promote on a non-failed fact returns 409

- GIVEN a fact F in `verified` state
- WHEN the promote route is called
- THEN the response is HTTP 409
- AND the body is `{ "error": "not in failed state" }`
- AND F's status is unchanged

### Requirement: Compound Display and Edit Reset

The system MUST treat `fact.compound` as a raw audit anchor: the
extractor's original wording MUST be preserved verbatim on the
row. When the resolved `compound_canonical_id` differs from the
raw `compound`, the UI and the provenance viewer MUST show both
values side by side.

**Display rules:**

- The `compound` column is the source of truth for the raw text.
  It is NEVER overwritten by the canonical name.
- When `compound_canonical_id IS NOT NULL` and the canonical
  name differs from `compound` (case-insensitive compare after
  normalization), the UI MUST render
  `"{compound} → {canonical_name}"` as a badge or label.
- The provenance viewer MUST show both values explicitly with the
  InChIKey and PubChem CID on click. No data is lost in the
  evidence trail.

**Edit reset:**

- When the editorial flow changes `fact.compound` (e.g.
  `updateBioprospectingFactEntities` or an equivalent admin
  endpoint):
  1. Re-run `resolveCompoundStatus` against the new compound
     text.
  2. If the resulting `compound_canonical_id` differs from the
     previous value (including NULL ↔ non-NULL transitions),
     insert a `compound_authority_audit` row with
     `event_type = 'manual_edit'`, `old_value` = the previous
     `{ compound, compound_canonical_id, compound_authority_status }`,
     `new_value` = the new
     `{ compound, compound_canonical_id, compound_authority_status }`,
     `user_id = editor`, `reason = 'compound_text_changed'`.
  3. Stamp the new authority state via `attachCanonicalToFact`
     (which writes its own `status_change` audit row in addition
     to the `manual_edit` row — both rows are required, one for
     the text diff and one for the status diff).
  4. The raw `compound` text is preserved.

The edit reset is implemented in the data layer
(`src/services/researchBrain/db.ts`) as a side effect of the
update function. Callers MUST NOT need to invoke compound
authority logic manually; the data layer encapsulates the
invariant.

#### Scenario: Raw text is never overwritten

- GIVEN a fact F with `compound = 'diferuloylmethane'`,
  `compound_canonical_id = C_curcumin.id`
- WHEN any code path runs (extraction, backfill, admin edit, UI)
- THEN F.compound remains `'diferuloylmethane'`
- AND only the canonical id and authority status columns change

#### Scenario: UI shows the raw → canonical badge

- GIVEN the same fact F as above
- WHEN the UI renders the fact
- THEN the display includes
  `"diferuloylmethane → Curcumin"`
- AND the provenance viewer shows the InChIKey
  `VFLDPWHFBROODJ-UHFFFAOYSA-N` and PubChem CID `969516` on
  click

#### Scenario: Edit reset writes both audit rows

- GIVEN a fact F with `compound = 'curcumin'`,
  `compound_canonical_id = C_curcumin.id`,
  `compound_authority_status = 'verified'`
- AND an editor user U
- WHEN U updates F.compound to 'Curcuma longa extract'
- AND the data layer re-resolves (extract → skipped, canonical
  NULL)
- THEN `compound_authority_audit` has two new rows for F:
  - `event_type = 'manual_edit'` with
    `old_value = { compound: 'curcumin', compound_canonical_id: C_curcumin.id, compound_authority_status: 'verified' }`,
    `new_value = { compound: 'Curcuma longa extract', compound_canonical_id: null, compound_authority_status: 'skipped' }`,
    `user_id = U.id`, `reason = 'compound_text_changed'`
  - `event_type = 'status_change'` with
    `old_value = { compound_authority_status: 'verified', compound_canonical_id: C_curcumin.id }`,
    `new_value = { compound_authority_status: 'skipped', compound_canonical_id: null }`,
    `user_id = U.id`, `reason = 'extract_detected'`
- AND F.compound is `'Curcuma longa extract'`

### Requirement: Status Flow and Type Updates

The system MUST define a `CompoundStatus` TypeScript type and
export it from `src/services/researchBrain/types.ts`. The type
is the source of truth for the four status values and is reused
by the service module, the worker, the API routes, and the
audit row payloads.

**Type definition:**

```typescript
export type CompoundStatus = "pending" | "verified" | "failed" | "skipped";
```

**Extended `BioprospectingFact` type:**

```typescript
export type BioprospectingFact = {
  // ... existing fields ...
  compound_canonical_id?: string | null;
  compound_authority_status?: CompoundStatus;
  compound_authority_at?: string | null;
  compound_authority_error?: string | null;
};
```

All four new fields are optional and nullable. The TypeScript
shape MUST stay backwards compatible: existing callers that
ignore the new fields MUST NOT break.

**New sibling types:**

```typescript
export type ResearchCompound = {
  id: string;
  canonical_name: string;
  normalized_name: string;
  inchi_key: string | null;
  pubchem_cid: number | null;
  chebi_id: number | null;
  molecular_formula: string | null;
  iupac_name: string | null;
  compound_kind: "small_molecule" | "peptide" | "protein" | "lipid" | "other";
  status: "local" | "pubchem" | "chebi" | "manual" | "curated";
  external_ids: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ResearchCompoundAlias = {
  id: string;
  compound_id: string;
  alias: string;
  normalized_alias: string;
  source: "local_extraction" | "pubchem" | "chebi" | "manual" | "curated";
  confidence: "high" | "medium" | "low";
  metadata: Record<string, unknown>;
  created_at: string;
};

export type CompoundAuthorityAuditEvent = {
  id: string;
  fact_id: string;
  event_type: "status_change" | "manual_edit" | "manual_alias_add";
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  user_id: string | null;
  reason: string | null;
  created_at: string;
};
```

**Status flow contract:**

| Transition | Trigger | Result |
|---|---|---|
| `null` → `pending` | extractor persists a fact with no alias hit and not an extract | `compound_canonical_id = NULL`, `compound_authority_status = 'pending'` |
| `null` → `verified` | extractor persists a fact with alias-table hit | `compound_canonical_id = C.id`, `compound_authority_status = 'verified'`, `compound_authority_at = NOW()` |
| `null` → `skipped` | extractor persists a fact matching `looksLikeExtract` | `compound_canonical_id = NULL`, `compound_authority_status = 'skipped'`, `compound_authority_error = 'extract_or_mixture'` |
| `pending` → `verified` | worker resolves a pending fact via PubChem | `compound_canonical_id = C.id`, `compound_authority_status = 'verified'`, `compound_authority_at = NOW()` |
| `pending` → `pending` | worker fails to resolve but retry counter < 5 | `compound_authority_at = NOW()`, `compound_authority_error = <error>` |
| `pending` → `failed` | worker retry counter ≥ 5 | `compound_canonical_id = NULL`, `compound_authority_status = 'failed'`, `compound_authority_error = <last error>` |
| `failed` → `pending` | admin calls `promoteToPending` | `compound_canonical_id` unchanged, `compound_authority_status = 'pending'`, `compound_authority_error = NULL` |
| any → `verified` or `pending` | editor changes `fact.compound` and re-resolves | both `manual_edit` and `status_change` audit rows written |

#### Scenario: Extractor hit on the alias table sets verified

- GIVEN an alias table row `(alias = 'diferuloylmethane', compound_id = C_curcumin)`
- WHEN the extractor persists a fact F with
  `compound = 'diferuloylmethane'`
- THEN F's status is `'verified'` and `compound_canonical_id = C_curcumin.id`

#### Scenario: Backfill hit upgrades pending to verified

- GIVEN F in `'pending'` with `compound = 'quercetin'`
- WHEN the worker queries PubChem, gets CID 5280343, and
  upserts C
- THEN `attachCanonicalToFact(F.id, C.id, 'verified')` is called
- AND F's status is `'verified'`

#### Scenario: Backfill exhaustion moves pending to failed

- GIVEN F in `'pending'` with retry counter = 5
- WHEN the worker's PubChem call returns 404
- THEN `attachCanonicalToFact(F.id, null, 'failed', 'pubchem 404 not found')` is called
- AND F's status is `'failed'`
- AND no further delayed retry is scheduled

#### Scenario: Admin promote moves failed back to pending

- GIVEN F in `'failed'` and an admin user U
- WHEN `promoteToPending(F.id, U.id, 'curator confirmed')` runs
- THEN F's status is `'pending'`
- AND `compound_authority_at = NULL`
- AND `compound_authority_error = NULL`

### Requirement: Environment Variables

The system MUST document and accept the following environment
variables in `.env.example` and read them in the worker startup
path. All variables have safe defaults so the system runs even if
none are set.

| Variable | Default | Purpose |
|---|---|---|
| `COMPOUND_AUTHORITY_INTERVAL_HOURS` | `6` | Repeat interval for the scheduled `compound-authority` job. `0` disables scheduling. |
| `COMPOUND_AUTHORITY_RATE_LIMIT_RPS` | `4` | PubChem requests per second cap (anonymous limit is 5). |
| `COMPOUND_AUTHORITY_MAX_RETRIES` | `5` | Maximum PubChem attempts per fact within a 24h window. |
| `COMPOUND_AUTHORITY_ENABLED` | `true` | Kill switch. When `false`, the worker does not start and no repeat job is registered. |

The variables MUST be read at process start (in the worker init
path) and MUST NOT be re-read mid-cycle. A value of
`COMPOUND_AUTHORITY_INTERVAL_HOURS=0` MUST be honored as
"disabled" and MUST NOT throw an error (the queue is still
registered so the worker can be enabled later by a process
restart).

#### Scenario: Default values apply when env is empty

- GIVEN the process starts with no compound-authority env vars
- WHEN the worker initializes
- THEN the repeat interval is 6 hours
- AND the rate limit is 4 req/s
- AND the max retries is 5
- AND the worker is enabled

#### Scenario: Disabling the worker halts scheduling

- GIVEN `COMPOUND_AUTHORITY_ENABLED=false`
- WHEN the API server and worker process start
- THEN no repeat job is registered
- AND the worker does not start
- AND the existing data is untouched

#### Scenario: Interval=0 is honored as disabled

- GIVEN `COMPOUND_AUTHORITY_INTERVAL_HOURS=0`
- WHEN the worker initializes
- THEN the queue is registered
- AND no repeat job is created
- AND the worker still starts (so an admin can manually trigger
  a one-off run via the queue UI)
