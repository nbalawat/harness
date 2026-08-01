"""cost-meter module: app-level spend observation. See agent-guide."""
import time

from db import store

PRICES_PER_MTOK = {
    "claude-opus-5": {"in": 5.0, "out": 25.0},
    "claude-sonnet-5": {"in": 3.0, "out": 15.0},
    "claude-haiku-4-5": {"in": 1.0, "out": 5.0},
}


def record(model, in_tokens, out_tokens):
    prices = PRICES_PER_MTOK.get(model, {"in": 0.0, "out": 0.0})
    usd = (in_tokens * prices["in"] + out_tokens * prices["out"]) / 1_000_000
    return store.insert("_llm_costs", {"day": time.strftime("%Y-%m-%d", time.gmtime()), "model": model, "usd": round(usd, 6)})


def totals():
    out = {}
    for row in store.list("_llm_costs"):
        key = (row["day"], row["model"])
        out[key] = round(out.get(key, 0) + row["usd"], 6)
    return [{"day": d, "model": m, "usd": v} for (d, m), v in sorted(out.items())]
