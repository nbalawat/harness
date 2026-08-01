"""Ask Docs — a grounded knowledge assistant.

Real, usable app assembled from certified harness modules:
  rag.py (rag-core: tf-idf retrieval)  +  agent_runtime.py (agent-runtime:
  live-cli / live-api / stub)  +  db.py (persistence-core: history).

The answer is ALWAYS grounded: we retrieve the most relevant handbook passages,
give ONLY those to the model, and return the answer with the exact sources it
drew from. No retrieval hit -> we say so honestly rather than inventing.
"""
import glob
import json
import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import agent_runtime
from db import store
from rag import Index

app = FastAPI(title="Ask Docs")
_BASE = os.path.dirname(os.path.abspath(__file__))
_FRONTEND = os.path.join(_BASE, "..", "frontend")

# --- Build the retrieval index from the knowledge/ corpus at startup ---------
_index = Index()
_SOURCES = []
for path in sorted(glob.glob(os.path.join(_BASE, "..", "knowledge", "*.md"))):
    title = os.path.basename(path)
    text = open(path, encoding="utf-8").read()
    # index each section separately so a source cites the actual heading
    section, body = title, ""
    for line in text.splitlines():
        if line.startswith("## "):
            if body.strip():
                _index.add(section, body)
                _SOURCES.append(section)
            section, body = line[3:].strip(), ""
        else:
            body += line + "\n"
    if body.strip():
        _index.add(section, body)
        _SOURCES.append(section)


class Ask(BaseModel):
    message: str = Field(min_length=1, max_length=1000)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/agent/mode")
def agent_mode():
    return agent_runtime.mode()


@app.get("/api/sources")
def sources():
    return {"count": len(_SOURCES), "sections": _SOURCES}


@app.post("/chat")
def chat(req: Ask):
    hits = _index.retrieve(req.message, k=3)
    if not hits:
        reply = (
            "I couldn't find anything about that in the Northwind handbook. "
            "Try asking about PTO, remote work, expenses, benefits, parental leave, "
            "security, or performance reviews — or rephrase your question."
        )
        row = store.insert("conversations", {"question": req.message, "answer": reply, "sources": []})
        return {"reply": reply, "sources": [], "grounded": False, "id": row["id"]}

    # Ground the model in ONLY the retrieved passages.
    context = "\n\n".join(f"[{h['doc_id']}]\n{h['text']}" for h in hits)
    prompt = (
        "You are a precise, friendly assistant for Northwind Software employees. "
        "Answer the question using ONLY the handbook passages provided. Be concise "
        "and direct — 1 to 3 sentences, plain language, no preamble. If the passages "
        "don't fully answer it, say what you do know and suggest who to ask. Never "
        "invent policy.\n\n"
        f"Handbook passages:\n{context}\n\nQuestion: {req.message}\n\nAnswer:"
    )
    reply = agent_runtime.respond(prompt).strip()
    # Only cite sources that are genuinely relevant: within 45% of the top
    # hit's score. Avoids noise chips (e.g. "Security" showing up for a PTO
    # question just because it was the 3rd-best of three).
    top = hits[0]["score"] or 1
    seen, srcs = set(), []
    for h in hits:
        if h["doc_id"] in seen or h["score"] < 0.45 * top:
            continue
        seen.add(h["doc_id"])
        srcs.append({"section": h["doc_id"], "score": h["score"]})
    row = store.insert("conversations", {"question": req.message, "answer": reply, "sources": [s["section"] for s in srcs]})
    return {"reply": reply, "sources": srcs, "grounded": True, "id": row["id"]}


@app.get("/api/conversations")
def conversations():
    rows = store.list("conversations")
    return list(reversed(rows))[:50]


@app.get("/")
def index():
    return FileResponse(os.path.join(_FRONTEND, "index.html"))


@app.get("/app.js")
def appjs():
    return FileResponse(os.path.join(_FRONTEND, "app.js"))
