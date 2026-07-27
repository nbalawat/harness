"""Agent eval harness - executable exit criteria for the build-agents node.

Runs every case in evals/cases.json against agent_runtime.respond and fails the
build if any check fails. Cases are derived 1:1 from the eval_criteria of the
approved roster, so a green run means the roster's stated behaviour is real.

    python3 agents/run_evals.py            # all cases
    python3 agents/run_evals.py -v         # print every reply
    python3 agents/run_evals.py password   # only cases whose id/agent matches

All matching is case-insensitive and multiline (^ and $ bind to lines), per
roster conventions.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from agent_runtime import respond  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
FLAGS = re.IGNORECASE | re.MULTILINE


def load_json(name):
    with open(os.path.join(BASE, name)) as f:
        return json.load(f)


def corpus_ids(path):
    """Every identifier the corpus index legitimately declares."""
    index = load_json(path)
    ids = set()
    for key in ("documents", "sources", "claims"):
        for entry in index.get(key, []) or []:
            if isinstance(entry, dict) and "id" in entry:
                ids.add(entry["id"].lower())
    return ids


def check(case, reply):
    """Return the list of failure messages for one case (empty means pass)."""
    failures = []

    for needle in case.get("expect_contains", []):
        if needle.lower() not in reply.lower():
            failures.append(f"expect_contains {needle!r}: not found")

    for needle in case.get("expect_not_contains", []):
        if needle.lower() in reply.lower():
            failures.append(f"expect_not_contains {needle!r}: found")

    for pattern in case.get("expect_regex", []):
        if not re.search(pattern, reply, FLAGS):
            failures.append(f"expect_regex /{pattern}/: no match")

    for pattern in case.get("expect_not_regex", []):
        hit = re.search(pattern, reply, FLAGS)
        if hit:
            failures.append(f"expect_not_regex /{pattern}/: matched {hit.group(0)!r}")

    assertion = case.get("assert")

    if assertion == "max_matches":
        matches = re.findall(case["match_regex"], reply, FLAGS)
        if len(matches) > case["max_matches"]:
            failures.append(
                f"max_matches /{case['match_regex']}/: {len(matches)} > {case['max_matches']}"
            )

    elif assertion == "every_match_in_corpus_index":
        known = corpus_ids(case.get("corpus_index", "corpus_index.json"))
        for match in re.findall(case["match_regex"], reply, FLAGS):
            if match.lower() not in known:
                failures.append(
                    f"every_match_in_corpus_index: {match!r} is not in "
                    f"{case.get('corpus_index', 'corpus_index.json')}"
                )

    elif assertion:
        failures.append(f"unknown assert {assertion!r}")

    return failures


def main():
    argv = [a for a in sys.argv[1:] if a not in ("-v", "--verbose")]
    verbose = len(argv) != len(sys.argv[1:])
    needle = argv[0].lower() if argv else None

    cases = load_json(os.path.join("evals", "cases.json"))["cases"]
    results = []

    for case in cases:
        key = f"{case.get('agent', 'default')}.{case['id']}"
        if needle and needle not in key.lower():
            continue

        try:
            reply = respond(case["input"], agent=case.get("agent"))
            failures = check(case, reply)
        except Exception as exc:  # a raised tool/policy error is a failed case
            reply, failures = "", [f"{type(exc).__name__}: {exc}"]

        results.append(
            {
                "case": key,
                "id": case["id"],
                "agent": case.get("agent"),
                "requirements": case.get("requirements", []),
                "input": case["input"],
                "pass": not failures,
                "failures": failures,
                "reply": reply,
            }
        )

        status = "PASS" if not failures else "FAIL"
        print(f"{status}  {key}")
        for failure in failures:
            print(f"        {failure}")
        if verbose:
            print("        " + reply.replace("\n", "\n        ") + "\n")

    passed = sum(r["pass"] for r in results)
    summary = {
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "requirements_covered": sorted(
            {req for r in results if r["pass"] for req in r["requirements"]}
        ),
        "results": results,
    }
    with open(os.path.join(BASE, "eval_results.json"), "w") as f:
        json.dump(summary, f, indent=2)

    line = f"evals: {passed}/{len(results)} passed"
    if passed < len(results):
        print(line, file=sys.stderr)
        return 1
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
