from __future__ import annotations

import os
from typing import Optional

from openai import AsyncOpenAI
from dotenv import load_dotenv

load_dotenv()

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _client


ANALYSIS_SYSTEM_PROMPT = """You are an expert software engineer who analyzes codebases.
You will be given information about a GitHub repository including its file tree, detected tech stack, and contents of key files.
Your job is to produce a comprehensive but concise analysis of the codebase.
Respond in valid JSON with this exact structure:
{
  "project_summary": "A 2-3 paragraph summary of what this project is and does",
  "tech_stack": ["list", "of", "technologies", "and", "frameworks"],
  "architecture_overview": "A description of the project architecture and how components fit together",
  "top_important_files": [
    {"path": "file/path.ext", "description": "Why this file is important"}
  ],
  "reading_order": [
    {"step": 1, "path": "file/path.ext", "reason": "Why read this first"}
  ],
  "how_it_works": "A detailed explanation of how the codebase works, covering the main flows and key components",
  "key_concepts": ["Important concept 1", "Important concept 2"]
}
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
