import { useMemo, useState } from "preact/hooks";
import { Icon } from "../components/icons";
import {
  GraphCanvas,
  type GraphEdge,
  type GraphNode,
} from "../components/graph/GraphCanvas";

/**
 * GraphExplorerPage — user-facing Knowledge Graph explorer at `/graph`.
 *
 * Master-detail layout: the left panel searches entities (bioactivity /
 * application_area / assay_model) or compounds; selecting a result becomes the
 * focus node, whose 1-hop neighborhood is fetched from the read-only graph API
 * and stitched client-side into an ego graph rendered by `GraphCanvas`
 * (d3-force + SVG). A detail card shows the focus node's linked facts with
 * provenance (quote / page / DOI). Clicking a node in the canvas re-centers on
 * it; clicking a source node overlays citation (source↔source) edges.
 *
 * All fetches reuse the shared `getAuthHeaders()` pattern (Bearer
 * `bioagents_auth_token` + `credentials: "include"`); the four graph GETs are
 * open to any authenticated user, so this page is NOT admin-gated.
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

type FocusNode =
  | { type: "entity"; kind: EntityKind; value: string; display: string }
  | { type: "compound"; compoundId: string; name: string };

interface GraphElements {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

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
// Client-side ego-graph stitchers.
// ---------------------------------------------------------------------------

function stitchEntityExpansion(
  focus: Extract<FocusNode, { type: "entity" }>,
  expansion: EntityExpansion,
): GraphElements {
  const centerId = `entity:${focus.kind}:${focus.value}`;
  const nodes: GraphNode[] = [
    { id: centerId, label: focus.display || focus.value, type: "entity" },
  ];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>([centerId]);
  const connected = new Set<string>();

  for (const c of expansion.compounds) {
    const id = `compound:${c.id}`;
    if (!seen.has(id)) {
      nodes.push({ id, label: c.canonical_name, type: "compound" });
      seen.add(id);
    }
    edges.push({ source: centerId, target: id });
    connected.add(id);
  }

  for (const s of expansion.sources) {
    const id = `source:${s.id}`;
    if (!seen.has(id)) {
      nodes.push({ id, label: s.title || "Source", type: "source" });
      seen.add(id);
    }
  }

  for (const f of expansion.facts) {
    if (!f.source_id) continue;
    const sId = `source:${f.source_id}`;
    if (!seen.has(sId)) continue;
    const cId = f.compound_canonical_id
      ? `compound:${f.compound_canonical_id}`
      : null;
    if (cId && seen.has(cId)) {
      edges.push({
        source: cId,
        target: sId,
        label: f.result_summary ?? undefined,
      });
      connected.add(sId);
    }
  }

  // Keep any orphan source attached to the center so the ego graph stays
  // connected instead of floating disconnected nodes.
  for (const s of expansion.sources) {
    const id = `source:${s.id}`;
    if (!connected.has(id)) edges.push({ source: centerId, target: id });
  }

  return { nodes, edges };
}

function stitchCompound(
  focus: Extract<FocusNode, { type: "compound" }>,
  hit: CompoundSearchHit,
): GraphElements {
  const centerId = `compound:${focus.compoundId}`;
  const nodes: GraphNode[] = [
    { id: centerId, label: focus.name, type: "compound" },
  ];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>([centerId]);

  for (const co of hit.topCoOccurring ?? []) {
    const id = `compound:${co.compound_id}`;
    if (id === centerId) continue;
    if (!seen.has(id)) {
      nodes.push({ id, label: co.canonical_name, type: "compound" });
      seen.add(id);
    }
    edges.push({ source: centerId, target: id });
  }

  for (const b of hit.topBioactivities ?? []) {
    const id = `entity:bioactivity:${b.value}`;
    if (!seen.has(id)) {
      nodes.push({ id, label: b.value, type: "entity" });
      seen.add(id);
    }
    edges.push({ source: centerId, target: id });
  }

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
  const [elements, setElements] = useState<GraphElements>({
    nodes: [],
    edges: [],
  });
  const [overlay, setOverlay] = useState<GraphElements>({
    nodes: [],
    edges: [],
  });
  const [expansion, setExpansion] = useState<EntityExpansion | null>(null);
  const [compoundDetail, setCompoundDetail] = useState<CompoundSearchHit | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState("");

  // Merge the base ego graph with any citation overlay (dedup by node id).
  const canvasElements = useMemo<GraphElements>(() => {
    if (overlay.nodes.length === 0 && overlay.edges.length === 0) {
      return elements;
    }
    const byId = new Map<string, GraphNode>();
    for (const n of elements.nodes) byId.set(n.id, n);
    for (const n of overlay.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
    return {
      nodes: Array.from(byId.values()),
      edges: [...elements.edges, ...overlay.edges],
    };
  }, [elements, overlay]);

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

  const focusEntity = async (
    kind: EntityKind,
    value: string,
    display: string,
  ) => {
    setExpanding(true);
    setError("");
    setOverlay({ nodes: [], edges: [] });
    const focus: FocusNode = { type: "entity", kind, value, display };
    setFocusNode(focus);
    try {
      const data = await apiGet<{ expansion: EntityExpansion }>(
        `/api/research-brain/graph/entities/${kind}/${encodeURIComponent(
          value,
        )}/expand?limit=20`,
      );
      const exp = data.expansion || { compounds: [], facts: [], sources: [] };
      setExpansion(exp);
      setCompoundDetail(null);
      setElements(stitchEntityExpansion(focus, exp));
    } catch (err: any) {
      setError(err?.message || "Could not expand entity");
      setExpansion({ compounds: [], facts: [], sources: [] });
      setElements({
        nodes: [{ id: `entity:${kind}:${value}`, label: display, type: "entity" }],
        edges: [],
      });
    } finally {
      setExpanding(false);
    }
  };

  const focusCompound = async (compoundId: string, name: string) => {
    setExpanding(true);
    setError("");
    setOverlay({ nodes: [], edges: [] });
    const focus: FocusNode = { type: "compound", compoundId, name };
    setFocusNode(focus);
    try {
      const data = await apiGet<{ compounds: CompoundSearchHit[] }>(
        `/api/research-brain/graph/compounds/search?q=${encodeURIComponent(
          name,
        )}&limit=5&expand=true`,
      );
      const hit =
        (data.compounds || []).find(
          (c) => c.compound.compound_id === compoundId,
        ) || (data.compounds || [])[0];
      if (hit) {
        setCompoundDetail(hit);
        setExpansion(null);
        setElements(stitchCompound(focus, hit));
      } else {
        setCompoundDetail(null);
        setElements({
          nodes: [{ id: `compound:${compoundId}`, label: name, type: "compound" }],
          edges: [],
        });
      }
    } catch (err: any) {
      setError(err?.message || "Could not expand compound");
      setElements({
        nodes: [{ id: `compound:${compoundId}`, label: name, type: "compound" }],
        edges: [],
      });
    } finally {
      setExpanding(false);
    }
  };

  const overlayCitations = async (sourceId: string, title: string) => {
    setError("");
    try {
      const data = await apiGet<{
        edges: Array<{
          otherSourceId: string;
          otherTitle: string;
          otherDoi: string | null;
          weight: number;
        }>;
      }>(`/api/research-brain/citations/${encodeURIComponent(sourceId)}?limit=20`);
      const centerId = `source:${sourceId}`;
      const nodes: GraphNode[] = [
        { id: centerId, label: title || "Source", type: "source" },
      ];
      const edges: GraphEdge[] = [];
      const seen = new Set<string>([centerId]);
      for (const e of data.edges || []) {
        const id = `source:${e.otherSourceId}`;
        if (!seen.has(id)) {
          nodes.push({ id, label: e.otherTitle || "Source", type: "source" });
          seen.add(id);
        }
        edges.push({ source: centerId, target: id, label: "cites" });
      }
      setOverlay({ nodes, edges });
    } catch (err: any) {
      setError(err?.message || "Could not load citations");
    }
  };

  const handleNodeClick = (node: GraphNode) => {
    if (node.type === "entity") {
      const rest = node.id.split(":");
      const kind = rest[1] as EntityKind;
      const value = rest.slice(2).join(":");
      if (kind && value) void focusEntity(kind, value, node.label);
    } else if (node.type === "compound") {
      const compoundId = node.id.slice("compound:".length);
      void focusCompound(compoundId, node.label);
    } else if (node.type === "source") {
      const sourceId = node.id.slice("source:".length);
      void overlayCitations(sourceId, node.label);
    }
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
                      onClick={() => focusEntity(n.kind, n.value, n.display)}
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
                        focusCompound(
                          hit.compound.compound_id,
                          hit.compound.canonical_name,
                        )
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
                    The ego graph shows the focus node with its 1-hop
                    compounds, facts, and sources.
                  </span>
                </div>
              )}
              {focusNode && !expanding && (
                <GraphCanvas
                  nodes={canvasElements.nodes}
                  edges={canvasElements.edges}
                  onNodeClick={handleNodeClick}
                />
              )}
            </div>

            {focusNode && (
              <div class="graph-detail-card">
                <DetailCard
                  focus={focusNode}
                  expansion={expansion}
                  compound={compoundDetail}
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
}: {
  focus: FocusNode;
  expansion: EntityExpansion | null;
  compound: CompoundSearchHit | null;
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
                <span class="graph-source-title">{s.title || "Source"}</span>
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
                <span key={b.value} class="graph-tag">
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
                <span key={g.value} class="graph-tag">
                  {g.value} · {g.fact_count}
                </span>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  return <div class="graph-empty">No details for this node.</div>;
}
