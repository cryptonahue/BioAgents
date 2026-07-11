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
 * Graph explorer. It lays out an *ego graph* (a focus node plus its 1-hop
 * neighbors) with `d3-force` and renders it as an SVG the component fully
 * controls: `<line>` per edge, `<circle>` + `<text>` per node.
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

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  type: GraphNodeType;
}

export interface GraphEdge extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  label?: string;
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (node: GraphNode) => void;
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

export function GraphCanvas({ nodes, edges, onNodeClick }: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRef = useRef<SVGGElement | null>(null);
  const linksRef = useRef<SVGGElement | null>(null);
  const nodesRef = useRef<SVGGElement | null>(null);
  // Keep the latest click handler without re-running the whole effect.
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;

  const hasNeighbors = nodes.length > 1;

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
    const simLinks: GraphEdge[] = edges
      .filter((e) => {
        const s = typeof e.source === "string" ? e.source : e.source.id;
        const t = typeof e.target === "string" ? e.target : e.target.id;
        return byId.has(s) && byId.has(t);
      })
      .map((e) => ({ ...e }));

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
      .attr("stroke", "#334155")
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", 0.7);

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
  }, [nodes, edges, hasNeighbors]);

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
