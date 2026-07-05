import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import type {
  BioprospectingFact,
  ResearchTaxon,
  ResearchTaxonRank,
} from "./types";

const supabase = getServiceClient();

type TaxonInput = {
  rank: ResearchTaxonRank;
  name: string;
  parentId?: string | null;
  alias?: string | null;
  status?: string;
  externalIds?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type FactTaxa = {
  family?: ResearchTaxon | null;
  genus?: ResearchTaxon | null;
  species?: ResearchTaxon | null;
};

type ResolvedTaxon = {
  name: string;
  status?: string;
  externalIds?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  aliases?: string[];
};

export type TaxonomyNormalizationResult = {
  dryRun: boolean;
  externalAuthority: "worms" | "none";
  scannedFacts: number;
  eligibleFacts: number;
  updatedFacts: number;
  taxaCreatedOrFound: number;
  aliasesCreatedOrFound: number;
  externallyResolvedTaxa: number;
  skippedFacts: number;
  examples: Array<{
    factId: string;
    species?: string | null;
    genus?: string | null;
    family?: string | null;
    normalizedSpecies?: string | null;
    normalizedGenus?: string | null;
    normalizedFamily?: string | null;
  }>;
};

export function normalizeTaxonName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function deriveGenusFromSpeciesName(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const first = value.trim().split(/\s+/)[0];
  return first && first.length > 3 ? first : null;
}

export async function listResearchTaxa(params: {
  rank?: ResearchTaxonRank;
  query?: string;
  limit?: number;
}): Promise<ResearchTaxon[]> {
  let request = supabase
    .from("research_taxa")
    .select("*")
    .order("rank", { ascending: true })
    .order("canonical_name", { ascending: true })
    .limit(params.limit || 100);

  if (params.rank) request = request.eq("rank", params.rank);
  if (params.query?.trim()) {
    request = request.ilike("canonical_name", `%${escapeIlike(params.query)}%`);
  }

  const { data, error } = await request;
  if (error) throw error;
  return (data || []) as ResearchTaxon[];
}

export async function normalizeBioprospectingTaxonomy(params: {
  limit?: number;
  dryRun?: boolean;
  onlyMissing?: boolean;
  useWoRMS?: boolean;
}): Promise<TaxonomyNormalizationResult> {
  const limit = params.limit || 500;
  const dryRun = params.dryRun ?? false;
  const onlyMissing = params.onlyMissing ?? true;
  const useWoRMS = params.useWoRMS ?? process.env.WORMS_ENABLED === "true";

  let query = supabase
    .from("research_bioprospecting_facts")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (onlyMissing) query = query.eq("taxonomy_status", "pending");

  const { data, error } = await query;
  if (error) throw error;

  const facts = (data || []) as BioprospectingFact[];
  const result: TaxonomyNormalizationResult = {
    dryRun,
    externalAuthority: useWoRMS ? "worms" : "none",
    scannedFacts: facts.length,
    eligibleFacts: 0,
    updatedFacts: 0,
    taxaCreatedOrFound: 0,
    aliasesCreatedOrFound: 0,
    externallyResolvedTaxa: 0,
    skippedFacts: 0,
    examples: [],
  };

  for (const fact of facts) {
    const names = getFactTaxonomyNames(fact);
    if (!names.species && !names.genus && !names.family) {
      result.skippedFacts += 1;
      if (!dryRun) {
        await updateFactTaxonomyStatus(fact.id, {
          taxonomy_status: "skipped",
          taxonomy_normalized_at: new Date().toISOString(),
          taxonomy_error: null,
        });
      }
      continue;
    }

    result.eligibleFacts += 1;
    if (result.examples.length < 10) {
      result.examples.push({
        factId: fact.id,
        species: fact.species,
        genus: fact.genus,
        family: fact.family,
        normalizedSpecies: names.species,
        normalizedGenus: names.genus,
        normalizedFamily: names.family,
      });
    }

    if (dryRun) continue;

    const resolved = useWoRMS ? await resolveFactTaxaWithWoRMS(names) : {};
    result.externallyResolvedTaxa +=
      Object.values(resolved).filter(Boolean).length;

    const taxa = await upsertFactTaxa(fact, names, resolved);
    result.taxaCreatedOrFound += Object.values(taxa).filter(Boolean).length;

    result.aliasesCreatedOrFound += await upsertFactTaxonAliases(
      fact,
      taxa,
      resolved,
    );

    const patch = {
      species_taxon_id: taxa.species?.id || null,
      genus_taxon_id: taxa.genus?.id || null,
      family_taxon_id: taxa.family?.id || null,
      taxonomy_status: "normalized",
      taxonomy_normalized_at: new Date().toISOString(),
      taxonomy_error: null,
    };

    const { error: updateError } = await supabase
      .from("research_bioprospecting_facts")
      .update(patch)
      .eq("id", fact.id);
    if (updateError) throw updateError;

    result.updatedFacts += 1;
  }

  logger.info(result, "research_taxonomy_normalization_completed");
  return result;
}

async function updateFactTaxonomyStatus(
  factId: string,
  patch: {
    taxonomy_status: "normalized" | "skipped" | "failed";
    taxonomy_normalized_at?: string | null;
    taxonomy_error?: string | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from("research_bioprospecting_facts")
    .update(patch)
    .eq("id", factId);
  if (error) throw error;
}

async function upsertFactTaxa(
  fact: BioprospectingFact,
  names: {
    species: string | null;
    genus: string | null;
    family: string | null;
  },
  resolved: {
    species?: ResolvedTaxon | null;
    genus?: ResolvedTaxon | null;
    family?: ResolvedTaxon | null;
  } = {},
): Promise<FactTaxa> {
  const family = names.family
    ? await upsertTaxon({
        rank: "family",
        name: resolved.family?.name || names.family,
        alias: fact.family,
        status: resolved.family?.status,
        externalIds: resolved.family?.externalIds,
        metadata: {
          ...factMetadata(fact),
          ...(resolved.family?.metadata || {}),
        },
      })
    : null;

  const genus = names.genus
    ? await upsertTaxon({
        rank: "genus",
        name: resolved.genus?.name || names.genus,
        parentId: family?.id || null,
        alias: fact.genus || deriveGenusFromSpeciesName(fact.species),
        status: resolved.genus?.status,
        externalIds: resolved.genus?.externalIds,
        metadata: {
          ...factMetadata(fact),
          ...(resolved.genus?.metadata || {}),
        },
      })
    : null;

  const species = names.species
    ? await upsertTaxon({
        rank: "species",
        name: resolved.species?.name || names.species,
        parentId: genus?.id || null,
        alias: fact.species,
        status: resolved.species?.status,
        externalIds: resolved.species?.externalIds,
        metadata: {
          ...factMetadata(fact),
          ...(resolved.species?.metadata || {}),
        },
      })
    : null;

  return { family, genus, species };
}

async function upsertTaxon(input: TaxonInput): Promise<ResearchTaxon> {
  const canonicalName = compactName(input.name);
  const normalizedName = normalizeTaxonName(canonicalName);

  const { data: existing, error: findError } = await supabase
    .from("research_taxa")
    .select("*")
    .eq("rank", input.rank)
    .eq("normalized_name", normalizedName)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    if (input.parentId && !(existing as ResearchTaxon).parent_id) {
      const { data, error } = await supabase
        .from("research_taxa")
        .update({
          parent_id: input.parentId,
          status: input.status || (existing as ResearchTaxon).status,
          external_ids: {
            ...(((existing as ResearchTaxon).external_ids || {}) as Record<
              string,
              unknown
            >),
            ...(input.externalIds || {}),
          },
          metadata: {
            ...(((existing as ResearchTaxon).metadata || {}) as Record<
              string,
              unknown
            >),
            ...(input.metadata || {}),
          },
        })
        .eq("id", (existing as ResearchTaxon).id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ResearchTaxon;
    }
    if (input.status || input.externalIds || input.metadata) {
      const { data, error } = await supabase
        .from("research_taxa")
        .update({
          status: input.status || (existing as ResearchTaxon).status,
          external_ids: {
            ...(((existing as ResearchTaxon).external_ids || {}) as Record<
              string,
              unknown
            >),
            ...(input.externalIds || {}),
          },
          metadata: {
            ...(((existing as ResearchTaxon).metadata || {}) as Record<
              string,
              unknown
            >),
            ...(input.metadata || {}),
          },
        })
        .eq("id", (existing as ResearchTaxon).id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ResearchTaxon;
    }
    return existing as ResearchTaxon;
  }

  const { data, error } = await supabase
    .from("research_taxa")
    .insert({
      rank: input.rank,
      canonical_name: canonicalName,
      normalized_name: normalizedName,
      parent_id: input.parentId || null,
      status: input.status || "local",
      external_ids: input.externalIds || {},
      metadata: input.metadata || {},
    })
    .select("*")
    .single();
  if (error) throw error;

  return data as ResearchTaxon;
}

async function upsertFactTaxonAliases(
  fact: BioprospectingFact,
  taxa: FactTaxa,
  resolved: {
    species?: ResolvedTaxon | null;
    genus?: ResolvedTaxon | null;
    family?: ResolvedTaxon | null;
  } = {},
): Promise<number> {
  const aliases: Array<{ taxon: ResearchTaxon; alias?: string | null }> = [
    { taxon: taxa.family!, alias: fact.family },
    ...(resolved.family?.aliases || []).map((alias) => ({
      taxon: taxa.family!,
      alias,
    })),
    {
      taxon: taxa.genus!,
      alias: fact.genus || deriveGenusFromSpeciesName(fact.species),
    },
    ...(resolved.genus?.aliases || []).map((alias) => ({
      taxon: taxa.genus!,
      alias,
    })),
    { taxon: taxa.species!, alias: fact.species },
    ...(resolved.species?.aliases || []).map((alias) => ({
      taxon: taxa.species!,
      alias,
    })),
  ].filter((entry) => entry.taxon && entry.alias);

  let count = 0;
  for (const entry of aliases) {
    const alias = compactName(entry.alias || "");
    if (!alias) continue;
    await upsertTaxonAlias({
      taxonId: entry.taxon.id,
      alias,
      metadata: factMetadata(fact),
    });
    count += 1;
  }
  return count;
}

async function upsertTaxonAlias(params: {
  taxonId: string;
  alias: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const normalizedAlias = normalizeTaxonName(params.alias);
  const { data: existing, error: findError } = await supabase
    .from("research_taxon_aliases")
    .select("id")
    .eq("taxon_id", params.taxonId)
    .eq("normalized_alias", normalizedAlias)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return;

  const { error } = await supabase.from("research_taxon_aliases").insert({
    taxon_id: params.taxonId,
    alias: params.alias,
    normalized_alias: normalizedAlias,
    source: "local_extraction",
    metadata: params.metadata || {},
  });
  if (error) throw error;
}

function getFactTaxonomyNames(fact: BioprospectingFact): {
  species: string | null;
  genus: string | null;
  family: string | null;
} {
  const species = compactName(fact.species);
  const genus = compactName(fact.genus) || deriveGenusFromSpeciesName(species);
  const family = compactName(fact.family);
  return { species, genus, family };
}

async function resolveFactTaxaWithWoRMS(names: {
  species: string | null;
  genus: string | null;
  family: string | null;
}): Promise<{
  species?: ResolvedTaxon | null;
  genus?: ResolvedTaxon | null;
  family?: ResolvedTaxon | null;
}> {
  const [family, genus, species] = await Promise.all([
    names.family ? resolveTaxonWithWoRMS(names.family, "family") : null,
    names.genus ? resolveTaxonWithWoRMS(names.genus, "genus") : null,
    names.species ? resolveTaxonWithWoRMS(names.species, "species") : null,
  ]);

  return { family, genus, species };
}

type WoRMSRecord = {
  AphiaID?: number;
  url?: string;
  scientificname?: string;
  authority?: string;
  status?: string;
  rank?: string;
  valid_AphiaID?: number;
  valid_name?: string;
  valid_authority?: string;
  kingdom?: string;
  phylum?: string;
  class?: string;
  order?: string;
  family?: string;
  genus?: string;
  citation?: string;
  lsid?: string;
  isMarine?: number | boolean | null;
  isBrackish?: number | boolean | null;
  isFreshwater?: number | boolean | null;
  isTerrestrial?: number | boolean | null;
  isExtinct?: number | boolean | null;
};

async function resolveTaxonWithWoRMS(
  name: string,
  rank: "species" | "genus" | "family",
): Promise<ResolvedTaxon | null> {
  try {
    const records = await fetchWoRMSRecordsByName(name);
    const match = chooseWoRMSRecord(records, name, rank);
    if (!match) return null;

    const acceptedName = compactName(match.valid_name || match.scientificname);
    if (!acceptedName) return null;

    const aphiaId = match.AphiaID || null;
    const validAphiaId = match.valid_AphiaID || aphiaId;

    return {
      name: acceptedName,
      status: "external",
      aliases: [name, match.scientificname, match.valid_name].filter(
        (alias): alias is string => Boolean(alias && compactName(alias)),
      ),
      externalIds: {
        worms: {
          aphia_id: aphiaId,
          valid_aphia_id: validAphiaId,
          lsid: match.lsid || null,
          url: match.url || null,
        },
      },
      metadata: {
        externalAuthority: "WoRMS",
        worms: {
          rank: match.rank || null,
          status: match.status || null,
          scientificname: match.scientificname || null,
          authority: match.authority || null,
          valid_name: match.valid_name || null,
          valid_authority: match.valid_authority || null,
          citation: match.citation || null,
          flags: {
            isMarine: match.isMarine ?? null,
            isBrackish: match.isBrackish ?? null,
            isFreshwater: match.isFreshwater ?? null,
            isTerrestrial: match.isTerrestrial ?? null,
            isExtinct: match.isExtinct ?? null,
          },
        },
      },
    };
  } catch (error) {
    logger.warn({ err: error, name, rank }, "worms_taxon_lookup_failed");
    return null;
  }
}

async function fetchWoRMSRecordsByName(name: string): Promise<WoRMSRecord[]> {
  const baseUrl =
    process.env.WORMS_REST_URL || "https://www.marinespecies.org/rest";
  const url = new URL(
    `${baseUrl.replace(/\/$/, "")}/AphiaRecordsByName/${encodeURIComponent(
      name,
    )}`,
  );
  url.searchParams.set("like", "false");
  url.searchParams.set("fuzzy", "false");
  url.searchParams.set("marine_only", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`WoRMS lookup failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    return Array.isArray(body) ? (body as WoRMSRecord[]) : [];
  } finally {
    clearTimeout(timeout);
  }
}

function chooseWoRMSRecord(
  records: WoRMSRecord[],
  name: string,
  rank: "species" | "genus" | "family",
): WoRMSRecord | null {
  const normalizedName = normalizeTaxonName(name);
  const rankMatches = records.filter(
    (record) => normalizeTaxonName(record.rank || "") === rank,
  );
  const candidates = rankMatches.length > 0 ? rankMatches : records;
  const exactMatches = candidates.filter((record) =>
    [record.scientificname, record.valid_name]
      .filter(Boolean)
      .some((value) => normalizeTaxonName(value || "") === normalizedName),
  );
  if (exactMatches.length > 0) {
    return exactMatches.find(isAcceptedWoRMSRecord) || exactMatches[0];
  }

  if (rankMatches.length === 1) return rankMatches[0];
  return null;
}

function isAcceptedWoRMSRecord(record: WoRMSRecord): boolean {
  return normalizeTaxonName(record.status || "") === "accepted";
}

function factMetadata(fact: BioprospectingFact): Record<string, unknown> {
  return {
    sourceId: fact.source_id || null,
    factId: fact.id,
    extraction: "bioprospecting_fact_normalization",
  };
}

function compactName(value: string | null | undefined): string | null {
  if (!value) return null;
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > 0 ? compacted : null;
}

function escapeIlike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}
