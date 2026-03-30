from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

import httpx
import certifi
from openai import AsyncOpenAI
from dotenv import load_dotenv

_HERE = Path(__file__).resolve().parent
# Prefer local env files when running without a process manager.
# Order matters: repo-level backend/.env first, then app/.env overrides.
load_dotenv(_HERE.parent / ".env")
load_dotenv(_HERE / ".env", override=True)

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY is not set. Set it in the environment (recommended) "
                "or in backend/.env before running the backend."
            )
        _client = AsyncOpenAI(
            api_key=api_key,
            timeout=60,
            max_retries=2,
            http_client=httpx.AsyncClient(verify=certifi.where()),
        )
    return _client


ANALYSIS_SYSTEM_PROMPT = """You are an expert software engineer who analyzes codebases.
You will be given information about a GitHub repository including its file tree, detected tech stack, and contents of key files.
Your job is to produce a comprehensive but concise analysis of the codebase.
Respond in valid JSON with this exact structure:
{
  "project_summary": "A 2-3 paragraph summary of what this project is and does",
  "tech_stack": ["Technology (frontend)", "Technology (backend)", "Technology (full-stack)", "Technology (tooling)"],
  "architecture_overview": "A description of the project architecture and how components fit together",
  "top_important_files": [
    {"path": "file/path.ext", "description": "Why this file is important"}
  ],
  "reading_order": [
    {"step": 1, "path": "file/path.ext", "reason": "Why read this first"}
  ],
  "how_it_works": "A detailed explanation of how the codebase works, covering the main flows and key components",
  "key_concepts": ["Important concept 1", "Important concept 2"],
  "conceptual_dependency_graph": {
    "nodes": [
      {
        "id": "frontend-ui",
        "label": "Frontend UI",
        "kind": "frontend",
        "description": "What this concept is responsible for"
      }
    ],
    "edges": [
      {
        "source": "frontend-ui",
        "target": "api-layer",
        "label": "calls"
      }
    ]
  }
}
For tech_stack, label each technology with its role in parentheses: (frontend), (backend), (full-stack), (database), (tooling), or (devops) as appropriate.
For conceptual_dependency_graph, create a polished concept-level architecture diagram:
- Use concepts, capabilities, or architectural layers, not raw file names.
- Include 4-8 nodes and 3-10 edges.
- Base it on the repo context and architecture you infer from the files.
- Keep ids short, unique, and kebab-case.
- Use kinds from this set when possible: frontend, backend, data, integration, infrastructure, workflow, shared.
Be specific and reference actual file names and code patterns you see. Do not make up files that don't exist."""

CHAT_SYSTEM_PROMPT = """You are an expert software engineer helping a user understand a codebase.
You have analyzed a GitHub repository and have context about its structure and contents.
Answer the user's questions concisely and accurately based on the codebase context provided.
Reference specific files and code when relevant. If you're unsure about something, say so."""


async def generate_analysis(
    file_tree_str: str,
    project_types: list[str],
    file_contents: dict[str, str],
    repo_url: str,
) -> str:
    """Generate a comprehensive analysis of the codebase using the LLM."""
    files_context = ""
    for fpath, content in file_contents.items():
        files_context += f"\n\n=== {fpath} ===\n{content}"

    user_prompt = f"""Analyze this GitHub repository: {repo_url}
Detected project type(s): {', '.join(project_types)}
File tree:
{file_tree_str}
Key file contents:
{files_context}
Provide a comprehensive analysis in the JSON format specified."""

    response = await _get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
        max_tokens=4000,
        response_format={"type": "json_object"},
    )
    return response.choices[0].message.content or "{}"


def normalize_analysis_payload(raw_analysis: str) -> dict[str, Any]:
    try:
        analysis = json.loads(raw_analysis)
    except json.JSONDecodeError:
        return {"error": "Failed to parse analysis", "raw": raw_analysis}

    if not isinstance(analysis, dict):
        return {"error": "Failed to parse analysis", "raw": raw_analysis}

    analysis["conceptual_dependency_graph"] = _normalize_graph(analysis)
    return analysis


def _normalize_graph(analysis: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    graph = analysis.get("conceptual_dependency_graph")
    raw_nodes = graph.get("nodes", []) if isinstance(graph, dict) else []
    raw_edges = graph.get("edges", []) if isinstance(graph, dict) else []

    nodes: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for node in raw_nodes:
        if not isinstance(node, dict):
            continue
        label = _clean_text(node.get("label")) or _clean_text(node.get("id"))
        if not label:
            continue
        node_id = _slugify(node.get("id") or label)
        if not node_id or node_id in seen_ids:
            continue
        seen_ids.add(node_id)
        nodes.append(
            {
                "id": node_id,
                "label": label[:40],
                "kind": _clean_text(node.get("kind")) or _infer_kind(label),
                "description": _clean_text(node.get("description"))[:140],
            }
        )

    if not nodes:
        nodes = _build_fallback_nodes(analysis)
        seen_ids = {node["id"] for node in nodes}

    edges: list[dict[str, str]] = []
    for edge in raw_edges:
        if not isinstance(edge, dict):
            continue
        source = _slugify(edge.get("source"))
        target = _slugify(edge.get("target"))
        if not source or not target or source == target:
            continue
        if source not in seen_ids or target not in seen_ids:
            continue
        edges.append(
            {
                "source": source,
                "target": target,
                "label": _clean_text(edge.get("label"))[:48] or "connects to",
            }
        )

    if not edges:
        edges = _build_fallback_edges(nodes)

    return {"nodes": nodes[:8], "edges": edges[:10]}


def _build_fallback_nodes(analysis: dict[str, Any]) -> list[dict[str, str]]:
    concepts = analysis.get("key_concepts")
    raw_labels: list[str] = []
    if isinstance(concepts, list):
        raw_labels.extend(_clean_text(item) for item in concepts if _clean_text(item))

    for file_info in analysis.get("top_important_files", []) if isinstance(analysis.get("top_important_files"), list) else []:
        if not isinstance(file_info, dict):
            continue
        description = _clean_text(file_info.get("description"))
        if description:
            raw_labels.append(description.split(".")[0])
        if len(raw_labels) >= 6:
            break

    deduped: list[str] = []
    seen_labels: set[str] = set()
    for label in raw_labels:
        short = label[:40]
        if short and short.lower() not in seen_labels:
            seen_labels.add(short.lower())
            deduped.append(short)
        if len(deduped) >= 6:
            break

    if not deduped:
        deduped = ["User Interface", "Core Application", "Repository Context", "AI Analysis"]

    return [
        {
            "id": _slugify(label),
            "label": label,
            "kind": _infer_kind(label),
            "description": "",
        }
        for label in deduped
    ]


def _build_fallback_edges(nodes: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        {
            "source": nodes[index]["id"],
            "target": nodes[index + 1]["id"],
            "label": "informs" if index == 0 else "feeds",
        }
        for index in range(len(nodes) - 1)
    ]


def _clean_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()


def _slugify(value: Any) -> str:
    text = _clean_text(value).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:40]


def _infer_kind(label: str) -> str:
    lowered = label.lower()
    if any(word in lowered for word in ("ui", "frontend", "client", "page", "view")):
        return "frontend"
    if any(word in lowered for word in ("api", "backend", "server", "service", "application")):
        return "backend"
    if any(word in lowered for word in ("data", "database", "cache", "storage", "repo")):
        return "data"
    if any(word in lowered for word in ("deploy", "infra", "build", "pipeline", "hosting")):
        return "infrastructure"
    if any(word in lowered for word in ("shared", "common", "util", "model", "schema")):
        return "shared"
    return "workflow"


async def chat_about_repo(
    question: str,
    context: str,
    file_tree_str: str,
    project_types: list[str],
    file_contents: dict[str, str],
    repo_url: str,
) -> str:
    """Answer a question about the codebase."""
    files_context = ""
    for fpath, content in file_contents.items():
        files_context += f"\n\n=== {fpath} ===\n{content}"

    system_msg = f"""{CHAT_SYSTEM_PROMPT}
Repository: {repo_url}
Project type(s): {', '.join(project_types)}
File tree:
{file_tree_str}
Key file contents:
{files_context}"""

    messages = [{"role": "system", "content": system_msg}]
    if context:
        messages.append({"role": "assistant", "content": f"Here's what I know about this repo:\n{context}"})
    messages.append({"role": "user", "content": question})

    response = await _get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        temperature=0.3,
        max_tokens=2000,
    )
    return response.choices[0].message.content or "I couldn't generate a response."
