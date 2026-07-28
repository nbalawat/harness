"""Replay the slice plan's acceptance checks against the app, in order."""
import json
import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app", "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)
plan = json.load(open(json.load(open("inputs.json"))["slice_plan"]["path"]))
which = int(sys.argv[1]) if len(sys.argv) > 1 else 1
slices = plan["slices"][: which]

failures = 0
for s in slices:
    print(f"\n=== slice: {s['id']}")
    for check in s["acceptance"]:
        method, path = check["method"], check["path"]
        response = client.request(method, path, json=check.get("body"))
        body = response.text
        problems = []
        if response.status_code != check["expect_status"]:
            problems.append(f"status {response.status_code} != {check['expect_status']}")
        for needle in check.get("expect_contains", []):
            if needle.lower() not in body.lower():
                problems.append(f"missing {needle!r}")
            elif needle not in body:
                problems.append(f"(case-insensitive only) {needle!r}")
        mark = "ok " if not problems else "FAIL"
        if problems:
            failures += 1
        print(f"  {mark} {method} {path}  {'; '.join(problems)}")
        if problems:
            print(f"       body: {body[:600]}")
print(f"\n{failures} failing checks")
sys.exit(1 if failures else 0)
