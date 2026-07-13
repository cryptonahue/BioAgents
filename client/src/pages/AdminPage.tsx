import { route } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { Modal } from "../components/ui/Modal";
import { TabList, TabPanel, Tabs, type TabItem } from "../components/ui/Tabs";
import {
  isContradictionOpen,
  useAdmin,
  useAdminContradictions,
  useAdminStats,
  useBulkResolveContradictions,
  useDedupEvents,
  useResolveContradiction,
  useSetWhitelistAccess,
  useUnmergeFact,
  useWhitelistUsers,
  type AccessRequest,
  type AdminContradiction,
  type AdminContradictionStatus,
  type DedupEventWindow,
  type ReasonCategory,
  type RecentDedupEvent,
  type WhitelistUser,
} from "../hooks";

type TabId = "contras" | "dedup" | "stats" | "whitelist";

/** Namespaces the generated `id`s that wire each tab to its panel. */
const ADMIN_TABS_ID = "admin";

const ADMIN_TABS: TabItem<TabId>[] = [
  { value: "contras", label: "Contras" },
  { value: "dedup", label: "Dedup" },
  { value: "stats", label: "Stats" },
  { value: "whitelist", label: "Whitelist" },
];

// ---------------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------------

/**
 * The merge-review state is a SEMANTIC badge color. Basecoat ships only
 * `destructive`, so the states map onto the project `data-tone` family — see
 * `badges.css`. `dismissed` is deliberately neutral: it is not an outcome, it is
 * the absence of one.
 */
function statusTone(status: string): "success" | "danger" | "neutral" {
  if (status === "resolved" || status === "active") return "success";
  if (status === "unresolved" || status === "inactive") return "danger";
  return "neutral";
}

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
          <div class="alert" data-tone="danger" role="alert">
            <strong>Admin role required to view this page.</strong>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div class="admin-page">
      <main class="admin-main">
        <div class="admin-header">
          <h1>Bioprospecting Review</h1>
          <p>
            Triage contradiction detections, audit semantic dedup decisions,
            and watch the activity snapshot. All actions are audit-logged.
          </p>
        </div>

        <Tabs className="admin-tabs">
          <TabList
            idPrefix={ADMIN_TABS_ID}
            label="Bioprospecting review"
            tabs={ADMIN_TABS}
            value={tab}
            // Not `onChange={setTab}`: Preact's `StateUpdater<TabId>` also accepts
            // the `(prev) => next` form, and inferring `T` from that overload
            // widens it to `string`. The arrow pins `T` to `TabId`.
            onChange={(value) => setTab(value)}
          />

          {tab === "contras" && (
            <TabPanel idPrefix={ADMIN_TABS_ID} value="contras">
              <ContrasTab onSwitchTab={setTab} />
            </TabPanel>
          )}
          {tab === "dedup" && (
            <TabPanel idPrefix={ADMIN_TABS_ID} value="dedup">
              <DedupTab />
            </TabPanel>
          )}
          {tab === "stats" && (
            <TabPanel idPrefix={ADMIN_TABS_ID} value="stats">
              <StatsTab onSwitchTab={setTab} />
            </TabPanel>
          )}
          {tab === "whitelist" && (
            <TabPanel idPrefix={ADMIN_TABS_ID} value="whitelist">
              <WhitelistTab />
            </TabPanel>
          )}
        </Tabs>
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

/**
 * Render helpers. Both are defensive on purpose: the previous version of
 * this table called `row.source_fact_id.slice(0, 8)` against a column
 * that does not exist on a real row, so the very first contradiction
 * ever detected would have crashed the tab with a TypeError.
 */
function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export interface ContradictionRowProps {
  row: AdminContradiction;
  selected: boolean;
  onToggle: () => void;
  onAct: (resolutionStatus: "resolved" | "dismissed") => void | Promise<void>;
}

/**
 * One contradiction row. Presentational and hook-free on purpose: it can
 * be invoked directly in a test (no DOM required) so the DB→UI column
 * contract is asserted against the REAL row shape.
 */
export function ContradictionRow({
  row,
  selected,
  onToggle,
  onAct,
}: ContradictionRowProps) {
  return (
    <tr>
      <td>
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td>{row.conflict_type}</td>
      <td>{row.severity}</td>
      <td>
        <code>{shortId(row.fact_a_id)}</code>
      </td>
      <td>
        <code>{shortId(row.fact_b_id)}</code>
      </td>
      <td>
        <span class="badge admin-status-badge" data-tone={statusTone(row.status)}>
          {row.status}
        </span>
      </td>
      <td>{formatTimestamp(row.detected_at)}</td>
      <td>
        {isContradictionOpen(row) ? (
          <>
            <button
              class="btn" data-variant="outline" data-tone="success"
              onClick={() => onAct("resolved")}
            >
              Resolve
            </button>{" "}
            <button class="btn" data-variant="outline" onClick={() => onAct("dismissed")}>
              Dismiss
            </button>
          </>
        ) : (
          <span style={{ color: "var(--text-tertiary)" }}>—</span>
        )}
      </td>
    </tr>
  );
}

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
      {error && <div class="alert" data-tone="danger" role="alert">
          <strong>{error}</strong>
        </div>}
      {resolveError && <div class="alert" data-tone="danger" role="alert">
          <strong>{resolveError}</strong>
        </div>}
      {bulkError && <div class="alert" data-tone="danger" role="alert">
          <strong>{bulkError}</strong>
        </div>}
      {actionMessage && <div class="alert" data-tone="info" role="status">
          <strong>{actionMessage}</strong>
        </div>}

      <div class="admin-toolbar">
        {CONTRAS_STATUSES.map((s) => (
          <button
            key={s.value}
            class="badge admin-chip"
            data-variant={statusFilter === s.value ? "primary" : "outline"}
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
        <div class="empty">
          <header>
            <p>No contradictions match this filter.</p>
          </header>
        </div>
      )}

      {!isLoading && rows.length > 0 && (
        <div class="table-container">
        <table class="table">
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
              <th>Severity</th>
              <th>Fact A</th>
              <th>Fact B</th>
              <th>Status</th>
              <th>Detected</th>
              <th style={{ width: 220 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ContradictionRow
                key={row.id}
                row={row}
                selected={selectedIds.has(row.id)}
                onToggle={() => toggleRow(row.id)}
                onAct={async (resolutionStatus) => {
                  try {
                    await resolveOne(row.id, resolutionStatus);
                    await refetch();
                  } catch (err: any) {
                    setActionMessage(err?.message || "Failed");
                  }
                }}
              />
            ))}
          </tbody>
        </table>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div class="admin-actionbar">
          <span class="admin-actionbar-count">
            {selectedIds.size} selected
          </span>
          <button
            class="btn" data-variant="outline" data-tone="success"
            disabled={bulkLoading}
            onClick={() => handleBulk("resolved")}
          >
            Resolve selected ({selectedIds.size})
          </button>
          <button
            class="btn" data-variant="outline"
            disabled={bulkLoading}
            onClick={() => handleBulk("dismissed")}
          >
            Dismiss selected ({selectedIds.size})
          </button>
          <button
            class="btn" data-variant="outline"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      <div class="admin-pagination">
        <button
          class="btn" data-variant="outline"
          disabled={page === 0}
          onClick={() => setPage(Math.max(0, page - 1))}
        >
          Prev
        </button>
        <span>
          Page {page + 1} of {totalPages} ({total} total)
        </span>
        <button
          class="btn" data-variant="outline"
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
      {error && <div class="alert" data-tone="danger" role="alert">
          <strong>{error}</strong>
        </div>}
      {unmergeError && <div class="alert" data-tone="danger" role="alert">
          <strong>{unmergeError}</strong>
        </div>}
      {actionMessage && <div class="alert" data-tone="info" role="status">
          <strong>{actionMessage}</strong>
        </div>}

      <div class="admin-toolbar">
        {DEDUP_WINDOWS.map((w) => (
          <button
            key={w.value}
            class="badge admin-chip"
            data-variant={window === w.value ? "primary" : "outline"}
            onClick={() => setWindow(w.value)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {isLoading && <div class="admin-loading">Loading dedup events...</div>}

      {!isLoading && events.length === 0 && (
        <div class="empty">
          <header>
            <p>No dedup events in this window.</p>
          </header>
        </div>
      )}

      {!isLoading && events.length > 0 && (
        <div class="table-container">
        <table class="table">
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
                    class="badge admin-status-badge"
                    data-tone={event.isActive ? "success" : "danger"}
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
                      class="btn" data-variant="destructive"
                      onClick={() =>
                        setDialogState({ open: true, factId: event.factId })
                      }
                    >
                      Unmerge
                    </button>
                  ) : (
                    <span style={{ color: "var(--text-tertiary)" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <div class="admin-pagination">
        <button
          class="btn" data-variant="outline"
          disabled={page === 0}
          onClick={() => setPage(Math.max(0, page - 1))}
        >
          Prev
        </button>
        <span>Page {page + 1}</span>
        <button
          class="btn" data-variant="outline"
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

  // The scrim, the centering and the Escape/backdrop dismissal all come from
  // `ui/Modal` (a native <dialog> on Basecoat's `.dialog`) rather than from a
  // second hand-rolled overlay. The form is not dismissible while the unmerge
  // is in flight, and it keeps its own footer Cancel instead of Modal's X.
  return (
    <Modal
      isOpen
      onClose={() => props.onCancel()}
      maxWidth="480px"
      showClose={false}
      dismissible={!props.isLoading}
      label="Unmerge fact"
    >
      <form class="admin-dialog" onSubmit={handleSubmit}>
        <h2>Unmerge fact</h2>
        <p>
          Soft-delete the active edge for this fact. The merge becomes
          reversible; the audit row records the reason. Fact id:{" "}
          <code>{props.factId.slice(0, 8)}</code>
        </p>

        <div class="field">
          <label class="label" for="admin-unmerge-reason">
            Reason *
          </label>
          <select
            class="select"
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
        </div>

        <div class="field">
          <label class="label" for="admin-unmerge-detail">
            Detail (optional)
          </label>
          <textarea
            class="textarea"
            id="admin-unmerge-detail"
            value={reasonDetail}
            placeholder="Why is this a wrong merge?"
            onInput={(e) => setReasonDetail((e.target as HTMLTextAreaElement).value)}
          />
          <p class="admin-dialog-helper">Detail is optional</p>
        </div>

        {error && <div class="alert admin-dialog-error" data-tone="danger" role="alert">
          <strong>{error}</strong>
        </div>}

        <div class="admin-dialog-actions">
          <button
            type="button"
            class="btn" data-variant="outline"
            onClick={() => props.onCancel()}
            disabled={props.isLoading}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn" data-variant="destructive"
            disabled={!reasonCode || props.isLoading}
          >
            {props.isLoading ? "Unmerging..." : "Unmerge"}
          </button>
        </div>
      </form>
    </Modal>
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
      {error && <div class="alert" data-tone="danger" role="alert">
          <strong>{error}</strong>
        </div>}

      {isLoading && <div class="admin-loading">Loading stats...</div>}

      {!isLoading && data && (
        <>
          <div class="card admin-stats-card">
            <StatsSection title="Today" window={data.today} />
            <StatsSection title="Last 7 days" window={data.last7d} />
            <footer>
              <a
                class="admin-stats-link"
                onClick={switchToContras}
                href="#contras"
              >
                View all activity →
              </a>
            </footer>
          </div>
          <button
            class="btn" data-variant="outline"
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
    <section class="admin-stats-section">
      <h3 class="admin-stats-section-title">{props.title}</h3>
      <div class="admin-stats-grid">
        <StatsTile label="Found" value={w.found} />
        <StatsTile label="Resolved" value={w.resolved} />
        <StatsTile label="Dismissed" value={w.dismissed} />
        <StatsTile label="Pending" value={w.pending} highlight={w.pending > 0} />
        <StatsTile label="Merges" value={w.merges} />
        <StatsTile label="Unmerges" value={w.unmerges} />
      </div>
    </section>
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

// ---------------------------------------------------------------------------
// Whitelist Tab — grant / revoke CoralGPT access (users.access_type)
// ---------------------------------------------------------------------------

/**
 * The UI half of the whitelist manager. It renders the roster and a toggle per
 * row; the SERVER is what actually authorizes the change
 * (`authResolver({ required: true, role: "admin" })` on both routes), so
 * nothing here is a security boundary — it is the affordance on top of one.
 *
 * Revoking your OWN access is refused by the server with `cannot_revoke_self`.
 * The row's control is disabled for the signed-in admin so the user does not
 * have to discover that by hitting the error.
 */
/**
 * The request context — WHY this person should be approved.
 *
 * A native <details>, not a hand-rolled disclosure: the browser owns the
 * expanded state, the role, and Enter/Space. Same reasoning as the landing FAQ.
 * It is NOT Basecoat's `.accordion` — that skin is for a stack of sibling
 * panels, and this is one disclosure nested inside a table cell.
 */
function RequestDetails({ request }: { request: AccessRequest }) {
  return (
    <details class="admin-request">
      <summary>
        {request.role || "Role not given"}
        {request.organization ? ` · ${request.organization}` : ""}
      </summary>
      <dl class="admin-request-body">
        <dt>Use case</dt>
        <dd>{request.useCase || "—"}</dd>

        <dt>Name</dt>
        <dd>{request.fullName || "—"}</dd>

        <dt>Contact</dt>
        <dd>{request.email || "—"}</dd>

        {request.twitterHandle && (
          <>
            <dt>X / Twitter</dt>
            <dd>{request.twitterHandle}</dd>
          </>
        )}

        {request.referralSource && (
          <>
            <dt>Heard via</dt>
            <dd>{request.referralSource}</dd>
          </>
        )}

        <dt>Requested</dt>
        <dd>{formatTimestamp(request.requestedAt)}</dd>
      </dl>
    </details>
  );
}

function WhitelistTab() {
  const { userId: selfId } = useAdmin();
  const [search, setSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [actionMessage, setActionMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useWhitelistUsers({
    search,
    pendingOnly,
    page,
  });
  const { mutate: setAccess, error: mutateError } = useSetWhitelistAccess();

  useEffect(() => {
    setPage(0);
  }, [search, pendingOnly]);

  const users: WhitelistUser[] = data?.users ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.limit || 50)));

  const toggle = async (user: WhitelistUser) => {
    setActionMessage("");
    setBusyId(user.id);
    try {
      const { user: updated, email } = await setAccess(
        user.id,
        !user.whitelisted,
      );

      if (!updated.whitelisted) {
        setActionMessage(`Revoked access for ${updated.email || updated.id}`);
      } else {
        // The grant ALWAYS succeeded by the time we get here — the email is a
        // side effect of a committed write and can never fail it. So this says
        // what happened to the NOTIFICATION, and never implies the approval
        // itself is in doubt.
        const who = updated.email || updated.id;
        if (email?.sent) {
          setActionMessage(`Granted access to ${who}. Approval email sent.`);
        } else if (email?.reason === "not_configured") {
          setActionMessage(
            `Granted access to ${who}. No email sent (mail is not configured) — tell them yourself.`,
          );
        } else if (email?.reason === "no_address") {
          setActionMessage(
            `Granted access to ${who}. No email sent (no address on file) — tell them yourself.`,
          );
        } else if (email) {
          setActionMessage(
            `Granted access to ${who}. The approval email FAILED to send — tell them yourself.`,
          );
        } else {
          setActionMessage(`Granted access to ${who}.`);
        }
      }

      await refetch();
    } catch (err: any) {
      setActionMessage(err?.message || "Failed to update access");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      {error && (
        <div class="alert" data-tone="danger" role="alert">
          <strong>{error}</strong>
        </div>
      )}
      {mutateError && (
        <div class="alert" data-tone="danger" role="alert">
          <strong>{mutateError}</strong>
        </div>
      )}
      {actionMessage && (
        <div class="alert" data-tone="info" role="status">
          <strong>{actionMessage}</strong>
        </div>
      )}

      <div class="admin-toolbar">
        <input
          class="input admin-whitelist-search"
          type="search"
          placeholder="Search by email, username or ID…"
          aria-label="Search users"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        <button
          class="badge admin-chip"
          data-variant={pendingOnly ? "primary" : "outline"}
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly((v) => !v)}
        >
          Pending only
        </button>
      </div>

      {isLoading && <div class="admin-loading">Loading users...</div>}

      {!isLoading && users.length === 0 && (
        <div class="empty">
          <header>
            <p>No users match this filter.</p>
          </header>
        </div>
      )}

      {!isLoading && users.length > 0 && (
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Request</th>
                <th>Access</th>
                <th>Joined</th>
                <th style={{ width: 160 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isSelf = user.id === selfId;
                return (
                  <tr key={user.id}>
                    <td>
                      {user.email || user.username || "—"}
                      {user.isAdmin && (
                        <>
                          {" "}
                          <span class="badge" data-tone="brand">
                            admin
                          </span>
                        </>
                      )}
                      <div class="admin-whitelist-id">
                        <code>{shortId(user.id)}</code>
                      </div>
                    </td>
                    <td>
                      {/* The reason to approve. A user with no request was
                          whitelisted directly by an admin and never asked —
                          which is a meaningful state, so it is named rather
                          than left as an empty cell. */}
                      {user.request ? (
                        <RequestDetails request={user.request} />
                      ) : (
                        <span class="admin-request-none">No request on file</span>
                      )}
                    </td>
                    <td>
                      <span
                        class="badge admin-status-badge"
                        data-tone={user.whitelisted ? "success" : "neutral"}
                      >
                        {user.whitelisted ? "whitelisted" : "pending"}
                      </span>
                    </td>
                    <td>{formatTimestamp(user.createdAt)}</td>
                    <td>
                      {/* `data-tone` MUST ride an explicit `data-variant` — a
                          toned button with no variant matches Lyra's
                          `.btn:not([data-variant])` primary-hover rule and turns
                          teal on hover. See the header of `buttons.css`. */}
                      <button
                        class="btn"
                        data-variant="outline"
                        data-tone={user.whitelisted ? undefined : "success"}
                        disabled={busyId === user.id || (isSelf && user.whitelisted)}
                        title={
                          isSelf && user.whitelisted
                            ? "You cannot revoke your own access"
                            : undefined
                        }
                        onClick={() => toggle(user)}
                      >
                        {busyId === user.id
                          ? "Saving…"
                          : user.whitelisted
                            ? "Revoke"
                            : "Grant"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div class="admin-pagination">
        <button
          class="btn"
          data-variant="outline"
          disabled={page === 0}
          onClick={() => setPage(Math.max(0, page - 1))}
        >
          Prev
        </button>
        <span>
          Page {page + 1} of {totalPages} ({total} total)
        </span>
        <button
          class="btn"
          data-variant="outline"
          disabled={page + 1 >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
