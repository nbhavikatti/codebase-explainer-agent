from __future__ import annotations

import json
import asyncio
import time
from collections import defaultdict
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

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

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_repo_cache: dict[str, dict] = {}

# --- Rate limiting ---
_rate_limits: dict[str, dict] = {
    "/analyze": {"max_requests": 8, "window_seconds": 600},
    "/chat": {"max_requests": 30, "window_seconds": 600},
}
_request_log: dict[str, list[float]] = defaultdict(list)

_RATE_LIMIT_MSG = "Rate limit reached. Please wait a few minutes and try again."


def _check_rate_limit(ip: str, endpoint: str) -> None:
    config = _rate_limits.get(endpoint)
    if not config:
        return
    key = f"{ip}:{endpoint}"
    now = time.time()
    cutoff = now - config["window_seconds"]
    # Prune old entries
    _request_log[key] = [t for t in _request_log[key] if t > cutoff]
    if len(_request_log[key]) >= config["max_requests"]:
        raise HTTPException(status_code=429, detail=_RATE_LIMIT_MSG)
    _request_log[key].append(now)


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


async def _analyze_stream(repo_url: str) -> AsyncGenerator[str, None]:
    """Stream analysis steps as SSE events, with keepalive pings for long steps."""
    queue: asyncio.Queue = asyncio.Queue()

    async def worker():
        repo_path = None
        try:
            await queue.put(_sse_event("step", {"step": "cloning", "message": "Cloning repository..."}))
            try:
                repo_path = await asyncio.to_thread(clone_repo, repo_url)
            except Exception as e:
                await queue.put(_sse_event("error", {"message": f"Failed to clone repository: {type(e).__name__}: {str(e)}"}))
                return
            await queue.put(_sse_event("step", {"step": "cloning", "message": "Repository cloned successfully", "done": True}))

            await queue.put(_sse_event("step", {"step": "file_tree", "message": "Inspecting file tree..."}))
            file_tree = await asyncio.to_thread(build_file_tree, repo_path)
            file_tree_str = format_file_tree_string(file_tree)
            file_count = len(file_tree)
            await queue.put(_sse_event("step", {
                "step": "file_tree",
                "message": f"Found {file_count} files",
                "done": True,
                "data": {"file_count": file_count, "tree_preview": file_tree_str[:2000]},
            }))

            await queue.put(_sse_event("step", {"step": "detect_type", "message": "Detecting project type and tech stack..."}))
            project_types = await asyncio.to_thread(detect_project_type, repo_path, file_tree)
            await queue.put(_sse_event("step", {
                "step": "detect_type",
                "message": f"Detected: {', '.join(project_types)}",
                "done": True,
                "data": {"project_types": project_types},
            }))

            await queue.put(_sse_event("step", {"step": "select_files", "message": "Selecting important files to analyze..."}))
            important_files = await asyncio.to_thread(select_important_files, repo_path, file_tree, project_types)
            await queue.put(_sse_event("step", {
                "step": "select_files",
                "message": f"Selected {len(important_files)} key files",
                "done": True,
                "data": {"files": important_files},
            }))

            await queue.put(_sse_event("step", {"step": "read_files", "message": "Reading file contents..."}))
            file_contents = await asyncio.to_thread(read_file_contents, repo_path, important_files)
            await queue.put(_sse_event("step", {
                "step": "read_files",
                "message": f"Read {len(file_contents)} files",
                "done": True,
            }))

            await queue.put(_sse_event("step", {"step": "llm_analysis", "message": "Generating AI analysis (this may take a moment)..."}))
            try:
                analysis_json = await asyncio.wait_for(
                    generate_analysis(file_tree_str, project_types, file_contents, repo_url),
                    timeout=180,
                )
            except asyncio.TimeoutError:
                await queue.put(_sse_event("error", {"message": "AI analysis timed out. Try a smaller repo or increase the server timeout."}))
                return
            try:
                analysis = json.loads(analysis_json)
            except json.JSONDecodeError:
                analysis = {"error": "Failed to parse analysis", "raw": analysis_json}

            await queue.put(_sse_event("step", {"step": "llm_analysis", "message": "Analysis complete!", "done": True}))

            _repo_cache[repo_url] = {
                "analysis": analysis,
                "file_tree_str": file_tree_str,
                "project_types": project_types,
                "file_contents": file_contents,
            }

            await queue.put(_sse_event("result", {"analysis": analysis}))

        except Exception as e:
            await queue.put(_sse_event("error", {"message": f"Analysis failed: {type(e).__name__}: {str(e)}"}))
        finally:
            if repo_path:
                await asyncio.to_thread(cleanup_repo, repo_path)
            await queue.put(None)  # sentinel

    async def pinger():
        """Send a keepalive comment every 8 seconds to prevent proxy timeouts."""
        while True:
            await asyncio.sleep(8)
            await queue.put(": ping\n\n")

    pinger_task = asyncio.ensure_future(pinger())
    worker_task = asyncio.ensure_future(worker())

    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        pinger_task.cancel()
        worker_task.cancel()


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.post("/analyze")
async def analyze(request: AnalyzeRequest, req: Request):
    _check_rate_limit(req.client.host if req.client else "unknown", "/analyze")
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
async def chat(request: ChatRequest, req: Request):
    _check_rate_limit(req.client.host if req.client else "unknown", "/chat")
    repo_url = request.repo_url.strip()
    if repo_url not in _repo_cache:
        raise HTTPException(status_code=404, detail="Repository not analyzed yet. Please analyze it first.")

    cached = _repo_cache[repo_url]
    answer = await chat_about_repo(
        request.question,
        request.context,
        cached["file_tree_str"],
        cached["project_types"],
        cached["file_contents"],
        repo_url,
    )
    return {"answer": answer}


# Serve frontend static files
STATIC_DIR = Path(__file__).parent.parent / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        file_path = STATIC_DIR / full_path
        if file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(STATIC_DIR / "index.html"))
