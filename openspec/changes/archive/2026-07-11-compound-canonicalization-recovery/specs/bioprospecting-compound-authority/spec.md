# Spec Delta: bioprospecting-compound-authority — compound-canonicalization-recovery

This delta EXTENDS the existing `bioprospecting-compound-authority`
capability. It activates the already-implemented (but dormant)
fuzzy/failed recovery engine through an explicit out-of-band pass, and
adds a feature-flagged accept-as-canonical (`status='local'`) path for
compounds that are genuinely absent from PubChem. No DB migration and
no entity-graph change are introduced.

All new behavior is additive. When the accept-as-canonical feature flag
is OFF (the default), the routine 6h worker tick behaves EXACTLY as it
does today.

## ADDED Requirements

### Requirement: Recovery-Pass Backfill Flags

The system MUST expose an explicit, out-of-band recovery path that
re-attempts `failed` and `pending` facts using the existing
deterministic name-variant engine, without altering the conservative
default behavior of the routine 6h worker tick.

**CLI:**

- `scripts/normalize-compounds.ts` MUST accept three new flags and
  thread them into the existing `normalizeBioprospectingCompounds`
  call:
  - `--include-failed` → `NormalizeBackfillParams.includeFailed = true`
  - `--try-fuzzy-variants` → `NormalizeBackfillParams.tryFuzzyVariants = true`
  - `--max-variants=<n>` → `NormalizeBackfillParams.maxVariantsPerFact = n`
- When none of the three flags are passed, the CLI MUST reproduce
  today's behavior exactly (original-name-only lookup, `pending`-only
  candidate set, no attempts reset). The flags are inert when unused.

**Driver behavior (already implemented, contractually locked here):**

- With `includeFailed = true`, `selectPendingFacts` MUST widen the
  candidate set to `status IN ('pending', 'failed')` and MUST reset
  each recovered fact's `compound_authority_attempts` counter to 0 so
  the recovery pass starts fresh.
- With `tryFuzzyVariants = true`, when the original compound name
  returns a PubChem 404, the driver MUST try the deterministic
  variants produced by `buildCompoundNameVariants` (diacritics,
  hyphens, stereo / Greek / D-L prefixes, parenthetical provenance),
  in order, up to `maxVariantsPerFact`; the first CID hit wins.
- The recovery path MUST use DETERMINISTIC variants ONLY. It MUST NOT
  perform edit-distance matching, synonym expansion, or any fuzzy
  merge that could collide two distinct compounds.
- The routine 6h worker tick MUST continue to call the driver with the
  conservative default parameters (no `includeFailed`, no
  `tryFuzzyVariants`); the recovery flags are operator-driven via the
  CLI only.

#### Scenario: Failed fact with a PubChem-present variant recovers to verified

- GIVEN a fact F with `compound = 'β-Carotene'`,
  `compound_authority_status = 'failed'`,
  `compound_authority_attempts = 5`,
  `compound_canonical_id = NULL`
- AND PubChem returns 404 for the exact string `'β-Carotene'`
- AND PubChem resolves the deterministic variant `'beta-carotene'`
  to CID 5280489
- WHEN the recovery pass runs with `--include-failed --try-fuzzy-variants`
- THEN F is re-selected (failed rows are in the candidate set)
- AND the variant `'beta-carotene'` resolves to CID 5280489
- AND `attachCanonicalToFact(F.id, canonical.id, 'verified')` is called
- AND F's `compound_authority_status = 'verified'`
- AND F's `compound_authority_attempts` is reset to 0
- AND an alias row is recorded for the paper's spelling `'β-Carotene'`
  (source `'pubchem'`) and for the resolving variant `'beta-carotene'`
- AND F.compound is still the raw `'β-Carotene'` (never overwritten)

#### Scenario: Recovery flags are threaded from the CLI into the driver

- GIVEN an operator runs
  `bun scripts/normalize-compounds.ts --limit=200 --include-failed --try-fuzzy-variants --max-variants=3`
- WHEN the script executes
- THEN `normalizeBioprospectingCompounds` is called with
  `includeFailed = true`, `tryFuzzyVariants = true`,
  `maxVariantsPerFact = 3`, and `limit = 200`
- AND the pass re-attempts both `pending` and `failed` facts

#### Scenario: Recovery uses deterministic variants only

- GIVEN a fact F with `compound = 'anthoteibinene'`
  (a novel marine natural product absent from PubChem under any
  spelling)
- WHEN the recovery pass runs with `--try-fuzzy-variants`
- THEN only the deterministic variants from
  `buildCompoundNameVariants('anthoteibinene')` are queried against
  PubChem
- AND no edit-distance neighbor, synonym, or approximate string match
  is attempted
- AND no unrelated compound is merged onto F

### Requirement: Accept-as-Canonical Promotion for Genuinely-Absent Compounds

The system MUST, when the accept-as-canonical feature flag is ENABLED,
promote a fact whose compound name AND all deterministic variants
genuinely 404 across all PubChem tries to a canonical
`research_compounds` row instead of leaving it `failed`. This targets
the dominant failure bucket: novel marine natural products that are not
present in any external authority.

**Promotion behavior (terminal genuine-miss branch of `handleMiss`):**

- The promotion MUST occur on the FIRST genuine miss — the terminal
  branch where the attempts budget is exhausted with a true PubChem
  404 (not a 429/503 rate-limit signal). There MUST be NO `≥N-sources`
  threshold and NO curator-approval queue.
- The system MUST upsert a canonical `research_compounds` row keyed by
  `normalized_name` (the standard NFKD + diacritic-strip + lowercase
  transform of the fact's compound text) with:
  - `canonical_name` = the fact's raw compound text
  - `status = 'local'`
  - `pubchem_cid = NULL`
  - `inchi_key = NULL`
  - an `unverified` flag set in `metadata` (e.g.
    `metadata.unverified = true`) so every consumer that displays the
    compound can surface it as unverified.
- The system MAY record the raw compound name as an alias
  (`source = 'local_extraction'`).
- The system MUST link the fact via `attachCanonicalToFact`, setting
  `compound_canonical_id` to the promoted canonical row, and MUST write
  a `compound_authority_audit` row (`event_type = 'status_change'`,
  `user_id = NULL`, a promotion `reason` such as `'accepted_local'`)
  recording the transition into the linked state.
- Promotion MUST be additive and idempotent: it MUST NOT create a
  duplicate canonical row for a `normalized_name` that already exists,
  and it MUST NOT double-link a fact that is already linked.
- The rate-limit signal (HTTP 429/503) MUST NOT trigger promotion; a
  rate-limited fact is re-picked on a later pass, never promoted.

#### Scenario: Feature flag OFF leaves a genuine miss as failed (legacy behavior)

- GIVEN the accept-as-canonical feature flag is OFF (default)
- AND a fact F with `compound = 'anthoteibinene'` whose name and all
  deterministic variants return PubChem 404
- AND F has reached its retry budget in the routine 6h tick
- WHEN `handleMiss` runs for F
- THEN F's `compound_authority_status = 'failed'`
- AND `compound_canonical_id` remains `NULL`
- AND no `research_compounds` row is created for `'anthoteibinene'`
- AND this reproduces today's behavior exactly

#### Scenario: Feature flag ON promotes a single-source genuine miss to local canonical

- GIVEN the accept-as-canonical feature flag is ENABLED (recovery pass)
- AND exactly ONE fact F with `compound = 'anthoteibinene A'` whose
  name and all deterministic variants return PubChem 404
- WHEN the terminal miss branch of `handleMiss` runs for F
- THEN a `research_compounds` row R is created with
  `normalized_name = 'anthoteibinene a'`,
  `canonical_name = 'anthoteibinene A'`,
  `status = 'local'`, `pubchem_cid = NULL`,
  `metadata.unverified = true`
- AND F's `compound_canonical_id = R.id`
- AND a `compound_authority_audit` row records the promotion
  (`event_type = 'status_change'`, `user_id = NULL`)
- AND promotion happened on the first genuine miss (no source-count
  threshold was applied)

#### Scenario: Two facts with the same normalized novel name share one local canonical

- GIVEN the feature flag is ENABLED
- AND two distinct facts F1 (`compound = 'Anthoteibinene-A'`) and F2
  (`compound = 'anthoteibinene a'`) that both normalize to
  `'anthoteibinene a'`
- AND both genuinely 404 across all deterministic variants
- WHEN the recovery pass promotes both
- THEN exactly ONE `research_compounds` row R exists with
  `normalized_name = 'anthoteibinene a'` (the upsert de-duplicates on
  the UNIQUE `normalized_name`)
- AND both F1.`compound_canonical_id` and F2.`compound_canonical_id`
  equal R.id
- AND no duplicate canonical row is created

#### Scenario: Re-running the recovery pass is idempotent

- GIVEN a recovery pass has already promoted F to a local canonical R
  and linked F
- WHEN the recovery pass is run a second time over the same facts
- THEN no new `research_compounds` row is created for R's
  `normalized_name`
- AND F is not double-linked (its `compound_canonical_id` still equals
  R.id)
- AND no duplicate `research_compound_aliases` row is created for the
  raw name

### Requirement: Accept-as-Canonical Feature Flag

The system MUST gate the accept-as-canonical promotion behind an
environment feature flag that is OFF by default, following the existing
`COMPOUND_AUTHORITY_*` env conventions. The flag protects the routine
6h tick from ever promoting to `local` unless an operator explicitly
enables it for a recovery pass.

| Variable | Default | Purpose |
|---|---|---|
| `COMPOUND_AUTHORITY_ACCEPT_LOCAL` | `false` | When `true`, the terminal genuine-miss branch promotes the fact to a `status='local'`, null-CID, unverified canonical row instead of marking it `failed`. When `false`, `handleMiss` retains today's `failed` behavior exactly. |

- The flag MUST default to OFF so the routine 6h worker tick never
  promotes to `local` under normal operation.
- The recovery pass (operator-driven CLI run) MUST be able to enable
  promotion for that pass without permanently changing the routine
  tick's behavior.
- Disabling the flag MUST fully revert promotion behavior with no
  schema change to undo; `handleMiss` marks genuinely-absent facts
  `failed` again.

#### Scenario: Default flag OFF keeps the routine tick conservative

- GIVEN the process starts with `COMPOUND_AUTHORITY_ACCEPT_LOCAL` unset
- WHEN the routine 6h worker tick processes a genuinely-absent compound
- THEN the fact is marked `failed`
- AND no `local` canonical row is created

#### Scenario: Recovery pass enables promotion without changing the tick

- GIVEN an operator runs the recovery pass with promotion enabled
  (`COMPOUND_AUTHORITY_ACCEPT_LOCAL=true`)
- AND the routine tick continues to run with the flag OFF in its own
  process environment
- WHEN both run over overlapping data
- THEN only the recovery pass promotes genuine misses to `local`
- AND the routine tick still marks its genuine misses `failed`

### Requirement: Recovery Backfill Bounds and Resilience

The recovery pass MUST run within the existing safety bounds of the
backfill driver so it does not contend with the live 6h tick, exhaust
the PubChem quota, or abort on a single bad fact.

- The effective `limit` MUST be clamped to `MAX_BACKFILL_LIMIT` (500);
  a requested limit above 500 MUST be reduced to 500.
- The pass MUST respect the in-process `RateGate` (default 4 req/s,
  honoring PubChem `Retry-After` on 429/503) and the daily PubChem
  request cap (`PUBCHEM_DAILY_REQUEST_CAP`). When the daily cap is
  reached, the pass MUST abort cleanly without failing already-processed
  facts.
- Processing MUST be per-fact soft-fail: a single fact that throws MUST
  be caught, logged with structured context, and MUST NOT abort the
  batch; remaining facts MUST still be processed.
- After a batch, the operator flow MUST refresh the
  `refresh_compound_aggregates()` materialized view. The
  `research_graph_entities` live view requires no refresh.

#### Scenario: Requested limit above the cap is clamped

- GIVEN a recovery pass is invoked with `--limit=5000`
- WHEN the driver computes the effective limit
- THEN it processes at most `MAX_BACKFILL_LIMIT` (500) facts in the
  batch

#### Scenario: One bad fact does not abort the recovery batch

- GIVEN a recovery batch of 50 facts where fact 17 throws during
  processing
- WHEN the pass runs
- THEN facts 1–16 are processed normally
- AND fact 17 is caught and logged with structured context
- AND facts 18–50 are processed normally
- AND a run summary is logged at the end

#### Scenario: Daily PubChem cap aborts the pass cleanly

- GIVEN the daily PubChem request cap (`PUBCHEM_DAILY_REQUEST_CAP`) is
  reached mid-batch
- WHEN the pass attempts the next PubChem call
- THEN the pass aborts cleanly
- AND facts already resolved or promoted in the batch keep their new
  state
- AND no fact is corrupted or left half-written

#### Scenario: Aggregates are refreshed after a batch

- GIVEN a recovery batch has completed and linked N facts to canonical
  compounds
- WHEN the operator flow finishes the batch
- THEN `refresh_compound_aggregates()` is invoked
- AND the `research_graph_entities` live view reflects the newly-linked
  compounds without a separate refresh

### Requirement: Graph Consequence of Populated Canonical FK

This is a cross-capability contract note: populating
`compound_canonical_id` is the entire fix for the entity/compound graph
showing `compounds: 0`. No entity-graph code or API change is made by
this delta.

- Once a fact is linked (via fuzzy recovery OR local promotion),
  `research_graph_entities.compound_count`
  (`COUNT(DISTINCT compound_canonical_id)`, a live view) MUST reflect
  the linked compound with no graph-side change.
- Unverified `status='local'` compounds MUST be SHOWN in the graph,
  flagged unverified — they MUST NOT be filtered out of graph views.

#### Scenario: Linking facts self-corrects the compound count

- GIVEN a graph entity that showed `compound_count = 0` because all its
  bioprospecting facts were `failed`/`pending` with
  `compound_canonical_id = NULL`
- WHEN the recovery pass links those facts (verified via fuzzy recovery
  and/or promoted to `local`) and `refresh_compound_aggregates()` runs
- THEN `research_graph_entities.compound_count` for that entity is
  greater than 0
- AND no entity-graph code or API was modified

#### Scenario: Unverified local compounds appear in the graph flagged, not filtered

- GIVEN a fact linked to a `status='local'`, `metadata.unverified=true`
  canonical row
- WHEN the graph is rendered
- THEN the compound is present in the graph
- AND it is flagged as unverified
- AND it is NOT excluded from the compound count or the graph view

### Requirement: Additivity — No Migration, Routine Tick Unchanged

This delta MUST be structurally additive: it introduces no database
migration and does not alter the routine worker's conservative default.

- No new Supabase migration MUST be required. The existing
  `research_compounds` CHECK constraint already permits `status='local'`
  with a null `pubchem_cid`, and the fact FK already permits linking.
- With the accept-as-canonical flag OFF, the routine 6h tick's behavior
  MUST be byte-for-byte equivalent to today's: `pending`-only candidate
  set, original-name-only lookup, genuine misses marked `failed`.
- Rollback MUST require only disabling the feature flag (and omitting
  the CLI recovery flags); promoted `local` rows are additive and may be
  left in place (honestly flagged unverified) or removed by a targeted
  delete, with the fact FK degrading safely to `NULL` on delete.

#### Scenario: No migration is introduced

- GIVEN the change is applied
- WHEN the migration set is inspected
- THEN no new `supabase/migrations/*` file is added for this change
- AND `status='local'` with null `pubchem_cid` is already accepted by
  the existing schema

#### Scenario: Routine tick behavior is unchanged when the flag is OFF

- GIVEN the accept-as-canonical flag is OFF and no CLI recovery flags
  are passed
- WHEN the routine 6h worker tick runs
- THEN it selects only `pending` facts
- AND it looks up only the original compound name (no fuzzy variants)
- AND genuine misses at the retry budget are marked `failed`
- AND no fact is promoted to `local`
