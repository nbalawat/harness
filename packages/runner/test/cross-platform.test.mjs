// Cross-platform (Windows) portability guards. These lock in the fixes that let
// the harness run on cmd.exe as well as POSIX sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandEnvVars, failureSignature } from "@harness/runner";

test("expandEnvVars: $VAR and ${VAR} expand from env (POSIX-style commands work on Windows)", () => {
  const env = { HARNESS_PROJECT_DIR: "/x/pt", PORT: "8080" };
  assert.equal(
    expandEnvVars('node "$HARNESS_PROJECT_DIR/scripts/x.cjs"', env),
    'node "/x/pt/scripts/x.cjs"',
  );
  assert.equal(expandEnvVars("run --port ${PORT}", env), "run --port 8080");
});

test("expandEnvVars: %VAR% (cmd.exe-style) also expands", () => {
  assert.equal(expandEnvVars("run --port %PORT%", { PORT: "9090" }), "run --port 9090");
});

test("expandEnvVars: unknown variables are left untouched, never blanked", () => {
  assert.equal(expandEnvVars("echo $NOT_SET and ${ALSO} and %NOPE%", {}), "echo $NOT_SET and ${ALSO} and %NOPE%");
});

test("expandEnvVars: a Windows-style project dir splices into a quoted command", () => {
  const env = { HARNESS_PROJECT_DIR: "C:\\harness\\agentic-app" };
  assert.equal(
    expandEnvVars('node "$HARNESS_PROJECT_DIR/mocks/m.cjs"', env),
    'node "C:\\harness\\agentic-app/mocks/m.cjs"',
  );
});

// Doom-loop detection: the same underlying failure across retries must hash to
// the same signature even as attempt numbers, ports, paths, and hashes change.
test("failureSignature: the same failure across retries is stable", () => {
  const a = failureSignature('attempt 2 failed: [bugs] backend/x.py:41 — 0x1a2b at /tmp/harness-run-9/attempts/slice-2-2');
  const b = failureSignature('attempt 5 failed: [bugs] backend/x.py:88 — 0x9f3c at /tmp/harness-run-3/attempts/slice-2-5');
  assert.equal(a, b, "attempt#, line#, hex, and volatile paths are normalized away");
});

test("failureSignature: genuinely different failures differ", () => {
  const a = failureSignature("acceptance check GET /cases expected 200 got 401");
  const b = failureSignature("merge conflict in frontend/app.js");
  assert.notEqual(a, b);
});
