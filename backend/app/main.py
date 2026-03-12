from __future__ import annotations

import json
import asyncio
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

from app.models import AnalyzeRequest, ChatRequest
from app.analyzer import (
    clone_repo,
    cleanup_repo,
    build_file_tree,
    detect_project_type,
    select_important_files,
    read_file_contents,
    format_file_tree_string,
)
from app.llm import generate_analysis, chat_about_repo

load_dotenv()

app = FastAPI()

# CORS - allow all origins for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store for analyzed repos (keyed by repo URL)
_repo_cache: dict[str, dict] = {}


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _analyze_stream(repo_url: str) -> AsyncGenerator[str, None]:
    """Stream analysis steps as SSE events."""
    repo_path = None
    try:
        # Step 1: Clone
        yield _sse_event("step", {"step": "cloning", "message": "Cloning repository..."})
        await asyncio.sleep(0.1)
        try:
            repo_path = await asyncio.to_thread(clone_repo, repo_url)
        except Exception as e:
            yield _sse_event("error", {"message": f"Failed to clone repository: {str(e)}"})
            return
        yield _sse_event("step", {"step": "cloning", "message": "Repository cloned successfully", "done": True})

        # Step 2: Build file tree
        yield _sse_event("step", {"step": "file_tree", "message": "Inspecting file tree..."})
        await asyncio.sleep(0.1)
        file_tree = await asyncio.to_thread(build_file_tree, repo_path)
        file_tree_str = format_file_tree_string(file_tree)
        file_count = len(file_tree)
        yield _sse_event("step", {
            "step": "file_tree",
            "message": f"Found {file_count} files",
            "done": True,
            "data": {"file_count": file_count, "tree_preview": file_tree_str[:2000]},
        })

        # Step 3: Detect project type
        yield _sse_event("step", {"step": "detect_type", "message": "Detecting project type and tech stack..."})
        await asyncio.sleep(0.1)
        project_types = await asyncio.to_thread(detect_project_type, repo_path, file_tree)
        yield _sse_event("step", {
            "step": "detect_type",
            "message": f"Detected: {', '.join(project_types)}",
            "done": True,
            "data": {"project_types": project_types},
        })

        # Step 4: Select important files
        yield _sse_event("step", {"step": "select_files", "message": "Selecting important files to analyze..."})
        await asyncio.sleep(0.1)
        important_files = await asyncio.to_thread(
            select_important_files, repo_path, file_tree, project_types
        )
        yield _sse_event("step", {
            "step": "select_files",
            "message": f"Selected {len(important_files)} key files",
            "done": True,
            "data": {"files": important_files},
        })

        # Step 5: Read file contents
        yield _sse_event("step", {"step": "read_files", "message": "Reading file contents..."})
        await asyncio.sleep(0.1)
        file_contents = await asyncio.to_thread(read_file_contents, repo_path, important_files)
        yield _sse_event("step", {
            "step": "read_files",
            "message": f"Read {len(file_contents)} files",
            "done": True,
        })

        # Step 6: LLM Analysis
        yield _sse_event("step", {"step": "llm_analysis", "message": "Generating AI analysis (this may take a moment)..."})
        await asyncio.sleep(0.1)
        analysis_json = await asyncio.to_thread(
            generate_analysis, file_tree_str, project_types, file_contents, repo_url
        )
        try:
            analysis = json.loads(analysis_json)
        except json.JSONDecodeError:
            analysis = {"error": "Failed to parse analysis", "raw": analysis_json}

        yield _sse_event("step", {
            "step": "llm_analysis",
            "message": "Analysis complete!",
            "done": True,
        })

        # Cache the analysis context for chat
        _repo_cache[repo_url] = {
            "analysis": analysis,
            "file_tree_str": file_tree_str,
            "project_types": project_types,
            "file_contents": file_contents,
        }

        # Final result
        yield _sse_event("result", {"analysis": analysis})

    except Exception as e:
        yield _sse_event("error", {"message": f"Analysis failed: {str(e)}"})
    finally:
        if repo_path:
            await asyncio.to_thread(cleanup_repo, repo_path)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(request: AnalyzeRequest):
    """Start analysis of a GitHub repo. Returns SSE stream."""
    repo_url = request.repo_url.strip()
    if not repo_url.startswith("https://github.com/"):
        raise HTTPException(status_code=400, detail="Please provide a valid public GitHub URL")

    return StreamingResponse(
        _analyze_stream(repo_url),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/chat")
async def chat(request: ChatRequest):
    """Chat about an analyzed repo."""
    repo_url = request.repo_url.strip()
    if repo_url not in _repo_cache:
        raise HTTPException(status_code=404, detail="Repository not analyzed yet. Please analyze it first.")

    cached = _repo_cache[repo_url]
    answer = await asyncio.to_thread(
        chat_about_repo,
        request.question,
        request.context,
        cached["file_tree_str"],
        cached["project_types"],
        cached["file_contents"],
        repo_url,
    )
    return {"answer": answer}


# Serve frontend static files (for combined deployment)
STATIC_DIR = Path(__file__).parent.parent / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """Serve frontend SPA - catch all non-API routes."""
        file_path = STATIC_DIR / full_path
        if file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(STATIC_DIR / "index.html"))
