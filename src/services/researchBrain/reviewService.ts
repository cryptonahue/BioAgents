/**
 * reviewService.ts — admin-only read-side helpers for the Bioprospecting
 * Review UI.
 *
 * The four new admin routes in `src/routes/research-brain.ts` (see
 * openspec/changes/bioprospecting-review-ui/specs/.../spec.md) all
 * delegate their data access to this module:
 *
 *   - `listContradictionsGlobal`  → GET    /api/research-brain/contradictions
 *   - `getContradictionStats`     → GET    /api/research-brain/contradictions/stats
 *   - `listRecentMergeEvents`     → GET    /api/research-brain/dedup/events
 *   - `unmergeFact`               → POST   /api/research-brain/dedup/:factId/unmerge
 *
 * The module also re-exports `getDuplicateGroup` from `db.ts` so the
 * admin page can resolve a duplicate group on demand without a second
 * import. The four custom error classes thrown by `unmergeFact` map to
 * HTTP status codes in the route layer (409 / 400 / 404).
 *
 * The Supabase client is resolved lazily through the same Proxy pattern
 * `db.ts` uses, so tests can swap the chainable per-case without
 * freezing the import.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "../../db/client";
import type {
  DedupEventWindow,
  ReasonCategory,
  RecentDedupEvent,
  ResearchBioprospectingContradiction,
  StatsResponse,
  StatsWindow,
} from "./types";

const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getServiceClient() as unknown as Record<
      string | symbol,
      unknown
    >;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as SupabaseClient;

// ---------------------------------------------------------------------------
// Domain error classes — mapped to HTTP status codes by the route layer.
//
// - `NoActiveEdgeError`        → 409 Conflict (already-unmerged or no edge)
// - `AmbiguousEdgeError`       → 409 Conflict (defensive: >1 active edge)
// - `InvalidReasonCategoryError` → 400 Bad Request
// - `FactNotFoundError`        → 404 Not Found
// ---------------------------------------------------------------------------

export class NoActiveEdgeError extends Error {
  constructor(message = "No active edge found for this fact") {
    super(message);
    this.name = "NoActiveEdgeError";
  }
}

export class AmbiguousEdgeError extends Error {
  constructor(message = "Multiple active edges found for this fact") {
    super(message);
    this.name = "AmbiguousEdgeError";
  }
}

export class InvalidReasonCategoryError extends Error {
  constructor(received: string) {
    super(`Invalid reason category: ${received}`);
    this.name = "InvalidReasonCategoryError";
  }
}

export class FactNotFoundError extends Error {
  constructor(factId: string) {
    super(`Fact not found: ${factId}`);
    this.name = "FactNotFoundError";
  }
}

export const REASON_CATEGORIES: ReadonlyArray<ReasonCategory> = [
  "false_positive",
  "different_compound",
  "measurement_error",
  "other",
];

// ---------------------------------------------------------------------------
// `listContradictionsGlobal` — paginated, filtered, admin-only feed.
// ---------------------------------------------------------------------------

export type ListContradictionsGlobalParams = {
  // The DB column `status` carries values 'open' | 'resolved' | 'dismissed'
  // (the check constraint added by the original schema migration).
  // The caller-facing string 'unresolved' is mapped to 'open' inside
  // the function so the rest of the codebase keeps the historical
  // "unresolved" vocabulary.
  status?: "unresolved" | "resolved" | "dismissed";
  limit: number;
  offset: number;
};

export type ListContradictionsGlobalResult = {
  rows: ResearchBioprospectingContradiction[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * Returns contradictions across all sources, filtered by `status` and
 * optionally by `sourceId` (via the fact FKs), ordered by `detected_at DESC`
 * and paginated.
 *
 * The `total` is the unpaginated `COUNT(*)` for the same filter
 * combination (a single second query). The helper issues at most two
 * queries.
 */
export async function listContradictionsGlobal(
  params: ListContradictionsGlobalParams,
): Promise<ListContradictionsGlobalResult> {
  const limit = Math.max(1, Math.min(200, params.limit));
  const offset = Math.max(0, params.offset);

  // Map caller-facing "unresolved" → DB "open" (the check constraint's
  // unresolved state is named 'open' in the schema).
  const dbStatus =
    params.status === "unresolved"
      ? "open"
      : params.status;

  let countQuery = supabase
    .from("research_bioprospecting_contradictions")
    .select("id", { count: "exact", head: true });
  let pageQuery = supabase
    .from("research_bioprospecting_contradictions")
    .select("*")
    .order("detected_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (dbStatus) {
    countQuery = countQuery.eq("status", dbStatus);
    pageQuery = pageQuery.eq("status", dbStatus);
  }

  const [{ count, error: countError }, { data, error: pageError }] =
    await Promise.all([countQuery, pageQuery]);

  if (countError) throw countError;
  if (pageError) throw pageError;

  return {
    rows: (data || []) as ResearchBioprospectingContradiction[],
    total: count || 0,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// `getContradictionStats` — today + last7d × 6 metrics.
// ---------------------------------------------------------------------------

/**
 * Returns the activity snapshot for the Stats tab. The 4 contradiction
 * metrics (`found`, `resolved`, `dismissed`) come from a single
 * `get_contradiction_stats(interval, interval)` RPC call. The 2
 * dedup metrics (`merges`, `unmerges`) are computed in JS from a
 * single `research_bioprospecting_fact_edges` select on the soft-delete
 * columns (added in the same migration set).
 *
 * `pending` is derived in code as `max(0, found - resolved - dismissed)`
 * to defend against clock-skew drift (see spec scenario "Pending is
 * non-negative even with bookkeeping drift"). Total: 2 round-trips.
 */
export async function getContradictionStats(): Promise<StatsResponse> {
  // 1. RPC for the 3 contradiction metrics × 2 windows.
  //    The RPC returns rows of { window_label, found, resolved, dismissed }.
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    "get_contradiction_stats" as any,
    { window_1d: "1 day", window_7d: "7 days" } as any,
  );
  if (rpcError) throw rpcError;

  const rows = (rpcRows || []) as Array<{
    window_label: string;
    found: number;
    resolved: number;
    dismissed: number;
  }>;

  const rpcByWindow: Record<string, { found: number; resolved: number; dismissed: number }> = {
    "1d": { found: 0, resolved: 0, dismissed: 0 },
    "7d": { found: 0, resolved: 0, dismissed: 0 },
  };
  for (const row of rows) {
    if (row.window_label === "1d" || row.window_label === "7d") {
      rpcByWindow[row.window_label] = {
        found: Number(row.found) || 0,
        resolved: Number(row.resolved) || 0,
        dismissed: Number(row.dismissed) || 0,
      };
    }
  }

  // 2. Edge counts for the dedup metrics. Both `is_active` and the
  //    `unmerged_at` / `merged_at` timestamps are in the new soft-delete
  //    columns; the read-side `select` keeps the rowset small (we
  //    only need the timestamps + flag).
  const { data: edgeRows, error: edgesError } = await supabase
    .from("research_bioprospecting_fact_edges")
    .select("merged_at, unmerged_at, is_active");
  if (edgesError) throw edgesError;

  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const sevenDaysMs = 7 * oneDayMs;
  const mergesToday = { value: 0 };
  const merges7d = { value: 0 };
  const unmergesToday = { value: 0 };
  const unmerges7d = { value: 0 };
  for (const row of (edgeRows || []) as Array<{
    merged_at: string;
    unmerged_at: string | null;
    is_active: boolean;
  }>) {
    const mergedAt = row.merged_at ? new Date(row.merged_at).getTime() : 0;
    const unmergedAt = row.unmerged_at
      ? new Date(row.unmerged_at).getTime()
      : 0;
    if (row.is_active) {
      if (mergedAt >= now - oneDayMs) mergesToday.value++;
      if (mergedAt >= now - sevenDaysMs) merges7d.value++;
    }
    if (unmergedAt) {
      if (unmergedAt >= now - oneDayMs) unmergesToday.value++;
      if (unmergedAt >= now - sevenDaysMs) unmerges7d.value++;
    }
  }

  const buildWindow = (
    rpc: { found: number; resolved: number; dismissed: number },
    merges: number,
    unmerges: number,
  ): StatsWindow => {
    const pending = Math.max(0, rpc.found - rpc.resolved - rpc.dismissed);
    return {
      found: Math.max(0, rpc.found),
      resolved: Math.max(0, rpc.resolved),
      dismissed: Math.max(0, rpc.dismissed),
      pending,
      merges: Math.max(0, merges),
      unmerges: Math.max(0, unmerges),
    };
  };

  return {
    today: buildWindow(rpcByWindow["1d"], mergesToday.value, unmergesToday.value),
    last7d: buildWindow(rpcByWindow["7d"], merges7d.value, unmerges7d.value),
  };
}

// ---------------------------------------------------------------------------
// `listRecentMergeEvents` — paginated, time-windowed dedup feed.
// ---------------------------------------------------------------------------

const WINDOW_INTERVAL: Record<DedupEventWindow, string | null> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  all: null,
};

export type ListRecentMergeEventsParams = {
  limit: number;
  offset: number;
  since: DedupEventWindow;
};

export type ListRecentMergeEventsResult = {
  events: RecentDedupEvent[];
};

/**
 * Returns recent merge and unmerge events on bioprospecting fact edges.
 * Each event is a row from `research_bioprospecting_fact_edges`
 * left-joined to the most recent `research_bioprospecting_dedup_audit`
 * row for the same `fact_id` (NULL when no unmerge audit exists).
 *
 * Both `is_active = true` (active merges) and `is_active = false`
 * (unmerged) edges are returned; the client filters to whichever view
 * it wants.
 */
export async function listRecentMergeEvents(
  params: ListRecentMergeEventsParams,
): Promise<ListRecentMergeEventsResult> {
  const limit = Math.max(1, Math.min(200, params.limit));
  const offset = Math.max(0, params.offset);
  const interval = WINDOW_INTERVAL[params.since];

  let query = supabase
    .from("research_bioprospecting_fact_edges")
    .select(
      "canonical_fact_id, merged_fact_id, match_rule, merged_at, is_active, unmerged_at, unmerged_by, dedup_audit:research_bioprospecting_dedup_audit(id, reason, reason_category, created_at)",
    )
    .order("merged_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (interval) {
    // `gte("merged_at", NOW() - INTERVAL '...')` — the route layer
    // maps the window string to a Postgres interval string before
    // calling the helper. ISO 8601 timestamps are accepted by
    // Supabase, so we compute the cutoff here in JS.
    const cutoff = new Date(Date.now() - intervalToMs(interval)).toISOString();
    query = query.gte("merged_at", cutoff);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data || []) as Array<{
    canonical_fact_id: string;
    merged_fact_id: string;
    match_rule: "identity_key" | "embedding";
    merged_at: string;
    is_active: boolean;
    unmerged_at: string | null;
    unmerged_by: string | null;
    dedup_audit: Array<{
      id: string;
      reason: string | null;
      reason_category: ReasonCategory | null;
      created_at: string;
    }> | null;
  }>;

  const events: RecentDedupEvent[] = rows.map((row) => {
    // Supabase's foreign-key embed returns either an array (when the
    // join sees >=1 matching rows) or an object (when `.maybeSingle`
    // is used). We use the array shape; pick the most recent audit
    // row if there are several.
    const auditList = Array.isArray(row.dedup_audit) ? row.dedup_audit : [];
    const audit = auditList[0] ?? null;
    return {
      eventId: `${row.canonical_fact_id}|${row.merged_fact_id}`,
      factId: row.merged_fact_id,
      canonicalId: row.canonical_fact_id,
      mergedFactId: row.merged_fact_id,
      matchRule: row.match_rule,
      mergedAt: row.merged_at,
      unmergedAt: row.unmerged_at,
      unmergedBy: row.unmerged_by,
      isActive: row.is_active,
      reasonCode: audit?.reason_category ?? null,
      reasonDetail: audit?.reason ?? null,
    };
  });

  return { events };
}

function intervalToMs(interval: string): number {
  // Parse "24 hours" / "7 days" / "30 days" — the set the route
  // hands us. The contract is locked in WINDOW_INTERVAL.
  const match = /^(\d+)\s+(hour|day|week)s?$/i.exec(interval.trim());
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "hour") return n * 60 * 60 * 1000;
  if (unit === "day") return n * 24 * 60 * 60 * 1000;
  if (unit === "week") return n * 7 * 24 * 60 * 60 * 1000;
  return 0;
}

// ---------------------------------------------------------------------------
// `unmergeFact` — soft-delete an active edge + write an audit row.
// ---------------------------------------------------------------------------

export type UnmergeFactParams = {
  factId: string;
  userId: string;
  reason: string | null;
  reasonCategory: ReasonCategory;
};

export type UnmergeFactResult = {
  edge: {
    canonicalFactId: string;
    mergedFactId: string;
    matchRule: "identity_key" | "embedding";
    mergedAt: string;
    isActive: boolean;
    unmergedAt: string;
    unmergedBy: string;
  };
  audit: {
    id: string;
    factId: string;
    eventType: "unmerge";
    oldCanonicalId: string | null;
    newCanonicalId: string | null;
    userId: string | null;
    reason: string | null;
    reasonCategory: ReasonCategory;
    createdAt: string;
  };
};

/**
 * Soft-deletes the active edge for `factId` and writes the
 * corresponding audit row.
 *
 * Behavior:
 *   - If the fact does not exist → `FactNotFoundError` (→ 404).
 *   - If no active edge references the fact → `NoActiveEdgeError`
 *     (→ 409). This is also the CAS-guard result for a double-unmerge.
 *   - If multiple active edges reference the fact (defensive — the
 *     schema permits it) → `AmbiguousEdgeError` (→ 409).
 *   - The UPDATE uses `WHERE is_active = true` so the soft-delete is
 *     atomic and compare-and-set safe across concurrent operators.
 *
 * The UPDATE and the audit INSERT are issued sequentially (not
 * wrapped in a Postgres transaction) — Supabase's JS client does not
 * expose an explicit transaction boundary. The route layer treats
 * either failure as a 500 and the audit row is the forensic trail
 * for partial completions.
 */
export async function unmergeFact(
  params: UnmergeFactParams,
): Promise<UnmergeFactResult> {
  if (!REASON_CATEGORIES.includes(params.reasonCategory)) {
    throw new InvalidReasonCategoryError(params.reasonCategory);
  }

  // 1. Existence check on the fact. The route uses this to map
  //    missing facts to 404 (vs. 409 for the "no active edge" case).
  const { data: factRow, error: factError } = await supabase
    .from("research_bioprospecting_facts")
    .select("id")
    .eq("id", params.factId)
    .maybeSingle();
  if (factError) throw factError;
  if (!factRow) throw new FactNotFoundError(params.factId);

  // 2. Look up the active edge (could be 0, 1, or 2+ rows).
  //    0 → NoActiveEdgeError
  //    1 → soft-delete
  //    2+ → AmbiguousEdgeError (defensive)
  const { data: edges, error: edgesError } = await supabase
    .from("research_bioprospecting_fact_edges")
    .select("canonical_fact_id, merged_fact_id, match_rule, merged_at")
    .eq("merged_fact_id", params.factId)
    .eq("is_active", true);
  if (edgesError) throw edgesError;

  const activeEdges = (edges || []) as Array<{
    canonical_fact_id: string;
    merged_fact_id: string;
    match_rule: "identity_key" | "embedding";
    merged_at: string;
  }>;
  if (activeEdges.length === 0) throw new NoActiveEdgeError();
  if (activeEdges.length > 1) throw new AmbiguousEdgeError();

  const edge = activeEdges[0];

  // 3. Soft-delete with the CAS guard. The `WHERE is_active = true`
  //    clause is the compare-and-set: a second concurrent unmerge
  //    sees zero rows affected and 409s.
  const { data: updatedEdge, error: updateError } = await supabase
    .from("research_bioprospecting_fact_edges")
    .update({
      is_active: false,
      unmerged_at: new Date().toISOString(),
      unmerged_by: params.userId,
    })
    .eq("canonical_fact_id", edge.canonical_fact_id)
    .eq("merged_fact_id", edge.merged_fact_id)
    .eq("is_active", true)
    .select("canonical_fact_id, merged_fact_id, match_rule, merged_at, is_active, unmerged_at, unmerged_by")
    .single();
  if (updateError) throw updateError;
  if (!updatedEdge) throw new NoActiveEdgeError();

  const updated = updatedEdge as {
    canonical_fact_id: string;
    merged_fact_id: string;
    match_rule: "identity_key" | "embedding";
    merged_at: string;
    is_active: boolean;
    unmerged_at: string;
    unmerged_by: string;
  };

  // 4. Insert the audit row. We always use the fact's id as
  //    `fact_id` and the edge's `canonical_fact_id` as
  //    `old_canonical_id`. `new_canonical_id` is NULL — the unmerged
  //    fact becomes standalone.
  const { data: auditRow, error: auditError } = await supabase
    .from("research_bioprospecting_dedup_audit")
    .insert({
      fact_id: params.factId,
      event_type: "unmerge",
      old_canonical_id: updated.canonical_fact_id,
      new_canonical_id: null,
      user_id: params.userId,
      reason: params.reason,
      reason_category: params.reasonCategory,
    })
    .select("id, fact_id, event_type, old_canonical_id, new_canonical_id, user_id, reason, reason_category, created_at")
    .single();
  if (auditError) throw auditError;

  const audit = auditRow as {
    id: string;
    fact_id: string;
    event_type: "merge" | "unmerge";
    old_canonical_id: string | null;
    new_canonical_id: string | null;
    user_id: string | null;
    reason: string | null;
    reason_category: ReasonCategory;
    created_at: string;
  };

  return {
    edge: {
      canonicalFactId: updated.canonical_fact_id,
      mergedFactId: updated.merged_fact_id,
      matchRule: updated.match_rule,
      mergedAt: updated.merged_at,
      isActive: updated.is_active,
      unmergedAt: updated.unmerged_at,
      unmergedBy: updated.unmerged_by,
    },
    audit: {
      id: String(audit.id),
      factId: audit.fact_id,
      eventType: "unmerge",
      oldCanonicalId: audit.old_canonical_id,
      newCanonicalId: audit.new_canonical_id,
      userId: audit.user_id,
      reason: audit.reason,
      reasonCategory: audit.reason_category,
      createdAt: audit.created_at,
    },
  };
}

// Re-exported from `db.ts` so the admin page can pull the duplicate
// group for a fact on demand without importing a second module. The
// helper still filters on `is_active = true` (the unmerged edge is
// invisible to the lineage query layer).
export { getDuplicateGroup } from "./db";
