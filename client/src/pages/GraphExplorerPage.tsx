import { useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../components/icons";
import {
  EDGE_LABEL,
  EDGE_STROKE,
  GraphCanvas,
  type GraphEdge,
  type GraphEdgeType,
  type GraphNode,
} from "../components/graph/GraphCanvas";
import { openProvenanceLightbox } from "../utils/provenanceTrigger";

/** Open a source in the dedicated evidence viewer (new tab). */
function openSourceViewer(sourceId: string): void {
  window.open(`/viewer/${sourceId}`, "_blank", "noopener,noreferrer");
}

/**
 * GraphExplorerPage — user-facing Knowledge Graph explorer at `/graph`.
 *
 * Master-detail layout: the left panel searches entities (bioactivity /
 * application_area / assay_model) or compounds; selecting a result becomes the
 * focus node, whose neighborhood is fetched in ONE call from
 * `GET /api/research-brain/graph/neighborhood` and rendered by `GraphCanvas`
 * (d3-force + SVG).
 *
 * v2 (`graph-neighborhood-edges`): the page no longer stitches the graph
 * client-side. The old `stitchEntityExpansion` / `stitchCompound` /
 * `overlayCitations` helpers could only ever draw a STAR — every edge started
 * at the focus node, because one `expand` payload carries no neighbor-to-
 * neighbor information. The endpoint now returns the induced subgraph
 * (`reports`, `co_occurs_with`, `related_source` cross-edges included) and the
 * page renders `{ nodes, edges }` verbatim.
 *
 * The DetailCard keeps its OWN fetches (`/expand`,
 * `/compounds/search?expand=true`): it needs fact quotes / pages / DOIs, which
 * the graph payload deliberately does not carry. A graph endpoint returns a
 * graph, not a view model. Those run in parallel with the neighborhood call.
 *
 * All fetches reuse the shared `getAuthHeaders()` pattern (Bearer
 * `bioagents_auth_token` + `credentials: "include"`); the graph GETs are open
 * to any authenticated user, so this page is NOT admin-gated. A 401 surfaces
 * as an explicit error state, never as a blank canvas.
 */

interface Props {
  path?: string;
  coralGptMode?: boolean;
}

type EntityKind = "bioactivity" | "application_area" | "assay_model";
type SelectorKind = EntityKind | "compound";

// ---- API response shapes (mirror src/services/researchBrain/graphService.ts)
interface EntityNode {
  kind: EntityKind;
  value: string;
  display: string;
  compound_count: number;
  fact_count: number;
  source_count: number;
}

interface ExpandCompound {
  id: string;
  canonical_name: string;
  fact_count: number;
}
interface ExpandFact {
  id: string;
  source_id: string | null;
  compound_canonical_id: string | null;
  result_summary: string | null;
  quote: string | null;
  page: number | null;
  doi: string | null;
}
interface ExpandSource {
  id: string;
  title: string;
  doi: string | null;
  url: string | null;
  fact_count: number;
}
interface EntityExpansion {
  compounds: ExpandCompound[];
  facts: ExpandFact[];
  sources: ExpandSource[];
}

interface CompoundStats {
  fact_count: number;
  source_count: number;
}
interface CompoundAggregate {
  compound_id: string;
  canonical_name: string;
}
interface TopCompound {
  compound_id: string;
  canonical_name: string;
  fact_count: number;
}
interface TopStringBucket {
  value: string;
  fact_count: number;
}
interface CompoundSearchHit {
  compound: CompoundAggregate;
  stats: CompoundStats;
  topCoOccurring?: TopCompound[];
  topGeographies?: TopStringBucket[];
  topBioactivities?: TopStringBucket[];
}

// ---- Neighborhood payload (mirrors NeighborhoodResult in graphService.ts)
type GraphNodeType = "entity" | "compound" | "source";

interface NeighborhoodNodeDto {
  id: string; // "entity:{kind}:{value}" | "compound:{uuid}" | "source:{uuid}"
  type: GraphNodeType;
  label: string;
  meta?: {
    kind?: string;
    value?: string;
    factCount?: number;
    doi?: string | null;
    url?: string | null;
  };
}
interface NeighborhoodEdgeDto {
  source: string;
  target: string;
  type: GraphEdgeType;
  weight: number;
  label?: string;
}
interface NeighborhoodResult {
  focus: NeighborhoodNodeDto;
  nodes: NeighborhoodNodeDto[];
  edges: NeighborhoodEdgeDto[];
  meta: {
    limit: number;
    fanout: number;
    elapsed: number;
    counts: { nodes: number; edges: number };
  };
}

type FocusNode =
  | { type: "entity"; kind: EntityKind; value: string; display: string }
  | { type: "compound"; compoundId: string; name: string }
  | { type: "source"; sourceId: string; title: string };

interface GraphElements {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Source detail, read straight off the neighborhood focus node's meta. */
interface SourceDetail {
  id: string;
  title: string;
  doi: string | null;
  url: string | null;
  factCount: number;
}

const EMPTY_ELEMENTS: GraphElements = { nodes: [], edges: [] };

const NEIGHBORHOOD_LIMIT = 20;
const NEIGHBORHOOD_FANOUT = 3;

const KIND_OPTIONS: Array<{ key: SelectorKind; label: string }> = [
  { key: "bioactivity", label: "Bioactivity" },
  { key: "application_area", label: "Application" },
  { key: "assay_model", label: "Assay / model" },
  { key: "compound", label: "Compound" },
];

// ---------------------------------------------------------------------------
// Fetch helpers — mirror the getAuthHeaders() pattern from useAdminReview.ts.
// ---------------------------------------------------------------------------

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = localStorage.getItem("bioagents_auth_token");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: getAuthHeaders(),
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as any)?.error ||
        (data as any)?.message ||
        `Request failed (${res.status})`,
    );
  }
  return data as T;
}

function doiHref(doi: string): string {
  const trimmed = doi.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://doi.org/${trimmed.replace(/^doi:/i, "")}`;
}

// ---------------------------------------------------------------------------
// Focus <-> node-id plumbing.
// ---------------------------------------------------------------------------

/** Build the `/graph/neighborhood` query string for a focus node. */
function neighborhoodUrl(focus: FocusNode): string {
  const base = "/api/research-brain/graph/neighborhood";
  const tail = `&limit=${NEIGHBORHOOD_LIMIT}&fanout=${NEIGHBORHOOD_FANOUT}`;
  if (focus.type === "entity") {
    return (
      `${base}?type=entity&kind=${encodeURIComponent(focus.kind)}` +
      `&value=${encodeURIComponent(focus.value)}${tail}`
    );
  }
  const id = focus.type === "compound" ? focus.compoundId : focus.sourceId;
  return `${base}?type=${focus.type}&id=${encodeURIComponent(id)}${tail}`;
}

/**
 * Parse a canvas node id back into a focus. Entity ids are
 * `entity:{kind}:{value}` and the VALUE MAY CONTAIN COLONS, so only the first
 * two segments are split off.
 */
function focusFromNode(node: GraphNode): FocusNode | null {
  if (node.type === "entity") {
    const parts = node.id.split(":");
    const kind = parts[1] as EntityKind;
    const value = parts.slice(2).join(":");
    if (!kind || !value) return null;
    return { type: "entity", kind, value, display: node.label };
  }
  if (node.type === "compound") {
    const compoundId = node.id.slice("compound:".length);
    if (!compoundId) return null;
    return { type: "compound", compoundId, name: node.label };
  }
  const sourceId = node.id.slice("source:".length);
  if (!sourceId) return null;
  return { type: "source", sourceId, title: node.label };
}

/** The endpoint's payload IS the canvas model — no stitching, no filler edges. */
function toElements(payload: NeighborhoodResult): GraphElements {
  const nodes: GraphNode[] = (payload.nodes ?? []).map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
  }));
  const known = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = (payload.edges ?? [])
    .filter((e) => known.has(e.source) && known.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight,
      label: e.label,
    }));
  return { nodes, edges };
}

export function GraphExplorerPage(_props: Props) {
  const [selectedKind, setSelectedKind] = useState<SelectorKind>("bioactivity");
  const [query, setQuery] = useState("");
  const [entityResults, setEntityResults] = useState<EntityNode[]>([]);
  const [compoundResults, setCompoundResults] = useState<CompoundSearchHit[]>(
    [],
  );
  const [focusNode, setFocusNode] = useState<FocusNode | null>(null);
  const [elements, setElements] = useState<GraphElements>(EMPTY_ELEMENTS);
  const [expansion, setExpansion] = useState<EntityExpansion | null>(null);
  const [compoundDetail, setCompoundDetail] = useState<CompoundSearchHit | null>(
    null,
  );
  const [sourceDetail, setSourceDetail] = useState<SourceDetail | null>(null);
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState<GraphEdgeType[]>([]);
  const [searching, setSearching] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState("");
  const [graphError, setGraphError] = useState("");

  // Guards against a slow neighborhood response clobbering a newer focus.
  const requestSeq = useRef(0);

  // Edge types actually present in the payload — drives the legend/filter.
  const presentEdgeTypes = useMemo<GraphEdgeType[]>(() => {
    const counts = new Map<GraphEdgeType, number>();
    for (const e of elements.edges) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    return Array.from(counts.keys());
  }, [elements]);

  const handleSearch = async (event?: Event) => {
    event?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    try {
      if (selectedKind === "compound") {
        const data = await apiGet<{ compounds: CompoundSearchHit[] }>(
          `/api/research-brain/graph/compounds/search?q=${encodeURIComponent(
            q,
          )}&limit=20`,
        );
        setCompoundResults(Array.isArray(data.compounds) ? data.compounds : []);
        setEntityResults([]);
      } else {
        const data = await apiGet<{ entities: EntityNode[] }>(
          `/api/research-brain/graph/entities/${selectedKind}/search?q=${encodeURIComponent(
            q,
          )}&limit=20`,
        );
        setEntityResults(Array.isArray(data.entities) ? data.entities : []);
        setCompoundResults([]);
      }
    } catch (err: any) {
      setError(err?.message || "Search failed");
    } finally {
      setSearching(false);
    }
  };

  /**
   * Fetch the DetailCard's view model for a focus. The graph endpoint returns
   * a graph; the panel needs fact quotes / pages / DOIs, so it keeps its own
   * fetch. Runs in parallel with the neighborhood call.
   */
  const loadDetail = async (
    focus: FocusNode,
    payload: Promise<NeighborhoodResult>,
  ): Promise<void> => {
    if (focus.type === "entity") {
      const data = await apiGet<{ expansion: EntityExpansion }>(
        `/api/research-brain/graph/entities/${focus.kind}/${encodeURIComponent(
          focus.value,
        )}/expand?limit=${NEIGHBORHOOD_LIMIT}`,
      );
      setExpansion(
        data.expansion || { compounds: [], facts: [], sources: [] },
      );
      return;
    }

    if (focus.type === "compound") {
      // NOTE: compound detail is still fetched BY NAME (the search endpoint is
      // the only one that returns the expanded aggregate). Ugly, pre-existing,
      // explicitly out of scope for this change.
      const data = await apiGet<{ compounds: CompoundSearchHit[] }>(
        `/api/research-brain/graph/compounds/search?q=${encodeURIComponent(
          focus.name,
        )}&limit=5&expand=true`,
      );
      const hit =
        (data.compounds || []).find(
          (c) => c.compound.compound_id === focus.compoundId,
        ) || null;
      setCompoundDetail(hit);
      return;
    }

    // Source: the neighborhood focus node already carries title / doi / url /
    // factCount in `meta` — no second round trip needed. A failed graph fetch
    // is reported once, by the caller's graph-error state.
    const result = await payload.catch(() => null);
    if (!result) return;
    const meta = result.focus?.meta ?? {};
    setSourceDetail({
      id: focus.sourceId,
      title: result.focus?.label || focus.title,
      doi: meta.doi ?? null,
      url: meta.url ?? null,
      factCount: meta.factCount ?? 0,
    });
  };

  /** The single entry point: every focus change goes through here. */
  const focusOn = async (focus: FocusNode) => {
    const seq = ++requestSeq.current;
    setExpanding(true);
    setError("");
    setGraphError("");
    setFocusNode(focus);
    setExpansion(null);
    setCompoundDetail(null);
    setSourceDetail(null);
    setHiddenEdgeTypes([]);

    // Both calls are fired in PARALLEL: the graph endpoint returns a graph,
    // the DetailCard needs a view model. Neither waits on the other (except a
    // `source` focus, whose detail is read off the neighborhood payload).
    const graphPromise = apiGet<NeighborhoodResult>(neighborhoodUrl(focus));
    const detailPromise = loadDetail(focus, graphPromise).catch((err: any) => {
      if (seq === requestSeq.current) {
        setError(err?.message || "Could not load node details");
      }
    });

    try {
      const payload = await graphPromise;
      if (seq !== requestSeq.current) return;
      setElements(toElements(payload));
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      // 401 / 500 / network — explicit error state, NOT a blank canvas.
      setGraphError(err?.message || "Could not load this neighborhood");
      setElements(EMPTY_ELEMENTS);
    } finally {
      await detailPromise;
      if (seq === requestSeq.current) setExpanding(false);
    }
  };

  const handleNodeClick = (node: GraphNode) => {
    const focus = focusFromNode(node);
    if (focus) void focusOn(focus);
  };

  const toggleEdgeType = (type: GraphEdgeType) => {
    setHiddenEdgeTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  const retryFocus = () => {
    if (focusNode) void focusOn(focusNode);
  };

  return (
    <div class="graph-page">
      <main class="graph-main">
        <div class="graph-header">
          <h1>Knowledge Graph</h1>
          <p>
            Search entities and compounds, then explore the neighborhood of
            linked compounds, facts, and sources.
          </p>
        </div>

        {error && <div class="graph-error">{error}</div>}

        <div class="graph-layout">
          <aside class="graph-search-panel">
            <div class="graph-kind-selector">
              {KIND_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  class={`graph-kind-btn ${
                    selectedKind === opt.key ? "active" : ""
                  }`}
                  onClick={() => setSelectedKind(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <form class="graph-search-form" onSubmit={handleSearch}>
              <Icon name="search" size={16} />
              <input
                class="input"
                value={query}
                placeholder={
                  selectedKind === "compound"
                    ? "Search a compound…"
                    : "Search an entity…"
                }
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
              <button type="submit" class="graph-search-submit">
                <Icon name="chevronRight" size={18} />
              </button>
            </form>

            <div class="graph-results">
              {searching && <div class="graph-loading">Searching…</div>}

              {!searching &&
                selectedKind !== "compound" &&
                entityResults.map((n) => {
                  const active =
                    focusNode?.type === "entity" &&
                    focusNode.value === n.value &&
                    focusNode.kind === n.kind;
                  return (
                    <button
                      key={`${n.kind}:${n.value}`}
                      class={`graph-result-item ${active ? "active" : ""}`}
                      onClick={() =>
                        focusOn({
                          type: "entity",
                          kind: n.kind,
                          value: n.value,
                          display: n.display,
                        })
                      }
                    >
                      <span class="graph-result-title">{n.display}</span>
                      <span class="graph-result-meta">
                        {n.compound_count} compounds · {n.fact_count} facts ·{" "}
                        {n.source_count} sources
                      </span>
                    </button>
                  );
                })}

              {!searching &&
                selectedKind === "compound" &&
                compoundResults.map((hit) => {
                  const active =
                    focusNode?.type === "compound" &&
                    focusNode.compoundId === hit.compound.compound_id;
                  return (
                    <button
                      key={hit.compound.compound_id}
                      class={`graph-result-item ${active ? "active" : ""}`}
                      onClick={() =>
                        focusOn({
                          type: "compound",
                          compoundId: hit.compound.compound_id,
                          name: hit.compound.canonical_name,
                        })
                      }
                    >
                      <span class="graph-result-title">
                        {hit.compound.canonical_name}
                      </span>
                      <span class="graph-result-meta">
                        {hit.stats.fact_count} facts · {hit.stats.source_count}{" "}
                        sources
                      </span>
                    </button>
                  );
                })}

              {!searching &&
                ((selectedKind === "compound" && compoundResults.length === 0) ||
                  (selectedKind !== "compound" &&
                    entityResults.length === 0)) && (
                  <div class="graph-empty">
                    {query.trim()
                      ? "No results. Try another term."
                      : "Search to explore the graph."}
                  </div>
                )}
            </div>
          </aside>

          <section class="graph-canvas-panel">
            <div class="graph-canvas-wrap">
              {expanding && (
                <div class="graph-canvas-loading">Loading neighborhood…</div>
              )}
              {!focusNode && !expanding && (
                <div class="graph-canvas-empty">
                  <p>Select a result to explore its neighborhood</p>
                  <span>
                    The canvas shows the focus node, its compounds and sources,
                    and the edges BETWEEN those neighbors.
                  </span>
                </div>
              )}
              {focusNode && !expanding && graphError && (
                <div class="graph-canvas-error">
                  <p>Could not load this neighborhood</p>
                  <span>{graphError}</span>
                  <button
                    type="button"
                    class="graph-retry-btn"
                    onClick={retryFocus}
                  >
                    Retry
                  </button>
                </div>
              )}
              {focusNode && !expanding && !graphError && (
                <GraphCanvas
                  nodes={elements.nodes}
                  edges={elements.edges}
                  hiddenEdgeTypes={hiddenEdgeTypes}
                  onNodeClick={handleNodeClick}
                />
              )}
            </div>

            {focusNode && !graphError && presentEdgeTypes.length > 0 && (
              <div class="graph-legend">
                {presentEdgeTypes.map((type) => {
                  const hidden = hiddenEdgeTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      class={`graph-legend-item ${hidden ? "muted" : ""}`}
                      onClick={() => toggleEdgeType(type)}
                      title={
                        hidden
                          ? `Show ${EDGE_LABEL[type]} edges`
                          : `Hide ${EDGE_LABEL[type]} edges`
                      }
                      aria-pressed={!hidden}
                    >
                      <span
                        class="graph-legend-swatch"
                        style={{ background: EDGE_STROKE[type] }}
                      />
                      {EDGE_LABEL[type]}
                    </button>
                  );
                })}
              </div>
            )}

            {focusNode && (
              <div class="graph-detail-card">
                <DetailCard
                  focus={focusNode}
                  expansion={expansion}
                  compound={compoundDetail}
                  source={sourceDetail}
                />
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DetailCard — focus-node stats + linked facts / sources with provenance.
// ---------------------------------------------------------------------------

function DetailCard({
  focus,
  expansion,
  compound,
  source,
}: {
  focus: FocusNode;
  expansion: EntityExpansion | null;
  compound: CompoundSearchHit | null;
  source: SourceDetail | null;
}) {
  if (focus.type === "entity" && expansion) {
    return (
      <>
        <div class="graph-detail-header">
          <span class="graph-detail-kicker">{focus.kind}</span>
          <h2>{focus.display || focus.value}</h2>
          <div class="graph-detail-stats">
            <span>{expansion.compounds.length} compounds</span>
            <span>{expansion.facts.length} facts</span>
            <span>{expansion.sources.length} sources</span>
          </div>
        </div>

        {expansion.facts.length > 0 && (
          <div class="graph-detail-section">
            <h3>Linked facts</h3>
            {expansion.facts.map((f) => (
              <article key={f.id} class="graph-fact">
                {f.result_summary && <p>{f.result_summary}</p>}
                {f.quote && <blockquote>{f.quote}</blockquote>}
                <div class="graph-fact-meta">
                  {f.page != null && <span>p. {f.page}</span>}
                  {f.doi && (
                    <a href={doiHref(f.doi)} target="_blank" rel="noreferrer">
                      DOI
                    </a>
                  )}
                  <button
                    type="button"
                    class="graph-evidence-btn"
                    onClick={() => openProvenanceLightbox(f.id, f.source_id)}
                    title="Open this fact's evidence"
                  >
                    Evidence
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        {expansion.sources.length > 0 && (
          <div class="graph-detail-section">
            <h3>Sources</h3>
            {expansion.sources.map((s) => (
              <div key={s.id} class="graph-source-row">
                <button
                  type="button"
                  class="graph-source-title graph-source-open"
                  onClick={() => openSourceViewer(s.id)}
                  title="Open source in the evidence viewer"
                >
                  {s.title || "Source"}
                </button>
                <span class="graph-source-meta">
                  {s.fact_count} facts
                  {s.doi && (
                    <>
                      {" · "}
                      <a href={doiHref(s.doi)} target="_blank" rel="noreferrer">
                        DOI
                      </a>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  if (focus.type === "compound" && compound) {
    return (
      <>
        <div class="graph-detail-header">
          <span class="graph-detail-kicker">compound</span>
          <h2>{compound.compound.canonical_name}</h2>
          <div class="graph-detail-stats">
            <span>{compound.stats.fact_count} facts</span>
            <span>{compound.stats.source_count} sources</span>
          </div>
        </div>

        {(compound.topCoOccurring?.length ?? 0) > 0 && (
          <div class="graph-detail-section">
            <h3>Co-occurring compounds</h3>
            {compound.topCoOccurring!.map((c) => (
              <div key={c.compound_id} class="graph-source-row">
                <span class="graph-source-title">{c.canonical_name}</span>
                <span class="graph-source-meta">{c.fact_count} facts</span>
              </div>
            ))}
          </div>
        )}

        {(compound.topBioactivities?.length ?? 0) > 0 && (
          <div class="graph-detail-section">
            <h3>Bioactivities</h3>
            <div class="graph-tag-row">
              {compound.topBioactivities!.map((b) => (
                <span key={b.value} class="badge" data-tone="neutral">
                  {b.value} · {b.fact_count}
                </span>
              ))}
            </div>
          </div>
        )}

        {(compound.topGeographies?.length ?? 0) > 0 && (
          <div class="graph-detail-section">
            <h3>Geographies</h3>
            <div class="graph-tag-row">
              {compound.topGeographies!.map((g) => (
                <span key={g.value} class="badge" data-tone="neutral">
                  {g.value} · {g.fact_count}
                </span>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  if (focus.type === "source" && source) {
    return (
      <>
        <div class="graph-detail-header">
          <span class="graph-detail-kicker">source</span>
          <h2>{source.title || "Source"}</h2>
          <div class="graph-detail-stats">
            <span>{source.factCount} facts</span>
            {source.doi && (
              <a href={doiHref(source.doi)} target="_blank" rel="noreferrer">
                DOI
              </a>
            )}
          </div>
        </div>

        <div class="graph-detail-section">
          <button
            type="button"
            class="graph-evidence-btn"
            onClick={() => openSourceViewer(source.id)}
            title="Open source in the evidence viewer"
          >
            Open in evidence viewer
          </button>
        </div>
      </>
    );
  }

  return <div class="graph-empty">No details for this node.</div>;
}
