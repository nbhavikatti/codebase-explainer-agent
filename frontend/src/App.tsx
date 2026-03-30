import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import {
  Code2,
  GitBranch,
  FolderTree,
  Search,
  FileText,
  Brain,
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  BookOpen,
  ListOrdered,
  MessageSquare,
  Waypoints,
} from "lucide-react";

const RAW_API_URL = import.meta.env.VITE_API_URL || "";

function parseApiUrl(raw: string): { url: string; headers: Record<string, string> } {
  try {
    const parsed = new URL(raw);
    if (parsed.username) {
      const creds = btoa(`${parsed.username}:${parsed.password}`);
      parsed.username = "";
      parsed.password = "";
      return {
        url: parsed.origin + parsed.pathname.replace(/\/$/, ""),
        headers: { Authorization: `Basic ${creds}` },
      };
    }
  } catch { /* ignore */ }
  return { url: raw.replace(/\/$/, ""), headers: {} };
}

const { url: API_URL, headers: AUTH_HEADERS } = parseApiUrl(RAW_API_URL);

interface StepInfo {
  step: string;
  message: string;
  done?: boolean;
  data?: Record<string, unknown>;
}

interface AnalysisResult {
  project_summary: string;
  tech_stack: string[];
  architecture_overview: string;
  top_important_files: { path: string; description: string }[];
  reading_order: { step: number; path: string; reason: string }[];
  how_it_works: string;
  key_concepts: string[];
  conceptual_dependency_graph?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
}

interface GraphNode {
  id: string;
  label: string;
  kind: string;
  description: string;
}

interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

interface GraphPoint {
  x: number;
  y: number;
}

interface GraphLayoutNode extends GraphNode {
  x: number;
  y: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STEP_ICONS: Record<string, React.ReactNode> = {
  cloning: <GitBranch className="w-4 h-4" />,
  file_tree: <FolderTree className="w-4 h-4" />,
  detect_type: <Search className="w-4 h-4" />,
  select_files: <FileText className="w-4 h-4" />,
  read_files: <Code2 className="w-4 h-4" />,
  llm_analysis: <Brain className="w-4 h-4" />,
};

const STEP_ORDER = [
  "cloning",
  "file_tree",
  "detect_type",
  "select_files",
  "read_files",
  "llm_analysis",
];

const GRAPH_NODE_COLORS: Record<string, string> = {
  frontend: "from-cyan-400/30 via-sky-400/20 to-transparent text-cyan-100 border-cyan-300/30",
  backend: "from-emerald-400/30 via-teal-400/20 to-transparent text-emerald-100 border-emerald-300/30",
  data: "from-amber-400/30 via-orange-400/20 to-transparent text-amber-100 border-amber-300/30",
  integration: "from-pink-400/30 via-rose-400/20 to-transparent text-pink-100 border-pink-300/30",
  infrastructure: "from-indigo-400/30 via-blue-400/20 to-transparent text-indigo-100 border-indigo-300/30",
  workflow: "from-fuchsia-400/30 via-violet-400/20 to-transparent text-fuchsia-100 border-fuchsia-300/30",
  shared: "from-slate-200/20 via-slate-300/10 to-transparent text-slate-100 border-white/20",
};

const GRAPH_NODE_WIDTH = 260;
const GRAPH_NODE_HEIGHT = 168;
const GRAPH_X_GAP = 170;
const GRAPH_Y_GAP = 104;
const GRAPH_PADDING_X = 88;
const GRAPH_PADDING_Y = 72;

function getGraphNodeClass(kind: string) {
  return GRAPH_NODE_COLORS[kind] || GRAPH_NODE_COLORS.workflow;
}

function truncateEdgeLabel(label: string) {
  return label.length > 24 ? `${label.slice(0, 21)}...` : label;
}

function computeGraphLayout(graph: NonNullable<AnalysisResult["conceptual_dependency_graph"]>) {
  const nodes = graph.nodes;
  const edges = graph.edges.filter(
    (edge) =>
      nodes.some((node) => node.id === edge.source) &&
      nodes.some((node) => node.id === edge.target)
  );

  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));

  edges.forEach((edge) => {
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  });

  const queue = nodes
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .map((node) => node.id);
  const visited = new Set<string>();
  const layerById = new Map(nodes.map((node) => [node.id, 0]));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const currentLayer = layerById.get(current) || 0;

    for (const next of outgoing.get(current) || []) {
      layerById.set(next, Math.max(layerById.get(next) || 0, currentLayer + 1));
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if ((indegree.get(next) || 0) <= 0) {
        queue.push(next);
      }
    }
  }

  nodes.forEach((node, index) => {
    if (!visited.has(node.id)) {
      layerById.set(node.id, index % 3);
    }
  });

  const layers = new Map<number, GraphNode[]>();
  nodes.forEach((node) => {
    const layer = layerById.get(node.id) || 0;
    const bucket = layers.get(layer) || [];
    bucket.push(node);
    layers.set(layer, bucket);
  });

  const orderedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);
  const layerCount = Math.max(orderedLayers.length, 1);
  const maxNodesInLayer = Math.max(...orderedLayers.map(([, layerNodes]) => layerNodes.length), 1);
  const width = GRAPH_PADDING_X * 2 + layerCount * GRAPH_NODE_WIDTH + Math.max(layerCount - 1, 0) * GRAPH_X_GAP;
  const height = GRAPH_PADDING_Y * 2 + maxNodesInLayer * GRAPH_NODE_HEIGHT + Math.max(maxNodesInLayer - 1, 0) * GRAPH_Y_GAP;

  const positionedNodes: GraphLayoutNode[] = [];
  orderedLayers.forEach(([layerIndex, layerNodes]) => {
    const totalLayerHeight =
      layerNodes.length * GRAPH_NODE_HEIGHT + Math.max(layerNodes.length - 1, 0) * GRAPH_Y_GAP;
    const startY = (height - totalLayerHeight) / 2 + GRAPH_NODE_HEIGHT / 2;
    const x = GRAPH_PADDING_X + GRAPH_NODE_WIDTH / 2 + layerIndex * (GRAPH_NODE_WIDTH + GRAPH_X_GAP);

    layerNodes.forEach((node, nodeIndex) => {
      positionedNodes.push({
        ...node,
        x,
        y: startY + nodeIndex * (GRAPH_NODE_HEIGHT + GRAPH_Y_GAP),
      });
    });
  });

  const positionById = Object.fromEntries(
    positionedNodes.map((node) => [node.id, { x: node.x, y: node.y }])
  );

  return { width, height, nodes: positionedNodes, edges, positionById };
}

function getEdgeEndpoints(source: GraphPoint, target: GraphPoint) {
  const horizontal = Math.abs(target.x - source.x) >= Math.abs(target.y - source.y);
  if (horizontal) {
    return {
      start: {
        x: source.x + (target.x >= source.x ? GRAPH_NODE_WIDTH / 2 : -GRAPH_NODE_WIDTH / 2),
        y: source.y,
      },
      end: {
        x: target.x + (target.x >= source.x ? -GRAPH_NODE_WIDTH / 2 : GRAPH_NODE_WIDTH / 2),
        y: target.y,
      },
    };
  }

  return {
    start: {
      x: source.x,
      y: source.y + (target.y >= source.y ? GRAPH_NODE_HEIGHT / 2 : -GRAPH_NODE_HEIGHT / 2),
    },
    end: {
      x: target.x,
      y: target.y + (target.y >= source.y ? -GRAPH_NODE_HEIGHT / 2 : GRAPH_NODE_HEIGHT / 2),
    },
  };
}

function buildEdgePath(start: GraphPoint, end: GraphPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const bend = horizontal
    ? Math.max(Math.abs(dx) * 0.45, 72)
    : Math.max(Math.abs(dy) * 0.35, 56);

  if (horizontal) {
    return `M ${start.x} ${start.y} C ${start.x + Math.sign(dx || 1) * bend} ${start.y}, ${end.x - Math.sign(dx || 1) * bend} ${end.y}, ${end.x} ${end.y}`;
  }

  return `M ${start.x} ${start.y} C ${start.x} ${start.y + Math.sign(dy || 1) * bend}, ${end.x} ${end.y - Math.sign(dy || 1) * bend}, ${end.x} ${end.y}`;
}

function ConceptGraph({
  graph,
}: {
  graph?: AnalysisResult["conceptual_dependency_graph"];
}) {
  if (!graph || graph.nodes.length === 0) return null;

  const layout = computeGraphLayout(graph);

  return (
    <div className="concept-graph-shell mb-8">
      <div className="concept-graph-frame">
        <div
          className="concept-graph-canvas"
          style={{
            width: `${layout.width}px`,
            minHeight: `${layout.height}px`,
          }}
        >
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="absolute inset-0 h-full w-full"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="graphEdge" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(125, 211, 252, 0.85)" />
                <stop offset="100%" stopColor="rgba(244, 114, 182, 0.8)" />
              </linearGradient>
              <marker
                id="graphArrow"
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="5"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(191, 219, 254, 0.85)" />
              </marker>
            </defs>

            {layout.edges.map((edge, index) => {
              const source = layout.positionById[edge.source];
              const target = layout.positionById[edge.target];
              if (!source || !target) return null;

              const { start, end } = getEdgeEndpoints(source, target);
              const path = buildEdgePath(start, end);
              const labelX = (start.x + end.x) / 2;
              const labelY = (start.y + end.y) / 2 - (index % 2 === 0 ? 24 : -24);
              const label = truncateEdgeLabel(edge.label);
              const labelWidth = Math.max(88, Math.min(176, label.length * 7.2));

              return (
                <g key={`${edge.source}-${edge.target}-${index}`}>
                  <path
                    d={path}
                    fill="none"
                    stroke="url(#graphEdge)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    markerEnd="url(#graphArrow)"
                    opacity="0.9"
                  />
                  <g transform={`translate(${labelX - labelWidth / 2}, ${labelY - 14})`}>
                    <rect
                      width={labelWidth}
                      height="28"
                      rx="14"
                      fill="rgba(2, 6, 23, 0.92)"
                      stroke="rgba(148, 163, 184, 0.24)"
                    />
                    <text
                      x={labelWidth / 2}
                      y="18"
                      textAnchor="middle"
                      className="fill-slate-300 text-[10px] tracking-[0.18em] uppercase"
                    >
                      {label}
                    </text>
                  </g>
                </g>
              );
            })}
          </svg>

          {layout.nodes.map((node) => {
            return (
              <div
                key={node.id}
                className={`concept-node bg-gradient-to-br ${getGraphNodeClass(node.kind)}`}
                style={{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                }}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="text-sm font-semibold leading-tight text-white">
                    {node.label}
                  </div>
                  <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-white/60">
                    {node.kind}
                  </span>
                </div>
                {node.description && (
                  <p className="text-sm leading-relaxed text-white/70">
                    {node.description}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [repoUrl, setRepoUrl] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("summary");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatting, setIsChatting] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const analyzedUrlRef = useRef<string>("");

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const startAnalysis = useCallback(async () => {
    if (!repoUrl.trim() || isAnalyzing) return;

    setIsAnalyzing(true);
    setSteps([]);
    setAnalysis(null);
    setError(null);
    setChatMessages([]);
    analyzedUrlRef.current = repoUrl.trim();

    try {
      const response = await fetch(`${API_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ repo_url: repoUrl.trim() }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.detail || "Failed to start analysis");
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response stream");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "step") {
              setSteps((prev) => {
                const existing = prev.findIndex(
                  (s) => s.step === data.step && !s.done
                );
                if (existing >= 0 && data.done) {
                  const updated = [...prev];
                  updated[existing] = data;
                  return updated;
                }
                if (existing >= 0) return prev;
                return [...prev, data];
              });
            } else if (eventType === "result") {
              setAnalysis(data.analysis);
            } else if (eventType === "error") {
              setError(data.message);
            }
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "An error occurred");
    } finally {
      setIsAnalyzing(false);
    }
  }, [repoUrl, isAnalyzing]);

  const sendChat = useCallback(async () => {
    if (!chatInput.trim() || isChatting) return;

    const question = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: question }]);
    setIsChatting(true);

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          repo_url: analyzedUrlRef.current,
          question,
          context: analysis ? JSON.stringify(analysis).slice(0, 2000) : "",
        }),
      });

      if (!response.ok) {
        throw new Error("Chat request failed");
      }

      const data = await response.json();
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer },
      ]);
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error. Please try again.",
        },
      ]);
    } finally {
      setIsChatting(false);
    }
  }, [chatInput, isChatting, analysis]);

  const getStepStatus = (stepName: string) => {
    const step = steps.find((s) => s.step === stepName);
    if (!step) return "pending";
    if (step.done) return "done";
    return "active";
  };

  const getStepMessage = (stepName: string) => {
    const allForStep = steps.filter((s) => s.step === stepName);
    const doneStep = allForStep.find((s) => s.done);
    return doneStep?.message || allForStep[0]?.message || "";
  };

  const tabs = [
    { id: "summary", label: "Summary", icon: <BookOpen className="w-4 h-4" /> },
    { id: "architecture", label: "Architecture", icon: <Waypoints className="w-4 h-4" /> },
    { id: "files", label: "Key Files", icon: <FileText className="w-4 h-4" /> },
    { id: "reading", label: "Reading Order", icon: <ListOrdered className="w-4 h-4" /> },
    { id: "chat", label: "Ask Questions", icon: <MessageSquare className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/30 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-white/10">
            <Code2 className="w-5 h-5 text-blue-400" />
          </div>
          <h1 className="text-lg font-semibold">
            <span className="gradient-text">Codebase Explainer</span>
          </h1>
          <span className="text-xs text-white/40 ml-1">Agent</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Hero / Input */}
        {!analysis && !isAnalyzing && (
          <div className="text-center mb-12 animate-fade-in">
            <h2 className="text-4xl font-bold mb-4">
              Understand any{" "}
              <span className="gradient-text">GitHub repo</span> in seconds
            </h2>
            <p className="text-white/50 text-lg max-w-xl mx-auto">
              Paste a public repository URL and our AI agent will clone it,
              analyze the codebase, and generate a comprehensive explanation.
            </p>
          </div>
        )}

        {/* Input Bar */}
        {!analysis && (
          <div className="glass-card p-2 mb-8 flex items-center gap-2 max-w-3xl mx-auto">
            <div className="pl-3 text-white/30">
              <GitBranch className="w-5 h-5" />
            </div>
            <input
              type="text"
              placeholder="https://github.com/owner/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startAnalysis()}
              disabled={isAnalyzing}
              className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-white/30 py-2 px-2 font-mono text-sm"
            />
            <button
              onClick={startAnalysis}
              disabled={isAnalyzing || !repoUrl.trim()}
              className="px-5 py-2.5 bg-gradient-to-r from-blue-500 to-violet-500 text-white rounded-lg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 shrink-0"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Analyzing...
                </>
              ) : (
                <>
                  <Brain className="w-4 h-4" /> Analyze
                </>
              )}
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="max-w-3xl mx-auto mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-3 animate-fade-in">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* Analysis Steps */}
        {!analysis && steps.length > 0 && (
          <div className="max-w-3xl mx-auto mb-8">
            <div className="glass-card p-6">
              <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider mb-4">
                Analysis Progress
              </h3>
              <div className="space-y-3">
                {STEP_ORDER.map((stepName) => {
                  const status = getStepStatus(stepName);
                  const message = getStepMessage(stepName);
                  if (status === "pending" && !isAnalyzing) return null;
                  return (
                    <div
                      key={stepName}
                      className={`flex items-center gap-3 transition-all duration-300 ${
                        status === "pending" ? "opacity-30" : "opacity-100"
                      } ${status === "active" ? "animate-fade-in" : ""}`}
                    >
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                          status === "done"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : status === "active"
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-white/5 text-white/30"
                        }`}
                      >
                        {status === "done" ? (
                          <CheckCircle2 className="w-4 h-4" />
                        ) : status === "active" ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          STEP_ICONS[stepName]
                        )}
                      </div>
                      <span
                        className={`text-sm ${
                          status === "done"
                            ? "text-white/70"
                            : status === "active"
                            ? "text-white"
                            : "text-white/30"
                        }`}
                      >
                        {message ||
                          stepName.replace("_", " ").replace(/^\w/, (c) =>
                            c.toUpperCase()
                          )}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Show selected files if available */}
              {steps.some(
                (s) => s.step === "select_files" && s.done && s.data?.files
              ) && (
                <div className="mt-4 pt-4 border-t border-white/10">
                  <button
                    onClick={() => setExpandedFiles(!expandedFiles)}
                    className="flex items-center gap-2 text-xs text-white/50 hover:text-white/70 transition-colors"
                  >
                    {expandedFiles ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    Files selected for analysis
                  </button>
                  {expandedFiles && (
                    <div className="mt-2 max-h-48 overflow-y-auto">
                      {(
                        steps.find(
                          (s) => s.step === "select_files" && s.done
                        )?.data?.files as string[]
                      )?.map((f) => (
                        <div
                          key={f}
                          className="text-xs font-mono text-white/40 py-0.5"
                        >
                          {f}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Analysis Results */}
        {analysis && (
          <div className="animate-fade-in">
            {/* Tech Stack Badges */}
            {analysis.tech_stack && analysis.tech_stack.length > 0 && (
              <div className="mb-6">
                <p className="text-center text-sm font-semibold text-white/60 uppercase tracking-widest mb-3">Tech Stack</p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {analysis.tech_stack.map((tech) => (
                    <span
                      key={tech}
                      className="px-3 py-1 text-xs font-medium bg-blue-500/10 text-blue-300 border border-blue-500/20 rounded-full"
                    >
                      {tech}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="flex gap-1 mb-6 overflow-x-auto pb-2 justify-center flex-wrap">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                    activeTab === tab.id
                      ? "bg-white/10 text-white border border-white/20"
                      : "text-white/40 hover:text-white/60 hover:bg-white/5"
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="glass-card p-6 min-h-[300px]">
              {activeTab === "summary" && (
                <div className="animate-fade-in">
                  <h3 className="text-xl font-semibold mb-4 gradient-text">
                    Project Summary
                  </h3>
                  <div className="text-white/70 leading-relaxed whitespace-pre-line">
                    {analysis.project_summary}
                  </div>
                  {analysis.key_concepts &&
                    analysis.key_concepts.length > 0 && (
                      <div className="mt-6 pt-6 border-t border-white/10">
                        <h4 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">
                          Key Concepts
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {analysis.key_concepts.map((concept, i) => (
                            <span
                              key={i}
                              className="px-3 py-1.5 text-sm bg-violet-500/10 text-violet-300 border border-violet-500/20 rounded-lg"
                            >
                              {concept}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              )}

              {activeTab === "architecture" && (
                <div className="animate-fade-in">
                  <h3 className="text-xl font-semibold mb-4 gradient-text">
                    Architecture Overview
                  </h3>
                  <ConceptGraph graph={analysis.conceptual_dependency_graph} />
                  <div className="text-white/70 leading-relaxed whitespace-pre-line">
                    {analysis.architecture_overview}
                  </div>
                </div>
              )}

              {activeTab === "files" && (
                <div className="animate-fade-in">
                  <h3 className="text-xl font-semibold mb-4 gradient-text">
                    Top Important Files
                  </h3>
                  <div className="space-y-3">
                    {analysis.top_important_files?.map((file, i) => (
                      <div
                        key={i}
                        className="p-4 bg-white/5 rounded-lg border border-white/5 hover:border-white/10 transition-colors"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <FileText className="w-4 h-4 text-blue-400" />
                          <span className="font-mono text-sm text-blue-300">
                            {file.path}
                          </span>
                        </div>
                        <p className="text-sm text-white/50 ml-6">
                          {file.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === "reading" && (
                <div className="animate-fade-in">
                  <h3 className="text-xl font-semibold mb-4 gradient-text">
                    Suggested Reading Order
                  </h3>
                  <div className="space-y-4">
                    {analysis.reading_order?.map((item, i) => (
                      <div key={i} className="flex gap-4">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-white/10 flex items-center justify-center shrink-0 text-sm font-semibold text-blue-300">
                          {item.step}
                        </div>
                        <div className="pt-1">
                          <div className="font-mono text-sm text-blue-300 mb-1">
                            {item.path}
                          </div>
                          <p className="text-sm text-white/50">{item.reason}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

                {activeTab === "chat" && (
                <div className="animate-fade-in flex flex-col h-[500px]">
                  <h3 className="text-xl font-semibold mb-4 gradient-text">
                    Ask Questions About This Codebase
                  </h3>

                  {/* Chat Messages */}
                  <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
                    {chatMessages.length === 0 && (
                      <div className="text-center py-12 text-white/30">
                        <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-50" />
                        <p className="text-sm">
                          Ask anything about the codebase...
                        </p>
                        <div className="flex flex-wrap gap-2 justify-center mt-4">
                          {[
                            "What design patterns are used?",
                            "How does authentication work?",
                            "What are the main API endpoints?",
                          ].map((q) => (
                            <button
                              key={q}
                              onClick={() => {
                                setChatInput(q);
                              }}
                              className="px-3 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors text-white/50"
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {chatMessages.map((msg, i) => (
                      <div
                        key={i}
                        className={`flex ${
                          msg.role === "user" ? "justify-end" : "justify-start"
                        }`}
                      >
                        <div
                          className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm ${
                            msg.role === "user"
                              ? "bg-blue-500/20 text-blue-100 rounded-br-md"
                              : "bg-white/5 text-white/70 rounded-bl-md border border-white/10"
                          }`}
                        >
                          {msg.role === "assistant" ? (
                            <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-blue-300 prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10">
                              <ReactMarkdown>{msg.content}</ReactMarkdown>
                            </div>
                          ) : (
                            <div className="whitespace-pre-line">{msg.content}</div>
                          )}
                        </div>
                      </div>
                    ))}
                    {isChatting && (
                      <div className="flex justify-start">
                        <div className="bg-white/5 border border-white/10 rounded-2xl rounded-bl-md px-4 py-3">
                          <Loader2 className="w-4 h-4 animate-spin text-white/50" />
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Chat Input */}
                  <div className="flex gap-2 pt-4 border-t border-white/10">
                    <input
                      type="text"
                      placeholder="Ask a question about this codebase..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && sendChat()}
                      disabled={isChatting}
                      className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-blue-500/50 transition-colors placeholder:text-white/30 disabled:opacity-50"
                    />
                    <button
                      onClick={sendChat}
                      disabled={isChatting || !chatInput.trim()}
                      className="p-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 mt-16">
        <div className="max-w-6xl mx-auto px-4 py-6 text-center text-xs text-white/20">
          Codebase Explainer Agent &middot; Powered by AI
        </div>
      </footer>
    </div>
  );
}

export default App;
