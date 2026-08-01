"""Triage — an AI support-ticket board.

Submit a ticket; an AI agent classifies it (category, priority) and drafts a
first response; the board tracks it through New -> In progress -> Resolved.
The AI ASSISTS — a human always owns the status transition and the reply.

Built from certified harness modules: agent_runtime (agent-runtime) + db
(persistence-core). Deterministic fallback classifier keeps it useful offline.
"""
import json
import os
import re

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import agent_runtime
from db import store

app = FastAPI(title="Triage")
_BASE = os.path.dirname(os.path.abspath(__file__))
_FRONTEND = os.path.join(_BASE, "..", "frontend")

CATEGORIES = ["Bug", "Question", "Feature request", "Billing"]
PRIORITIES = ["Low", "Medium", "High", "Urgent"]
STATUSES = ["New", "In progress", "Resolved"]

_SEED = [
    ("Login page returns 500 after the latest deploy", "Since this morning I get a server error when I try to log in from Chrome. Incognito has the same problem. This is blocking my whole team."),
    ("Can I export my dashboard to PDF?", "I'd like to email a snapshot of my dashboard to a client every week. Is there an export option somewhere?"),
    ("Invoice charged twice this month", "My card was charged $49 twice on the 3rd. I only have one subscription. Please refund the duplicate."),
]


def _classify(title: str, body: str) -> dict:
    text = f"{title}\n{body}"
    prompt = (
        "You are a support triage assistant. Classify the ticket and draft a brief, "
        "friendly first response. Respond with ONLY a JSON object, no prose, with keys: "
        'category (one of ["Bug","Question","Feature request","Billing"]), '
        'priority (one of ["Low","Medium","High","Urgent"]), '
        'summary (one short sentence), suggested_reply (2-3 sentences the agent could send).\n\n'
        f"Ticket:\n{text}\n\nJSON:"
    )
    try:
        raw = agent_runtime.respond(prompt)
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        data = json.loads(m.group(0)) if m else {}
        cat = data.get("category") if data.get("category") in CATEGORIES else _fallback_category(text)
        pri = data.get("priority") if data.get("priority") in PRIORITIES else _fallback_priority(text)
        return {
            "category": cat,
            "priority": pri,
            "summary": (data.get("summary") or title)[:200],
            "suggested_reply": (data.get("suggested_reply") or "Thanks for reaching out — we're looking into this and will follow up shortly.")[:600],
            "by": agent_runtime.mode()["mode"],
        }
    except Exception:
        return _fallback(title, text)


def _fallback_category(text: str) -> str:
    t = text.lower()
    if any(w in t for w in ("error", "500", "crash", "broken", "fail", "bug")):
        return "Bug"
    if any(w in t for w in ("charge", "invoice", "refund", "billing", "payment", "$")):
        return "Billing"
    if any(w in t for w in ("can i", "could you add", "feature", "would like", "request", "support for")):
        return "Feature request"
    return "Question"


def _fallback_priority(text: str) -> str:
    t = text.lower()
    if any(w in t for w in ("blocking", "urgent", "asap", "down", "can't log", "cannot log", "charged twice")):
        return "Urgent"
    if any(w in t for w in ("error", "500", "refund", "broken")):
        return "High"
    return "Medium"


def _fallback(title: str, text: str) -> dict:
    return {
        "category": _fallback_category(text),
        "priority": _fallback_priority(text),
        "summary": title[:200],
        "suggested_reply": "Thanks for reaching out — we've received your ticket and a specialist will follow up shortly.",
        "by": "offline",
    }


def _seed_once():
    if store.list("tickets"):
        return
    for title, body in _SEED:
        tri = _fallback(title, f"{title}\n{body}")  # instant deterministic seed; new tickets use the live agent
        store.insert("tickets", {
            "title": title, "body": body, "status": "New",
            "category": tri["category"], "priority": tri["priority"],
            "summary": tri["summary"], "suggested_reply": tri["suggested_reply"],
            "triaged_by": tri["by"], "notes": [],
        })


class NewTicket(BaseModel):
    title: str = Field(min_length=3, max_length=140)
    body: str = Field(min_length=1, max_length=4000)


class StatusChange(BaseModel):
    status: str


class Note(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


@app.get("/health")
def health():
    _seed_once()
    return {"status": "ok"}


@app.get("/agent/mode")
def mode():
    return agent_runtime.mode()


@app.get("/api/board")
def board():
    _seed_once()
    tickets = store.list("tickets")
    cols = {s: [] for s in STATUSES}
    for t in tickets:
        cols.get(t.get("status", "New"), cols["New"]).append(t)
    counts = {
        "total": len(tickets),
        "urgent": sum(1 for t in tickets if t.get("priority") == "Urgent"),
        "open": sum(1 for t in tickets if t.get("status") != "Resolved"),
    }
    return {"columns": [{"status": s, "tickets": list(reversed(cols[s]))} for s in STATUSES], "counts": counts}


@app.post("/api/tickets", status_code=201)
def create_ticket(req: NewTicket):
    tri = _classify(req.title, req.body)
    row = store.insert("tickets", {
        "title": req.title, "body": req.body, "status": "New",
        "category": tri["category"], "priority": tri["priority"],
        "summary": tri["summary"], "suggested_reply": tri["suggested_reply"],
        "triaged_by": tri["by"], "notes": [],
    })
    return row


def _ticket_or_404(ticket_id: int):
    for t in store.list("tickets"):
        if t["id"] == ticket_id:
            return t
    raise HTTPException(status_code=404, detail="no such ticket")


@app.post("/api/tickets/{ticket_id}/status")
def set_status(ticket_id: int, req: StatusChange):
    if req.status not in STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of {STATUSES}")
    t = _ticket_or_404(ticket_id)
    t["status"] = req.status
    return t


@app.post("/api/tickets/{ticket_id}/notes")
def add_note(ticket_id: int, req: Note):
    t = _ticket_or_404(ticket_id)
    t.setdefault("notes", []).append(req.text)
    return t


@app.get("/")
def index():
    return FileResponse(os.path.join(_FRONTEND, "index.html"))


@app.get("/app.js")
def appjs():
    return FileResponse(os.path.join(_FRONTEND, "app.js"))
