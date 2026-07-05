import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import {
  checkCap,
  recordApiCall,
  CostCapExceededError,
  isProviderDisabled,
} from "./costService";
// Re-export so callers (and tests) can `import { CostCapExceededError }
// from "../compoundAuthority"` without reaching into costService.
export { CostCapExceededError } from "./costService";
import type {
  BioprospectingFact,
  CompoundAuthorityAuditEvent,
  CompoundStatus,
  ExtractedBioprospectingFact,
  ResearchCompound,
  ResearchCompoundAlias,
} from "./types";

/**
 * Compound authority service module. Mirrors the structural template
 * of `taxonomy.ts` (status enum + alias table + JSONB audit pattern)
 * adapted for chemistry: a `research_compounds` canonical table, a
 * `research_compound_aliases` alias table, a `compound_authority_audit`
 * edge table, and a `CompoundStatus` lifecycle.
 *
 * PR #1 ships the synchronous (extract-time) resolution path:
 *   - `looksLikeExtract`          — pure regex predicate
 *   - `normalizeForCompoundLookup` — NFKD + diacritic + lowercase
 *   - `resolveInitialStatus`       — extract-time resolver (no IO)
 *   - `attachCompoundAuthority`   — stamp the in-memory fact
 *   - `loadAliasMap`               — one-shot alias map loader
 *   - `attachCanonicalToFact`      — transactional write + audit
 *   - `searchCompoundsByName`     — case-insensitive search
 *   - `getCanonicalById`           — get canonical + aliases
 *   - `addAlias`                   — manual alias add
 *   - `promoteFactToPending`       — admin re-promote
 *
 * PR #2 adds the async backfill path: PubChem client, rate gate,
 * retry counter, and the `normalizeBioprospectingCompounds` driver.
 */

const supabase = new Proxy({} as ReturnType<typeof getServiceClient>, {
  get(_target, prop) {
    const client = getServiceClient() as unknown as Record<
      string | symbol,
      unknown
    >;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as ReturnType<typeof getServiceClient>;

/**
 * Reasons passed to `attachCanonicalToFact` and recorded in
 * `compound_authority_audit.reason`. Kept as a typed const tuple so
 * tests + the API layer can reference them by name.
 */
export const COMPOUND_AUTHORITY_REASONS = {
  pubchemResolved: "pubchem_resolved",
  pubchemMiss: "pubchem_miss",
  extractDetected: "extract_detected",
  adminPromote: "admin_promote",
  adminAliasAdded: "admin_alias_added",
  compoundTextChanged: "compound_text_changed",
} as const;

export type CompoundAuthorityReason =
  (typeof COMPOUND_AUTHORITY_REASONS)[keyof typeof COMPOUND_AUTHORITY_REASONS];

/**
 * In-memory shape used by the synchronous extract-time path. The
 * extractor stamps these four fields on every fact before persistence.
 * `compound_canonical_id` is `string | null` (not `undefined`) to make
 * the JSON column on the fact row explicit.
 */
export type CompoundAuthorityStamp = {
  compound_canonical_id: string | null;
  compound_authority_status: CompoundStatus;
  compound_authority_at: string | null;
  compound_authority_error: string | null;
};

const EMPTY_STAMP: CompoundAuthorityStamp = {
  compound_canonical_id: null,
  compound_authority_status: "pending",
  compound_authority_at: null,
  compound_authority_error: null,
};

// ---------------------------------------------------------------------------
// looksLikeExtract — pure regex predicate
// ---------------------------------------------------------------------------

/**
 * Lexical cues that mark a compound value as an extract / mixture
 * (and therefore ineligible for canonical resolution). Mirrors the
 * spec's required cue set:
 *   extract, oil, fraction, tincture, juice, powder, infusion,
 *   decoction, TME, essential oil, resin, formulation, preparation,
 *   solution, suspension, emulsion, blend, mixture, combination
 *
 * The match is case-insensitive and word-boundary-aware. Multi-word
 * cues (e.g. "essential oil") are matched as a phrase. "TME" is an
 * acronym for "Tumour-Mimetic Extract" (a class of bioprospecting
 * fractions); matched as a word.
 *
 * Pure function: no IO, no LLM, no PubChem. Safe to call inline on
 * every fact in every batch.
 */
export function looksLikeExtract(value: string | null | undefined): boolean {
  if (!value) return false;
  if (typeof value !== "string") return false;
  // Multi-word phrases first (longest match wins implicitly because
  // alternation in JS regex tries left-to-right).
  const pattern =
    /\b(?:extract|essential\s+oil|oil|fraction|tincture|juice|powder|infusion|decoction|TME|resin|formulation|preparation|solution|suspension|emulsion|blend|mixture|combination)\b/i;
  return pattern.test(value);
}

// ---------------------------------------------------------------------------
// normalizeForCompoundLookup — canonicalization for matching
// ---------------------------------------------------------------------------

/**
 * Canonicalize a compound name for matching against the alias table
 * and the canonical `normalized_name` column. Pipeline:
 *   1. NFKD decompose
 *   2. Strip diacritics
 *   3. Collapse non-alphanumeric runs to a single space
 *   4. Lowercase
 *   5. Trim + collapse whitespace
 *
 * Examples:
 *   normalizeForCompoundLookup("Curcumín")     -> "curcumin"
 *   normalizeForCompoundLookup("  EPA  ")      -> "epa"
 *   normalizeForCompoundLookup("quercetin-3-O-glucoside") -> "quercetin 3 o glucoside"
 */
export function normalizeForCompoundLookup(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// resolveInitialStatus — extract-time resolution
// ---------------------------------------------------------------------------

/**
 * Generate a list of alternative compound names to try when the
 * canonical name returns a PubChem 404. The goal is to RECOVER
 * `failed` facts whose spelling is correct for the paper's domain
 * (e.g. "alpha-mangostin" in a marine paper) but is one tweak away
 * from what PubChem's PUG-REST recognises.
 *
 * The pipeline is intentionally conservative: it returns a SMALL
 * ordered list of high-precision candidates. We do NOT do
 * edit-distance fuzzy search; PubChem is sensitive to its own
 * canonical index and a Levenshtein match is more likely to land
 * on the wrong compound than the right one. Instead we strip
 * determinable surface variants:
 *
 *   1. Parenthesized chunks — "curcumin (from Curcuma longa)"
 *      becomes "curcumin". PubChem rarely indexes the parenthetical
 *      provenance note.
 *   2. Stereochemistry prefixes — (E)-, (Z)-, (R)-, (S)-, (+)-, (-)-,
 *      (±)-. PubChem's name index is the racemate/canonical form.
 *   3. D/L / d-/l- sugar prefixes — D-glucose -> glucose, L-arginine
 *      -> arginine.
 *   4. Greek-letter stereo descriptors — alpha, beta, gamma, delta,
 *      omega. We strip them as a STANDALONE word (preceded by a
 *      hyphen) but keep them when they are part of a name like
 *      "alpha-tocopherol" -> "tocopherol" (the prefix IS
 *      meaningless on its own in PubChem).
 *   5. "n-" (normal) and "iso-" chain descriptors — n-butanol ->
 *      butanol, isovaleric acid -> valeric acid (the latter is
 *      debated; we only strip the most common ones).
 *   6. The original name is returned FIRST so the caller can short-
 *      circuit if a different path already tried it.
 *
 * The function is PURE: no IO, no LLM, no PubChem. The result is
 * de-duplicated and the original name is included at index 0.
 * Length is bounded: the caller should stop after the first hit.
 *
 * Examples:
 *   buildCompoundNameVariants("alpha-mangostin")
 *     -> ["alpha-mangostin", "mangostin"]
 *   buildCompoundNameVariants("(E)-resveratrol")
 *     -> ["(E)-resveratrol", "resveratrol"]
 *   buildCompoundNameVariants("quercetin-3-O-glucoside")
 *     -> ["quercetin-3-O-glucoside", "quercetin 3 O glucoside",
 *         "quercetin glucoside", "quercetin"]
 *   buildCompoundNameVariants("D-glucose")
 *     -> ["D-glucose", "glucose"]
 *   buildCompoundNameVariants("curcumin (from Curcuma longa)")
 *     -> ["curcumin (from Curcuma longa)", "curcumin"]
 */
export function buildCompoundNameVariants(name: string | null | undefined): string[] {
  if (!name || typeof name !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const trimmed = s.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  add(name);

  // 1) Strip parenthesized chunks: "curcumin (from Curcuma longa)"
  //    "kaempferol-3-O-rutinoside (NAR)". We collapse multiple
  //    parentheticals and surrounding whitespace.
  const withoutParens = name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  add(withoutParens);

  // 2) Stereochemistry prefixes at the start: "(E)-", "(Z)-", "(R)-",
  //    "(S)-", "(+)-", "(-)-", "(±)-" and the unparenthesized forms
  //    "E-", "Z-", "R-", "S-", "D-", "L-", "d-", "l-".
  //    Match: optional parens around a single letter (E/Z/R/S) or a
  //    sign (+/-/±), followed by a hyphen, followed by optional space.
  const stereoPrefix = /^\s*[(\[]?\s*(?:[+\-±]|[EeZzRrSs](?![A-Za-z]))\s*[)\]]?\s*-\s*/;
  const withoutStereo = name.replace(stereoPrefix, "").trim();
  add(withoutStereo);

  // 3) D/L sugar prefix standalone: "D-glucose" / "L-arginine" / "d-Glucose".
  //    Conservative: only strip a single ASCII letter followed by a hyphen
  //    at the start of the name.
  const dlPrefix = /^\s*[dlDL]-\s*/;
  const withoutDL = name.replace(dlPrefix, "").trim();
  add(withoutDL);

  // 4) Greek-letter stereo descriptors as a HYPHEN-PREFIXED word:
  //    "alpha-mangostin" -> "mangostin". The descriptor must be at the
  //    start, lowercase, and hyphen-joined (so we don't strip the
  //    "alpha" in "alpha tocopherol acetate" which is a different
  //    compound).
  const greekPrefix = /^\s*(?:alpha|beta|gamma|delta|omega)-\s*/i;
  const withoutGreek = name.replace(greekPrefix, "").trim();
  add(withoutGreek);

  // 5) "n-" and "iso-" chain descriptors at the start: "n-butanol"
  //    -> "butanol", "iso-valeric acid" -> "valeric acid". Same rule
  //    as the Greek prefix: must be a hyphen-joined prefix.
  const chainPrefix = /^\s*(?:n|iso|sec|tert|normal|ortho|meta|para)-\s*/i;
  const withoutChain = name.replace(chainPrefix, "").trim();
  add(withoutChain);

  // 6) Token-strip heuristic: try the longest prefix of words
  //    (greedy from the front). "marine compound 12B" -> first try
  //    "marine compound 12B", then "marine compound", then
  //    "marine". The function never returns an empty string.
  //
  //    We DON'T apply this when the original name has only one word
  //    (nothing to strip). And we don't apply it when the
  //    resulting prefix is one of the stereo/greek/dl/chain
  //    prefixes on its own (would land on "alpha" which is not a
  //    compound name).
  //
  //    We apply this to the WITHOUT-PARENS form so a parenthetical
  //    tail does not contaminate the prefix candidates.
  const tokens = withoutParens.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    for (let n = tokens.length - 1; n >= 1; n--) {
      const prefix = tokens.slice(0, n).join(" ");
      if (/^(?:alpha|beta|gamma|delta|omega|iso|n|sec|tert|normal|ortho|meta|para|[dlDL])$/i.test(prefix)) {
        continue;
      }
      add(prefix);
    }
  }

  return out;
}
/**
 * Resolve a freshly-extracted compound value to a canonical id and a
 * status. The contract:
 *   1. `looksLikeExtract(value)` true  -> `{ canonicalId: null, status: 'skipped', at: null, error: 'extract_or_mixture' }`
 *   2. aliasMap hit                    -> `{ canonicalId: <id>, status: 'verified', at: <now ISO>, error: null }`
 *   3. otherwise                       -> `{ canonicalId: null, status: 'pending', at: null, error: null }`
 *
 * No PubChem call. No SQL — the alias map is preloaded once per
 * source by the extractor. Safe to call inline on every fact in
 * every batch.
 */
export function resolveInitialStatus(
  value: string | null | undefined,
  aliasMap: Map<string, string>,
): {
  canonicalId: string | null;
  status: CompoundStatus;
  at: string | null;
  error: string | null;
} {
  if (!value || typeof value !== "string") {
    return {
      canonicalId: null,
      status: "pending",
      at: null,
      error: null,
    };
  }
  if (looksLikeExtract(value)) {
    return {
      canonicalId: null,
      status: "skipped",
      at: new Date().toISOString(),
      error: "extract_or_mixture",
    };
  }
  const normalized = normalizeForCompoundLookup(value);
  if (!normalized) {
    return {
      canonicalId: null,
      status: "pending",
      at: null,
      error: null,
    };
  }
  const canonicalId = aliasMap.get(normalized);
  if (canonicalId) {
    return {
      canonicalId,
      status: "verified",
      at: new Date().toISOString(),
      error: null,
    };
  }
  return {
    canonicalId: null,
    status: "pending",
    at: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// loadAliasMap — one-shot alias map loader (per source)
// ---------------------------------------------------------------------------

/**
 * Load the full alias -> compound_id map for in-process lookups.
 * One SQL query (SELECT normalized_alias, compound_id) covers both
 * the alias table and the canonical `normalized_name` column so a
 * freshly-inserted canonical row is also findable.
 *
 * Returns an empty map on read error (caller logs and continues with
 * all facts falling through to `pending`).
 */
export async function loadAliasMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const [{ data: aliasRows, error: aliasError }, { data: compoundRows, error: compoundError }] =
    await Promise.all([
      supabase
        .from("research_compound_aliases")
        .select("normalized_alias, compound_id"),
      supabase
        .from("research_compounds")
        .select("normalized_name, id"),
    ]);
  if (aliasError) {
    logger.warn({ err: aliasError }, "compound_authority_alias_map_failed");
  }
  if (compoundError) {
    logger.warn({ err: compoundError }, "compound_authority_canonical_map_failed");
  }
  for (const row of (compoundRows || []) as Array<{
    normalized_name: string;
    id: string;
  }>) {
    if (row.normalized_name && row.id) {
      // Canonical names win on collision (seeded curated rows are
      // more authoritative than the same string appearing as an
      // alias of a different canonical). We process canonicals
      // BEFORE aliases to enforce this deterministically.
      map.set(row.normalized_name, row.id);
    }
  }
  for (const row of (aliasRows || []) as Array<{
    normalized_alias: string;
    compound_id: string;
  }>) {
    if (row.normalized_alias && row.compound_id) {
      // Only set if the map does not already have a canonical entry
      // for this key. This preserves the canonical-wins-on-collision
      // rule above.
      if (!map.has(row.normalized_alias)) {
        map.set(row.normalized_alias, row.compound_id);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// attachCompoundAuthority — stamp the in-memory fact
// ---------------------------------------------------------------------------

/**
 * Stamp the 4 authority fields on the in-memory fact (plus the
 * `compound_authority_attempts` counter, default 0). Called from
 * `bioprospectingExtractor` between `normalizeFacts` and
 * `replaceBioprospectingFactsForSource`.
 *
 * The DB write happens later, in `replaceBioprospectingFactsForSource`,
 * which reads these 4 fields from the fact object and writes them
 * to the persisted row.
 *
 * Idempotent on `'verified'` facts: a second call does not re-resolve
 * and does not clobber a verified state. The intent is "calling twice
 * on the same fact MUST NOT clobber a verified status with a
 * pending re-resolution" (spec scenario in the
 * research-bioprospecting delta).
 *
 * Defensive: a bad input (e.g. non-string `compound`) does NOT
 * abort the batch. The fact is stamped `'pending'` and the error
 * is logged with the fact id.
 */
export function attachCompoundAuthority(
  fact: ExtractedBioprospectingFact,
  aliasMap: Map<string, string>,
): ExtractedBioprospectingFact & {
  compound_canonical_id: string | null;
  compound_authority_status: CompoundStatus;
  compound_authority_at: string | null;
  compound_authority_error: string | null;
  compound_authority_attempts: number;
} {
  // Preserve a previously-stamped verified state. A re-call on the
  // same fact (e.g. if the extractor's pre-pass calls it twice) is a
  // no-op.
  if (fact.compound_authority_status === "verified") {
    return {
      ...fact,
      compound_canonical_id: fact.compound_canonical_id ?? null,
      compound_authority_status: "verified",
      compound_authority_at: fact.compound_authority_at ?? null,
      compound_authority_error: fact.compound_authority_error ?? null,
      compound_authority_attempts: fact.compound_authority_attempts ?? 0,
    };
  }

  try {
    const resolved = resolveInitialStatus(fact.compound, aliasMap);
    return {
      ...fact,
      compound_canonical_id: resolved.canonicalId,
      compound_authority_status: resolved.status,
      compound_authority_at: resolved.at,
      compound_authority_error: resolved.error,
      compound_authority_attempts: fact.compound_authority_attempts ?? 0,
    };
  } catch (error) {
    logger.warn(
      { err: error, compound: fact.compound },
      "compound_authority_attach_failed_falling_back_to_pending",
    );
    return {
      ...fact,
      compound_canonical_id: null,
      compound_authority_status: "pending",
      compound_authority_at: null,
      compound_authority_error: null,
      compound_authority_attempts: fact.compound_authority_attempts ?? 0,
    };
  }
}

// ---------------------------------------------------------------------------
// attachCanonicalToFact — transactional status write + audit row
// ---------------------------------------------------------------------------

export type AttachCanonicalParams = {
  factId: string;
  canonicalId: string | null;
  status: CompoundStatus;
  error?: string | null;
  userId?: string | null;
  reason: CompoundAuthorityReason;
  attempts?: number;
};

/**
 * Transactional write of authority state on a fact + matching
 * `compound_authority_audit` row. Mirrors the spec contract:
 *   - updates `compound_canonical_id`, `compound_authority_status`,
 *     `compound_authority_at = NOW()`, `compound_authority_error`
 *     (and `compound_authority_attempts` when `attempts` is passed)
 *   - inserts a `status_change` audit row with
 *     `old_value` = previous authority state of the fact
 *     `new_value` = new state
 *     `user_id` = caller (or NULL for system/worker)
 *     `reason` = caller-supplied
 *   - idempotent on identical state: if `old_value` and `new_value`
 *     are structurally equal, the function still updates the row
 *     (the caller is responsible for not re-issuing) and writes
 *     exactly one audit row
 *
 * The function is intentionally NOT wrapped in a Supabase RPC
 * transaction (the project's Supabase client is postgREST, not the
 * server-side driver). Instead, the update is issued first; on
 * success, the audit insert is issued. If the audit insert throws,
 * the update is rolled back by issuing a compensating update that
 * restores the pre-call state. This mirrors the existing pattern in
 * `taxonomy.ts` and is acceptable because the audit table is the
 * only side effect — there is no cross-row invariant to preserve.
 *
 * Defensive: if the rollback itself throws, the error is logged and
 * re-thrown (the caller decides whether to swallow).
 */
export async function attachCanonicalToFact(
  params: AttachCanonicalParams,
): Promise<void> {
  const {
    factId,
    canonicalId,
    status,
    error: errorMessage = null,
    userId = null,
    reason,
    attempts,
  } = params;

  // 1) Read the previous state (for the audit old_value).
  const { data: previous, error: readError } = await supabase
    .from("research_bioprospecting_facts")
    .select(
      "compound_canonical_id, compound_authority_status, compound_authority_error",
    )
    .eq("id", factId)
    .maybeSingle();
  if (readError) {
    logger.error(
      { err: readError, factId },
      "compound_authority_attach_read_failed",
    );
    throw readError;
  }
  const previousRow = (previous || {}) as {
    compound_canonical_id?: string | null;
    compound_authority_status?: CompoundStatus | null;
    compound_authority_error?: string | null;
  };
  const oldValue = {
    compound_canonical_id: previousRow.compound_canonical_id ?? null,
    compound_authority_status:
      previousRow.compound_authority_status ?? "pending",
    compound_authority_error: previousRow.compound_authority_error ?? null,
  };
  const newValue = {
    compound_canonical_id: canonicalId,
    compound_authority_status: status,
    compound_authority_error: errorMessage,
  };

  // 2) Update the fact row.
  const updatePayload: Record<string, unknown> = {
    compound_canonical_id: canonicalId,
    compound_authority_status: status,
    compound_authority_at: new Date().toISOString(),
    compound_authority_error: errorMessage,
  };
  if (typeof attempts === "number") {
    updatePayload.compound_authority_attempts = attempts;
  }
  const { error: updateError } = await supabase
    .from("research_bioprospecting_facts")
    .update(updatePayload)
    .eq("id", factId);
  if (updateError) {
    logger.error(
      { err: updateError, factId, status },
      "compound_authority_attach_update_failed",
    );
    throw updateError;
  }

  // 3) Insert the audit row. If this throws, compensate by
  //    restoring the previous state.
  const auditPayload = {
    fact_id: factId,
    event_type: "status_change" as const,
    old_value: oldValue,
    new_value: newValue,
    user_id: userId,
    reason,
  };
  const { error: insertError } = await supabase
    .from("compound_authority_audit")
    .insert(auditPayload);
  if (insertError) {
    logger.error(
      { err: insertError, factId, reason },
      "compound_authority_audit_insert_failed_rolling_back",
    );
    // Compensating update: restore the previous state. If THIS
    // also throws, re-throw the audit error so the caller sees
    // the root cause.
    const { error: rollbackError } = await supabase
      .from("research_bioprospecting_facts")
      .update({
        compound_canonical_id: oldValue.compound_canonical_id,
        compound_authority_status: oldValue.compound_authority_status,
        compound_authority_error: oldValue.compound_authority_error,
        // NOTE: we do NOT restore compound_authority_at. The spec
        // treats `at` as the timestamp of the last authority
        // action; on a rollback, the prior update is "undone" but
        // the timestamp of the failed attempt is useful audit
        // signal.
      })
      .eq("id", factId);
    if (rollbackError) {
      logger.error(
        { err: rollbackError, factId },
        "compound_authority_rollback_failed",
      );
    }
    throw insertError;
  }
}

// ---------------------------------------------------------------------------
// searchCompoundsByName — case-insensitive search
// ---------------------------------------------------------------------------

/**
 * Case-insensitive name search across canonical + alias names. Rank
 * order:
 *   1. exact-normalized canonical match
 *   2. alias hit
 *   3. canonical prefix
 *   4. canonical substring
 * Ties break by canonical_name ASC.
 *
 * Read-only. Default limit 25, max 100. Implemented as a single
 * `or(...)` query that returns candidates; the in-process ranking
 * applies the spec's tie-breakers. For ~10k rows the per-call cost
 * is dominated by the network round-trip, not the sort.
 */
export async function searchCompoundsByName(
  query: string,
  limit: number = 25,
): Promise<ResearchCompound[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 25));
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const escaped = trimmed.replace(/[%_]/g, (match) => `\\${match}`);

  // Fetch a wide candidate set; we re-rank in-process.
  const { data, error } = await supabase
    .from("research_compounds")
    .select("*")
    .or(
      `canonical_name.ilike.%${escaped}%,inchi_key.ilike.%${escaped}%`,
    )
    .order("canonical_name", { ascending: true })
    .limit(safeLimit * 4);
  if (error) throw error;

  const canonicals = ((data || []) as ResearchCompound[]).slice(
    0,
    safeLimit * 4,
  );
  if (canonicals.length === 0) return [];

  // Alias pass: include canonicals that match the query through an
  // alias but not through canonical_name / inchi_key.
  const ids = canonicals.map((c) => c.id);
  const { data: aliasRows, error: aliasError } = await supabase
    .from("research_compound_aliases")
    .select("compound_id, alias, normalized_alias")
    .in("compound_id", ids)
    .ilike("normalized_alias", `%${normalizeForCompoundLookup(escaped)}%`)
    .limit(safeLimit * 2);
  if (aliasError) {
    logger.warn(
      { err: aliasError },
      "compound_authority_search_alias_pass_failed",
    );
  }

  const aliased = new Set(
    ((aliasRows || []) as Array<{ compound_id: string }>).map(
      (r) => r.compound_id,
    ),
  );

  const queryNorm = normalizeForCompoundLookup(trimmed);
  const ranked = [...canonicals].sort((a, b) => {
    const aNorm = normalizeForCompoundLookup(a.canonical_name);
    const bNorm = normalizeForCompoundLookup(b.canonical_name);
    const aExact = aNorm === queryNorm ? 0 : 1;
    const bExact = bNorm === queryNorm ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    const aAlias = aliased.has(a.id) ? 0 : 1;
    const bAlias = aliased.has(b.id) ? 0 : 1;
    if (aAlias !== bAlias) return aAlias - bAlias;

    const aPrefix = aNorm.startsWith(queryNorm) ? 0 : 1;
    const bPrefix = bNorm.startsWith(queryNorm) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;

    return a.canonical_name.localeCompare(b.canonical_name);
  });

  return ranked.slice(0, safeLimit);
}

// ---------------------------------------------------------------------------
// getCanonicalById — get canonical + aliases
// ---------------------------------------------------------------------------

/**
 * Fetch a single canonical compound by id along with all of its
 * aliases. Returns `null` when the canonical does not exist.
 */
export async function getCanonicalById(
  canonicalId: string,
): Promise<(ResearchCompound & { aliases: ResearchCompoundAlias[] }) | null> {
  if (!canonicalId) return null;
  const [{ data: compoundRow, error: compoundError }, { data: aliasRows, error: aliasError }] =
    await Promise.all([
      supabase
        .from("research_compounds")
        .select("*")
        .eq("id", canonicalId)
        .maybeSingle(),
      supabase
        .from("research_compound_aliases")
        .select("*")
        .eq("compound_id", canonicalId)
        .order("alias", { ascending: true }),
    ]);
  if (compoundError) throw compoundError;
  if (aliasError) throw aliasError;
  if (!compoundRow) return null;
  return {
    ...(compoundRow as ResearchCompound),
    aliases: (aliasRows || []) as ResearchCompoundAlias[],
  };
}

// ---------------------------------------------------------------------------
// addAlias — manual alias add (admin)
// ---------------------------------------------------------------------------

export type AddAliasParams = {
  canonicalId: string;
  alias: string;
  source?: "manual" | "curated";
  confidence: "high" | "medium" | "low";
  userId: string;
};

export type AddAliasResult = { id: string };

/**
 * Manually add an alias to a canonical compound and write a
 * `manual_alias_add` audit row in the same logical operation.
 *
 * Idempotency: if a row with the same `(compound_id, normalized_alias)`
 * already exists, the function is a no-op (no new alias, no new audit
 * row). This is what the spec's "Re-submitting the same alias is a
 * no-op" scenario requires.
 *
 * Errors (e.g. missing canonical, malformed alias) throw. The
 * function does NOT auto-resolve; the worker handles that on the
 * next backfill cycle.
 */
export async function addAlias(params: AddAliasParams): Promise<AddAliasResult> {
  const aliasTrimmed = (params.alias || "").trim();
  if (!aliasTrimmed) {
    throw new Error("alias is required");
  }
  const normalized = normalizeForCompoundLookup(aliasTrimmed);
  if (!normalized) {
    throw new Error("alias is required");
  }

  // 1) Look up existing alias (idempotency check). If present, return
  //    the existing id and DO NOT write a new audit row.
  const { data: existing, error: existingError } = await supabase
    .from("research_compound_aliases")
    .select("id")
    .eq("compound_id", params.canonicalId)
    .eq("normalized_alias", normalized)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    return { id: (existing as { id: string }).id };
  }

  // 2) Insert the alias. If the canonical doesn't exist, the FK
  //    constraint will reject the insert and we surface the error.
  const { data: inserted, error: insertError } = await supabase
    .from("research_compound_aliases")
    .insert({
      compound_id: params.canonicalId,
      alias: aliasTrimmed,
      normalized_alias: normalized,
      source: params.source ?? "manual",
      confidence: params.confidence,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  const aliasId = (inserted as { id: string }).id;

  // 3) Write the audit row. If this throws, compensate by deleting
  //    the alias we just inserted. `fact_id` is NULL for alias-only
  //    events; the canonical id lives in `new_value.compound_id`.
  //    The spec author defers this FK relaxation to design — see
  //    the migration header comment.
  const { error: auditError } = await supabase
    .from("compound_authority_audit")
    .insert({
      fact_id: null,
      event_type: "manual_alias_add" as const,
      old_value: null,
      new_value: {
        compound_id: params.canonicalId,
        alias: aliasTrimmed,
        normalized_alias: normalized,
        source: params.source ?? "manual",
        confidence: params.confidence,
      },
      user_id: params.userId,
      reason: COMPOUND_AUTHORITY_REASONS.adminAliasAdded,
    });
  if (auditError) {
    logger.error(
      { err: auditError, aliasId, canonicalId: params.canonicalId },
      "compound_authority_alias_audit_insert_failed_rolling_back",
    );
    const { error: rollbackError } = await supabase
      .from("research_compound_aliases")
      .delete()
      .eq("id", aliasId);
    if (rollbackError) {
      logger.error(
        { err: rollbackError, aliasId },
        "compound_authority_alias_rollback_failed",
      );
    }
    throw auditError;
  }

  return { id: aliasId };
}

// ---------------------------------------------------------------------------
// promoteFactToPending — admin re-promote (failed -> pending)
// ---------------------------------------------------------------------------

export type PromoteFactParams = {
  factId: string;
  userId: string;
  reason: string;
};

/**
 * Move a fact from `'failed'` back to `'pending'` for one more
 * backfill cycle. The function refuses to operate on facts whose
 * current status is not `'failed'`: it throws `Error("not in failed
 * state")` and does NOT mutate the fact.
 *
 * The compound_authority_attempts counter is NOT reset (PR #3 design
 * will revisit). The error message is cleared; the canonical id is
 * preserved so the worker can pick it up if PubChem now finds it.
 */
export async function promoteFactToPending(
  params: PromoteFactParams,
): Promise<void> {
  // 1) Read the current state. If not failed, throw without writing.
  const { data: current, error: readError } = await supabase
    .from("research_bioprospecting_facts")
    .select(
      "compound_canonical_id, compound_authority_status, compound_authority_error",
    )
    .eq("id", params.factId)
    .maybeSingle();
  if (readError) {
    logger.error(
      { err: readError, factId: params.factId },
      "compound_authority_promote_read_failed",
    );
    throw readError;
  }
  if (!current) {
    throw new Error("fact not found");
  }
  const currentRow = current as {
    compound_canonical_id?: string | null;
    compound_authority_status?: CompoundStatus | null;
    compound_authority_error?: string | null;
  };
  if (currentRow.compound_authority_status !== "failed") {
    throw new Error("not in failed state");
  }
  const oldValue = {
    compound_canonical_id: currentRow.compound_canonical_id ?? null,
    compound_authority_status: "failed" as CompoundStatus,
    compound_authority_error: currentRow.compound_authority_error ?? null,
  };
  const newValue = {
    compound_canonical_id: currentRow.compound_canonical_id ?? null,
    compound_authority_status: "pending" as CompoundStatus,
    compound_authority_error: null,
  };

  // 2) Update the fact.
  const { error: updateError } = await supabase
    .from("research_bioprospecting_facts")
    .update({
      compound_authority_status: "pending",
      compound_authority_at: null,
      compound_authority_error: null,
    })
    .eq("id", params.factId);
  if (updateError) throw updateError;

  // 3) Write the audit row. If this throws, restore the prior state.
  const { error: auditError } = await supabase
    .from("compound_authority_audit")
    .insert({
      fact_id: params.factId,
      event_type: "status_change" as const,
      old_value: oldValue,
      new_value: newValue,
      user_id: params.userId,
      reason: params.reason,
    });
  if (auditError) {
    logger.error(
      { err: auditError, factId: params.factId },
      "compound_authority_promote_audit_insert_failed_rolling_back",
    );
    const { error: rollbackError } = await supabase
      .from("research_bioprospecting_facts")
      .update({
        compound_authority_status: "failed",
        compound_authority_error: oldValue.compound_authority_error,
      })
      .eq("id", params.factId);
    if (rollbackError) {
      logger.error(
        { err: rollbackError, factId: params.factId },
        "compound_authority_promote_rollback_failed",
      );
    }
    throw auditError;
  }
}

// ---------------------------------------------------------------------------
// emptyStamp — re-exported for tests
// ---------------------------------------------------------------------------

/** Default authority stamp for fresh inserts. Exported for tests. */
export const emptyStamp: CompoundAuthorityStamp = { ...EMPTY_STAMP };

// ---------------------------------------------------------------------------
// PR #2 — PubChem backfill path
// Rate gate, PubChem HTTP client, upsert helpers, retry policy, and the
// `normalizeBioprospectingCompounds` driver. Lives in the same module
// so PR #1's sync path and PR #2's async path share `attachCanonicalToFact`.
// ---------------------------------------------------------------------------

/**
 * PubChem PUG-REST base URL. The three endpoints the worker uses are:
 *   GET /compound/name/{name}/cids/JSON              — name -> CID
 *   GET /compound/cid/{cid}/property/InChIKey,...   — CID -> props
 *   GET /compound/cid/{cid}/synonyms/JSON            — CID -> synonyms
 *
 * Spike findings (see `scripts/spike-pubchem.ts`, removed before merge):
 *   - 200 OK on hit
 *       name->cid:      { IdentifierList: { CID: [number] } }   (array, even for single)
 *       cid->props:     { PropertyTable: { Properties: [{ CID, MolecularFormula, InChIKey, IUPACName }] } }
 *       cid->synonyms:  { InformationList: { Information: [{ CID, Synonym: [string, ...] }] } }
 *   - 404 with body: { Fault: { Code: "PUGREST.NotFound", Message: "No CID found" } }
 *   - 503 (not 429) is the rate-limit signal. Body:
 *       { Fault: { Code: "PUGREST.ServerBusy", Message: "Too many requests or server too busy" } }
 *     The 503 response carries `Retry-After: <seconds>` which we honor.
 *   - `X-Throttling-Control` header is informational only (server
 *     load percentages); we do not act on it.
 *   - PubChem may return InChIKey/MolecularFormula as `undefined` for
 *     compounds that have not been fully indexed; defensive parsing
 *     coerces to null.
 */
const PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const PUBCHEM_TIMEOUT_MS = 12_000;

/** Default requests per second. Overridable via env
 * `COMPOUND_AUTHORITY_RATE_LIMIT_RPS` (read once at module load by
 * `getCompoundAuthorityConfig`). */
export const COMPOUND_AUTHORITY_DEFAULT_RPS = 4;

/** Default max retry attempts before a fact is moved to `failed`.
 * Overridable via env `COMPOUND_AUTHORITY_MAX_RETRIES` (read once at
 * module load by `getCompoundAuthorityConfig`). */
export const COMPOUND_AUTHORITY_DEFAULT_MAX_RETRIES = 5;

/**
 * Configuration snapshot read once at module load from `process.env`.
 * The spec requires env vars to be read at worker init and NOT
 * re-read mid-cycle; this object is the read-time contract.
 *
 * Resolution rules (mirrors the spec's "Default values apply when env
 * is empty" scenario):
 *   - missing / non-numeric / non-positive -> use the in-code default
 *   - floats are floored
 *
 * Tests that need to exercise env-driven values should call
 * `getCompoundAuthorityConfig()` after setting `process.env.*` BEFORE
 * importing the module — or, for the `rps` path that flows through
 * `RateGate`, pass `rps` explicitly via `NormalizeBackfillParams.rps`
 * or to the `RateGate` constructor.
 */
export type CompoundAuthorityConfig = {
  rateLimitRps: number;
  maxRetries: number;
};

function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

/** Read the worker config from env. Called once at module load and
 * exposed for the worker to thread into the driver. */
export function getCompoundAuthorityConfig(): CompoundAuthorityConfig {
  return {
    rateLimitRps: parsePositiveIntEnv(
      process.env.COMPOUND_AUTHORITY_RATE_LIMIT_RPS,
      COMPOUND_AUTHORITY_DEFAULT_RPS,
    ),
    maxRetries: parsePositiveIntEnv(
      process.env.COMPOUND_AUTHORITY_MAX_RETRIES,
      COMPOUND_AUTHORITY_DEFAULT_MAX_RETRIES,
    ),
  };
}

/** Cached config snapshot — read once at module load per the spec. */
export const COMPOUND_AUTHORITY_CONFIG: CompoundAuthorityConfig =
  getCompoundAuthorityConfig();

/**
 * Backoff schedule (ms) for the `compound_authority_at` re-check
 * window. The column itself IS the backoff — the next scheduled run
 * will only re-pick the fact when `compound_authority_at < NOW() -
 * 24h` (matching the 24h cycle). The exact value in `at` does not
 * need to encode the backoff; the `attempts` counter does. This
 * array exists so the design has an auditable reference and tests
 * can assert the schedule. Indices:
 *   attempts=1 -> 60_000      (1 minute — first retry)
 *   attempts=2 -> 300_000     (5 minutes)
 *   attempts=3 -> 1_500_000   (25 minutes)
 *   attempts=4 -> 7_200_000   (2 hours)
 *   attempts=5 -> 28_800_000  (8 hours — final retry before failed)
 *
 * The design obviates BullMQ delayed jobs by using a re-check window
 * on the fact row. Operators who want a per-fact backoff can read
 * the worker's run summary (attempts) and re-enqueue via the
 * `normalize-compounds` CLI.
 */
export const BACKOFFS_MS: readonly number[] = Object.freeze([
  60_000,
  300_000,
  1_500_000,
  7_200_000,
  28_800_000,
]);

/** Pick the backoff for the next attempt. `attempts` is the count
 * AFTER the increment (i.e. 1 on first retry). */
export function backoffFor(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return BACKOFFS_MS[0];
  const idx = Math.min(attempts - 1, BACKOFFS_MS.length - 1);
  return BACKOFFS_MS[idx];
}

// ---------------------------------------------------------------------------
// RateGate — closure over last=0 + pausedUntil=0
// ---------------------------------------------------------------------------

/**
 * Minimal in-process rate limiter. Blocks `take()` until either
 * `last + minIntervalMs` or `pausedUntil` (whichever is later) has
 * elapsed, then sets `last = now`. `pause(ms)` raises `pausedUntil`
 * to `max(pausedUntil, now + ms)` — used to honor `Retry-After`
 * responses from PubChem.
 *
 * Implementation note: not a token bucket. The chosen design
 * (await sleep + clamp) is the simplest gate that satisfies the
 * contract. At 4 rps the worker's load is steady; bursts are
 * smoothed by the 250ms cadence.
 *
 * The class is intentionally test-friendly: `now()` and `sleep()`
 * can be overridden via constructor for deterministic tests.
 */
export class RateGate {
  private last = 0;
  private pausedUntil = 0;
  private readonly minIntervalMs: number;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts?: { rps?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    const rps = opts?.rps ?? COMPOUND_AUTHORITY_DEFAULT_RPS;
    this.minIntervalMs = Math.max(1, Math.floor(1000 / rps));
    this.nowFn = opts?.now ?? (() => Date.now());
    this.sleepFn =
      opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Block until the gate allows the next call, then claim the slot. */
  async take(): Promise<void> {
    const now = this.nowFn();
    const target = Math.max(this.pausedUntil, this.last + this.minIntervalMs);
    const wait = target - now;
    if (wait > 0) await this.sleepFn(wait);
    this.last = this.nowFn();
  }

  /** Raise the gate's pause deadline. Multiple `pause()` calls take
   * the max — a 30s pause is not shortened by a later 5s pause. */
  pause(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const now = this.nowFn();
    const proposed = now + ms;
    if (proposed > this.pausedUntil) this.pausedUntil = proposed;
  }

  /** Read-only debug accessor (used by tests). */
  getMinIntervalMs(): number {
    return this.minIntervalMs;
  }

  getPausedUntil(): number {
    return this.pausedUntil;
  }
}

// ---------------------------------------------------------------------------
// PubChem HTTP client (worker only)
// ---------------------------------------------------------------------------

export class PubChemRateLimited extends Error {
  readonly retryAfterMs: number;
  readonly status: number;
  constructor(message: string, status: number, retryAfterMs: number) {
    super(message);
    this.name = "PubChemRateLimited";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PubChemNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PubChemNotFound";
  }
}

/**
 * Parse a `Retry-After` header value (seconds or HTTP-date) into
 * milliseconds. Returns the fallback when the header is missing or
 * unparseable. PubChem's actual behavior is always integer seconds
 * (we observed `Retry-After: 30`); HTTP-date is supported per RFC
 * 9110 but not exercised.
 */
export function parseRetryAfter(value: string | null, fallbackMs: number = 30_000): number {
  if (!value) return fallbackMs;
  const trimmed = value.trim();
  if (!trimmed) return fallbackMs;
  // Pure integer seconds
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.floor(Number(trimmed) * 1000));
  }
  // HTTP-date
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return fallbackMs;
}

/**
 * Internal fetch wrapper that:
 *   - respects the rate gate (`gate.take()` first)
 *   - pre-checks the daily request cap via `costService.checkCap` and
 *     throws `CostCapExceededError({ scope: 'day' })` on a hit
 *   - short-circuits via `globalThis.__pubchemDisabled__` when the
 *     same process has already hit the cap today
 *   - applies a 12s timeout via `AbortController`
 *   - throws `PubChemRateLimited` on 429/503 with the parsed Retry-After
 *     (and pauses the gate so the next caller waits too)
 *   - throws `PubChemNotFound` on 404
 *   - records the call via `costService.recordApiCall` on 2xx so the
 *     cap check consults the updated counter on the next pass
 *   - returns parsed JSON on 2xx
 *   - logs and rethrows other non-2xx (caller decides whether to retry)
 *
 * The function is `async` and `await`s the rate gate. It is the only
 * place in the worker that issues HTTP traffic to PubChem.
 */
async function pubchemFetch(
  url: string,
  gate: RateGate,
  opts?: { fetchImpl?: typeof fetch; runId?: string; sourceId?: string },
): Promise<unknown> {
  // Pre-call cap check. PubChem is free, but the daily request cap
  // (PUBCHEM_DAILY_REQUEST_CAP, default 200K) counts `units`, not
  // `costUsd`. `checkCap` short-circuits when the globalThis flag is
  // already set; the globalThis flag is set by `recordApiCall` when
  // the RPC returns cap_hit='day'.
  if (isProviderDisabled("pubchem")) {
    logger.warn(
      { event: "pubchem_disabled_today", reason: "cost_cap", url },
      "pubchem fetch short-circuited (provider disabled)",
    );
    throw new CostCapExceededError({ scope: "day", provider: "pubchem" });
  }
  const cap = await checkCap({
    provider: "pubchem",
    estimatedCostUsd: 0,
    units: 1,
    ...(opts?.runId ? { runId: opts.runId } : {}),
    ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
  });
  if (!cap.allowed) {
    logger.warn(
      { event: "pubchem_disabled_today", reason: "cost_cap", url },
      "pubchem fetch refused by pre-call cap check",
    );
    throw new CostCapExceededError({ scope: "day", provider: "pubchem" });
  }

  await gate.take();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBCHEM_TIMEOUT_MS);
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pubchem_fetch_failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    throw new PubChemNotFound(`pubchem 404: ${url}`);
  }
  if (response.status === 429 || response.status === 503) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    gate.pause(retryAfterMs);
    throw new PubChemRateLimited(
      `pubchem ${response.status}: ${url}`,
      response.status,
      retryAfterMs,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`pubchem ${response.status}: ${text.slice(0, 200)}`);
  }

  // Post-call increment. PubChem is free (costUsd=0); the daily cap
  // counts requests, so we record `units: 1`. Soft-fails on RPC
  // exception — `recordApiCall` never throws.
  await recordApiCall({
    provider: "pubchem",
    units: 1,
    costUsd: 0,
    ...(opts?.runId ? { runId: opts.runId } : {}),
    ...(opts?.sourceId ? { sourceId: opts.sourceId } : {}),
  });

  return response.json();
}

// ---------------------------------------------------------------------------
// fetchPubChemCid / fetchPubChemProperties / fetchPubChemSynonyms
// ---------------------------------------------------------------------------

/**
 * Resolve a compound name to a PubChem CID via the
 * `/compound/name/{name}/cids/JSON` endpoint. Returns the integer CID
 * or `null` on 404.
 */
export async function fetchPubChemCid(
  name: string,
  gate: RateGate,
  opts?: { fetchImpl?: typeof fetch },
): Promise<number | null> {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const url = `${PUBCHEM_BASE}/compound/name/${encodeURIComponent(trimmed)}/cids/JSON`;
  try {
    const body = (await pubchemFetch(url, gate, opts)) as {
      IdentifierList?: { CID?: number[] };
    };
    const cid = body?.IdentifierList?.CID?.[0];
    return typeof cid === "number" ? cid : null;
  } catch (err) {
    if (err instanceof PubChemNotFound) return null;
    throw err;
  }
}

export type PubChemProperties = {
  cid: number;
  inchiKey: string | null;
  formula: string | null;
  iupac: string | null;
};

/**
 * Fetch InChIKey / MolecularFormula / IUPACName for a CID. Returns
 * `null` on 404. Defensive against PubChem returning
 * `InChIKey: undefined` (seen in spike for some compounds).
 */
export async function fetchPubChemProperties(
  cid: number,
  gate: RateGate,
  opts?: { fetchImpl?: typeof fetch },
): Promise<PubChemProperties | null> {
  if (!Number.isFinite(cid) || cid <= 0) return null;
  const url = `${PUBCHEM_BASE}/compound/cid/${encodeURIComponent(String(cid))}/property/InChIKey,MolecularFormula,IUPACName/JSON`;
  try {
    const body = (await pubchemFetch(url, gate, opts)) as {
      PropertyTable?: { Properties?: Array<{
        CID?: number;
        InChIKey?: string | null;
        MolecularFormula?: string | null;
        IUPACName?: string | null;
      }> };
    };
    const row = body?.PropertyTable?.Properties?.[0];
    if (!row) return null;
    return {
      cid: row.CID ?? cid,
      inchiKey: row.InChIKey ?? null,
      formula: row.MolecularFormula ?? null,
      iupac: row.IUPACName ?? null,
    };
  } catch (err) {
    if (err instanceof PubChemNotFound) return null;
    throw err;
  }
}

/**
 * Fetch synonyms for a CID. Returns `[]` on 404 or on parse failure.
 * Note: the worker does NOT currently write PubChem synonyms to the
 * alias table — the seed loader supplies the curated starter set,
 * and the worker is concerned with the canonical row's identity. This
 * helper is exported for future use (PR #3 admin UI) and for tests.
 */
export async function fetchPubChemSynonyms(
  cid: number,
  gate: RateGate,
  opts?: { fetchImpl?: typeof fetch; limit?: number },
): Promise<string[]> {
  if (!Number.isFinite(cid) || cid <= 0) return [];
  const url = `${PUBCHEM_BASE}/compound/cid/${encodeURIComponent(String(cid))}/synonyms/JSON`;
  try {
    const body = (await pubchemFetch(url, gate, opts)) as {
      InformationList?: { Information?: Array<{ Synonym?: string[] }> };
    };
    const syns = body?.InformationList?.Information?.[0]?.Synonym;
    if (!Array.isArray(syns)) return [];
    const limit = opts?.limit ?? 50;
    return syns.filter((s) => typeof s === "string").slice(0, limit);
  } catch (err) {
    if (err instanceof PubChemNotFound) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// upsertCanonicalByPubChem / upsertAlias
// ---------------------------------------------------------------------------

export type UpsertCanonicalInput = {
  cid: number;
  canonicalName: string;
  inchiKey: string | null;
  formula: string | null;
  iupac: string | null;
  compoundKind?: "small_molecule" | "peptide" | "protein" | "lipid" | "other";
};

export type UpsertCanonicalResult = {
  id: string;
  inserted: boolean;
};

/**
 * Upsert a canonical `research_compounds` row by `pubchem_cid` (the
 * most authoritative signal) and fall back to `normalized_name` (to
 * merge with a curator-seeded row whose CID is not yet known). On
 * insert, `status = 'pubchem'`. Returns the row id and whether the
 * row was newly created.
 */
export async function upsertCanonicalByPubChem(
  input: UpsertCanonicalInput,
): Promise<UpsertCanonicalResult> {
  const normalized = normalizeForCompoundLookup(input.canonicalName);
  if (!normalized) {
    throw new Error("canonicalName is required");
  }
  // 1) Try a match on pubchem_cid first.
  const { data: byCid, error: byCidError } = await supabase
    .from("research_compounds")
    .select("id")
    .eq("pubchem_cid", input.cid)
    .maybeSingle();
  if (byCidError) throw byCidError;
  if (byCid) {
    return { id: (byCid as { id: string }).id, inserted: false };
  }

  // 2) Try a match on normalized_name (may have been seeded as 'curated').
  const { data: byName, error: byNameError } = await supabase
    .from("research_compounds")
    .select("id, pubchem_cid")
    .eq("normalized_name", normalized)
    .maybeSingle();
  if (byNameError) throw byNameError;
  if (byName) {
    const existing = byName as { id: string; pubchem_cid: number | null };
    // Backfill CID/props if missing. We do NOT overwrite curator values
    // (curated rows keep their curated status).
    if (existing.pubchem_cid == null) {
      const { error: updateError } = await supabase
        .from("research_compounds")
        .update({
          pubchem_cid: input.cid,
          inchi_key: input.inchiKey,
          molecular_formula: input.formula,
          iupac_name: input.iupac,
        })
        .eq("id", existing.id);
      if (updateError) throw updateError;
    }
    return { id: existing.id, inserted: false };
  }

  // 3) Insert fresh.
  const { data: inserted, error: insertError } = await supabase
    .from("research_compounds")
    .insert({
      canonical_name: input.canonicalName,
      normalized_name: normalized,
      inchi_key: input.inchiKey,
      pubchem_cid: input.cid,
      molecular_formula: input.formula,
      iupac_name: input.iupac,
      compound_kind: input.compoundKind ?? "small_molecule",
      status: "pubchem",
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return { id: (inserted as { id: string }).id, inserted: true };
}

/**
 * Idempotent alias insert. On duplicate `(compound_id,
 * normalized_alias)` the call is a no-op (no new row, no error).
 * Returns `{ id, inserted }`.
 */
export async function upsertAlias(input: {
  compoundId: string;
  alias: string;
  source: "local_extraction" | "pubchem" | "chebi" | "manual" | "curated";
  confidence?: "high" | "medium" | "low";
}): Promise<{ id: string; inserted: boolean }> {
  const trimmed = (input.alias || "").trim();
  if (!trimmed) throw new Error("alias is required");
  const normalized = normalizeForCompoundLookup(trimmed);
  if (!normalized) throw new Error("alias is required");
  const { data: existing, error: existingError } = await supabase
    .from("research_compound_aliases")
    .select("id")
    .eq("compound_id", input.compoundId)
    .eq("normalized_alias", normalized)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { id: (existing as { id: string }).id, inserted: false };
  const { data: inserted, error: insertError } = await supabase
    .from("research_compound_aliases")
    .insert({
      compound_id: input.compoundId,
      alias: trimmed,
      normalized_alias: normalized,
      source: input.source,
      confidence: input.confidence ?? "medium",
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return { id: (inserted as { id: string }).id, inserted: true };
}

// ---------------------------------------------------------------------------
// NormalizeBackfillParams / BackfillSummary
// ---------------------------------------------------------------------------

export type NormalizeBackfillParams = {
  limit?: number;
  dryRun?: boolean;
  onlyMissing?: boolean;
  /** Override the rate (req/s). Defaults to the env-driven config
   * (`COMPOUND_AUTHORITY_RATE_LIMIT_RPS` or
   * `COMPOUND_AUTHORITY_DEFAULT_RPS` as fallback). */
  rps?: number;
  /** Override the max retries. Defaults to the env-driven config
   * (`COMPOUND_AUTHORITY_MAX_RETRIES` or
   * `COMPOUND_AUTHORITY_DEFAULT_MAX_RETRIES` as fallback). */
  maxRetries?: number;
  /** Inject a custom fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Inject a clock (tests). */
  now?: () => number;
  /** Include facts in `failed` state in the candidate set, with
   * their `compound_authority_attempts` counter RESET to 0 for
   * this pass. Intended for the recovery flow that re-runs the
   * fuzzy PubChem search against facts that exhausted their
   * standard retry budget. Default: `false` (do not touch
   * `failed` facts). */
  includeFailed?: boolean;
  /** When the original compound name returns a PubChem 404, try
   * the deterministic name variants produced by
   * `buildCompoundNameVariants` before giving up. Each variant
   * is tried in order; the first CID hit wins. Default: `false`
   * (match the original-name-only contract of PR #2). */
  tryFuzzyVariants?: boolean;
  /** Cap on the number of fuzzy variant attempts per fact.
   * Default: 3 (most of the recovery value is in the first 2-3
   * candidates; the rest are diminishing returns). Set to 0 to
   * disable regardless of `tryFuzzyVariants`. */
  maxVariantsPerFact?: number;
};

export type BackfillSummary = {
  scannedFacts: number;
  aliasHits: number;
  pubchemHits: number;
  pubchemMisses: number;
  retriesScheduled: number;
  failed: number;
  /** Facts recovered by a fuzzy variant (i.e. the original name
   * returned 404 but a variant returned a CID). Reported
   * separately so operators can tell how much of the run is
   * recovery vs. clean hits. */
  fuzzyHits: number;
  /** Cumulative count of PubChem calls issued to fuzzy variants
   * (does not include the first attempt with the original name).
   * Useful for cost guard-rails. */
  fuzzyCalls: number;
  elapsed: number;
};

const MAX_BACKFILL_LIMIT = 500;

/**
 * The 24h re-check window. A fact whose `compound_authority_at` is
 * older than this and is still `pending` is eligible for another
 * attempt. Matches the `BACKOFFS_MS[4] = 8h` ceiling — the
 * exponential backoff caps at 8h but the window is 24h so a fact
 * gets one extra chance beyond the strict backoff before being
 * re-picked.
 */
const RECHECK_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// normalizeBioprospectingCompounds — async backfill driver
// ---------------------------------------------------------------------------

/**
 * Drive one pass of the PubChem backfill. Reads up to `limit`
 * pending facts (oldest first), resolves each one through the
 * alias map (fast path) or PubChem (slow path), and writes the
 * authority state. Returns a summary the worker logs.
 *
 * Per-fact try/catch: one bad fact does NOT abort the pass. The
 * fact is logged with structured context and the worker proceeds.
 *
 * Concurrency: serial. The gate guarantees at most one PubChem
 * call at a time, capped at `rps` (default 4). For a typical 50-fact
 * batch with 30 alias hits and 20 PubChem hits, the pass completes
 * in ~20 × 2 / 4 = 10 seconds (excluding the 24h re-check window).
 */
export async function normalizeBioprospectingCompounds(
  params: NormalizeBackfillParams = {},
): Promise<BackfillSummary> {
  const limit = Math.max(1, Math.min(MAX_BACKFILL_LIMIT, params.limit ?? 50));
  const onlyMissing = params.onlyMissing ?? true;
  const includeFailed = params.includeFailed ?? false;
  const tryFuzzyVariants = params.tryFuzzyVariants ?? false;
  const maxVariantsPerFact = Math.max(
    0,
    Math.min(20, params.maxVariantsPerFact ?? 3),
  );
  // Resolve rate limit / max retries from the env-driven config
  // (read once at module load) and fall back to in-code defaults
  // when neither env nor explicit override is present. The spec
  // mandates reading at init time and not re-reading mid-cycle.
  const rps =
    params.rps ?? COMPOUND_AUTHORITY_CONFIG.rateLimitRps;
  const maxRetries =
    params.maxRetries ?? COMPOUND_AUTHORITY_CONFIG.maxRetries;
  const gate = new RateGate({ rps, ...(params.now ? { now: params.now } : {}) });
  const startedAt = Date.now();
  const summary: BackfillSummary = {
    scannedFacts: 0,
    aliasHits: 0,
    pubchemHits: 0,
    pubchemMisses: 0,
    retriesScheduled: 0,
    failed: 0,
    fuzzyHits: 0,
    fuzzyCalls: 0,
    elapsed: 0,
  };

  // 1) Build the alias map (same in-memory shape as the sync path).
  const aliasMap = await loadAliasMap();

  // 2) Load the eligible fact set.
  const facts = await selectPendingFacts({
    limit,
    onlyMissing,
    maxRetries,
    includeFailed,
  });
  summary.scannedFacts = facts.length;
  if (facts.length === 0) {
    summary.elapsed = Date.now() - startedAt;
    return summary;
  }

  // 3) Per-fact processing with isolated error handling.
  for (const fact of facts) {
    if (params.dryRun) {
      // Dry-run: count what we WOULD do without writing. We also
      // report the variant count that would be tried if
      // `tryFuzzyVariants` were on, so the operator can see the
      // cost of a recovery pass before running it for real.
      const resolved = resolveInitialStatus(fact.compound, aliasMap);
      if (resolved.status === "verified") summary.aliasHits++;
      else if (tryFuzzyVariants) {
        const variants = buildCompoundNameVariants(fact.compound);
        const wouldTry = Math.min(maxVariantsPerFact, Math.max(0, variants.length - 1));
        summary.fuzzyCalls += wouldTry;
        summary.pubchemMisses++;
      } else {
        summary.pubchemMisses++;
      }
      continue;
    }
    try {
      await processOneFact(
        fact,
        {
          aliasMap,
          gate,
          fetchImpl: params.fetchImpl,
          tryFuzzyVariants,
          maxVariantsPerFact,
        },
        summary,
        maxRetries,
        includeFailed,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, factId: fact.id, compound: fact.compound, message },
        "compound_authority_backfill_fact_failed",
      );
      // Do not increment summary counters — the per-fact helper
      // accounts for alias hits, PubChem hits, and misses inside
      // the try block. A throw here is a hard failure (e.g. DB
      // write error) that does not map to a clean state.
    }
  }

  summary.elapsed = Date.now() - startedAt;
  return summary;
}

type PendingFactRow = {
  id: string;
  compound: string;
  compound_authority_attempts: number;
};

async function selectPendingFacts(opts: {
  limit: number;
  onlyMissing: boolean;
  maxRetries: number;
  includeFailed: boolean;
}): Promise<PendingFactRow[]> {
  const recheckIso = new Date(
    Date.now() - RECHECK_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  // When `includeFailed` is true, we widen the candidate set to
  // include `failed` rows as well as `pending`. The caller is
  // expected to use this in combination with `tryFuzzyVariants`
  // for the recovery flow; `processOneFact` will RESET the
  // attempts counter so the recovery pass starts fresh.
  const statusFilter = opts.includeFailed ? "pending,failed" : "pending";
  let query = supabase
    .from("research_bioprospecting_facts")
    .select(
      "id, compound, compound_authority_attempts",
    )
    .in("compound_authority_status", statusFilter.split(","))
    .not("compound", "is", null)
    .order("created_at", { ascending: true })
    .limit(opts.limit);
  if (opts.onlyMissing && !opts.includeFailed) {
    // Compound predicate: attempts<MAX OR at IS NULL OR at<NOW()-24h
    // PostgREST can't express a multi-clause OR cleanly; we use OR.
    // We do NOT apply this filter when including `failed` rows —
    // the recovery flow intentionally re-runs every failed fact
    // once with the fuzzy variants.
    const max = opts.maxRetries;
    query = query.or(
      `compound_authority_attempts.lt.${max},compound_authority_at.is.null,compound_authority_at.lt.${recheckIso}`,
    );
  }
  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, "compound_authority_backfill_select_failed");
    return [];
  }
  return ((data || []) as Array<{
    id: string;
    compound: string | null;
    compound_authority_attempts: number | null;
  }>).filter(
    (r): r is PendingFactRow => typeof r.id === "string" && typeof r.compound === "string",
  ).map((r) => ({
    id: r.id,
    compound: r.compound,
    compound_authority_attempts: r.compound_authority_attempts ?? 0,
  }));
}

type ProcessCtx = {
  aliasMap: Map<string, string>;
  gate: RateGate;
  fetchImpl?: typeof fetch;
  tryFuzzyVariants: boolean;
  maxVariantsPerFact: number;
};

async function processOneFact(
  fact: PendingFactRow,
  ctx: ProcessCtx,
  summary: BackfillSummary,
  maxRetries: number,
  includeFailed: boolean,
): Promise<void> {
  // 1) Re-check the alias map (in case an admin added one since the fact was extracted).
  const initial = resolveInitialStatus(fact.compound, ctx.aliasMap);
  if (initial.status === "verified" && initial.canonicalId) {
    await attachCanonicalToFact({
      factId: fact.id,
      canonicalId: initial.canonicalId,
      status: "verified",
      reason: COMPOUND_AUTHORITY_REASONS.pubchemResolved,
    });
    summary.aliasHits++;
    return;
  }
  if (initial.status === "skipped") {
    // Extract detected — re-stamp with skipped (idempotent on identical state).
    await attachCanonicalToFact({
      factId: fact.id,
      canonicalId: null,
      status: "skipped",
      error: "extract_or_mixture",
      reason: COMPOUND_AUTHORITY_REASONS.extractDetected,
    });
    return;
  }

  // 2) PubChem path. Both calls go through the gate.
  let cid: number | null;
  let cidLookupName = fact.compound;
  let triedVariants: string[] = [];
  try {
    cid = await fetchPubChemCid(fact.compound, ctx.gate, {
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
  } catch (err) {
    if (err instanceof PubChemRateLimited) {
      // Pause already applied; do not move the fact to failed (it
      // is a server signal, not a name problem). The next scheduled
      // run will re-pick it.
      logger.warn(
        { factId: fact.id, retryAfterMs: err.retryAfterMs },
        "compound_authority_backfill_rate_limited_skipping_fact",
      );
      return;
    }
    throw err;
  }

  // 2a) Fuzzy fallback. If the original name returned 404 and the
  //     caller opted in, try the deterministic variants produced
  //     by `buildCompoundNameVariants`. Each variant is tried
  //     serially; the first CID hit wins. We log every attempt
  //     and report the cumulative call count via summary.fuzzyCalls.
  if (cid == null && ctx.tryFuzzyVariants) {
    const variants = buildCompoundNameVariants(fact.compound);
    // variants[0] is the original name (already tried). Skip it.
    const candidates = variants.slice(1, 1 + ctx.maxVariantsPerFact);
    for (const variant of candidates) {
      triedVariants.push(variant);
      summary.fuzzyCalls++;
      let variantCid: number | null;
      try {
        variantCid = await fetchPubChemCid(variant, ctx.gate, {
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        });
      } catch (err) {
        if (err instanceof PubChemRateLimited) {
          // Server signal — bail out of the variant loop but do
          // NOT mark the fact as failed; the next scheduled run
          // will re-pick it.
          logger.warn(
            { factId: fact.id, retryAfterMs: err.retryAfterMs, variant },
            "compound_authority_backfill_fuzzy_rate_limited",
          );
          return;
        }
        if (err instanceof PubChemNotFound) {
          continue;
        }
        // Unknown fetch error — re-raise so the per-fact try
        // catches it and the operator sees it in the logs.
        throw err;
      }
      if (variantCid != null) {
        cid = variantCid;
        cidLookupName = variant;
        summary.fuzzyHits++;
        logger.info(
          { factId: fact.id, original: fact.compound, variant, cid },
          "compound_authority_fuzzy_recovery_hit",
        );
        break;
      }
    }
  }

  if (cid == null) {
    const triedSuffix =
      triedVariants.length > 0
        ? ` (tried ${triedVariants.length} variants)`
        : "";
    await handleMiss(
      fact,
      `pubchem 404 not found${triedSuffix}`,
      summary,
      maxRetries,
    );
    return;
  }

  let props: PubChemProperties | null = null;
  try {
    props = await fetchPubChemProperties(cid, ctx.gate, {
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
  } catch (err) {
    if (err instanceof PubChemRateLimited) {
      logger.warn(
        { factId: fact.id, retryAfterMs: err.retryAfterMs },
        "compound_authority_backfill_props_rate_limited",
      );
      return;
    }
    throw err;
  }
  if (props == null) {
    await handleMiss(fact, "pubchem 404 not found (props)", summary, maxRetries);
    return;
  }

  // 3) Upsert canonical + write a starter alias for the fact's
  //    compound name (so the next pass hits the alias map). When
  //    the canonical row was located via a fuzzy variant, we use
  //    the original compound name as the alias (the paper's
  //    spelling) AND the variant that hit PubChem (so the next
  //    similar fact does not need to re-do the search).
  const canonical = await upsertCanonicalByPubChem({
    cid: props.cid,
    canonicalName: cidLookupName,
    inchiKey: props.inchiKey,
    formula: props.formula,
    iupac: props.iupac,
  });
  const aliasInsertions: Array<{ alias: string; source: "pubchem" }> = [
    { alias: fact.compound, source: "pubchem" },
  ];
  if (cidLookupName !== fact.compound) {
    aliasInsertions.push({ alias: cidLookupName, source: "pubchem" });
  }
  for (const { alias, source } of aliasInsertions) {
    try {
      await upsertAlias({
        compoundId: canonical.id,
        alias,
        source,
        confidence: "medium",
      });
    } catch (err) {
      // Alias insert failure is non-fatal — the canonical row is
      // committed and a retry on a later pass will re-upsert the alias.
      logger.warn(
        { err, factId: fact.id, canonicalId: canonical.id, alias },
        "compound_authority_backfill_alias_upsert_failed",
      );
    }
  }

  // 4) Stamp verified. When this is a recovery pass over a fact
  //    that was previously `failed`, reset the attempts counter
  //    so the next backfill cycle starts fresh. The includeFailed
  //    flag is the only path that touches `failed` facts; we
  //    capture that here as the audit signal that this transition
  //    was a recovery, not a normal run.
  const attempts = includeFailed ? 0 : undefined;
  await attachCanonicalToFact({
    factId: fact.id,
    canonicalId: canonical.id,
    status: "verified",
    reason: COMPOUND_AUTHORITY_REASONS.pubchemResolved,
    ...(attempts !== undefined ? { attempts } : {}),
  });
  summary.pubchemHits++;
}

async function handleMiss(
  fact: PendingFactRow,
  errorMessage: string,
  summary: BackfillSummary,
  maxRetries: number,
): Promise<void> {
  const nextAttempts = (fact.compound_authority_attempts ?? 0) + 1;
  const max = maxRetries;
  if (nextAttempts >= max) {
    await attachCanonicalToFact({
      factId: fact.id,
      canonicalId: null,
      status: "failed",
      error: errorMessage,
      reason: COMPOUND_AUTHORITY_REASONS.pubchemMiss,
      attempts: nextAttempts,
    });
    summary.failed++;
  } else {
    await attachCanonicalToFact({
      factId: fact.id,
      canonicalId: null,
      status: "pending",
      error: errorMessage,
      reason: COMPOUND_AUTHORITY_REASONS.pubchemMiss,
      attempts: nextAttempts,
    });
    summary.retriesScheduled++;
    summary.pubchemMisses++;
  }
}
