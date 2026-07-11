import { useEffect, useRef } from "preact/hooks";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom, zoomIdentity } from "d3-zoom";

/**
 * GraphCanvas — a self-contained SVG node-link renderer for the Knowledge
 * Graph explorer. It lays out the *neighborhood subgraph* returned by
 * `GET /api/research-brain/graph/neighborhood` (a focus node, its 1-hop
 * neighbors, AND the induced edges between those neighbors) with `d3-force`
 * and renders it as an SVG the component fully controls: `<line>` per edge,
 * `<circle>` + `<text>` per node.
 *
 * The library decision (design.md banner) is d3-force + SVG, NOT cytoscape:
 * only the small, tree-shaken `d3-force` / `d3-selection` / `d3-drag` /
 * `d3-zoom` modules are imported, so the graph ships in the single bundle
 * without chunking.
 *
 * d3 owns the inner SVG DOM (data-joined `<g>` groups); Preact only renders
 * the static shell. This is the standard "d3-in-a-component" pattern and
 * keeps the force simulation, drag and zoom behaviors on real d3 selections.
 */

export type GraphNodeType = "entity" | "compound" | "source";

/**
 * Closed set of edge types, mirroring `GraphEdgeType` in
 * `src/services/researchBrain/graphService.ts`. Facts are EDGES, never nodes.
 */
export type GraphEdgeType =
  | "has_compound" // focus entity  -> compound        (spoke)
  | "has_source" // focus entity  -> source          (spoke)
  | "reports" // compound     <-> source          (fact-backed)
  | "co_occurs_with" // compound     <-> compound        (shared sources)
  | "related_source"; // source       <-> source          (citation graph)

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  type: GraphNodeType;
}

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  /** Required: the neighborhood endpoint is the only producer of edges. */
  type: GraphEdgeType;
  /** Required. Comparable WITHIN a type only — normalized per type below. */
  weight: number;
  label?: string;
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (node: GraphNode) => void;
  /** Edge types to drop before layout (legend filter / hairball control). */
  hiddenEdgeTypes?: GraphEdgeType[];
}

// Node fill by type — three distinct colors mirroring the design.
const NODE_FILL: Record<GraphNodeType, string> = {
  entity: "#3b82f6", // accent / blue
  compound: "#4ade80", // green
  source: "#a78bfa", // purple (DOI-badged sources)
};

const NODE_RADIUS: Record<GraphNodeType, number> = {
  entity: 22,
  compound: 15,
  source: 13,
};

/**
 * Stroke per edge type. Spokes stay structural grey; the CROSS-EDGES are the
 * story of this graph (they are what makes it a subgraph and not a star), so
 * they get the node-matching hues and a much higher opacity.
 */
export const EDGE_STROKE: Record<GraphEdgeType, string> = {
  has_compound: "#475569", // grey (spoke)
  has_source: "#334155", // darker grey (spoke)
  reports: "#60a5fa", // slate-blue (compound <-> source)
  co_occurs_with: "#4ade80", // green, matches the compound fill
  related_source: "#a78bfa", // purple, matches the source fill
};

const EDGE_OPACITY: Record<GraphEdgeType, number> = {
  has_compound: 0.45,
  has_source: 0.45,
  reports: 0.9,
  co_occurs_with: 0.9,
  related_source: 0.9,
};

export const EDGE_LABEL: Record<GraphEdgeType, string> = {
  has_compound: "has compound",
  has_source: "has source",
  reports: "reports",
  co_occurs_with: "co-occurs with",
  related_source: "related source",
};

/**
 * Peak weight per edge type over the current edge array. Weights are only
 * comparable WITHIN a type (a `related_source` 11 and a `co_occurs_with` 11
 * are different units), so stroke width is normalized per type — never
 * globally.
 */
function maxWeightByType(list: GraphEdge[]): Map<GraphEdgeType, number> {
  const max = new Map<GraphEdgeType, number>();
  for (const e of list) {
    const w = Number.isFinite(e.weight) ? e.weight : 0;
    max.set(e.type, Math.max(max.get(e.type) ?? 0, w));
  }
  return max;
}

function strokeWidth(edge: GraphEdge, max: Map<GraphEdgeType, number>): number {
  const peak = max.get(edge.type) ?? 0;
  const w = Number.isFinite(edge.weight) ? edge.weight : 0;
  const ratio = peak > 0 ? w / peak : 0;
  return Math.min(4, Math.max(1, 1 + 3 * ratio));
}

export function GraphCanvas({
  nodes,
  edges,
  onNodeClick,
  hiddenEdgeTypes,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<SVGGElement | null>(null);
  const linksRef = useRef<SVGGElement | null>(null);
  const nodesRef = useRef<SVGGElement | null>(null);
  // Keep the latest click handler without re-running the whole effect.
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;

  const hasNeighbors = nodes.length > 1;
  // Stable dep for the effect: `hiddenEdgeTypes` is a fresh array each render.
  const hiddenKey = (hiddenEdgeTypes ?? []).slice().sort().join(",");

  useEffect(() => {
    if (!hasNeighbors) return;
    const svgEl = svgRef.current;
    const viewportEl = viewportRef.current;
    const linksEl = linksRef.current;
    const nodesEl = nodesRef.current;
    if (!svgEl || !viewportEl || !linksEl || !nodesEl) return;

    const rect = svgEl.getBoundingClientRect();
    const width = rect.width || 640;
    const height = rect.height || 480;

    // Clone data — d3 mutates node/link objects with x/y and resolves
    // link endpoints from ids to node references.
    const simNodes: GraphNode[] = nodes.map((n) => ({ ...n }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const hidden = new Set<string>(hiddenEdgeTypes ?? []);
    const simLinks: GraphEdge[] = edges
      .filter((e) => {
        if (hidden.has(e.type)) return false;
        const s = typeof e.source === "string" ? e.source : e.source.id;
        const t = typeof e.target === "string" ? e.target : e.target.id;
        return byId.has(s) && byId.has(t);
      })
      .map((e) => ({ ...e }));

    // Per-type peak weight, computed over the edges actually being drawn.
    const peakByType = maxWeightByType(simLinks);

    const simulation: Simulation<GraphNode, GraphEdge> = forceSimulation(
      simNodes,
    )
      .force(
        "link",
        forceLink<GraphNode, GraphEdge>(simLinks)
          .id((d) => d.id)
          .distance(90)
          .strength(0.6),
      )
      .force("charge", forceManyBody().strength(-320))
      .force("center", forceCenter(width / 2, height / 2))
      .force(
        "collide",
        forceCollide<GraphNode>().radius((d) => NODE_RADIUS[d.type] + 6),
      );

    const viewport = select(viewportEl);

    // --- Edges -------------------------------------------------------------
    const link = select(linksEl)
      .selectAll<SVGLineElement, GraphEdge>("line")
      .data(simLinks)
      .join("line")
      .attr("stroke", (d) => EDGE_STROKE[d.type] ?? "#334155")
      .attr("stroke-width", (d) => strokeWidth(d, peakByType))
      .attr("stroke-opacity", (d) => EDGE_OPACITY[d.type] ?? 0.7);

    // Hover inspection: "co-occurs with · 7".
    link
      .selectAll<SVGTitleElement, GraphEdge>("title")
      .data((d) => [d])
      .join("title")
      .text((d) => `${EDGE_LABEL[d.type] ?? d.type} · ${d.weight}`);

    // --- Nodes -------------------------------------------------------------
    const node = select(nodesEl)
      .selectAll<SVGGElement, GraphNode>("g.graph-node")
      .data(simNodes, (d) => d.id)
      .join((enter) => {
        const g = enter
          .append("g")
          .attr("class", "graph-node")
          .style("cursor", "pointer");
        g.append("circle");
        g.append("text");
        return g;
      });

    node
      .select<SVGCircleElement>("circle")
      .attr("r", (d) => NODE_RADIUS[d.type])
      .attr("fill", (d) => NODE_FILL[d.type])
      .attr("stroke", "#0a0e17")
      .attr("stroke-width", 2);

    node
      .select<SVGTextElement>("text")
      .text((d) => (d.label.length > 26 ? d.label.slice(0, 25) + "…" : d.label))
      .attr("x", 0)
      .attr("y", (d) => NODE_RADIUS[d.type] + 12)
      .attr("text-anchor", "middle")
      .attr("fill", "#cbd5e1")
      .attr("font-size", "11px")
      .style("pointer-events", "none");

    node.on("click", (event, d) => {
      event.stopPropagation();
      clickRef.current?.(d);
    });

    // --- Drag (pin while dragging) ----------------------------------------
    const dragBehavior = drag<SVGGElement, GraphNode>()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    node.call(dragBehavior);

    // --- Zoom / pan on the svg --------------------------------------------
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 4])
      .on("zoom", (event) => {
        viewport.attr("transform", event.transform.toString());
      });
    const svgSelection = select(svgEl);
    svgSelection.call(zoomBehavior);
    svgSelection.call(zoomBehavior.transform, zoomIdentity);

    // --- Tick --------------------------------------------------------------
    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
        .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
        .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
        .attr("y2", (d) => (d.target as GraphNode).y ?? 0);
      node.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => {
      simulation.stop();
      svgSelection.on(".zoom", null);
      select(linksEl).selectAll("*").remove();
      select(nodesEl).selectAll("*").remove();
    };
  }, [nodes, edges, hasNeighbors, hiddenKey]);

  if (!hasNeighbors) {
    return (
      <div class="graph-canvas-empty">
        <p>no linked neighbors yet</p>
        <span>
          This node has no compounds, facts, or sources linked to it in the
          current corpus.
        </span>
      </div>
    );
  }

  return (
    <svg ref={svgRef} class="graph-canvas-svg" role="img" aria-label="Knowledge graph neighborhood">
      <g ref={viewportRef}>
        <g ref={linksRef} class="graph-links" />
        <g ref={nodesRef} class="graph-nodes" />
      </g>
    </svg>
  );
}
