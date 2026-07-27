"""Agent eval harness - executable exit criteria for the build-agents node.

Every case in evals/cases.json is derived 1:1 from an `eval_criteria` entry in
roster.json and is executed against `backend/agent_runtime.respond`.

Usage:  python3 agents/run_evals.py
Exit 0 when all cases pass; exit 1 (with a per-case failure report) otherwise.
Writes a machine-readable summary to agents/eval_results.json.
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, "..", "backend"))

from agent_runtime import respond  # noqa: E402

FLAGS = re.IGNORECASE | re.MULTILINE


def _load(path):
    with open(path) as handle:
        return json.load(handle)


def _corpus_doc_ids(filename):
    index = _load(os.path.join(BASE, filename))
    return {doc["doc_id"].lower() for doc in index["documents"]}


def check(case, reply):
    """Return the list of failure messages for one case (empty == pass)."""
    failures = []
    low = reply.lower()

    for needle in case.get("expect_contains", []):
        if needle.lower() not in low:
            failures.append("expected substring %r not found" % needle)

    for needle in case.get("expect_not_contains", []):
        if needle.lower() in low:
            failures.append("forbidden substring %r found" % needle)

    for pattern in case.get("expect_regex", []):
        if not re.search(pattern, reply, FLAGS):
            failures.append("expected regex %r did not match" % pattern)

    for pattern in case.get("expect_not_regex", []):
        found = re.search(pattern, reply, FLAGS)
        if found:
            failures.append(
                "forbidden regex %r matched %r" % (pattern, found.group(0))
            )

    kind = case.get("assert")
    if kind == "every_match_in_corpus_index":
        allowed = _corpus_doc_ids(case["corpus_index"])
        for match in re.findall(case["match_regex"], reply, FLAGS):
            if match.lower() not in allowed:
                failures.append(
                    "cited %r is not present in %s" % (match, case["corpus_index"])
                )
    elif kind == "max_matches":
        count = len(re.findall(case["match_regex"], reply, FLAGS))
        if count > case["max_matches"]:
            failures.append(
                "%d matches of %r exceeds max_matches=%d"
                % (count, case["match_regex"], case["max_matches"])
            )
    elif kind is not None:
        failures.append("unknown assert kind %r" % kind)

    return failures


def main():
    cases = _load(os.path.join(BASE, "evals", "cases.json"))["cases"]
    results = []

    for case in cases:
        try:
            reply = respond(case["input"], case.get("agent"))
        except Exception as exc:  # noqa: BLE001 - a raising agent is a failing case
            results.append({
                "id": case["id"],
                "agent": case.get("agent"),
                "pass": False,
                "failures": ["runtime raised %s: %s" % (type(exc).__name__, exc)],
                "reply": "",
            })
            continue
        failures = check(case, reply)
        results.append({
            "id": case["id"],
            "agent": case.get("agent"),
            "criterion": case.get("criterion"),
            "input": case["input"],
            "pass": not failures,
            "failures": failures,
            "reply": reply,
        })

    summary = {
        "total": len(results),
        "passed": sum(1 for r in results if r["pass"]),
        "results": results,
    }
    with open(os.path.join(BASE, "eval_results.json"), "w") as handle:
        json.dump(summary, handle, indent=2)

    if summary["passed"] < summary["total"]:
        for result in results:
            if not result["pass"]:
                print("FAIL %s" % result["id"], file=sys.stderr)
                for failure in result["failures"]:
                    print("     - %s" % failure, file=sys.stderr)
                print("     reply: %r" % result["reply"], file=sys.stderr)
        print(
            "evals: %d/%d passed" % (summary["passed"], summary["total"]),
            file=sys.stderr,
        )
        return 1

    print("evals: %d/%d passed" % (summary["passed"], summary["total"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
