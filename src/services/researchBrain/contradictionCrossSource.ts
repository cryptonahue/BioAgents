import logger from "../../utils/logger";
import type { BioprospectingFact } from "./types";
import { normalizeForMatch } from "./search";
import type { ContradictionInsert } from "./contradictionDb";

/**
 * CORPUS-WIDE (cross-source) rule-based contradiction detection.
 *
 * `runContradictionDetection` (contradictionDetector.ts) only ever sees ONE
 * paper's facts: it loads them with `getBioprospectingFactsForSource(sourceId)`.
 * A disagreement between two papers — the scientifically interesting case — was
 * therefore structurally undetectable.
 *
 * This module is ADDITIVE: the intra-source tier is untouched. It is a separate,
 * MANUAL/SCHEDULED sweep (see `scripts/detect-contradictions.ts`) because a
 * corpus-wide pass on every ingest would be quadratic in the number of sources.
 *
 * It is 100% deterministic: ZERO LLM calls. Nothing in this module's import
 * graph reaches `./llm` or `./contradictionLlM` — that is asserted by a test.
 *
 * Row shape: GROUP-LEVEL, not pairwise. A group with N facts on one side of a
 * conflict and M on the other would produce N x M pairwise rows (a hub group on
 * a large corpus could emit thousands and flood the review queue). Instead we
 * emit ONE row per (group, conflict axis): a deterministic representative pair
 * lands in the existing `fact_a_id` / `fact_b_id` columns (the schema stays
 * pair-shaped) and the FULL picture — every conflicting fact, every source, the
 * per-side values — lands in `metadata`. That is also what an operator actually
 * wants to read: "Lupinacidin A / antitumor: opposite directions across papers
 * X, Y and Z".
 */

const MEASUREMENT_DIRECTION_OPPOSITES: Record<string, string> = {
  agonist: "antagonist",
  antagonist: "agonist",
  activator: "inhibitor",
  inhibitor: "activator",
  upregulator: "downregulator",
  downregulator: "upregulator",
  increase: "decrease",
  decrease: "increase",
};

const RELATION_TYPE_OPPOSITES: Record<string, string> = {
  activates: "inhibits",
  inhibits: "activates",
  upregulates: "downregulates",
  downregulates: "upregulates",
  increases: "decreases",
  decreases: "increases",
};

export type ConflictAxis = "measurement_direction" | "relation_type";

export const CONFLICT_AXES: readonly ConflictAxis[] = [
  "measurement_direction",
  "relation_type",
] as const;

const AXIS_OPPOSITES: Record<ConflictAxis, Record<string, string>> = {
  measurement_direction: MEASUREMENT_DIRECTION_OPPOSITES,
  relation_type: RELATION_TYPE_OPPOSITES,
};

/**
 * `conflict_type` is constrained on the live table to
 * `compound_mismatch | bioactivity_mismatch | organism_mismatch |
 * measurement_mismatch` (see the amended spec). We therefore reuse values from
 * that set rather than inventing `cross_source_*` labels that a CHECK
 * constraint would reject mid-sweep. Cross-source rows are identified by
 * `metadata.detection = 'cross_source_rule_based'`.
 *
 * The intra-source tier stores a `measurement_direction` conflict as
 * `compound_mismatch` (the compounds MATCH — that is the whole point); that
 * mislabeling is a tracked follow-up and is deliberately NOT fixed here. This
 * sweep uses the honest `measurement_mismatch` label for the direction axis,
 * which also keeps the natural key of a cross-source row distinct from an
 * intra-source row on the same axis.
 */
const AXIS_CONFLICT_TYPE: Record<ConflictAxis, string> = {
  measurement_direction: "measurement_mismatch",
  relation_type: "bioactivity_mismatch",
};

// ---------------------------------------------------------------------------
// Bounds — future-proofing, not a present emergency.
//
// Measured on the live corpus at implementation time: 145 (canonical compound,
// normalized bioactivity) groups, only 3 of which span more than one source,
// and a max group size of 9 facts. There is no combinatorial bomb TODAY. These
// bounds exist because the corpus is about to grow, and a hub group (e.g. one
// compound/bioactivity discussed by every paper) is the shape that would blow
// up first.
//
// A group above MAX_GROUP_SIZE is SKIPPED and logged at ERROR — never silently
// truncated. A run that hits MAX_ROWS_PER_RUN stops emitting and reports
// `truncated: true`, also at ERROR.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_GROUP_SIZE = 200;
export const DEFAULT_MAX_ROWS_PER_RUN = 500;

export type CrossSourceBounds = {
  maxGroupSize: number;
  maxRowsPerRun: number;
};

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Bounds are read from the env INSIDE the function (never at module top level —
 * module-level env reads cause TDZ errors in Bun workers, see CLAUDE.md).
 */
export function resolveCrossSourceBounds(
  overrides: Partial<CrossSourceBounds> = {},
  env: NodeJS.ProcessEnv = process.env,
): CrossSourceBounds {
  return {
    maxGroupSize:
      overrides.maxGroupSize ??
      readPositiveInt(
        env.BIOPROSPECTING_CONTRADICTION_MAX_GROUP_SIZE,
        DEFAULT_MAX_GROUP_SIZE,
      ),
    maxRowsPerRun:
      overrides.maxRowsPerRun ??
      readPositiveInt(
        env.BIOPROSPECTING_CONTRADICTION_MAX_ROWS_PER_RUN,
        DEFAULT_MAX_ROWS_PER_RUN,
      ),
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type CrossSourceGroup = {
  key: string;
  compoundCanonicalId: string;
  /** Representative raw compound text (from the lowest-id fact in the group). */
  compoundLabel: string;
  /** Normalized bioactivity — the second half of the group key. */
  bioactivity: string;
  facts: BioprospectingFact[];
  /** Distinct source ids, sorted. Cross-source groups have >= 2. */
  sourceIds: string[];
};

/**
 * Group key: canonical compound id + normalized bioactivity.
 *
 * The compound half uses `compound_canonical_id` (the compound-authority FK),
 * NOT the raw `compound` text: across papers the same molecule is spelled a
 * dozen ways, and the canonical id is exactly the signal that survives that.
 * A fact without a canonical id cannot be safely grouped across sources and is
 * skipped (counted as `factsWithoutCanonicalId` in the summary).
 *
 * The bioactivity half uses `normalizeForMatch` — the SAME normalizer the
 * intra-source detector uses (`contradictionDetector.buildKey`), so the two
 * tiers agree on what "the same bioactivity" means.
 */
export function buildCrossSourceGroupKey(fact: BioprospectingFact): string | null {
  const canonicalId = fact.compound_canonical_id;
  const bioactivity = fact.bioactivity;
  if (!canonicalId || !bioactivity) return null;
  const normalized = normalizeForMatch(bioactivity);
  if (!normalized) return null;
  return `${canonicalId}|${normalized}`;
}

function factSourceId(fact: BioprospectingFact): string | null {
  return fact.source_id ?? fact.source?.id ?? null;
}

function distinctSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Groups facts corpus-wide by (canonical compound, normalized bioactivity) and
 * returns ONLY the groups that span >= 2 distinct sources. A group confined to a
 * single paper is already the intra-source tier's job; re-flagging it here would
 * duplicate its rows.
 *
 * Output order is deterministic (by group key).
 */
export function groupFactsAcrossSources(
  facts: BioprospectingFact[],
): { groups: CrossSourceGroup[]; totalGroups: number; factsWithoutCanonicalId: number } {
  const byKey = new Map<string, BioprospectingFact[]>();
  let factsWithoutCanonicalId = 0;

  for (const fact of facts) {
    const key = buildCrossSourceGroupKey(fact);
    if (!key) {
      factsWithoutCanonicalId++;
      continue;
    }
    if (!factSourceId(fact)) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(fact);
  }

  const groups: CrossSourceGroup[] = [];
  for (const [key, groupFacts] of byKey) {
    const sourceIds = distinctSorted(
      groupFacts.map((f) => factSourceId(f)).filter((id): id is string => Boolean(id)),
    );
    if (sourceIds.length < 2) continue;

    const sorted = [...groupFacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [canonicalId, bioactivity] = splitKey(key);
    groups.push({
      key,
      compoundCanonicalId: canonicalId,
      compoundLabel: sorted[0]?.compound ?? canonicalId,
      bioactivity,
      facts: sorted,
      sourceIds,
    });
  }

  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { groups, totalGroups: byKey.size, factsWithoutCanonicalId };
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf("|");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// Conflict detection (group level)
// ---------------------------------------------------------------------------

export type CrossSourceConflictSide = {
  value: string;
  factIds: string[];
  sourceIds: string[];
};

export type CrossSourceConflict = {
  groupKey: string;
  axis: ConflictAxis;
  conflictType: string;
  severity: "medium" | "high";
  /** The deterministic pair written to `fact_a_id` / `fact_b_id`. */
  representative: { factAId: string; factBId: string };
  sides: CrossSourceConflictSide[];
  /** Every fact participating in the conflict, sorted. */
  factIds: string[];
  /** Every source the conflict spans, sorted. Always >= 2. */
  sourceIds: string[];
  summary: string;
};

function axisValue(fact: BioprospectingFact, axis: ConflictAxis): string | null {
  const raw = axis === "measurement_direction" ? fact.measurement_direction : fact.relation_type;
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return value || null;
}

/**
 * Finds, per axis, whether the group holds opposite values that are asserted by
 * DIFFERENT sources. A pair of opposite values that lives entirely inside one
 * paper is NOT a cross-source conflict (the intra-source tier owns it).
 *
 * Emits at most ONE conflict per axis — the group-level row.
 */
export function findCrossSourceConflicts(group: CrossSourceGroup): CrossSourceConflict[] {
  const conflicts: CrossSourceConflict[] = [];

  for (const axis of CONFLICT_AXES) {
    const opposites = AXIS_OPPOSITES[axis];

    // value -> facts (facts already sorted by id at group build time)
    const byValue = new Map<string, BioprospectingFact[]>();
    for (const fact of group.facts) {
      const value = axisValue(fact, axis);
      if (!value) continue;
      if (!byValue.has(value)) byValue.set(value, []);
      byValue.get(value)!.push(fact);
    }

    // Deterministic scan over opposite value pairs, each visited once (v < o).
    const values = [...byValue.keys()].sort();
    const participating = new Set<string>();
    const candidates: Array<{ a: BioprospectingFact; b: BioprospectingFact }> = [];

    for (const value of values) {
      const opposite = opposites[value];
      if (!opposite || opposite <= value) continue;
      const sideA = byValue.get(value);
      const sideB = byValue.get(opposite);
      if (!sideA || !sideB) continue;

      const crossPair = firstCrossSourcePair(sideA, sideB);
      if (!crossPair) continue; // opposites exist, but only within one paper

      participating.add(value);
      participating.add(opposite);
      candidates.push(crossPair);
    }

    if (candidates.length === 0) continue;

    const representative = pickRepresentative(candidates);

    const sides: CrossSourceConflictSide[] = [...participating]
      .sort()
      .map((value) => {
        const sideFacts = byValue.get(value)!;
        return {
          value,
          factIds: sideFacts.map((f) => f.id).sort(),
          sourceIds: distinctSorted(
            sideFacts.map((f) => factSourceId(f)).filter((id): id is string => Boolean(id)),
          ),
        };
      });

    const factIds = distinctSorted(sides.flatMap((s) => s.factIds));
    const sourceIds = distinctSorted(sides.flatMap((s) => s.sourceIds));

    conflicts.push({
      groupKey: group.key,
      axis,
      conflictType: AXIS_CONFLICT_TYPE[axis],
      // Three or more papers disagreeing is a louder signal than two.
      severity: sourceIds.length >= 3 ? "high" : "medium",
      representative,
      sides,
      factIds,
      sourceIds,
      summary: `Conflicting ${axis} for ${group.compoundLabel} / ${group.bioactivity}: ${sides
        .map((s) => s.value)
        .join(" vs ")} across ${sourceIds.length} sources`,
    });
  }

  return conflicts;
}

/**
 * Lowest-id fact on one side paired with the lowest-id fact on the opposite
 * side that comes from a DIFFERENT source. Both sides arrive sorted by id, so
 * the first hit of the ascending scan is the minimum.
 */
function firstCrossSourcePair(
  sideA: BioprospectingFact[],
  sideB: BioprospectingFact[],
): { a: BioprospectingFact; b: BioprospectingFact } | null {
  for (const a of sideA) {
    for (const b of sideB) {
      const sourceA = factSourceId(a);
      const sourceB = factSourceId(b);
      if (!sourceA || !sourceB) continue;
      if (sourceA === sourceB) continue;
      if (a.id === b.id) continue;
      return { a, b };
    }
  }
  return null;
}

/** Global minimum over the candidate pairs, normalized so factAId < factBId. */
function pickRepresentative(
  candidates: Array<{ a: BioprospectingFact; b: BioprospectingFact }>,
): { factAId: string; factBId: string } {
  const normalized = candidates.map(({ a, b }) =>
    a.id < b.id
      ? { factAId: a.id, factBId: b.id }
      : { factAId: b.id, factBId: a.id },
  );
  normalized.sort((x, y) =>
    x.factAId === y.factAId
      ? x.factBId < y.factBId
        ? -1
        : 1
      : x.factAId < y.factAId
        ? -1
        : 1,
  );
  return normalized[0]!;
}

// ---------------------------------------------------------------------------
// Metadata (the full picture the pair-shaped schema cannot hold)
// ---------------------------------------------------------------------------

export function buildCrossSourceMetadata(
  group: CrossSourceGroup,
  conflict: CrossSourceConflict,
): Record<string, unknown> {
  const factById = new Map(group.facts.map((f) => [f.id, f]));
  const sourceById = new Map<string, { id: string; title: string | null; doi: string | null }>();
  for (const fact of group.facts) {
    const id = factSourceId(fact);
    if (!id || sourceById.has(id)) continue;
    sourceById.set(id, {
      id,
      title: fact.source?.title ?? null,
      doi: fact.source?.doi ?? fact.doi ?? null,
    });
  }

  return {
    detection: "cross_source_rule_based",
    conflict_axis: conflict.axis,
    group_key: group.key,
    compound_canonical_id: group.compoundCanonicalId,
    compound_label: group.compoundLabel,
    bioactivity: group.bioactivity,
    fact_count: conflict.factIds.length,
    source_count: conflict.sourceIds.length,
    sources: conflict.sourceIds.map(
      (id) => sourceById.get(id) ?? { id, title: null, doi: null },
    ),
    sides: conflict.sides.map((side) => ({
      value: side.value,
      fact_ids: side.factIds,
      source_ids: side.sourceIds,
      facts: side.factIds.map((factId) => {
        const fact = factById.get(factId);
        return {
          fact_id: factId,
          source_id: fact ? factSourceId(fact) : null,
          source_title: fact?.source?.title ?? null,
          page: fact?.page ?? null,
          result_summary: fact?.result_summary ?? null,
        };
      }),
    })),
    conflicting_fact_ids: conflict.factIds,
    representative: {
      fact_a_id: conflict.representative.factAId,
      fact_b_id: conflict.representative.factBId,
    },
    conflict_summary: conflict.summary,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type CrossSourceDeps = {
  fetchFacts: () => Promise<BioprospectingFact[]>;
  upsert: (params: ContradictionInsert) => Promise<{ created: boolean }>;
};

export type SkippedGroup = {
  key: string;
  factCount: number;
  sourceCount: number;
  reason: "group_too_large";
};

export type CrossSourceDetectionSummary = {
  skipped: boolean;
  reason?: string;
  dryRun: boolean;
  factsScanned: number;
  factsWithoutCanonicalId: number;
  totalGroups: number;
  crossSourceGroups: number;
  groupsProcessed: number;
  groupsSkippedTooLarge: number;
  skippedGroups: SkippedGroup[];
  conflictsFound: number;
  rowsCreated: number;
  rowsExisting: number;
  truncated: boolean;
  bounds: CrossSourceBounds;
  durationMs: number;
};

export type CrossSourceDetectionParams = {
  dryRun?: boolean;
  /** Max cross-source GROUPS to process this run (CLI `--limit`). */
  limit?: number;
  maxGroupSize?: number;
  maxRowsPerRun?: number;
  /** Injected for tests; production resolves the real DB adapters lazily. */
  deps?: CrossSourceDeps;
};

/**
 * Production deps are imported LAZILY so that (a) callers who inject their own
 * never instantiate a Supabase client, and (b) no module-level state is created
 * at import time (Bun worker TDZ safety).
 */
async function resolveDeps(): Promise<CrossSourceDeps> {
  const db = await import("./contradictionDb");
  return {
    fetchFacts: () => db.getBioprospectingFactsForCrossSource(),
    upsert: async (params) => {
      const result = await db.upsertBioprospectingContradictionRow(params);
      return { created: result.created };
    },
  };
}

/**
 * Corpus-wide sweep. MANUAL / SCHEDULED only — never wired into the per-source
 * ingest path (that would make ingestion quadratic in the corpus size).
 *
 * Gated by `BIOPROSPECTING_CONTRADICTION_DETECTION` (the same flag as the
 * intra-source tier). The LLM flag `BIOPROSPECTING_CONTRADICTION_LLM` is
 * irrelevant here: this sweep makes ZERO LLM calls under any configuration.
 */
export async function runCrossSourceContradictionDetection(
  params: CrossSourceDetectionParams = {},
): Promise<CrossSourceDetectionSummary> {
  const startedAt = Date.now();
  const bounds = resolveCrossSourceBounds({
    ...(params.maxGroupSize != null ? { maxGroupSize: params.maxGroupSize } : {}),
    ...(params.maxRowsPerRun != null ? { maxRowsPerRun: params.maxRowsPerRun } : {}),
  });
  const dryRun = params.dryRun ?? false;

  const empty: CrossSourceDetectionSummary = {
    skipped: true,
    dryRun,
    factsScanned: 0,
    factsWithoutCanonicalId: 0,
    totalGroups: 0,
    crossSourceGroups: 0,
    groupsProcessed: 0,
    groupsSkippedTooLarge: 0,
    skippedGroups: [],
    conflictsFound: 0,
    rowsCreated: 0,
    rowsExisting: 0,
    truncated: false,
    bounds,
    durationMs: 0,
  };

  if (process.env.BIOPROSPECTING_CONTRADICTION_DETECTION !== "true") {
    logger.warn(
      { flag: "BIOPROSPECTING_CONTRADICTION_DETECTION" },
      "runCrossSourceContradictionDetection_flag_disabled",
    );
    return { ...empty, reason: "flag_disabled", durationMs: Date.now() - startedAt };
  }

  const deps = params.deps ?? (await resolveDeps());
  const facts = await deps.fetchFacts();

  const { groups, totalGroups, factsWithoutCanonicalId } = groupFactsAcrossSources(facts);

  const summary: CrossSourceDetectionSummary = {
    ...empty,
    skipped: false,
    factsScanned: facts.length,
    factsWithoutCanonicalId,
    totalGroups,
    crossSourceGroups: groups.length,
  };

  const selected =
    params.limit != null && params.limit > 0 ? groups.slice(0, params.limit) : groups;

  for (const group of selected) {
    if (group.facts.length > bounds.maxGroupSize) {
      // LOUD skip. Never silently truncate a group: a hub group is exactly the
      // one an operator most needs to know about.
      summary.groupsSkippedTooLarge++;
      summary.skippedGroups.push({
        key: group.key,
        factCount: group.facts.length,
        sourceCount: group.sourceIds.length,
        reason: "group_too_large",
      });
      logger.error(
        {
          groupKey: group.key,
          compound: group.compoundLabel,
          bioactivity: group.bioactivity,
          factCount: group.facts.length,
          sourceCount: group.sourceIds.length,
          maxGroupSize: bounds.maxGroupSize,
        },
        "runCrossSourceContradictionDetection_group_too_large_skipped",
      );
      continue;
    }

    summary.groupsProcessed++;

    for (const conflict of findCrossSourceConflicts(group)) {
      if (summary.rowsCreated + summary.rowsExisting >= bounds.maxRowsPerRun) {
        summary.truncated = true;
        logger.error(
          {
            maxRowsPerRun: bounds.maxRowsPerRun,
            rowsCreated: summary.rowsCreated,
            rowsExisting: summary.rowsExisting,
            groupKey: group.key,
          },
          "runCrossSourceContradictionDetection_row_cap_reached",
        );
        break;
      }

      summary.conflictsFound++;
      if (dryRun) continue;

      const result = await deps.upsert({
        factAId: conflict.representative.factAId,
        factBId: conflict.representative.factBId,
        conflictType: conflict.conflictType,
        severity: conflict.severity,
        explanation: conflict.summary,
        metadata: buildCrossSourceMetadata(group, conflict),
      });

      if (result.created) summary.rowsCreated++;
      else summary.rowsExisting++;
    }

    if (summary.truncated) break;
  }

  summary.durationMs = Date.now() - startedAt;

  logger.info(
    {
      factsScanned: summary.factsScanned,
      factsWithoutCanonicalId: summary.factsWithoutCanonicalId,
      totalGroups: summary.totalGroups,
      crossSourceGroups: summary.crossSourceGroups,
      groupsProcessed: summary.groupsProcessed,
      groupsSkippedTooLarge: summary.groupsSkippedTooLarge,
      conflictsFound: summary.conflictsFound,
      rowsCreated: summary.rowsCreated,
      rowsExisting: summary.rowsExisting,
      truncated: summary.truncated,
      dryRun: summary.dryRun,
      durationMs: summary.durationMs,
    },
    "runCrossSourceContradictionDetection_completed",
  );

  return summary;
}
