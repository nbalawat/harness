# Apps produced from the harness substrate

Two complete, genuinely usable applications assembled from the harness's
certified modules (agent-runtime, persistence-core, rag-core) with polished,
production-grade frontends. Both run live against Claude via your existing
login (agent-runtime auto-detects live-cli / live-api / offline).

## ask-docs — grounded knowledge assistant
Ask questions about a knowledge base; get concise answers grounded in the exact
source passages, with citations and searchable history.
    cd apps/ask-docs/backend && uv run --with fastapi --with uvicorn uvicorn main:app --port 8901
Open http://127.0.0.1:8901

## triage — AI support-ticket board
Submit a ticket; an AI agent classifies it (category + priority), summarizes it,
and drafts a first reply. A kanban board tracks New -> In progress -> Resolved,
with a human owning every status transition.
    cd apps/triage/backend && uv run --with fastapi --with uvicorn uvicorn main:app --port 8902
Open http://127.0.0.1:8902
