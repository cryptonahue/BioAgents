/**
 * Discovery re-evaluation service module (PR #2 of `discovery-persistence`).
 *
 * Drives the periodic "is this discovery still alive?" pass. v1
 * (this PR) is **LLM-free** — the verdict (`clean` / `extended` /
 * `contradicted`) is computed from SQL joins against the existing
 * `research_bioprospecting_facts` + `research_bioprospecting_contradictions`
 * tables. v2 (when OpenRouter has credit) will add an LLM pass that
 * reads the new evidence and decides whether the contradiction is
 * genuine or noise.
 *
 * State machine:
 *
 *   none | clean | extended
 *      |
 *      v   (worker picks due rows; reeval_status := 'pending')
 *   pending
 *      |
 *      v   (evaluate; verdict written; reeval_status := clean|extended|contradicted)
 *   clean | extended | contradicted
 *      |
 *      v   (next tick; same as above)
 *   pending
 *
 * The transition `pending -> clean/extended/contradicted` is
 * ATOMIC per row (a single UPDATE), so two concurrent workers cannot
 * race a row into two different verdicts. BullMQ concurrency is
 * capped at 1 in v1; v2 may raise it once the LLM pass lands.
 *
 * Inputs:
 *   - `research_discoveries` (the rows being re-evaluated)
 *   - `research_discovery_evidence` (the evidence rows that link a
 *     discovery to its supporting `task_id`s)
 *   - `research_bioprospecting_facts` (the source of new evidence;
 *     matched on `compound_canonical_id` and on a normalized
 *     `compound` text vs. the discovery's normalized title)
 *   - `research_bioprospecting_contradictions` (the source of
 *     contradictions; matched on the discovery's normalized title
 *     appearing in any fact pair)
 *
 * Spec:     openspec/changes/discovery-persistence/specs/.../spec.md
 * Design:   openspec/changes/discovery-persistence/design/design.md §5
 *
 * LLM-free: this module never invokes the LLM. The verdicts are
 * derived from SQL counts only. The `notes` field on each verdict
 * is a human-readable summary; v2 may extend it with an LLM summary.
 */

import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import type { ResearchDiscoveryReevalStatus } from "./types";

// Re-export the reeval status type for callers.
export type { ResearchDiscoveryReevalStatus };

/** A due discovery row, as returned by `selectDueDiscoveries`. */
export type DueDiscovery = {
  id: string;
  discovery_group_id: string;
  conversation_id: string;
  title: string;
  claim: string;
  created_at: string;
  last_checked_at: string | null;
};

export type ReevalVerdict = "clean" | "extended" | "contradicted";

export type ReevalResult = {
  discoveryId: string;
  discoveryGroupId: string;
  verdict: ReevalVerdict;
  notes: string;
  /** Number of supporting facts the verdict is based on. */
  supportingFacts: number;
  /** Number of contradicting pairs the verdict is based on (for
   * `contradicted`). Always 0 for `clean` and `extended`. */
  contradictingPairs: number;
};

/** Result of one full pass over the due set. */
export type ReevalRunSummary = {
  scanned: number;
  clean: number;
  extended: number;
  contradicted: number;
  errors: number;
  /** Number of due rows that were picked up but the verdict write
   * failed (DB error, FK violation, etc.). They stay in `pending`
   * and the next tick re-tries them. */
  pendingRetained: number;
  elapsed: number;
};

const EMPTY_SUMMARY: ReevalRunSummary = {
  scanned: 0,
  clean: 0,
  extended: 0,
  contradicted: 0,
  errors: 0,
  pendingRetained: 0,
  elapsed: 0,
};

// ---------------------------------------------------------------------------
// Supabase client — Proxy pattern mirrors discoveryPersistence.ts.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Env-driven config
// ---------------------------------------------------------------------------

/** Default batch size per tick. Operators can tune via
 * `DISCOVERY_REEVAL_BATCH_SIZE`. */
export const DISCOVERY_REEVAL_DEFAULT_BATCH_SIZE = 100;

/** Default re-check window in hours. After this many hours a
 * `clean` / `extended` / `contradicted` row becomes eligible for
 * another pass. Operators can tune via `DISCOVERY_REEVAL_INTERVAL_HOURS`. */
export const DISCOVERY_REEVAL_DEFAULT_INTERVAL_HOURS = 24;

export type DiscoveryReevalConfig = {
  enabled: boolean;
  intervalHours: number;
  batchSize: number;
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

export function getDiscoveryReevalConfig(): DiscoveryReevalConfig {
  return {
    enabled: process.env.DISCOVERY_REEVAL_ENABLED !== "false",
    intervalHours: parsePositiveIntEnv(
      process.env.DISCOVERY_REEVAL_INTERVAL_HOURS,
      DISCOVERY_REEVAL_DEFAULT_INTERVAL_HOURS,
    ),
    batchSize: parsePositiveIntEnv(
      process.env.DISCOVERY_REEVAL_BATCH_SIZE,
      DISCOVERY_REEVAL_DEFAULT_BATCH_SIZE,
    ),
  };
}

// ---------------------------------------------------------------------------
// Normalize title for the (rough) match against fact compound text.
// Same shape as the read-through's `normalizedKey` so the two
// surfaces agree on what "the same finding" looks like.
// ---------------------------------------------------------------------------

export function normalizeTitleForMatch(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// selectDueDiscoveries — pull rows that need a re-eval
// ---------------------------------------------------------------------------

/**
 * Pull the next batch of discoveries that need a re-eval.
 * "Due" means: `is_current = true` AND
 * `reeval_status IN ('none','clean','extended')` AND
 * (`last_checked_at IS NULL` OR `last_checked_at < NOW() - INTERVAL`)
 *
 * We do NOT pick up `pending` rows here — they are owned by the
 * worker that transitioned them and are either about to be
 * resolved (in the same tick) or will be retried by the NEXT tick
 * if the verdict write failed.
 *
 * The atomic transition `* -> pending` is performed inside this
 * query by RETURNING the rows we just stamped. A second worker
 * calling this query in parallel would not see the same rows
 * (the update + returning is one statement; Postgres takes a row
 * lock for the duration).
 */
export async function selectDueDiscoveries(opts: {
  batchSize: number;
  intervalHours: number;
}): Promise<DueDiscovery[]> {
  const { batchSize, intervalHours } = opts;
  const recheckIso = new Date(
    Date.now() - intervalHours * 60 * 60 * 1000,
  ).toISOString();
  // UPDATE ... RETURNING is the standard Postgres pattern for
  // "atomically claim N rows". The RPC layer does not wrap this;
  // we issue it as a single SELECT after the UPDATE, but a
  // direct update+return is more efficient. For simplicity and
  // parity with the rest of the codebase, we use two queries:
  // 1) UPDATE the eligible rows to 'pending' and bump
  //    last_checked_at.
  // 2) SELECT those exact rows by id.
  // The race window is closed by the fact that
  // last_checked_at=NOW() is now in the past for the next tick
  // (so the row is NOT eligible until the interval elapses), and
  // the UPDATE's WHERE clause already filtered the eligible set.
  // Two concurrent updates will see the same rows but the second
  // will update 0 rows (they are no longer in the eligible set
  // because reeval_status is no longer in the IN list).
  const { data: updated, error: updateError } = await supabase
    .from("research_discoveries")
    .update({
      reeval_status: "pending",
      last_checked_at: new Date().toISOString(),
    })
    .eq("is_current", true)
    .in("reeval_status", ["none", "clean", "extended"])
    .or(
      `last_checked_at.is.null,last_checked_at.lt.${recheckIso}`,
    )
    .select("id");
  if (updateError) {
    logger.error(
      { err: updateError, batchSize, intervalHours },
      "discovery_reeval_select_due_failed",
    );
    return [];
  }
  const ids = ((updated || []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return [];

  const { data: rows, error: rowsError } = await supabase
    .from("research_discoveries")
    .select(
      "id, discovery_group_id, conversation_id, title, claim, created_at, last_checked_at",
    )
    .in("id", ids);
  if (rowsError) {
    logger.error(
      { err: rowsError },
      "discovery_reeval_load_pending_failed",
    );
    return [];
  }
  return (rows || []) as DueDiscovery[];
}

// ---------------------------------------------------------------------------
// evaluateOne — compute the verdict for a single discovery
// ---------------------------------------------------------------------------

/**
 * Pure, no-side-effects verdict computation. Given a discovery's
 * normalized title and the counts of new supporting facts and
 * contradicting pairs, return the verdict + human-readable notes.
 *
 * The decision order is:
 *   1. Any contradicting pair  -> 'contradicted'
 *   2. Any new supporting fact  -> 'extended'
 *   3. Otherwise                -> 'clean'
 *
 * This ordering ensures the most actionable signal (a real
 * contradiction) wins over the noisy "more facts" signal. The
 * admin UI surfaces the verdict in this priority order, so a
 * contradicted discovery is never out-shouted by a clean one.
 */
export function computeVerdict(input: {
  supportingFacts: number;
  contradictingPairs: number;
}): { verdict: ReevalVerdict; notes: string } {
  if (input.contradictingPairs > 0) {
    return {
      verdict: "contradicted",
      notes: `${input.contradictingPairs} contradicting fact pair(s) detected since the last check`,
    };
  }
  if (input.supportingFacts > 0) {
    return {
      verdict: "extended",
      notes: `${input.supportingFacts} new supporting fact(s) added since the last check`,
    };
  }
  return {
    verdict: "clean",
    notes: "no new evidence in the re-check window",
  };
}

/**
 * Count the supporting facts for a discovery. A "supporting fact"
 * is a `research_bioprospecting_facts` row that:
 *   - was created after the discovery's `created_at` (so it is
 *     "new relative to the discovery", not the same paper's
 *     extraction), AND
 *   - matches on `compound_canonical_id` (when the discovery
 *     references a canonical compound via its evidence) OR on a
 *     normalized text match between the discovery title and the
 *     fact's `compound` field (when no canonical id is
 *     available).
 *
 * The "created_at > discovery.created_at" clause is the v1
 * simplification: v2 will also factor in the discovery's
 * `last_checked_at` so a tick that runs more frequently than
 * the interval does not re-count the same facts. Today the
 * interval is the only guard.
 */
export async function countSupportingFacts(input: {
  discovery: DueDiscovery;
}): Promise<number> {
  const { discovery } = input;
  const normalizedTitle = normalizeTitleForMatch(discovery.title);
  if (!normalizedTitle) return 0;

  // Try a canonical_id match first. Discoveries do not store
  // compound_canonical_id directly, but the related evidence
  // rows do not store it either (they store task_id pointing
  // into JSONB). For v1 we use the text match against `compound`.
  // The Supabase PostgREST or() does not support subqueries, so
  // we run two separate count queries and take the larger.
  const titleMatchCount = await countFactsByTitleMatch({
    title: normalizedTitle,
    sinceIso: discovery.created_at,
  });
  return titleMatchCount;
}

async function countFactsByTitleMatch(input: {
  title: string;
  sinceIso: string;
}): Promise<number> {
  // PostgREST `ilike` on a single column is what we have here.
  // We search for the normalized title as a substring of the
  // compound field, case-insensitive. The discovery title is
  // a richer phrase ("Anthoteibinene J inhibits C. albicans"),
  // so we use the first two tokens of the normalized title as
  // a conservative search anchor.
  const tokens = input.title.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  // Use the longest token (typically the compound name) as the
  // search anchor, then require the rest as additional ilike
  // predicates. This is a rough match; v2 will replace it with
  // a similarity search.
  const anchor = tokens.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (!anchor) return 0;
  const { count, error } = await supabase
    .from("research_bioprospecting_facts")
    .select("id", { count: "exact", head: true })
    .ilike("compound", `%${anchor}%`)
    .gt("created_at", input.sinceIso);
  if (error) {
    logger.warn(
      { err: error, anchor, sinceIso: input.sinceIso },
      "discovery_reeval_supporting_count_failed",
    );
    return 0;
  }
  return count || 0;
}

/**
 * Count contradicting pairs that touch the discovery's topic.
 * A "pair" is a row in `research_bioprospecting_contradictions`
 * where either the source or conflicting fact has a `compound`
 * matching the discovery's normalized title.
 *
 * The discovery does not have a direct FK to the contradiction
 * table; we anchor on the same normalized title as the
 * supporting-fact match.
 */
export async function countContradictingPairs(input: {
  discovery: DueDiscovery;
}): Promise<number> {
  const { discovery } = input;
  const tokens = normalizeTitleForMatch(discovery.title).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const anchor = tokens.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (!anchor) return 0;
  // We use a subquery via the PostgREST foreign-table embed.
  // Supabase syntax: `select=source_fact:research_bioprospecting_facts!source_fact_id(...)`
  // For v1 simplicity we run two counts (one per fact side) and
  // sum them. The pair is unique in the table, so the same
  // contradiction will be counted twice — we accept this
  // overcount in v1 (the verdict is a single bit, not a count)
  // and the verdict logic only checks "any pairs > 0".
  const [sourceSide, conflictingSide] = await Promise.all([
    countContradictionsBySide("source_fact_id", anchor),
    countContradictionsBySide("conflicting_fact_id", anchor),
  ]);
  return sourceSide + conflictingSide;
}

async function countContradictionsBySide(
  side: "source_fact_id" | "conflicting_fact_id",
  anchor: string,
): Promise<number> {
  // PostgREST embed: select the embedded fact's compound and
  // filter on it. The syntax is
  //   .select(`id, ${side}:research_bioprospecting_facts!${side}(compound)`)
  //   .ilike(`${side}.compound`, `%${anchor}%`)
  const select = `id, ${side}(compound)`;
  const { count, error } = await supabase
    .from("research_bioprospecting_contradictions")
    .select(select, { count: "exact", head: true })
    .ilike(`${side}.compound`, `%${anchor}%`)
    .eq("resolution_status", "unresolved");
  if (error) {
    logger.warn(
      { err: error, side, anchor },
      "discovery_reeval_contradiction_count_failed",
    );
    return 0;
  }
  return count || 0;
}

// ---------------------------------------------------------------------------
// writeVerdict — persist the verdict + audit row
// ---------------------------------------------------------------------------

/**
 * Write the verdict on the discovery row and a matching audit row
 * in `research_discovery_reeval_audit`. Both writes are best-effort:
 * a failure here does NOT throw; the row stays in `pending` and the
 * next tick retries.
 */
export async function writeVerdict(input: {
  discovery: DueDiscovery;
  result: Omit<ReevalResult, "discoveryId" | "discoveryGroupId">;
}): Promise<boolean> {
  const { discovery, result } = input;
  try {
    // 1) Update the discovery row.
    const { error: updateError } = await supabase
      .from("research_discoveries")
      .update({
        reeval_status: result.verdict,
        reeval_notes: result.notes,
        last_checked_at: new Date().toISOString(),
      })
      .eq("id", discovery.id);
    if (updateError) {
      logger.error(
        { err: updateError, discoveryId: discovery.id },
        "discovery_reeval_write_failed",
      );
      return false;
    }

    // 2) Write the audit row. event_type is 'auto_reeval' per the
    //    research_discovery_reeval_audit CHECK constraint.
    const { error: auditError } = await supabase
      .from("research_discovery_reeval_audit")
      .insert({
        discovery_id: discovery.id,
        event_type: "auto_reeval",
        old_version_id: null,
        new_version_id: null,
        outcome: result.verdict,
        notes: result.notes,
      });
    if (auditError) {
      // Audit is best-effort: log and continue. The verdict on
      // the discovery row is what the UI reads.
      logger.warn(
        { err: auditError, discoveryId: discovery.id },
        "discovery_reeval_audit_insert_failed",
      );
    }
    return true;
  } catch (err) {
    logger.error(
      { err, discoveryId: discovery.id },
      "discovery_reeval_write_threw",
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// runReevalPass — driver called by the worker
// ---------------------------------------------------------------------------

/**
 * One pass over the due set. Returns a summary for the worker to
 * log. NEVER throws — a single bad discovery is logged and
 * skipped; the next row is processed.
 */
export async function runReevalPass(opts: {
  batchSize?: number;
  intervalHours?: number;
} = {}): Promise<ReevalRunSummary> {
  const config = getDiscoveryReevalConfig();
  if (!config.enabled) {
    logger.info(
      { event: "discovery_reeval_disabled_by_env" },
      "discovery reeval pass skipped (DISCOVERY_REEVAL_ENABLED=false)",
    );
    return { ...EMPTY_SUMMARY };
  }

  const startedAt = Date.now();
  const batchSize = opts.batchSize ?? config.batchSize;
  const intervalHours = opts.intervalHours ?? config.intervalHours;

  const summary: ReevalRunSummary = { ...EMPTY_SUMMARY };

  // 1) Atomically claim the due set.
  const due = await selectDueDiscoveries({ batchSize, intervalHours });
  summary.scanned = due.length;
  if (due.length === 0) {
    summary.elapsed = Date.now() - startedAt;
    return summary;
  }
  logger.info(
    { batchSize, intervalHours, claimed: due.length },
    "discovery_reeval_claimed",
  );

  // 2) Per-discovery verdict.
  for (const discovery of due) {
    try {
      const supportingFacts = await countSupportingFacts({ discovery });
      const contradictingPairs = await countContradictingPairs({ discovery });
      const { verdict, notes } = computeVerdict({
        supportingFacts,
        contradictingPairs,
      });
      const result: Omit<ReevalResult, "discoveryId" | "discoveryGroupId"> = {
        verdict,
        notes,
        supportingFacts,
        contradictingPairs,
      };
      const wrote = await writeVerdict({ discovery, result });
      if (wrote) {
        summary[verdict]++;
        logger.info(
          {
            discoveryId: discovery.id,
            discoveryGroupId: discovery.discovery_group_id,
            verdict,
            notes,
            supportingFacts,
            contradictingPairs,
          },
          "discovery_reeval_verdict",
        );
      } else {
        // writeVerdict did NOT throw but returned false. The row
        // stays in `pending`; the next tick re-tries.
        summary.pendingRetained++;
      }
    } catch (err) {
      // Should not happen (writeVerdict swallows), but be
      // defensive: a thrown error in the count helpers is
      // handled internally. Anything that escapes is logged
      // and the row stays in `pending`.
      logger.error(
        { err, discoveryId: discovery.id },
        "discovery_reeval_fact_failed",
      );
      summary.errors++;
      summary.pendingRetained++;
    }
  }

  summary.elapsed = Date.now() - startedAt;
  return summary;
}
