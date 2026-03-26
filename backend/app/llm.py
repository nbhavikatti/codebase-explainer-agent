from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

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
  "architecture_overview": {
    "pattern": "ONE OF: dependency-tree, parallel-lanes, service-map, hub-and-spokes",
    "nodes": [
      {"id": "relative/file/path.ext", "label": "Short display name", "description": "What this file/module does", "group": "group-id"}
    ],
    "edges": [
      {"source": "relative/file/path.ext", "target": "other/file.ext"}
    ],
    "groups": [
      {"id": "group-id", "label": "Human-readable group name"}
    ]
  },
  "top_important_files": [
    {"path": "file/path.ext", "description": "Why this file is important"}
  ],
  "reading_order": [
    {"step": 1, "path": "file/path.ext", "reason": "Why read this first"}
  ],
  "how_it_works": "A detailed explanation of how the codebase works, covering the main flows and key components",
  "key_concepts": ["Important concept 1", "Important concept 2"]
}
For tech_stack, label each technology with its role in parentheses: (frontend), (backend), (full-stack), (database), (tooling), or (devops) as appropriate.
For architecture_overview:
First, classify the repo into exactly one pattern:
- "dependency-tree": A single cohesive system (e.g. a web app, a CLI tool, a library). Show the file-level import/dependency tree.
- "parallel-lanes": Multiple independent implementations of similar things (e.g. same service in Go + TypeScript, multiple language SDKs). Show parallel lanes, one per implementation.
- "service-map": A monorepo with multiple services or packages (e.g. packages/, services/, apps/ directories). Show a service/package-level map with key files within each.
- "hub-and-spokes": A plugin/extension ecosystem with a core and plugins (e.g. a framework with middleware, a tool with plugins). Show the core hub with spokes radiating out.

Then build the graph:
- ONLY use file paths that appear in the provided file tree. Never invent or guess file paths.
- Each node id MUST be an exact path from the file tree.
- Include 8-20 runtime-critical source files as nodes. EXCLUDE tests, docs, examples/samples, config files, lock files, CI/CD.
- Do NOT include multiple nodes for the same logical component. For example, if a module has both __init__.py and a core implementation file, pick only the one with the most meaningful code. Each node should represent a distinct responsibility.
- Assign each node a "group" matching a group id. Groups represent logical clusters (e.g. "frontend", "api", "core", "auth-service", "plugin-stripe").
- For "dependency-tree": groups are architectural layers (e.g. "entrypoints", "routes", "models", "utils").
- For "parallel-lanes": each group is one lane/implementation (e.g. "go-sdk", "typescript-sdk").
- For "service-map": each group is a service or package (e.g. "api-gateway", "user-service", "shared-lib").
- For "hub-and-spokes": one group for the hub (e.g. "core"), and one group per spoke (e.g. "plugin-auth", "plugin-billing").
- Edges represent real imports/dependencies visible in the file contents.
- Every node MUST have a group. Every group in the groups array MUST be referenced by at least one node.
Be specific and reference actual file names and code patterns you see. Do not make up files that don't exist.
CRITICAL: Base your analysis ONLY on the file tree and file contents provided. Do NOT use any prior knowledge you may have about this repository from your training data. If something is not visible in the provided files, it does not exist for the purposes of this analysis."""

CHAT_SYSTEM_PROMPT = """You are an expert software engineer helping a user understand a codebase.
You have analyzed a GitHub repository and have context about its structure and contents.
Answer the user's questions concisely and accurately based on the codebase context provided.
Reference specific files and code when relevant. If you're unsure about something, say so."""


async def generate_analysis(
    file_tree_str: str,
    project_types: list[str],
    file_contents: dict[str, str],
) -> str:
    """Generate a comprehensive analysis of the codebase using the LLM."""
    files_context = ""
    for fpath, content in file_contents.items():
        files_context += f"\n\n=== {fpath} ===\n{content}"

    user_prompt = f"""Analyze this repository.
Detected project type(s): {', '.join(project_types)}

IMPORTANT: Base your ENTIRE analysis strictly on the file tree and file contents provided below. Do NOT use any prior knowledge about this repository. Only reference files, components, and technologies that are explicitly present in the provided data.

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
        max_tokens=8000,
        response_format={"type": "json_object"},
    )
    return response.choices[0].message.content or "{}"


async def chat_about_repo(
    question: str,
    context: str,
    file_tree_str: str,
    project_types: list[str],
    file_contents: dict[str, str],
) -> str:
    """Answer a question about the codebase."""
    files_context = ""
    for fpath, content in file_contents.items():
        files_context += f"\n\n=== {fpath} ===\n{content}"

    system_msg = f"""{CHAT_SYSTEM_PROMPT}
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
