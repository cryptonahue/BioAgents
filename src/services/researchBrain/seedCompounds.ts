/**
 * Seed loader for `seeds/compounds-top-50.json`.
 *
 * Reads the hand-curated top-50 (51 entries) marine bioprospecting
 * compounds and idempotently upserts them into
 * `research_compounds` (status='curated') + their starter aliases
 * (status='curated', confidence='high').
 *
 * Idempotency:
 *   - canonical row: matched on `pubchem_cid` first, then on
 *     `normalized_name` (canonical fallback for entries without a
 *     CID). On a hit, the row's `inchi_key` / `molecular_formula` /
 *     `iupac_name` are backfilled ONLY when they are NULL on the
 *     existing row (we never overwrite curator values).
 *   - alias row: matched on `(compound_id, normalized_alias)`. On a
 *     hit, the call is a no-op.
 *
 * The loader is structured so the whole pass runs in a single
 * client-side loop with one DB round-trip per canonical lookup and
 * one per alias insert. The Supabase client is postgREST (no
 * server-side transaction), so the pass is NOT wrapped in a server
 * transaction; instead, the script reports inserts vs skips so an
 * operator can detect a mid-run failure and re-run. The
 * re-run is itself safe (idempotency) — that is the property the
 * spec requires.
 *
 * The function is intentionally side-effect-only via the shared
 * `supabase` proxy from `compoundAuthority.ts`. Tests should mock
 * the proxy.
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import seedData from "../../../seeds/compounds-top-50.json";
import { normalizeForCompoundLookup } from "./compoundAuthority";

const supabase = new Proxy({} as ReturnType<typeof getServiceClient>, {
  get(_target, prop) {
    const client = getServiceClient() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as ReturnType<typeof getServiceClient>;

export type SeedCompoundEntry = {
  canonical_name: string;
  pubchem_cid: number | null;
  inchi_key: string | null;
  molecular_formula: string | null;
  iupac_name: string | null;
  compound_kind?:
    | "small_molecule"
    | "peptide"
    | "protein"
    | "lipid"
    | "other";
  aliases?: string[];
};

export type SeedLoadSummary = {
  canonicalsInserted: number;
  canonicalsSkipped: number;
  canonicalsUpdated: number;
  aliasesInserted: number;
  aliasesSkipped: number;
};

/**
 * Type-narrow the seed JSON. We deliberately accept `null` for the
 * optional scientific fields because some seed entries (e.g. crude
 * marine extracts, complex glycans) are not fully characterized in
 * PubChem.
 */
function isSeedEntry(value: unknown): value is SeedCompoundEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.canonical_name !== "string" || !v.canonical_name.trim()) {
    return false;
  }
  // pubchem_cid may be null OR a non-negative integer
  if (
    v.pubchem_cid !== null &&
    v.pubchem_cid !== undefined &&
    (!Number.isInteger(v.pubchem_cid) || (v.pubchem_cid as number) < 0)
  ) {
    return false;
  }
  if (!Array.isArray(v.aliases)) return false;
  return true;
}

/**
 * Idempotent seed loader. Walks the JSON, upserts each canonical row
 * and each alias. Returns a summary that the CLI script prints.
 *
 * Pass `dryRun: true` to log the would-be writes without actually
 * persisting. Used by `bun run seed:compounds --dry-run` in CI to
 * validate the JSON shape.
 */
export async function loadSeedCompounds(
  opts: { dryRun?: boolean } = {},
): Promise<SeedLoadSummary> {
  const summary: SeedLoadSummary = {
    canonicalsInserted: 0,
    canonicalsSkipped: 0,
    canonicalsUpdated: 0,
    aliasesInserted: 0,
    aliasesSkipped: 0,
  };

  const entries = (seedData as unknown[]).filter(isSeedEntry);
  if (entries.length === 0) {
    logger.warn(
      { seedLength: (seedData as unknown[]).length },
      "compound_authority_seed_empty_after_filter",
    );
    return summary;
  }

  for (const entry of entries) {
    const normalized = normalizeForCompoundLookup(entry.canonical_name);
    if (!normalized) {
      logger.warn(
        { canonical_name: entry.canonical_name },
        "compound_authority_seed_skipping_unnormalizeable_entry",
      );
      continue;
    }

    // 1) Find or insert the canonical row.
    const { id: canonicalId, inserted, updated } = await upsertCanonical(
      entry,
      normalized,
      opts,
    );
    if (inserted) summary.canonicalsInserted++;
    else if (updated) summary.canonicalsUpdated++;
    else summary.canonicalsSkipped++;

    // 2) Upsert each alias.
    for (const alias of entry.aliases ?? []) {
      const aliasTrimmed = (alias || "").trim();
      if (!aliasTrimmed) continue;
      const aliasNormalized = normalizeForCompoundLookup(aliasTrimmed);
      if (!aliasNormalized) continue;

      if (opts.dryRun) {
        summary.aliasesSkipped++; // dry-run: pretend all are skipped
        continue;
      }
      const result = await upsertAlias({
        compoundId: canonicalId,
        alias: aliasTrimmed,
        normalizedAlias: aliasNormalized,
      });
      if (result.inserted) summary.aliasesInserted++;
      else summary.aliasesSkipped++;
    }
  }

  return summary;
}

type UpsertCanonicalOutcome = {
  id: string;
  inserted: boolean;
  updated: boolean;
};

async function upsertCanonical(
  entry: SeedCompoundEntry,
  normalized: string,
  opts: { dryRun?: boolean },
): Promise<UpsertCanonicalOutcome> {
  if (opts.dryRun) {
    // Pretend the lookup succeeded; we do not write in dry-run.
    return { id: "DRY_RUN", inserted: false, updated: false };
  }

  // a) Try match on pubchem_cid
  if (entry.pubchem_cid != null) {
    const { data: byCid, error: byCidError } = await supabase
      .from("research_compounds")
      .select("id, inchi_key, molecular_formula, iupac_name")
      .eq("pubchem_cid", entry.pubchem_cid)
      .maybeSingle();
    if (byCidError) throw byCidError;
    if (byCid) {
      return { id: (byCid as { id: string }).id, inserted: false, updated: false };
    }
  }

  // b) Try match on normalized_name (curator might have seeded it with status='local')
  const { data: byName, error: byNameError } = await supabase
    .from("research_compounds")
    .select("id, inchi_key, molecular_formula, iupac_name, pubchem_cid, status")
    .eq("normalized_name", normalized)
    .maybeSingle();
  if (byNameError) throw byNameError;
  if (byName) {
    const row = byName as {
      id: string;
      inchi_key: string | null;
      molecular_formula: string | null;
      iupac_name: string | null;
      pubchem_cid: number | null;
      status: string;
    };
    // Backfill props only when the existing row has them NULL.
    // Never overwrite a 'curated' row's curated values.
    const needsBackfill =
      entry.pubchem_cid != null &&
      (row.inchi_key == null ||
        row.molecular_formula == null ||
        row.iupac_name == null ||
        row.pubchem_cid == null);
    if (needsBackfill) {
      const patch: Record<string, unknown> = {};
      if (row.pubchem_cid == null && entry.pubchem_cid != null) {
        patch.pubchem_cid = entry.pubchem_cid;
      }
      if (row.inchi_key == null) patch.inchi_key = entry.inchi_key;
      if (row.molecular_formula == null) patch.molecular_formula = entry.molecular_formula;
      if (row.iupac_name == null) patch.iupac_name = entry.iupac_name;
      const { error: updateError } = await supabase
        .from("research_compounds")
        .update(patch)
        .eq("id", row.id);
      if (updateError) throw updateError;
      return { id: row.id, inserted: false, updated: true };
    }
    return { id: row.id, inserted: false, updated: false };
  }

  // c) Insert fresh curated row
  const insertPayload: Record<string, unknown> = {
    canonical_name: entry.canonical_name,
    normalized_name: normalized,
    inchi_key: entry.inchi_key,
    molecular_formula: entry.molecular_formula,
    iupac_name: entry.iupac_name,
    compound_kind: entry.compound_kind ?? "small_molecule",
    status: "curated",
  };
  if (entry.pubchem_cid != null) {
    insertPayload.pubchem_cid = entry.pubchem_cid;
  }
  const { data: inserted, error: insertError } = await supabase
    .from("research_compounds")
    .insert(insertPayload)
    .select("id")
    .single();
  if (insertError) throw insertError;
  return { id: (inserted as { id: string }).id, inserted: true, updated: false };
}

async function upsertAlias(input: {
  compoundId: string;
  alias: string;
  normalizedAlias: string;
}): Promise<{ inserted: boolean }> {
  const { data: existing, error: existingError } = await supabase
    .from("research_compound_aliases")
    .select("id")
    .eq("compound_id", input.compoundId)
    .eq("normalized_alias", input.normalizedAlias)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { inserted: false };

  const { error: insertError } = await supabase
    .from("research_compound_aliases")
    .insert({
      compound_id: input.compoundId,
      alias: input.alias,
      normalized_alias: input.normalizedAlias,
      source: "curated",
      confidence: "high",
    });
  if (insertError) throw insertError;
  return { inserted: true };
}
