/**
 * discovery-persistence service module.
 *
 * Write-through layer that dual-writes every discovery extracted by the
 * LLM to the new relational tables (`research_discoveries` +
 * `research_discovery_evidence`) and keeps the existing JSONB cache in
 * sync via the caller's separate write. v1 ships ONLY this write path;
 * the read endpoint is PR #2's work.
 *
 * Contract: this module is **non-throwing**. Every catch site logs a
 * structured event with one of the names from design.md §4.4 and
 * returns a best-effort `PersistResult`. The agent and the worker both
 * wrap their call in try/catch as a defensive belt-and-suspenders, but
 * the contract is "this function never throws".
 *
 * Flow (design.md §4.2):
 *   1. Load existing current rows for the conversation
 *   2. For each incoming discovery: match by Jaccard, insert new +
 *      supersede old (or insert fresh)
 *   3. Reconcile removals: existing current rows that did NOT match any
 *      incoming discovery are soft-deleted
 *   4. Bulk insert evidence for newly-inserted rows
 *   5. Return { inserted, superseded, removed, unchanged, errors }
 *
 * Idempotency (design.md §4.5): the function is idempotent on rerun for
 * the same `(messageId, discovery_key)` tuple because the second pass
 * matches the just-inserted row exactly (Jaccard = 1.0) and supersedes
 * it. End-state is "one current row, N historical rows".
 *
 * Spec:     openspec/changes/discovery-persistence/specs/.../spec.md
 * Design:   openspec/changes/discovery-persistence/design/design.md
 */

import { getServiceClient } from "../../db/client";
import type { Discovery } from "../../types/core";
import logger from "../../utils/logger";
import {
  discoveryStableKey,
  findMatchingDiscovery,
  jaccard,
  normalizeTokens,
} from "../../agents/discovery/utils";
import type { ResearchDiscovery, ResearchDiscoveryEvidence } from "./types";

// Re-export the 4 pure match functions so callers can `import {
// normalizeTokens, jaccard, discoveryStableKey, findMatchingDiscovery }
// from ".../discoveryPersistence"`.
export {
  discoveryStableKey,
  findMatchingDiscovery,
  jaccard,
  normalizeTokens,
} from "../../agents/discovery/utils";

// ---------------------------------------------------------------------------
// Supabase client — Proxy pattern mirrors `compoundAuthority.ts:44-53`.
// Each `.from(...)` call reads the (possibly mocked) service client at
// call time, so test mocks take effect immediately.
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
// Types
// ---------------------------------------------------------------------------

/** Result of a single persist call. All four arrays are always defined
 * (never undefined) so callers can read `.length` without a null check. */
export type PersistResult = {
  inserted: string[];
  superseded: string[];
  removed: string[];
  unchanged: string[];
  errors: string[];
};

export type PersistParams = {
  discoveries: Discovery[];
  conversationId: string;
  messageId: string;
  threshold?: number;
  loggerFields?: Record<string, unknown>;
};

/** Existing current row loaded for matching. */
type ExistingRow = {
  id: string;
  discovery_key: string;
  discovery_group_id: string;
};

const EMPTY_RESULT: PersistResult = {
  inserted: [],
  superseded: [],
  removed: [],
  unchanged: [],
  errors: [],
};

// ---------------------------------------------------------------------------
// persistDiscoveriesToDb — main entry point
// ---------------------------------------------------------------------------

/**
 * Best-effort write-through. NEVER throws. On any unrecoverable error
 * returns `EMPTY_RESULT` after logging `discovery_persist_failed_soft_fail`.
 *
 * The agent and worker both wrap this in try/catch as a defensive
 * belt-and-suspenders, but the contract is "this function never throws".
 */
export async function persistDiscoveriesToDb(
  params: PersistParams,
): Promise<PersistResult> {
  const {
    discoveries,
    conversationId,
    messageId,
    threshold = 0.7,
    loggerFields = {},
  } = params;
  const baseLog = {
    conversationId,
    messageId,
    discoveryCount: discoveries.length,
    threshold,
    ...loggerFields,
  };

  try {
    // Step 1: load existing current rows.
    let existing: ExistingRow[] = [];
    try {
      const { data, error } = await supabase
        .from("research_discoveries")
        .select("id, discovery_key, discovery_group_id")
        .eq("conversation_id", conversationId)
        .eq("is_current", true);
      if (error) throw error;
      existing = (data || []) as ExistingRow[];
    } catch (err) {
      logger.error(
        { err, ...baseLog },
        "discovery_persist_load_failed",
      );
      return {
        ...EMPTY_RESULT,
        errors: ["discovery_persist_load_failed"],
      };
    }

    // Step 2: per-incoming match + insert + supersede.
    const inserted: string[] = [];
    const superseded: string[] = [];
    const errors: string[] = [];
    const matchedExistingIds = new Set<string>();
    // v1: there is no "unchanged" path — every existing row that the
    // LLM does NOT re-emit is treated as removed. We track matched
    // ids above and reconcile the rest in step 3. The `unchanged`
    // field in PersistResult is always [] in v1; it exists for v2
    // where the LLM can opt to leave a row untouched.
    const unchanged: string[] = [];

    for (const incoming of discoveries) {
      if (!incoming || !incoming.title || !incoming.claim) {
        // Defensive: skip rows with empty title/claim.
        continue;
      }
      const incomingKey = discoveryStableKey(incoming.title, incoming.claim);
      const matchedId = findMatchingDiscovery(
        { title: incoming.title, claim: incoming.claim },
        existing,
        threshold,
      );
      try {
        if (matchedId) {
          matchedExistingIds.add(matchedId);
          const target = existing.find((r) => r.id === matchedId);
          if (!target) {
            // Should not happen — findMatchingDiscovery returned an id
            // we don't have. Defensive: fall through to fresh insert.
            errors.push("discovery_persist_supersede_target_missing");
            continue;
          }
          // 2a: insert new row superseding the matched one.
          const newId = crypto.randomUUID();
          const insertedRow = await insertDiscoveryRow({
            id: newId,
            discovery_group_id: target.discovery_group_id,
            conversation_id: conversationId,
            message_id: messageId,
            supersedes_discovery_id: matchedId,
            title: incoming.title,
            claim: incoming.claim,
            summary: incoming.summary || "",
            novelty: incoming.novelty || null,
            artifacts: incoming.artifacts || [],
            discovery_key: incomingKey,
          });
          if (!insertedRow) {
            errors.push("discovery_persist_insert_failed");
            continue;
          }
          inserted.push(newId);
          // 2b: mark the old row superseded.
          const ok = await supersedeDiscovery(matchedId);
          if (!ok) errors.push("discovery_persist_supersede_failed");
          else superseded.push(matchedId);

          // 2c: merge evidence: copy OLD evidence rows into the NEW row
          // (deduped by taskId), then add NEW rows. The merge is a copy
          // of the OLD rows + the new ones — both end up as separate
          // rows in research_discovery_evidence pointing at the new
          // discovery_id, preserving the audit trail. We dedupe by
          // taskId so a row referenced by both old and new versions
          // is not duplicated.
          const oldEvidence = await loadEvidenceForDiscovery(matchedId);
          const seenTaskIds = new Set<string>();
          const carryOverRows: EvidenceInsertRow[] = [];
          for (const ev of oldEvidence) {
            if (seenTaskIds.has(ev.task_id)) continue;
            seenTaskIds.add(ev.task_id);
            carryOverRows.push({
              discovery_id: newId,
              task_id: ev.task_id,
              job_id: ev.job_id ?? null,
              explanation: ev.explanation || "",
              source_url: ev.source_url ?? null,
              evidence_archived: false,
            });
          }
          const newEvidenceRows: EvidenceInsertRow[] = (incoming.evidenceArray || [])
            .filter((e) => e && e.taskId)
            .map((e) => ({
              discovery_id: newId,
              task_id: e.taskId,
              job_id: e.jobId ?? null,
              explanation: e.explanation || "",
              source_url: null,
              evidence_archived: false,
            }))
            .filter((r) => {
              if (seenTaskIds.has(r.task_id)) return false;
              seenTaskIds.add(r.task_id);
              return true;
            });
          const allRows = [...carryOverRows, ...newEvidenceRows];
          if (allRows.length > 0) {
            const okInsert = await insertEvidenceRows(allRows);
            if (!okInsert) errors.push("discovery_evidence_insert_failed");
          }
        } else {
          // Fresh insert with a new group id.
          const newId = crypto.randomUUID();
          const newGroupId = crypto.randomUUID();
          const insertedRow = await insertDiscoveryRow({
            id: newId,
            discovery_group_id: newGroupId,
            conversation_id: conversationId,
            message_id: messageId,
            supersedes_discovery_id: null,
            title: incoming.title,
            claim: incoming.claim,
            summary: incoming.summary || "",
            novelty: incoming.novelty || null,
            artifacts: incoming.artifacts || [],
            discovery_key: incomingKey,
          });
          if (!insertedRow) {
            errors.push("discovery_persist_insert_failed");
            continue;
          }
          inserted.push(newId);
          const newEvidenceRows = (incoming.evidenceArray || [])
            .filter((e) => e && e.taskId)
            .map((e) => ({
              discovery_id: newId,
              task_id: e.taskId,
              job_id: e.jobId ?? null,
              explanation: e.explanation || "",
              source_url: null,
              evidence_archived: false,
            }));
          if (newEvidenceRows.length > 0) {
            const okInsert = await insertEvidenceRows(newEvidenceRows);
            if (!okInsert) errors.push("discovery_evidence_insert_failed");
          }
        }
      } catch (err) {
        logger.error(
          { err, conversationId, messageId, title: incoming.title },
          "discovery_persist_insert_failed",
        );
        errors.push("discovery_persist_insert_failed");
      }
    }

    // Step 3: reconcile removals — any existing current row that did NOT
    // match an incoming discovery is the LLM's signal of removal.
    const removed: string[] = [];
    for (const row of existing) {
      if (matchedExistingIds.has(row.id)) continue;
      try {
        const ok = await supersedeDiscovery(row.id);
        if (ok) {
          removed.push(row.id);
        } else {
          errors.push("discovery_persist_reconcile_failed");
        }
      } catch (err) {
        logger.error(
          { err, conversationId, messageId, rowId: row.id },
          "discovery_persist_reconcile_failed",
        );
        errors.push("discovery_persist_reconcile_failed");
      }
    }

    logger.info(
      {
        ...baseLog,
        insertedCount: inserted.length,
        supersededCount: superseded.length,
        removedCount: removed.length,
        unchangedCount: unchanged.length,
        errorCount: errors.length,
      },
      "discovery_persist_completed",
    );

    return { inserted, superseded, removed, unchanged, errors };
  } catch (err) {
    // Top-level catch. We never want to throw to the caller.
    logger.error(
      { err, ...baseLog },
      "discovery_persist_failed_soft_fail",
    );
    return { ...EMPTY_RESULT, errors: ["discovery_persist_failed_soft_fail"] };
  }
}

// ---------------------------------------------------------------------------
// getDiscoveriesForConversation — v1 read path used by the PR #2 route.
// Exposed now so PR #1 callers (none in this PR) can already use it.
// Strategy: try a single Supabase join `*, evidence:research_discovery_evidence(*)`
// first; on any error, fall back to two queries (spec design.md §4.3).
// ---------------------------------------------------------------------------

export type GetDiscoveriesParams = {
  conversationId: string;
};

export type ResearchDiscoveryWithEvidence = ResearchDiscovery & {
  evidence: ResearchDiscoveryEvidence[];
};

export async function getDiscoveriesForConversation(
  params: GetDiscoveriesParams,
): Promise<ResearchDiscoveryWithEvidence[]> {
  const { conversationId } = params;
  if (!conversationId) return [];

  // 1) Single join attempt.
  try {
    const { data, error } = await supabase
      .from("research_discoveries")
      .select("*, evidence:research_discovery_evidence(*)")
      .eq("conversation_id", conversationId)
      .eq("is_current", true)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = (data || []) as Array<
      ResearchDiscovery & { evidence?: ResearchDiscoveryEvidence[] }
    >;
    return rows.map((r) => ({
      ...r,
      evidence: r.evidence || [],
    }));
  } catch (err) {
    logger.warn(
      { err, conversationId },
      "discovery_get_join_failed_falling_back_to_two_queries",
    );
  }

  // 2) Fallback: two queries.
  let rows: ResearchDiscovery[] = [];
  try {
    const { data, error } = await supabase
      .from("research_discoveries")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("is_current", true)
      .order("created_at", { ascending: false });
    if (error) throw error;
    rows = (data || []) as ResearchDiscovery[];
  } catch (err) {
    logger.error(
      { err, conversationId },
      "discovery_get_discoveries_failed",
    );
    return [];
  }

  if (rows.length === 0) return rows.map((r) => ({ ...r, evidence: [] }));

  const ids = rows.map((r) => r.id);
  let evidence: ResearchDiscoveryEvidence[] = [];
  try {
    const { data, error } = await supabase
      .from("research_discovery_evidence")
      .select("*")
      .in("discovery_id", ids)
      .order("created_at", { ascending: true });
    if (error) throw error;
    evidence = (data || []) as ResearchDiscoveryEvidence[];
  } catch (err) {
    logger.error(
      { err, conversationId },
      "discovery_get_evidence_failed",
    );
    // Continue with empty evidence; the discoveries themselves are still useful.
  }

  const byId = new Map<string, ResearchDiscoveryEvidence[]>();
  for (const e of evidence) {
    const arr = byId.get(e.discovery_id) || [];
    arr.push(e);
    byId.set(e.discovery_id, arr);
  }
  return rows.map((r) => ({
    ...r,
    evidence: byId.get(r.id) || [],
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers — each one catches its own error and returns
// boolean/null. None of them throws.
// ---------------------------------------------------------------------------

type InsertRowPayload = {
  id: string;
  discovery_group_id: string;
  conversation_id: string;
  message_id: string;
  supersedes_discovery_id: string | null;
  title: string;
  claim: string;
  summary: string;
  novelty: string | null;
  artifacts: Discovery["artifacts"];
  discovery_key: string;
};

async function insertDiscoveryRow(
  payload: InsertRowPayload,
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("research_discoveries")
      .insert({
        id: payload.id,
        discovery_group_id: payload.discovery_group_id,
        conversation_id: payload.conversation_id,
        message_id: payload.message_id,
        supersedes_discovery_id: payload.supersedes_discovery_id,
        is_current: true,
        superseded_at: null,
        title: payload.title,
        claim: payload.claim,
        summary: payload.summary,
        novelty: payload.novelty,
        artifacts: payload.artifacts || [],
        discovery_key: payload.discovery_key,
        reeval_status: "none",
        reeval_notes: null,
        last_checked_at: null,
      });
    if (error) {
      logger.error(
        { err: error, discoveryId: payload.id },
        "discovery_persist_insert_failed",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err, discoveryId: payload.id },
      "discovery_persist_insert_failed",
    );
    return false;
  }
}

async function supersedeDiscovery(rowId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("research_discoveries")
      .update({
        is_current: false,
        superseded_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    if (error) {
      logger.error(
        { err: error, rowId },
        "discovery_persist_supersede_failed",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err, rowId },
      "discovery_persist_supersede_failed",
    );
    return false;
  }
}

async function loadEvidenceForDiscovery(
  discoveryId: string,
): Promise<ResearchDiscoveryEvidence[]> {
  try {
    const { data, error } = await supabase
      .from("research_discovery_evidence")
      .select("*")
      .eq("discovery_id", discoveryId);
    if (error) {
      logger.warn(
        { err: error, discoveryId },
        "discovery_load_evidence_failed",
      );
      return [];
    }
    return (data || []) as ResearchDiscoveryEvidence[];
  } catch (err) {
    logger.warn(
      { err, discoveryId },
      "discovery_load_evidence_failed",
    );
    return [];
  }
}

type EvidenceInsertRow = {
  discovery_id: string;
  task_id: string;
  job_id: string | null;
  explanation: string;
  source_url: string | null;
  evidence_archived: boolean;
};

async function insertEvidenceRows(
  rows: EvidenceInsertRow[],
): Promise<boolean> {
  if (rows.length === 0) return true;
  try {
    const { error } = await supabase
      .from("research_discovery_evidence")
      .insert(rows);
    if (error) {
      logger.error(
        { err: error, count: rows.length },
        "discovery_evidence_insert_failed",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err, count: rows.length },
      "discovery_evidence_insert_failed",
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// loadDiscoveriesForConversation — read-through for downstream consumers
// (PR #2 of discovery-persistence)
//
// Replaces the JSONB read path (`conversationState.values.discoveries`)
// for the consumers that build LLM prompts and user-facing UI off the
// current set of findings. The discovery agent itself keeps reading the
// JSONB because it is the LLM's input for the SAME iteration; the new
// rows are not yet persisted when the agent runs.
//
// Modes (env var DISCOVERY_READ_SOURCE):
//   - "jsonb" (default for dev): always return the JSONB. The DB is
//     written but not read; useful when the operator wants to verify
//     the dual-write without trusting the read.
//   - "db" (default for prod): read from the table. If the table is
//     empty for this conversation, fall back to the JSONB and log
//     `discovery_read_db_empty_fallback` so operators see the gap.
//   - "dual": read BOTH and compare. If they match (same set of
//     normalized title+claim keys), use the DB. If they differ, log
//     `discovery_read_mismatch` with the diff and return the DB set
//     (DB is the source of truth). This is the rollout mode: a single
//     cycle of "dual" with zero mismatches is the green light to
//     flip DISCOVERY_READ_SOURCE to "db" and disable "dual".
//
// The function NEVER throws. On any unrecoverable DB error, it falls
// back to the JSONB and logs a structured event.
// ---------------------------------------------------------------------------

export type DiscoveryReadSource = "jsonb" | "db" | "dual";

const DEFAULT_READ_SOURCE: DiscoveryReadSource = "db";

export type LoadDiscoveriesParams = {
  conversationId: string;
  fallbackDiscoveries: Discovery[];
  /** Optional override for the read mode. Defaults to
   * env `DISCOVERY_READ_SOURCE` (or "db" if unset). */
  source?: DiscoveryReadSource;
  /** Optional logger fields (e.g. jobId, userId). */
  loggerFields?: Record<string, unknown>;
};

export type LoadDiscoveriesResult = {
  discoveries: Discovery[];
  /** The source that produced the result. */
  source: "jsonb" | "db";
  /** When source="db" and the DB was empty for this conversation
   * (i.e. we fell back to the JSONB), this is `true`. */
  dbWasEmpty: boolean;
  /** When running in "dual" mode, this carries the comparison
   * outcome for the operator dashboard. `null` when not in dual. */
  dualComparison: null | {
    dbCount: number;
    jsonbCount: number;
    /** Normalized `(title + claim)` key set present in DB but not
     * in JSONB. */
    onlyInDb: string[];
    /** Normalized key set present in JSONB but not in DB. */
    onlyInJsonb: string[];
  };
};

function readSourceFromEnv(): DiscoveryReadSource {
  const raw = process.env.DISCOVERY_READ_SOURCE?.toLowerCase().trim();
  if (raw === "jsonb" || raw === "db" || raw === "dual") return raw;
  return DEFAULT_READ_SOURCE;
}

/**
 * Convert a normalized (lowercase, NFKD, alnum-only, space-collapsed)
 * form of `title + " " + claim` to a stable comparison key. This is
 * the same shape used by the persist path's `discoveryStableKey`, but
 * we keep an independent implementation here so the read path is
 * correct even if the persist path's key formula changes.
 */
export function normalizedKey(title: string, claim: string): string {
  const joined = `${title || ""} ${claim || ""}`;
  return joined
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Pure shape conversion: `ResearchDiscoveryWithEvidence[]` (DB row
 * shape) to `Discovery[]` (consumer/JSONB shape). Preserves the
 * `created_at DESC` ordering the upstream `getDiscoveriesForConversation`
 * already produces, and defaults optional fields to safe empties.
 *
 * Evidence rows are deduplicated by `task_id` (the first row wins) so
 * a supersede cycle that re-inserted carry-over evidence does not
 * produce duplicates downstream.
 */
export function dbDiscoveriesToDomain(
  rows: ResearchDiscoveryWithEvidence[],
): Discovery[] {
  return rows.map((row) => {
    const seen = new Set<string>();
    const evidenceArray: Discovery["evidenceArray"] = [];
    for (const ev of row.evidence || []) {
      if (!ev.task_id) continue;
      if (seen.has(ev.task_id)) continue;
      seen.add(ev.task_id);
      evidenceArray.push({
        taskId: ev.task_id,
        ...(ev.job_id ? { jobId: ev.job_id } : {}),
        explanation: ev.explanation || "",
      });
    }
    return {
      title: row.title,
      claim: row.claim,
      summary: row.summary,
      evidenceArray,
      artifacts: (row.artifacts as Discovery["artifacts"]) || [],
      novelty: row.novelty || "",
    };
  });
}

function keySet(rows: Discovery[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) out.add(normalizedKey(r.title, r.claim));
  return out;
}

export async function loadDiscoveriesForConversation(
  params: LoadDiscoveriesParams,
): Promise<LoadDiscoveriesResult> {
  const source = params.source ?? readSourceFromEnv();
  const baseLog = {
    conversationId: params.conversationId,
    source,
    ...params.loggerFields,
  };

  if (source === "jsonb") {
    return {
      discoveries: params.fallbackDiscoveries || [],
      source: "jsonb",
      dbWasEmpty: false,
      dualComparison: null,
    };
  }

  // db or dual: query the table.
  let dbRows: ResearchDiscoveryWithEvidence[] = [];
  try {
    dbRows = await getDiscoveriesForConversation({
      conversationId: params.conversationId,
    });
  } catch (err) {
    logger.error(
      { err, ...baseLog },
      "discovery_read_db_failed_falling_back_to_jsonb",
    );
    return {
      discoveries: params.fallbackDiscoveries || [],
      source: "jsonb",
      dbWasEmpty: false,
      dualComparison: null,
    };
  }

  // Empty DB is a legitimate state (no discoveries yet, or a fresh
  // conversation). Fall back to the JSONB cache so downstream
  // prompts still get the LLM's last-known good output.
  if (dbRows.length === 0) {
    logger.warn(
      {
        ...baseLog,
        jsonbCount: (params.fallbackDiscoveries || []).length,
      },
      "discovery_read_db_empty_fallback",
    );
    return {
      discoveries: params.fallbackDiscoveries || [],
      source: "jsonb",
      dbWasEmpty: true,
      dualComparison: null,
    };
  }

  const dbDiscoveries = dbDiscoveriesToDomain(dbRows);
  const jsonbDiscoveries = params.fallbackDiscoveries || [];

  if (source === "dual") {
    const dbKeys = keySet(dbDiscoveries);
    const jsonbKeys = keySet(jsonbDiscoveries);
    const onlyInDb: string[] = [];
    const onlyInJsonb: string[] = [];
    for (const k of dbKeys) if (!jsonbKeys.has(k)) onlyInDb.push(k);
    for (const k of jsonbKeys) if (!dbKeys.has(k)) onlyInJsonb.push(k);
    if (onlyInDb.length > 0 || onlyInJsonb.length > 0) {
      logger.warn(
        {
          ...baseLog,
          dbCount: dbKeys.size,
          jsonbCount: jsonbKeys.size,
          onlyInDbCount: onlyInDb.length,
          onlyInJsonbCount: onlyInJsonb.length,
          // Sample up to 5 of each so the log line is bounded.
          onlyInDbSample: onlyInDb.slice(0, 5),
          onlyInJsonbSample: onlyInJsonb.slice(0, 5),
        },
        "discovery_read_mismatch",
      );
    } else {
      logger.info(
        { ...baseLog, dbCount: dbKeys.size, jsonbCount: jsonbKeys.size },
        "discovery_read_dual_match",
      );
    }
    return {
      discoveries: dbDiscoveries,
      source: "db",
      dbWasEmpty: false,
      dualComparison: {
        dbCount: dbKeys.size,
        jsonbCount: jsonbKeys.size,
        onlyInDb,
        onlyInJsonb,
      },
    };
  }

  return {
    discoveries: dbDiscoveries,
    source: "db",
    dbWasEmpty: false,
    dualComparison: null,
  };
}
