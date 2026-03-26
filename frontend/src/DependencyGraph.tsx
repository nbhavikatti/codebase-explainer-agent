import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  Position,
  Handle,
  type NodeProps,
} from "@xyflow/react";
import dagre from "dagre";
import "@xyflow/react/dist/style.css";

interface GraphData {
  nodes: { id: string; label: string; description: string }[];
  edges: { source: string; target: string; label?: string }[];
}

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

const nodeTypes = { file: FileNode };

function layoutGraph(graphData: GraphData) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const node of graphData.nodes) {
    g.setNode(node.id, { width: 180, height: 56 });
  }

  const nodeIds = new Set(graphData.nodes.map((n) => n.id));
  const validEdges = graphData.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target
  );

  for (const edge of validEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const nodes: Node[] = graphData.nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "file",
      position: { x: pos.x - 90, y: pos.y - 28 },
      data: { label: n.label, description: n.description },
    };
  });

  const edges: Edge[] = validEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.source,
    target: e.target,
    label: e.label || undefined,
    animated: false,
    style: { stroke: "rgba(139, 92, 246, 0.4)", strokeWidth: 1.5 },
    labelStyle: { fill: "rgba(255,255,255,0.4)", fontSize: 10 },
  }));

  return { nodes, edges };
}

export default function DependencyGraph({ data }: { data: GraphData }) {
  const { nodes, edges } = useMemo(() => layoutGraph(data), [data]);
  const onInit = useCallback((instance: { fitView: () => void }) => {
    setTimeout(() => instance.fitView(), 50);
  }, []);

  return (
    <div className="w-full h-[calc(100vh-12rem)] rounded-lg border border-white/10 overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={onInit}
        fitView
        minZoom={0.2}
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
