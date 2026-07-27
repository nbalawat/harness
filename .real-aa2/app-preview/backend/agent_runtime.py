"""agent-runtime module (v0): deterministic stub honoring the roster contract.

respond() is the single entry point the rest of the app may call. The Claude
Agent SDK implementation replaces this file with the same signature; evals in
agents/ run against whichever implementation is composed.
"""
import json
import os


def _roster():
    roster_path = os.path.join(os.path.dirname(__file__), "..", "agents", "roster.json")
    with open(roster_path) as f:
        return json.load(f)


def respond(message: str) -> str:
    agent = _roster()["agents"][0]
    return f"[{agent['name']}] I can help with that: {message}"
