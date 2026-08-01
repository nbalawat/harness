"""Agent eval harness — executable exit criteria for the build-agents node."""
import json
import os
import sys

os.environ.setdefault("HARNESS_AGENT_MODE", "stub")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from agent_runtime import respond  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(BASE, "evals", "cases.json")) as f:
    cases = json.load(f)["cases"]

results = []
for case in cases:
    reply = respond(case["input"])
    ok = all(expected.lower() in reply.lower() for expected in case["expect_contains"])
    results.append({"id": case["id"], "pass": ok, "reply": reply})

summary = {"total": len(results), "passed": sum(r["pass"] for r in results), "results": results}
with open(os.path.join(BASE, "eval_results.json"), "w") as f:
    json.dump(summary, f, indent=2)

if summary["passed"] < summary["total"]:
    print(f"evals: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
    sys.exit(1)
print(f"evals: {summary['passed']}/{summary['total']} passed")
