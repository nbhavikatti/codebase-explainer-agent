from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from git import Repo
# Files/dirs to always skip
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".next", "dist", "build",
    ".venv", "venv", "env", ".env", ".tox", ".mypy_cache", ".pytest_cache",
    "vendor", "target", ".gradle", ".idea", ".vscode", "coverage",
    ".turbo", ".cache", ".parcel-cache", "bower_components",
}
SKIP_EXTENSIONS = {
    ".pyc", ".pyo", ".so", ".o", ".a", ".dylib", ".dll", ".exe",
    ".jar", ".class", ".woff", ".woff2", ".ttf", ".eot", ".ico",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".bmp", ".webp",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".pdf", ".zip",
    ".tar", ".gz", ".bz2", ".rar", ".7z", ".lock", ".min.js", ".min.css",
}
# Project type detection patterns
PROJECT_SIGNATURES = {
    "python": {
        "indicators": ["requirements.txt", "setup.py", "pyproject.toml", "Pipfile", "setup.cfg"],
        "entrypoints": ["main.py", "app.py", "manage.py", "run.py", "server.py", "wsgi.py", "asgi.py"],
        "config_files": ["pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "mypy.ini", ".flake8", "Pipfile"],
        "key_dirs": ["src", "app", "lib", "tests", "scripts"],
    },
    "javascript/node": {
        "indicators": ["package.json", "yarn.lock", "pnpm-lock.yaml"],
        "entrypoints": ["index.js", "index.ts", "server.js", "server.ts", "app.js", "app.ts", "main.js", "main.ts"],
        "config_files": ["package.json", "tsconfig.json", ".eslintrc.js", ".eslintrc.json", "webpack.config.js", "vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs"],
        "key_dirs": ["src", "lib", "pages", "app", "components", "api", "routes"],
    },
    "react": {
        "indicators": ["package.json"],
        "secondary_indicators": ["react", "react-dom"],
        "entrypoints": ["src/App.tsx", "src/App.jsx", "src/App.js", "src/index.tsx", "src/index.jsx", "src/main.tsx", "src/main.jsx"],
        "config_files": ["package.json", "tsconfig.json", "vite.config.ts", "next.config.js", "next.config.mjs"],
        "key_dirs": ["src", "src/components", "src/pages", "src/hooks", "src/lib", "src/utils", "public"],
    },
    "go": {
        "indicators": ["go.mod", "go.sum"],
        "entrypoints": ["main.go", "cmd/main.go"],
        "config_files": ["go.mod", "Makefile"],
        "key_dirs": ["cmd", "internal", "pkg", "api"],
    },
    "rust": {
        "indicators": ["Cargo.toml", "Cargo.lock"],
        "entrypoints": ["src/main.rs", "src/lib.rs"],
        "config_files": ["Cargo.toml"],
        "key_dirs": ["src", "tests", "benches", "examples"],
    },
    "java": {
        "indicators": ["pom.xml", "build.gradle", "build.gradle.kts"],
        "entrypoints": [],
        "config_files": ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
        "key_dirs": ["src/main/java", "src/test/java", "src/main/resources"],
    },
    "ruby": {
        "indicators": ["Gemfile", "Rakefile"],
        "entrypoints": ["app.rb", "config.ru", "bin/rails"],
        "config_files": ["Gemfile", "Rakefile", ".ruby-version"],
        "key_dirs": ["app", "lib", "config", "db", "spec", "test"],
    },
    "docker": {
        "indicators": ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"],
        "entrypoints": [],
        "config_files": ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore"],
        "key_dirs": [],
    },
}
# Files that are universally important
UNIVERSAL_FILES = [
    "README.md", "README.rst", "README.txt", "README",
    "LICENSE", "LICENSE.md", "LICENSE.txt",
    "CONTRIBUTING.md", "CHANGELOG.md",
    "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    ".github/workflows", ".gitignore",
]
def clone_repo(repo_url: str) -> str:
    """Clone a GitHub repo to a temp directory. Returns the path."""
    tmp_dir = tempfile.mkdtemp(prefix="codebase_explainer_")
    # Normalize URL
    url = repo_url.strip().rstrip("/")
    if not url.endswith(".git"):
        url = url + ".git"
    Repo.clone_from(url, tmp_dir, depth=1)
    return tmp_dir
def cleanup_repo(repo_path: str) -> None:
    """Remove the cloned repo."""
    if os.path.exists(repo_path):
        shutil.rmtree(repo_path, ignore_errors=True)
def build_file_tree(repo_path: str, max_depth: int = 6) -> list[dict]:
    """Build a file tree structure, skipping irrelevant directories."""
    tree: list[dict] = []
    root = Path(repo_path)
    for dirpath, dirnames, filenames in os.walk(repo_path):
        # Skip ignored directories
        dirnames[:] = [
            d for d in dirnames
            if d not in SKIP_DIRS and not d.startswith(".")
        ]
        rel_dir = Path(dirpath).relative_to(root)
        depth = len(rel_dir.parts)
        if depth > max_depth:
            dirnames.clear()
            continue
        for fname in filenames:
            fpath = Path(dirpath) / fname
            ext = fpath.suffix.lower()
            if ext in SKIP_EXTENSIONS:
                continue
            if fname.startswith(".") and fname not in (".env.example", ".gitignore", ".dockerignore"):
                continue
            rel_path = str(fpath.relative_to(root))
            try:
                size = fpath.stat().st_size
            except OSError:
                size = 0
            tree.append({
                "path": rel_path,
                "size": size,
                "extension": ext,
            })
    return tree
def detect_project_type(repo_path: str, file_tree: list[dict]) -> list[str]:
    """Detect the project type(s) based on file indicators."""
    file_paths = {f["path"] for f in file_tree}
    file_names = {os.path.basename(f["path"]) for f in file_tree}
    detected = []
    for project_type, sigs in PROJECT_SIGNATURES.items():
        for indicator in sigs["indicators"]:
            if indicator in file_names or indicator in file_paths:
                # Special handling for react - check package.json for react dependency
                if project_type == "react":
                    pkg_path = os.path.join(repo_path, "package.json")
                    if os.path.exists(pkg_path):
                        try:
                            with open(pkg_path) as f:
                                content = f.read()
                            if '"react"' in content:
                                detected.append(project_type)
                        except Exception:
                            pass
                else:
                    detected.append(project_type)
                break
    # Remove duplicates while preserving order
    seen = set()
    result = []
    for t in detected:
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result if result else ["unknown"]
def select_important_files(
    repo_path: str,
    file_tree: list[dict],
    project_types: list[str],
    max_files: int = 30,
) -> list[str]:
    """Intelligently select the most important files to read based on project type."""
    file_paths = {f["path"] for f in file_tree}
    selected: list[str] = []
    seen: set[str] = set()
    def add_file(path: str) -> None:
        if path in file_paths and path not in seen:
            seen.add(path)
            selected.append(path)
    def add_by_name(name: str) -> None:
        for f in file_tree:
            if os.path.basename(f["path"]) == name and f["path"] not in seen:
                seen.add(f["path"])
                selected.append(f["path"])
    # 1. Universal files first
    for uf in UNIVERSAL_FILES:
        add_file(uf)
        # Also check case-insensitive
        for f in file_tree:
            if f["path"].lower() == uf.lower():
                add_file(f["path"])
    # 2. Project-type specific files
    for ptype in project_types:
        if ptype in PROJECT_SIGNATURES:
            sigs = PROJECT_SIGNATURES[ptype]
            # Config files
            for cf in sigs.get("config_files", []):
                add_file(cf)
                add_by_name(cf)
            # Entrypoints
            for ep in sigs.get("entrypoints", []):
                add_file(ep)
                add_by_name(os.path.basename(ep))
            # Key directory index files
            for kd in sigs.get("key_dirs", []):
                for f in file_tree:
                    fdir = os.path.dirname(f["path"])
                    fname = os.path.basename(f["path"])
                    if fdir == kd and fname in (
                        "__init__.py", "index.ts", "index.js", "index.tsx",
                        "index.jsx", "mod.rs", "lib.rs", "main.go",
                    ):
                        add_file(f["path"])
    # 3. Look for CI/CD configs
    for f in file_tree:
        if ".github/workflows" in f["path"] and f["path"].endswith((".yml", ".yaml")):
            add_file(f["path"])
            break  # Just one workflow file
    # 4. Fill remaining slots with the most "important-looking" files
    # Prioritize: shorter paths (closer to root), common important names
    important_names = {
        "router", "routes", "api", "schema", "model", "models",
        "config", "settings", "types", "utils", "helpers", "middleware",
        "database", "db", "auth", "handler", "handlers", "service", "services",
        "controller", "controllers",
    }
    remaining = [
        f for f in file_tree
        if f["path"] not in seen
        and f["size"] > 0
        and f["size"] < 100_000  # Skip huge files
        and f["extension"] in (".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb", ".yml", ".yaml", ".toml", ".json", ".md")
    ]
    def file_importance(f: dict) -> tuple:
        path = f["path"]
        depth = path.count("/")
        name = os.path.splitext(os.path.basename(path))[0].lower()
        is_important = name in important_names
        return (not is_important, depth, len(path))
    remaining.sort(key=file_importance)
    for f in remaining:
        if len(selected) >= max_files:
            break
        add_file(f["path"])
    return selected
def read_file_contents(repo_path: str, file_paths: list[str], max_chars_per_file: int = 8000) -> dict[str, str]:
    """Read file contents, truncating large files."""
    contents: dict[str, str] = {}
    for fpath in file_paths:
        full_path = os.path.join(repo_path, fpath)
        if not os.path.isfile(full_path):
            continue
        try:
            with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read(max_chars_per_file)
            if len(content) == max_chars_per_file:
                content += "\n... [TRUNCATED]"
            contents[fpath] = content
        except Exception:
            contents[fpath] = "[Could not read file]"
    return contents
def format_file_tree_string(file_tree: list[dict], max_lines: int = 200) -> str:
    """Format the file tree as a readable string."""
    paths = sorted(f["path"] for f in file_tree)
    if len(paths) > max_lines:
        shown = paths[:max_lines]
        return "\n".join(shown) + f"\n... and {len(paths) - max_lines} more files"
    return "\n".join(paths)