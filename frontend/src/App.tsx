import { useState, useRef, useEffect, useCallback } from "react";
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
  Layers,
  ListOrdered,
  Lightbulb,
  MessageSquare,
} from "lucide-react";

const RAW_API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

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
    { id: "architecture", label: "Architecture", icon: <Layers className="w-4 h-4" /> },
    { id: "files", label: "Key Files", icon: <FileText className="w-4 h-4" /> },
    { id: "reading", label: "Reading Order", icon: <ListOrdered className="w-4 h-4" /> },
    { id: "how", label: "How It Works", icon: <Lightbulb className="w-4 h-4" /> },
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

        {/* Error */}
        {error && (
          <div className="max-w-3xl mx-auto mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-3 animate-fade-in">
            <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* Analysis Steps */}
        {steps.length > 0 && (
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
              <div className="flex flex-wrap gap-2 mb-6 justify-center">
                {analysis.tech_stack.map((tech) => (
                  <span
                    key={tech}
                    className="px-3 py-1 text-xs font-medium bg-blue-500/10 text-blue-300 border border-blue-500/20 rounded-full"
                  >
                    {tech}
                  </span>
                ))}
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

              {activeTab === "how" && (
                <div className="animate-fade-in">
                  <h3 className="text-xl font-semibold mb-4 gradient-text">
                    How It Works
                  </h3>
                  <div className="text-white/70 leading-relaxed whitespace-pre-line">
                    {analysis.how_it_works}
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
                          <div className="whitespace-pre-line">
                            {msg.content}
                          </div>
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
