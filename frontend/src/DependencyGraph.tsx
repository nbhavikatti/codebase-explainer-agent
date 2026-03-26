import { useMemo, useCallback } from "react";
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

type Pattern = "dependency-tree" | "parallel-lanes" | "service-map" | "hub-and-spokes";

interface GraphData {
  pattern: Pattern;
  nodes: { id: string; label: string; description: string; group?: string }[];
  edges: { source: string; target: string }[];
  groups?: { id: string; label: string }[];
}

// --- Group colors ---
const GROUP_COLORS = [
  { bg: "rgba(59,130,246,0.06)", border: "rgba(59,130,246,0.25)", text: "rgb(147,197,253)" },
  { bg: "rgba(139,92,246,0.06)", border: "rgba(139,92,246,0.25)", text: "rgb(196,181,253)" },
  { bg: "rgba(16,185,129,0.06)", border: "rgba(16,185,129,0.25)", text: "rgb(110,231,183)" },
  { bg: "rgba(245,158,11,0.06)", border: "rgba(245,158,11,0.25)", text: "rgb(252,211,77)" },
  { bg: "rgba(236,72,153,0.06)", border: "rgba(236,72,153,0.25)", text: "rgb(249,168,212)" },
  { bg: "rgba(6,182,212,0.06)", border: "rgba(6,182,212,0.25)", text: "rgb(103,232,249)" },
];

// --- Custom nodes ---
type FileNodeData = { label: string; description: string };

function FileNode({ data }: NodeProps<Node<FileNodeData>>) {
  return (
    <div className="px-3 py-2 rounded-lg bg-[#1a1a2e] border border-white/10 hover:border-blue-500/40 transition-colors min-w-[140px] max-w-[220px]">
      <Handle type="target" position={Position.Top} className="!bg-blue-400 !w-2 !h-2 !border-0" />
      <div className="text-xs font-mono text-blue-300 truncate">{data.label}</div>
      {data.description && (
        <div className="text-[10px] text-white/40 mt-1 line-clamp-2">{data.description}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-violet-400 !w-2 !h-2 !border-0" />
    </div>
  );
}

type GroupNodeData = { label: string; color: typeof GROUP_COLORS[number] };

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
        className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: data.color.text }}
      >
        {data.label}
      </div>
    </div>
  );
}

const nodeTypes = { file: FileNode, group: GroupNode };

const NODE_W = 180;
const NODE_H = 56;
const GROUP_PAD = { top: 40, right: 24, bottom: 24, left: 24 };

const EDGE_STYLE = { stroke: "rgba(139, 92, 246, 0.4)", strokeWidth: 1.5 };
const MARKER_END = { type: MarkerType.ArrowClosed as const, color: "rgba(139, 92, 246, 0.6)", width: 16, height: 16 };

// --- Layout helpers ---

function buildEdges(
  validEdges: { source: string; target: string }[],
): Edge[] {
  return validEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    animated: false,
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

/** Standard top-down dagre layout for dependency-tree */
function layoutDependencyTree(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const node of data.nodes) {
    g.setNode(node.id, { width: NODE_W, height: NODE_H });
  }

  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const validEdges = filterEdges(data.edges, nodeIds);

  for (const edge of validEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  // Build group bounding boxes from node positions
  const groups = data.groups || [];
  const groupColorMap = new Map(groups.map((g, i) => [g.id, GROUP_COLORS[i % GROUP_COLORS.length]]));
  const groupBounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();

  const fileNodes: Node[] = data.nodes.map((n) => {
    const pos = g.node(n.id);
    const x = pos.x - NODE_W / 2;
    const y = pos.y - NODE_H / 2;

    if (n.group) {
      const b = groupBounds.get(n.group) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x + NODE_W);
      b.maxY = Math.max(b.maxY, y + NODE_H);
      groupBounds.set(n.group, b);
    }

    return {
      id: n.id,
      type: "file",
      position: { x, y },
      data: { label: n.label, description: n.description },
      zIndex: 10,
    };
  });

  const groupNodes: Node[] = [];
  for (const group of groups) {
    const b = groupBounds.get(group.id);
    if (!b) continue;
    groupNodes.push({
      id: `group-${group.id}`,
      type: "group",
      position: {
        x: b.minX - GROUP_PAD.left,
        y: b.minY - GROUP_PAD.top,
      },
      data: {
        label: group.label,
        color: groupColorMap.get(group.id) || GROUP_COLORS[0],
      },
      style: {
        width: b.maxX - b.minX + GROUP_PAD.left + GROUP_PAD.right,
        height: b.maxY - b.minY + GROUP_PAD.top + GROUP_PAD.bottom,
      },
      zIndex: 0,
      selectable: false,
      draggable: false,
    });
  }

  return { nodes: [...groupNodes, ...fileNodes], edges: buildEdges(validEdges) };
}

/** Lay out each group as a separate column (lane), left-to-right */
function layoutParallelLanes(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  const groups = data.groups || [];
  if (groups.length === 0) return layoutDependencyTree(data);

  const allNodes: Node[] = [];
  const laneGap = 80;
  let laneX = 0;
  const groupColorMap = new Map(groups.map((g, i) => [g.id, GROUP_COLORS[i % GROUP_COLORS.length]]));
  const nodeIds = new Set(data.nodes.map((n) => n.id));

  for (const group of groups) {
    const laneNodes = data.nodes.filter((n) => n.group === group.id);
    if (laneNodes.length === 0) continue;

    const laneEdges = filterEdges(data.edges, new Set(laneNodes.map((n) => n.id)));

    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 60 });

    for (const node of laneNodes) {
      g.setNode(node.id, { width: NODE_W, height: NODE_H });
    }
    for (const edge of laneEdges) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const fileNodes: Node[] = laneNodes.map((n) => {
      const pos = g.node(n.id);
      const x = laneX + pos.x - NODE_W / 2;
      const y = pos.y - NODE_H / 2;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_W);
      maxY = Math.max(maxY, y + NODE_H);
      return {
        id: n.id,
        type: "file" as const,
        position: { x, y },
        data: { label: n.label, description: n.description },
        zIndex: 10,
      };
    });

    allNodes.push({
      id: `group-${group.id}`,
      type: "group",
      position: { x: minX - GROUP_PAD.left, y: minY - GROUP_PAD.top },
      data: { label: group.label, color: groupColorMap.get(group.id) || GROUP_COLORS[0] },
      style: {
        width: maxX - minX + GROUP_PAD.left + GROUP_PAD.right,
        height: maxY - minY + GROUP_PAD.top + GROUP_PAD.bottom,
      },
      zIndex: 0,
      selectable: false,
      draggable: false,
    });
    allNodes.push(...fileNodes);

    laneX = maxX + GROUP_PAD.right + laneGap;
  }

  return { nodes: allNodes, edges: buildEdges(filterEdges(data.edges, nodeIds)) };
}

/** Service map: lay out groups in a grid, dagre within each, then cross-group edges */
function layoutServiceMap(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  const groups = data.groups || [];
  if (groups.length === 0) return layoutDependencyTree(data);

  const allNodes: Node[] = [];
  const cols = Math.ceil(Math.sqrt(groups.length));
  const cellGap = 100;
  const groupColorMap = new Map(groups.map((g, i) => [g.id, GROUP_COLORS[i % GROUP_COLORS.length]]));
  const nodeIds = new Set(data.nodes.map((n) => n.id));

  // Lay out each group independently, then position in a grid
  const groupSizes: { w: number; h: number }[] = [];
  const groupFileNodes: Node[][] = [];

  for (const group of groups) {
    const gNodes = data.nodes.filter((n) => n.group === group.id);
    if (gNodes.length === 0) {
      groupSizes.push({ w: 0, h: 0 });
      groupFileNodes.push([]);
      continue;
    }

    const gEdges = filterEdges(data.edges, new Set(gNodes.map((n) => n.id)));
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 50 });

    for (const node of gNodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
    for (const edge of gEdges) g.setEdge(edge.source, edge.target);
    dagre.layout(g);

    const fileNodes: Node[] = gNodes.map((n) => {
      const pos = g.node(n.id);
      return {
        id: n.id,
        type: "file" as const,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
        data: { label: n.label, description: n.description },
        zIndex: 10,
      };
    });

    let maxX = 0, maxY = 0;
    for (const fn of fileNodes) {
      maxX = Math.max(maxX, fn.position.x + NODE_W);
      maxY = Math.max(maxY, fn.position.y + NODE_H);
    }

    groupSizes.push({ w: maxX + GROUP_PAD.left + GROUP_PAD.right, h: maxY + GROUP_PAD.top + GROUP_PAD.bottom });
    groupFileNodes.push(fileNodes);
  }

  // Position groups in grid
  let gridY = 0;
  for (let row = 0; row < Math.ceil(groups.length / cols); row++) {
    let gridX = 0;
    let rowHeight = 0;
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (idx >= groups.length) break;
      const group = groups[idx];
      const size = groupSizes[idx];
      if (size.w === 0) continue;

      const offsetX = gridX + GROUP_PAD.left;
      const offsetY = gridY + GROUP_PAD.top;

      for (const fn of groupFileNodes[idx]) {
        fn.position.x += offsetX;
        fn.position.y += offsetY;
        allNodes.push(fn);
      }

      allNodes.push({
        id: `group-${group.id}`,
        type: "group",
        position: { x: gridX, y: gridY },
        data: { label: group.label, color: groupColorMap.get(group.id) || GROUP_COLORS[0] },
        style: { width: size.w, height: size.h },
        zIndex: 0,
        selectable: false,
        draggable: false,
      });

      gridX += size.w + cellGap;
      rowHeight = Math.max(rowHeight, size.h);
    }
    gridY += rowHeight + cellGap;
  }

  return { nodes: allNodes, edges: buildEdges(filterEdges(data.edges, nodeIds)) };
}

/** Hub-and-spokes: hub group centered, spokes arranged radially */
function layoutHubAndSpokes(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  const groups = data.groups || [];
  if (groups.length === 0) return layoutDependencyTree(data);

  const allNodes: Node[] = [];
  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const groupColorMap = new Map(groups.map((g, i) => [g.id, GROUP_COLORS[i % GROUP_COLORS.length]]));

  // Find hub: the group with the most cross-group edge connections
  const groupNodeIds = new Map<string, Set<string>>();
  for (const group of groups) {
    groupNodeIds.set(group.id, new Set(data.nodes.filter((n) => n.group === group.id).map((n) => n.id)));
  }

  let hubId = groups[0]?.id || "";
  let maxCross = -1;
  for (const group of groups) {
    const ids = groupNodeIds.get(group.id)!;
    const crossCount = data.edges.filter(
      (e) => (ids.has(e.source) && !ids.has(e.target)) || (!ids.has(e.source) && ids.has(e.target)),
    ).length;
    if (crossCount > maxCross) {
      maxCross = crossCount;
      hubId = group.id;
    }
  }

  const spokes = groups.filter((g) => g.id !== hubId);

  // Layout each group internally with dagre
  function layoutGroup(groupId: string) {
    const gNodes = data.nodes.filter((n) => n.group === groupId);
    if (gNodes.length === 0) return { fileNodes: [] as Node[], w: 0, h: 0 };

    const gEdges = filterEdges(data.edges, new Set(gNodes.map((n) => n.id)));
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 50 });
    for (const node of gNodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
    for (const edge of gEdges) g.setEdge(edge.source, edge.target);
    dagre.layout(g);

    const fileNodes: Node[] = gNodes.map((n) => {
      const pos = g.node(n.id);
      return {
        id: n.id,
        type: "file" as const,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
        data: { label: n.label, description: n.description },
        zIndex: 10,
      };
    });

    let maxX = 0, maxY = 0;
    for (const fn of fileNodes) {
      maxX = Math.max(maxX, fn.position.x + NODE_W);
      maxY = Math.max(maxY, fn.position.y + NODE_H);
    }
    return { fileNodes, w: maxX + GROUP_PAD.left + GROUP_PAD.right, h: maxY + GROUP_PAD.top + GROUP_PAD.bottom };
  }

  // Hub at center
  const hub = layoutGroup(hubId);
  const hubGroup = groups.find((g) => g.id === hubId)!;
  const hubOffsetX = -hub.w / 2;
  const hubOffsetY = -hub.h / 2;

  for (const fn of hub.fileNodes) {
    fn.position.x += hubOffsetX + GROUP_PAD.left;
    fn.position.y += hubOffsetY + GROUP_PAD.top;
    allNodes.push(fn);
  }
  allNodes.push({
    id: `group-${hubId}`,
    type: "group",
    position: { x: hubOffsetX, y: hubOffsetY },
    data: { label: hubGroup.label, color: groupColorMap.get(hubId) || GROUP_COLORS[0] },
    style: { width: hub.w, height: hub.h },
    zIndex: 0,
    selectable: false,
    draggable: false,
  });

  // Spokes arranged in a circle
  const radius = Math.max(hub.w, hub.h) + 150;
  const angleStep = (2 * Math.PI) / Math.max(spokes.length, 1);

  spokes.forEach((spoke, i) => {
    const spokeLayout = layoutGroup(spoke.id);
    if (spokeLayout.w === 0) return;

    const angle = angleStep * i - Math.PI / 2;
    const cx = Math.cos(angle) * radius;
    const cy = Math.sin(angle) * radius;
    const spokeX = cx - spokeLayout.w / 2;
    const spokeY = cy - spokeLayout.h / 2;

    for (const fn of spokeLayout.fileNodes) {
      fn.position.x += spokeX + GROUP_PAD.left;
      fn.position.y += spokeY + GROUP_PAD.top;
      allNodes.push(fn);
    }

    allNodes.push({
      id: `group-${spoke.id}`,
      type: "group",
      position: { x: spokeX, y: spokeY },
      data: { label: spoke.label, color: groupColorMap.get(spoke.id) || GROUP_COLORS[0] },
      style: { width: spokeLayout.w, height: spokeLayout.h },
      zIndex: 0,
      selectable: false,
      draggable: false,
    });
  });

  return { nodes: allNodes, edges: buildEdges(filterEdges(data.edges, nodeIds)) };
}

// --- Main layout dispatcher ---

function layoutGraph(data: GraphData): { nodes: Node[]; edges: Edge[] } {
  switch (data.pattern) {
    case "parallel-lanes":
      return layoutParallelLanes(data);
    case "service-map":
      return layoutServiceMap(data);
    case "hub-and-spokes":
      return layoutHubAndSpokes(data);
    case "dependency-tree":
    default:
      return layoutDependencyTree(data);
  }
}

// --- Component ---

const PATTERN_LABELS: Record<Pattern, string> = {
  "dependency-tree": "Dependency Tree",
  "parallel-lanes": "Parallel Implementations",
  "service-map": "Service / Package Map",
  "hub-and-spokes": "Hub & Spokes",
};

export default function DependencyGraph({ data }: { data: GraphData }) {
  const { nodes, edges } = useMemo(() => layoutGraph(data), [data]);
  const onInit = useCallback((instance: { fitView: () => void }) => {
    setTimeout(() => instance.fitView(), 50);
  }, []);

  return (
    <div className="w-full h-[calc(100vh-12rem)] rounded-lg border border-white/10 overflow-hidden relative">
      <div className="absolute top-3 right-3 z-10 px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-[11px] text-white/40">
        {PATTERN_LABELS[data.pattern] || data.pattern}
      </div>
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
