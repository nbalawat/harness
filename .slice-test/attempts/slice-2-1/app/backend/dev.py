"""Local dev server — one process, no Docker: API + frontend together.

Run from backend/:  uv run --with fastapi --with uvicorn uvicorn dev:app --port 8000
Then open http://localhost:8000
"""
import os

from fastapi.staticfiles import StaticFiles

from main import app

frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
