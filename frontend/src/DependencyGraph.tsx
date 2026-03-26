import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Node,
  type Edge,
  Position,
  Handle,
  type NodeProps,
} from "@xyflow/react";
import dagre from "dagre";
import "@xyflow/react/dist/style.css";

type Pattern =
  | "dependency-tree"
  | "parallel-lanes"
  | "service-map"
  | "hub-and-spokes";

interface GraphData {
  pattern: Pattern;
  nodes: { id: string; label: string; description: string; group?: string }[];
  edges: { source: string; target: string }[];
  groups?: { id: string; label: string }[];
}

// ── Palette ──

const GROUP_PALETTE = [
  { bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.35)", accent: "#93c5fd", text: "#93c5fd" },
  { bg: "rgba(139,92,246,0.08)", border: "rgba(139,92,246,0.35)", accent: "#c4b5fd", text: "#c4b5fd" },
  { bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.35)", accent: "#6ee7b7", text: "#6ee7b7" },
  { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.35)", accent: "#fcd34d", text: "#fcd34d" },
  { bg: "rgba(236,72,153,0.08)", border: "rgba(236,72,153,0.35)", accent: "#f9a8d4", text: "#f9a8d4" },
  { bg: "rgba(6,182,212,0.08)", border: "rgba(6,182,212,0.35)", accent: "#67e8f9", text: "#67e8f9" },
];

// ── Custom nodes ──

type FileNodeData = { label: string; description: string; accent?: string };

function FileNode({ data }: NodeProps<Node<FileNodeData>>) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className="relative px-3 py-2 rounded-md bg-[#141422] border border-white/10 hover:border-white/20 transition-colors"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: data.accent || "rgba(59,130,246,0.5)",
        width: 170,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} className="!bg-blue-400/80 !w-1.5 !h-1.5 !border-0" />
      <div className="text-[11px] font-mono text-white/80 truncate leading-tight">{data.label}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-violet-400/80 !w-1.5 !h-1.5 !border-0" />
      {hovered && data.description && (
        <div className="absolute left-0 top-full mt-1 z-50 px-2.5 py-1.5 rounded bg-[#1e1e36] border border-white/10 text-[10px] text-white/60 max-w-[240px] whitespace-normal shadow-xl pointer-events-none">
          {data.description}
        </div>
      )}
    </div>
  );
}

type GroupNodeData = { label: string; color: (typeof GROUP_PALETTE)[number] };

function GroupNode({ data }: NodeProps<Node<GroupNodeData>>) {
  return (
    <div
      className="rounded-xl border"
      style={{
        backgroundColor: data.color.bg,
        borderColor: data.color.border,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    >
      <div
        className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest"
        style={{ color: data.color.text }}
      >
        {data.label}
      </div>
    </div>
  );
}

const nodeTypes = { file: FileNode, group: GroupNode };

const NODE_W = 170;
const NODE_H = 32;
const GROUP_PAD = { top: 36, right: 20, bottom: 20, left: 20 };

const EDGE_STYLE = { stroke: "rgba(139,92,246,0.3)", strokeWidth: 1.2 };
const MARKER_END = {
  type: MarkerType.ArrowClosed as const,
  color: "rgba(139,92,246,0.5)",
  width: 14,
  height: 14,
};

// ── Helpers ──

function buildEdges(validEdges: { source: string; target: string }[]): Edge[] {
  return validEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    style: EDGE_STYLE,
    markerEnd: MARKER_END,
  }));
}

function filterEdges(
  edges: { source: string; target: string }[],
  nodeIds: Set<string>,
) {
  return edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target,
  );
}

function colorMap(groups: { id: string }[]) {
  return new Map(groups.map((g, i) => [g.id, GROUP_PALETTE[i % GROUP_PALETTE.length]]));
}

/** Run dagre on a set of nodes/edges and return positioned nodes. */
function dagreLayout(
  nodes: GraphData["nodes"],
  edges: { source: string; target: string }[],
  opts: { rankdir?: string; nodesep?: number; ranksep?: number } = {},
) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: opts.rankdir || "TB",
    nodesep: opts.nodesep ?? 50,
    ranksep: opts.ranksep ?? 70,
  });
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 };
  });
}

// ── Layout: Dependency Tree ──
// Global dagre pass. No group boxes (they'd overlap). Nodes are color-coded.

function layoutDependencyTree(data: GraphData): { nodes: Node[]; edges: Edge[]; legend: { label: string; color: string }[] } {
  const groups = data.groups || [];
  const gColors = colorMap(groups);
  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const validEdges = filterEdges(data.edges, nodeIds);
  const positioned = dagreLayout(data.nodes, validEdges, { nodesep: 60, ranksep: 80 });

  const fileNodes: Node[] = positioned.map((n) => ({
    id: n.id,
    type: "file",
    position: { x: n.x, y: n.y },
    data: {
      label: n.label,
      description: n.description,
      accent: gColors.get(n.group || "")?.accent || GROUP_PALETTE[0].accent,
    },
  }));

  const legend = groups.map((g) => ({
    label: g.label,
    color: gColors.get(g.id)?.accent || GROUP_PALETTE[0].accent,
  }));

  return { nodes: fileNodes, edges: buildEdges(validEdges), legend };
}

// ── Layout: Parallel Lanes ──
// Each group is a vertical column. Groups placed side by side.

function layoutColumns(data: GraphData): { nodes: Node[]; edges: Edge[]; legend: { label: string; color: string }[] } {
  const groups = data.groups || [];
  if (groups.length === 0) return layoutDependencyTree(data);

  const gColors = colorMap(groups);
  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const allNodes: Node[] = [];
  let offsetX = 0;

  for (const group of groups) {
    const gNodes = data.nodes.filter((n) => n.group === group.id);
    if (gNodes.length === 0) continue;

    const gEdges = filterEdges(data.edges, new Set(gNodes.map((n) => n.id)));
    const positioned = dagreLayout(gNodes, gEdges, { nodesep: 40, ranksep: 60 });

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const fileNodes: Node[] = positioned.map((n) => {
      const x = offsetX + n.x;
      const y = n.y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_W);
      maxY = Math.max(maxY, y + NODE_H);
      return {
        id: n.id,
        type: "file" as const,
        position: { x, y },
        data: { label: n.label, description: n.description, accent: gColors.get(group.id)?.accent },
        zIndex: 10,
      };
    });

    allNodes.push({
      id: `group-${group.id}`,
      type: "group",
      position: { x: minX - GROUP_PAD.left, y: minY - GROUP_PAD.top },
      data: { label: group.label, color: gColors.get(group.id) || GROUP_PALETTE[0] },
      style: {
        width: maxX - minX + GROUP_PAD.left + GROUP_PAD.right,
        height: maxY - minY + GROUP_PAD.top + GROUP_PAD.bottom,
      },
      zIndex: 0,
      selectable: false,
      draggable: false,
    });
    allNodes.push(...fileNodes);

    offsetX = maxX + GROUP_PAD.right + 60;
  }

  return { nodes: allNodes, edges: buildEdges(filterEdges(data.edges, nodeIds)), legend: [] };
}

// ── Layout: Service Map ──
// Groups arranged in a grid, dagre within each.

function layoutServiceMap(data: GraphData): { nodes: Node[]; edges: Edge[]; legend: { label: string; color: string }[] } {
  const groups = data.groups || [];
  if (groups.length === 0) return layoutDependencyTree(data);

  const gColors = colorMap(groups);
  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const allNodes: Node[] = [];
  const cols = Math.ceil(Math.sqrt(groups.length));

  // First pass: compute each group's internal layout and size
  const groupLayouts: { nodes: Node[]; w: number; h: number; groupId: string }[] = [];
  for (const group of groups) {
    const gNodes = data.nodes.filter((n) => n.group === group.id);
    if (gNodes.length === 0) { groupLayouts.push({ nodes: [], w: 0, h: 0, groupId: group.id }); continue; }
    const gEdges = filterEdges(data.edges, new Set(gNodes.map((n) => n.id)));
    const positioned = dagreLayout(gNodes, gEdges, { nodesep: 40, ranksep: 50 });
    let maxX = 0, maxY = 0;
    const fileNodes: Node[] = positioned.map((n) => {
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + NODE_H);
      return {
        id: n.id, type: "file" as const,
        position: { x: n.x, y: n.y },
        data: { label: n.label, description: n.description, accent: gColors.get(group.id)?.accent },
        zIndex: 10,
      };
    });
    groupLayouts.push({
      nodes: fileNodes,
      w: maxX + GROUP_PAD.left + GROUP_PAD.right,
      h: maxY + GROUP_PAD.top + GROUP_PAD.bottom,
      groupId: group.id,
    });
  }

  // Second pass: place groups in a grid with uniform row heights
  let gridY = 0;
  for (let row = 0; row < Math.ceil(groups.length / cols); row++) {
    let gridX = 0;
    let rowH = 0;
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (idx >= groups.length) break;
      const gl = groupLayouts[idx];
      if (gl.w === 0) continue;
      const group = groups[idx];
      for (const fn of gl.nodes) {
        fn.position.x += gridX + GROUP_PAD.left;
        fn.position.y += gridY + GROUP_PAD.top;
        allNodes.push(fn);
      }
      allNodes.push({
        id: `group-${group.id}`, type: "group",
        position: { x: gridX, y: gridY },
        data: { label: group.label, color: gColors.get(group.id) || GROUP_PALETTE[0] },
        style: { width: gl.w, height: gl.h },
        zIndex: 0, selectable: false, draggable: false,
      });
      gridX += gl.w + 80;
      rowH = Math.max(rowH, gl.h);
    }
    gridY += rowH + 80;
  }

  return { nodes: allNodes, edges: buildEdges(filterEdges(data.edges, nodeIds)), legend: [] };
}

// ── Layout: Hub & Spokes ──
// Hub group centered, spokes arranged in a ring.

function layoutHubAndSpokes(data: GraphData): { nodes: Node[]; edges: Edge[]; legend: { label: string; color: string }[] } {
  const groups = data.groups || [];
  if (groups.length === 0) return layoutDependencyTree(data);

  const gColors = colorMap(groups);
  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const allNodes: Node[] = [];

  // Find hub: the group with the most cross-group connections
  const groupNodeSets = new Map<string, Set<string>>();
  for (const group of groups) {
    groupNodeSets.set(group.id, new Set(data.nodes.filter((n) => n.group === group.id).map((n) => n.id)));
  }
  let hubId = groups[0]?.id || "";
  let maxCross = -1;
  for (const group of groups) {
    const ids = groupNodeSets.get(group.id)!;
    const cross = data.edges.filter(
      (e) => (ids.has(e.source) && !ids.has(e.target)) || (!ids.has(e.source) && ids.has(e.target)),
    ).length;
    if (cross > maxCross) { maxCross = cross; hubId = group.id; }
  }

  // Internal layout helper
  function layoutGroupInternal(groupId: string) {
    const gNodes = data.nodes.filter((n) => n.group === groupId);
    if (gNodes.length === 0) return { nodes: [] as Node[], w: 0, h: 0 };
    const gEdges = filterEdges(data.edges, new Set(gNodes.map((n) => n.id)));
    const positioned = dagreLayout(gNodes, gEdges, { nodesep: 40, ranksep: 50 });
    let maxX = 0, maxY = 0;
    const fileNodes: Node[] = positioned.map((n) => {
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + NODE_H);
      return {
        id: n.id, type: "file" as const,
        position: { x: n.x, y: n.y },
        data: { label: n.label, description: n.description, accent: gColors.get(groupId)?.accent },
        zIndex: 10,
      };
    });
    return { nodes: fileNodes, w: maxX + GROUP_PAD.left + GROUP_PAD.right, h: maxY + GROUP_PAD.top + GROUP_PAD.bottom };
  }

  // Hub at center
  const hubLayout = layoutGroupInternal(hubId);
  const hubGroup = groups.find((g) => g.id === hubId)!;
  const hubX = -hubLayout.w / 2;
  const hubY = -hubLayout.h / 2;
  for (const fn of hubLayout.nodes) {
    fn.position.x += hubX + GROUP_PAD.left;
    fn.position.y += hubY + GROUP_PAD.top;
    allNodes.push(fn);
  }
  allNodes.push({
    id: `group-${hubId}`, type: "group",
    position: { x: hubX, y: hubY },
    data: { label: hubGroup.label, color: gColors.get(hubId) || GROUP_PALETTE[0] },
    style: { width: hubLayout.w, height: hubLayout.h },
    zIndex: 0, selectable: false, draggable: false,
  });

  // Spokes in a ring
  const spokes = groups.filter((g) => g.id !== hubId);
  const radius = Math.max(hubLayout.w, hubLayout.h) * 0.8 + 200;
  const step = (2 * Math.PI) / Math.max(spokes.length, 1);

  spokes.forEach((spoke, i) => {
    const sl = layoutGroupInternal(spoke.id);
    if (sl.w === 0) return;
    const angle = step * i - Math.PI / 2;
    const cx = Math.cos(angle) * radius - sl.w / 2;
    const cy = Math.sin(angle) * radius - sl.h / 2;
    for (const fn of sl.nodes) {
      fn.position.x += cx + GROUP_PAD.left;
      fn.position.y += cy + GROUP_PAD.top;
      allNodes.push(fn);
    }
    allNodes.push({
      id: `group-${spoke.id}`, type: "group",
      position: { x: cx, y: cy },
      data: { label: spoke.label, color: gColors.get(spoke.id) || GROUP_PALETTE[0] },
      style: { width: sl.w, height: sl.h },
      zIndex: 0, selectable: false, draggable: false,
    });
  });

  return { nodes: allNodes, edges: buildEdges(filterEdges(data.edges, nodeIds)), legend: [] };
}

// ── Dispatcher ──

function layoutGraph(data: GraphData) {
  switch (data.pattern) {
    case "parallel-lanes":
      return layoutColumns(data);
    case "service-map":
      return layoutServiceMap(data);
    case "hub-and-spokes":
      return layoutHubAndSpokes(data);
    case "dependency-tree":
    default:
      return layoutDependencyTree(data);
  }
}

// ── Component ──

const PATTERN_LABELS: Record<Pattern, string> = {
  "dependency-tree": "Dependency Tree",
  "parallel-lanes": "Parallel Implementations",
  "service-map": "Service / Package Map",
  "hub-and-spokes": "Hub & Spokes",
};

export default function DependencyGraph({ data }: { data: GraphData }) {
  const { nodes, edges, legend } = useMemo(() => layoutGraph(data), [data]);
  const onInit = useCallback(
    (instance: { fitView: () => void }) => {
      setTimeout(() => instance.fitView(), 50);
    },
    [],
  );

  return (
    <div className="w-full h-[calc(100vh-12rem)] rounded-lg border border-white/10 overflow-hidden relative">
      {/* Pattern badge */}
      <div className="absolute top-3 right-3 z-10 px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-[11px] text-white/40">
        {PATTERN_LABELS[data.pattern] || data.pattern}
      </div>

      {/* Group legend (dependency-tree only — other patterns use group boxes) */}
      {legend.length > 0 && (
        <div className="absolute top-3 left-3 z-10 flex flex-wrap gap-2">
          {legend.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 border border-white/10">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="text-[10px] text-white/50">{item.label}</span>
            </div>
          ))}
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={onInit}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="rgba(255,255,255,0.03)" gap={20} />
        <Controls
          showInteractive={false}
          className="!bg-white/5 !border-white/10 !rounded-lg [&>button]:!bg-transparent [&>button]:!border-white/10 [&>button]:!text-white/50 [&>button:hover]:!bg-white/10"
        />
      </ReactFlow>
    </div>
  );
}
