"""eval-harness module: rubric-based agent evals. See agent-guide."""
import re


def run_case(case, respond_fn):
    reply = respond_fn(case["input"])
    checks = []
    for needle in case.get("expect_contains", []):
        checks.append({"check": f"contains '{needle}'", "ok": needle.lower() in reply.lower()})
    for needle in case.get("expect_not_contains", []):
        checks.append({"check": f"not contains '{needle}'", "ok": needle.lower() not in reply.lower()})
    for pattern in case.get("expect_regex", []):
        checks.append({"check": f"matches /{pattern}/", "ok": re.search(pattern, reply) is not None})
    return {"id": case["id"], "ok": all(c["ok"] for c in checks), "checks": checks, "reply": reply[:300]}


def run_cases(cases, respond_fn):
    results = [run_case(c, respond_fn) for c in cases]
    return {"total": len(results), "passed": sum(1 for r in results if r["ok"]), "results": results}
