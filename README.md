Currently live at: https://codebase-explainer-agent-production.up.railway.app/

# Codebase Explainer Agent

An AI-powered web app that analyzes public GitHub repositories and generates comprehensive explanations of their codebase. Submit a repo URL, watch real-time progress as the AI clones and analyzes it, then explore a detailed breakdown of the project's architecture, tech stack, key files, and more. You can also ask follow-up questions through an interactive chat interface.

## Tech Stack

**Backend:** Python, FastAPI, OpenAI API (gpt-4o-mini), Uvicorn<br>
**Frontend:** React, TypeScript, Vite, Tailwind CSS<br>
**Deployment:** Cloudflare Pages (frontend) + Render (backend); Nixpacks/Procfile also present

## Project Structure

```
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI app, API endpoints (/analyze, /chat, /healthz)
│   │   ├── analyzer.py      # Repo cloning, file tree building, project type detection
│   │   ├── llm.py           # OpenAI API integration
│   │   └── models.py        # Pydantic request/response models
│   ├── static/              # Frontend production build output
│   ├── requirements.txt
│   ├── Procfile
│   └── nixpacks.toml
├── frontend/
│   ├── src/
│   │   ├── App.tsx          # Main UI component with state management and API calls
│   │   ├── main.tsx         # React entry point
│   │   └── index.css        # Global styles and Tailwind config
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── package.json
```

## How It Works

1. User submits a public GitHub repo URL
2. Backend downloads the repo as a ZIP, extracts it, and builds a file tree
3. Project types are detected (Python, JS, Go, Rust, etc.) based on indicator files
4. Up to 30 important files are selected using smart prioritization
5. File contents and metadata are sent to OpenAI's gpt-4o-mini for analysis
6. Progress updates stream to the frontend via Server-Sent Events (SSE)
7. Results are displayed in a tabbed interface (Summary, Architecture, Key Files, Reading Order, How It Works)
8. Users can ask follow-up questions via the chat endpoint, which uses cached analysis context

## Setup

### Prerequisites

- Python 3.11+
- Node.js
- OpenAI API key

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export OPENAI_API_KEY="your-key-here"
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # Dev server on port 5173
npm run build      # Production build → backend/static/
```

In development, the Vite dev server proxies API requests to the backend on port 8000.

For production, build the frontend and run only the backend — it serves the static files directly.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI API key (set in env or `backend/.env`) |
| `PORT` | No | Server port (defaults to 8000) |
| `VITE_API_URL` | No | Backend origin for the frontend. Empty in dev (Vite proxies to `:8000`); set to the Render URL for the Cloudflare Pages build |

## Deployment

The app is split across two free tiers: the static frontend on Cloudflare Pages
(always warm, so the page loads instantly) and the FastAPI backend on a Render
free web service.

The backend must run as a single persistent process — `_repo_cache` and the rate
limiter both live in memory, and `/analyze` holds an SSE stream open for up to
three minutes. Serverless function platforms won't work for it.

### Backend (Render)

`render.yaml` is a Blueprint — point Render at this repo and it picks up the
build/start commands, Python version, and health check path. Set `OPENAI_API_KEY`
in the dashboard; it's deliberately marked `sync: false` so the key never lands
in git.

Free instances spin down after 15 minutes of inactivity and take roughly a minute
to wake. The frontend handles this: it pings `/healthz` first and shows wake-up
progress before starting the analysis.

### Frontend (Cloudflare Pages)

| Setting | Value |
|---|---|
| Root directory | *(repo root)* |
| Build command | `npm --prefix frontend ci && npm --prefix frontend run build` |
| Output directory | `backend/static` |
| Env var | `VITE_API_URL` = the Render service URL |

The output directory looks odd but is intentional — Vite already builds into
`backend/static` (see `vite.config.ts`), so the same build both deploys to Pages
and stays committed as a fallback the Render service can serve on its own.
`VITE_API_URL` is baked in at build time, so changing it requires a redeploy.
`public/_redirects` gives Pages the SPA fallback.
