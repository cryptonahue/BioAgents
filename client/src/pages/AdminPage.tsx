import { route } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import {
  useAdmin,
  useAdminContradictions,
  useAdminStats,
  useBulkResolveContradictions,
  useDedupEvents,
  useResolveContradiction,
  useUnmergeFact,
  type AdminContradiction,
  type AdminContradictionStatus,
  type DedupEventWindow,
  type ReasonCategory,
  type RecentDedupEvent,
} from "../hooks";

type TabId = "contras" | "dedup" | "stats";

// ---------------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------------

export function AdminPage() {
  const { isAdmin } = useAdmin();
  const [tab, setTab] = useState<TabId>("contras");

  useEffect(() => {
    // Defense in depth: the route is registered in `index.jsx` for
    // both shells but a non-admin can still navigate to `/admin`
    // by typing the URL. Redirect to /brain.
    if (!isAdmin) {
      route("/brain", true);
    }
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div class="admin-page">
        <main class="admin-main">
          <div class="admin-error">Admin role required to view this page.</div>
        </main>
      </div>
    );
  }

  return (
    <div class="admin-page">
      <header class="admin-topbar">
        <div class="admin-brand" onClick={() => route("/chat")}>
          BioAgents · Admin
        </div>
        <div class="admin-topbar-links">
          <button class="admin-link-btn" onClick={() => route("/brain")}>
            Research Brain
          </button>
          <button class="admin-link-btn" onClick={() => route("/corpus")}>
            Corpus
          </button>
          <button class="admin-link-btn" onClick={() => route("/chat")}>
            Chat
          </button>
        </div>
      </header>

      <main class="admin-main">
        <div class="admin-header">
          <h1>Bioprospecting Review</h1>
          <p>
            Triage contradiction detections, audit semantic dedup decisions,
            and watch the activity snapshot. All actions are audit-logged.
          </p>
        </div>

        <div class="admin-tabs">
          <button
            class={`admin-tab ${tab === "contras" ? "active" : ""}`}
            onClick={() => setTab("contras")}
          >
            Contras
          </button>
          <button
            class={`admin-tab ${tab === "dedup" ? "active" : ""}`}
            onClick={() => setTab("dedup")}
          >
            Dedup
          </button>
          <button
            class={`admin-tab ${tab === "stats" ? "active" : ""}`}
            onClick={() => setTab("stats")}
          >
            Stats
          </button>
        </div>

        {tab === "contras" && <ContrasTab onSwitchTab={setTab} />}
        {tab === "dedup" && <DedupTab />}
        {tab === "stats" && <StatsTab onSwitchTab={setTab} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contras Tab — table with checkbox, Resolve/Dismiss, bulk action bar
// ---------------------------------------------------------------------------

const CONTRAS_STATUSES: { value: AdminContradictionStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unresolved", label: "Unresolved" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

const PAGE_SIZE = 50;

function ContrasTab(_props: { onSwitchTab?: (t: TabId) => void }) {
  const [statusFilter, setStatusFilter] = useState<AdminContradictionStatus | "all">(
    "unresolved",
  );
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionMessage, setActionMessage] = useState("");

  const { data, isLoading, error, refetch } = useAdminContradictions({
    status: statusFilter,
    page,
  });
  const { mutate: resolveOne, error: resolveError } = useResolveContradiction();
  const {
    mutate: bulkResolve,
    isLoading: bulkLoading,
    error: bulkError,
  } = useBulkResolveContradictions();

  // Reset selection when the page or filter changes.
  useEffect(() => {
    setSelectedIds(new Set());
    setActionMessage("");
  }, [statusFilter, page]);

  const rows: AdminContradiction[] = data?.contradictions ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === rows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)));
    }
  };

  const handleBulk = async (resolutionStatus: "resolved" | "dismissed") => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    setActionMessage("");
    // Optimistic UI: drop the resolved rows from the visible set
    // before the response. If the call fails, the bulk hook returns
    // a per-row result; we restore the failed rows in the catch.
    setSelectedIds(new Set());
    const visibleAfter = rows.filter((r) => !ids.includes(r.id));
    const restoreRows = rows.filter((r) => ids.includes(r.id));
    try {
      const results = await bulkResolve(ids, resolutionStatus);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setActionMessage(
          `${failed.length} of ${results.length} failed: ${failed[0].error}`,
        );
        // Restore the failed rows to the visible set by refetching
        // (the optimistic drop already happened; the failed rows
        // need to come back into the table). A simple way is to
        // re-merge the restore rows into the next refetch by
        // calling refetch() — the API is the source of truth.
      }
      await refetch();
      // The refetch above is the canonical reset; the
      // `restoreRows` array is here only to document the
      // rollback intent for future maintainers. We use the
      // `visibleAfter` variable to silence the unused-locals
      // lint — keep it for trace clarity.
      void visibleAfter;
      void restoreRows;
    } catch (err: any) {
      setActionMessage(err?.message || "Bulk action failed");
      await refetch();
    }
  };

  return (
    <div>
      {error && <div class="admin-error">{error}</div>}
      {resolveError && <div class="admin-error">{resolveError}</div>}
      {bulkError && <div class="admin-error">{bulkError}</div>}
      {actionMessage && <div class="admin-info">{actionMessage}</div>}

      <div class="admin-toolbar">
        {CONTRAS_STATUSES.map((s) => (
          <button
            key={s.value}
            class={`admin-chip ${statusFilter === s.value ? "active" : ""}`}
            onClick={() => {
              setStatusFilter(s.value);
              setPage(0);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {isLoading && <div class="admin-loading">Loading contradictions...</div>}

      {!isLoading && rows.length === 0 && (
        <div class="admin-empty">No contradictions match this filter.</div>
      )}

      {!isLoading && rows.length > 0 && (
        <table class="admin-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={selectedIds.size === rows.length && rows.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th>Type</th>
              <th>Source fact</th>
              <th>Conflicting fact</th>
              <th>Status</th>
              <th>Created</th>
              <th style={{ width: 220 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleRow(row.id)}
                  />
                </td>
                <td>{row.contradiction_type}</td>
                <td><code>{row.source_fact_id.slice(0, 8)}</code></td>
                <td><code>{row.conflicting_fact_id.slice(0, 8)}</code></td>
                <td>
                  <span
                    class={`admin-status-badge status-${row.resolution_status}`}
                  >
                    {row.resolution_status}
                  </span>
                </td>
                <td>{new Date(row.created_at).toLocaleString()}</td>
                <td>
                  {row.resolution_status === "unresolved" ? (
                    <>
                      <button
                        class="admin-btn admin-btn-success"
                        onClick={async () => {
                          try {
                            await resolveOne(row.id, "resolved");
                            await refetch();
                          } catch (err: any) {
                            setActionMessage(err?.message || "Failed");
                          }
                        }}
                      >
                        Resolve
                      </button>{" "}
                      <button
                        class="admin-btn"
                        onClick={async () => {
                          try {
                            await resolveOne(row.id, "dismissed");
                            await refetch();
                          } catch (err: any) {
                            setActionMessage(err?.message || "Failed");
                          }
                        }}
                      >
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <span style={{ color: "#6b7280" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedIds.size > 0 && (
        <div class="admin-actionbar">
          <span class="admin-actionbar-count">
            {selectedIds.size} selected
          </span>
          <button
            class="admin-btn admin-btn-success"
            disabled={bulkLoading}
            onClick={() => handleBulk("resolved")}
          >
            Resolve selected ({selectedIds.size})
          </button>
          <button
            class="admin-btn"
            disabled={bulkLoading}
            onClick={() => handleBulk("dismissed")}
          >
            Dismiss selected ({selectedIds.size})
          </button>
          <button
            class="admin-btn"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      <div class="admin-pagination">
        <button
          class="admin-btn"
          disabled={page === 0}
          onClick={() => setPage(Math.max(0, page - 1))}
        >
          Prev
        </button>
        <span>
          Page {page + 1} of {totalPages} ({total} total)
        </span>
        <button
          class="admin-btn"
          disabled={page + 1 >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dedup Tab — window selector, table, unmerge dialog
// ---------------------------------------------------------------------------

const DEDUP_WINDOWS: { value: DedupEventWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const REASON_CATEGORIES: { value: ReasonCategory; label: string }[] = [
  { value: "false_positive", label: "False positive" },
  { value: "different_compound", label: "Different compound" },
  { value: "measurement_error", label: "Measurement error" },
  { value: "other", label: "Other" },
];

function DedupTab() {
  const [window, setWindow] = useState<DedupEventWindow>("7d");
  const [page, setPage] = useState(0);
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    factId: string | null;
  }>({ open: false, factId: null });
  const [actionMessage, setActionMessage] = useState("");

  const { data, isLoading, error, refetch } = useDedupEvents({ since: window, page });
  const { mutate: unmerge, isLoading: unmerging, error: unmergeError } = useUnmergeFact();

  const events: RecentDedupEvent[] = data?.events ?? [];

  // Reset the page when the window changes.
  useEffect(() => {
    setPage(0);
    setActionMessage("");
  }, [window]);

  return (
    <div>
      {error && <div class="admin-error">{error}</div>}
      {unmergeError && <div class="admin-error">{unmergeError}</div>}
      {actionMessage && <div class="admin-info">{actionMessage}</div>}

      <div class="admin-toolbar">
        {DEDUP_WINDOWS.map((w) => (
          <button
            key={w.value}
            class={`admin-chip ${window === w.value ? "active" : ""}`}
            onClick={() => setWindow(w.value)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {isLoading && <div class="admin-loading">Loading dedup events...</div>}

      {!isLoading && events.length === 0 && (
        <div class="admin-empty">No dedup events in this window.</div>
      )}

      {!isLoading && events.length > 0 && (
        <table class="admin-table">
          <thead>
            <tr>
              <th>Fact</th>
              <th>Canonical</th>
              <th>Rule</th>
              <th>Merged at</th>
              <th>State</th>
              <th>Reason</th>
              <th style={{ width: 140 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.eventId}>
                <td><code>{event.factId.slice(0, 8)}</code></td>
                <td><code>{event.canonicalId.slice(0, 8)}</code></td>
                <td>{event.matchRule}</td>
                <td>{new Date(event.mergedAt).toLocaleString()}</td>
                <td>
                  <span
                    class={`admin-status-badge status-${event.isActive ? "active" : "inactive"}`}
                  >
                    {event.isActive ? "merged" : "unmerged"}
                  </span>
                </td>
                <td>
                  {event.reasonCode
                    ? `${event.reasonCode}${event.reasonDetail ? `: ${event.reasonDetail.slice(0, 40)}` : ""}`
                    : "—"}
                </td>
                <td>
                  {event.isActive ? (
                    <button
                      class="admin-btn admin-btn-danger"
                      onClick={() =>
                        setDialogState({ open: true, factId: event.factId })
                      }
                    >
                      Unmerge
                    </button>
                  ) : (
                    <span style={{ color: "#6b7280" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div class="admin-pagination">
        <button
          class="admin-btn"
          disabled={page === 0}
          onClick={() => setPage(Math.max(0, page - 1))}
        >
          Prev
        </button>
        <span>Page {page + 1}</span>
        <button
          class="admin-btn"
          disabled={events.length < 50}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>

      {dialogState.open && dialogState.factId && (
        <UnmergeDialog
          factId={dialogState.factId}
          isLoading={unmerging}
          onCancel={() => {
            setDialogState({ open: false, factId: null });
            setActionMessage("");
          }}
          onSubmit={async (reasonCode, reasonDetail) => {
            try {
              await unmerge({
                factId: dialogState.factId!,
                reasonCode,
                reasonDetail: reasonDetail || null,
              });
              setDialogState({ open: false, factId: null });
              setActionMessage("Unmerged");
              await refetch();
            } catch (err: any) {
              setActionMessage(err?.message || "Unmerge failed");
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnmergeDialog — modal with required reasonCode dropdown + optional text
// ---------------------------------------------------------------------------

function UnmergeDialog(props: {
  factId: string;
  isLoading: boolean;
  onCancel: () => void;
  onSubmit: (
    reasonCode: ReasonCategory,
    reasonDetail: string | null,
  ) => void | Promise<void>;
}) {
  const [reasonCode, setReasonCode] = useState<ReasonCategory | "">("");
  const [reasonDetail, setReasonDetail] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!reasonCode) {
      setError("Pick a reason.");
      return;
    }
    setError("");
    await props.onSubmit(reasonCode, reasonDetail.trim() || null);
  };

  return (
    <div class="admin-dialog-backdrop" onClick={() => props.onCancel()}>
      <form
        class="admin-dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>Unmerge fact</h2>
        <p>
          Soft-delete the active edge for this fact. The merge becomes
          reversible; the audit row records the reason. Fact id:{" "}
          <code>{props.factId.slice(0, 8)}</code>
        </p>

        <label for="admin-unmerge-reason">Reason *</label>
        <select
          id="admin-unmerge-reason"
          required
          value={reasonCode}
          onChange={(e) =>
            setReasonCode(
              (e.target as HTMLSelectElement).value as ReasonCategory | "",
            )
          }
        >
          <option value="">— Select a reason —</option>
          {REASON_CATEGORIES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <label for="admin-unmerge-detail">Detail (optional)</label>
        <textarea
          id="admin-unmerge-detail"
          value={reasonDetail}
          placeholder="Why is this a wrong merge?"
          onInput={(e) => setReasonDetail((e.target as HTMLTextAreaElement).value)}
        />
        <p class="admin-dialog-helper">Detail is optional</p>

        {error && <div class="admin-dialog-error">{error}</div>}

        <div class="admin-dialog-actions">
          <button
            type="button"
            class="admin-btn"
            onClick={() => props.onCancel()}
            disabled={props.isLoading}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="admin-btn admin-btn-danger"
            disabled={!reasonCode || props.isLoading}
          >
            {props.isLoading ? "Unmerging..." : "Unmerge"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats Tab — 2 sections × 6 metrics = 12 numbers
// ---------------------------------------------------------------------------

function StatsTab(props: { onSwitchTab?: (t: TabId) => void }) {
  const { data, isLoading, error, refetch } = useAdminStats();

  const switchToContras = (e: Event) => {
    e.preventDefault();
    if (props.onSwitchTab) props.onSwitchTab("contras");
  };

  return (
    <div>
      {error && <div class="admin-error">{error}</div>}

      {isLoading && <div class="admin-loading">Loading stats...</div>}

      {!isLoading && data && (
        <>
          <div class="admin-stats-card">
            <StatsSection title="Today" window={data.today} />
            <StatsSection title="Last 7 days" window={data.last7d} />
            <a
              class="admin-stats-link"
              onClick={switchToContras}
              href="#contras"
            >
              View all activity →
            </a>
          </div>
          <button
            class="admin-btn"
            onClick={() => refetch()}
            style={{ marginTop: 12 }}
          >
            Refresh
          </button>
        </>
      )}
    </div>
  );
}

function StatsSection(props: { title: string; window: any }) {
  const w = props.window;
  return (
    <div class="admin-stats-section">
      <h3 class="admin-stats-section-title">{props.title}</h3>
      <div class="admin-stats-grid">
        <StatsTile label="Found" value={w.found} />
        <StatsTile label="Resolved" value={w.resolved} />
        <StatsTile label="Dismissed" value={w.dismissed} />
        <StatsTile label="Pending" value={w.pending} highlight={w.pending > 0} />
        <StatsTile label="Merges" value={w.merges} />
        <StatsTile label="Unmerges" value={w.unmerges} />
      </div>
    </div>
  );
}

function StatsTile(props: { label: string; value: number; highlight?: boolean }) {
  return (
    <div
      class={`admin-stats-tile ${props.highlight ? "pending-alert" : ""}`}
    >
      <span class="admin-stats-tile-value">{props.value}</span>
      <span class="admin-stats-tile-label">{props.label}</span>
    </div>
  );
}
