// THE NON-REPEAT GUARANTEE.
// Every failure CLASS that ever cost a remediation wave is locked here: an
// adversarial fixture that WOULD trigger the bug, asserted to be caught by the
// gate that now prevents it — at the EARLIEST, cheapest stage (plan/build/
// merge), never a live wave. If a gate stops catching its class, this fails
// and the regression is caught in CI, not in a $30 wave. Add a row here for
// every lesson `harness lessons` promotes. See docs/IMPROVEMENT-LOOP.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PT = path.join(REPO, "project-types", "agentic-app");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-reg-"));
const runScript = (script, dir, env = {}) =>
  spawnSync("node", [path.join(PT, "scripts", script)], { cwd: dir, encoding: "utf8", env: { ...process.env, HARNESS_PROJECT_DIR: PT, HARNESS_WORKSPACE: dir, ...env } });

function app(files) {
  const dir = tmp();
  const appDir = path.join(dir, "app");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ app: { path: appDir } }));
  return { dir, appDir };
}

// --- security-scan: the authz classes that cost waves 2, 4, 6, 7 -----------

test("GUARANTEE opt-out-authz — a build-time gate catches the wave-2/6/7 class", () => {
  const { dir } = app({ "backend/ext_x.py": "def read(acting_user_email=None):\n    if acting_user_email:\n        scope()\n    return rows()\n" });
  runScript("security-scan.cjs", dir);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "security_report.json"), "utf8"));
  assert.ok(rep.findings.some((f) => f.rule === "opt-out-authz"), "the `if acting_user_email:` anonymous-bypass pattern must be flagged");
});

test("GUARANTEE opt-out-authz does NOT false-positive on prose", () => {
  const { dir } = app({ "backend/ext_x.py": '"""Never guard behind `if acting_user_email:` — always fail closed."""\ndef read(acting_user_email):\n    require_actor(acting_user_email)\n    return rows()\n' });
  runScript("security-scan.cjs", dir);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "security_report.json"), "utf8"));
  assert.ok(!rep.findings.some((f) => f.rule === "opt-out-authz"), "a comment discussing the pattern must not self-flag");
});

test("GUARANTEE unauthenticated-mutation — a mutating slice route without identity BLOCKS", () => {
  const { dir } = app({ "backend/ext_x.py": '@router.post("/approve")\ndef approve(item_id: int):\n    return do_it(item_id)\n' });
  const r = runScript("security-scan.cjs", dir);
  assert.equal(r.status, 1, "a POST handler with no identity token is a HIGH block");
  assert.match(r.stderr, /unauthenticated-mutation/);
});

test("GUARANTEE generic-table-write-unguarded — the /api/{table} class that started it all BLOCKS", () => {
  const { dir } = app({ "backend/main.py": '@app.post("/api/{table}")\ndef create_row(table: str, row: dict):\n    return store.insert(table, row)\n' });
  const r = runScript("security-scan.cjs", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /generic-table-write-unguarded/);
});

test("GUARANTEE a public endpoint with an explicit marker is allowed (no false block)", () => {
  const { dir } = app({ "backend/ext_x.py": '@router.post("/feedback")  # public-endpoint: anonymous feedback by design\ndef fb(body: dict):\n    return save(body)\n' });
  assert.equal(runScript("security-scan.cjs", dir).status, 0);
});

// --- check-slice-plan: the plan-time classes (cheapest — no build spend) ----

function planInputs(dir, slices, screens) {
  fs.writeFileSync(path.join(dir, "slice_plan.json"), JSON.stringify({ slices }));
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({
    requirements: { data: { requirements: [{ id: "REQ-001" }] } },
    design_contract: { data: { screens } },
  }));
}

test("GUARANTEE oversized-slice — the $41 turn-exhaustion class is rejected at PLAN time", () => {
  const dir = tmp();
  const screens = ["a", "b", "c", "d"].map((x) => ({ id: "screen-" + x, element_count: 5 }));
  planInputs(dir, [{ id: "everything", name: "Everything", story: "one slice does the whole app at once here", addresses: ["REQ-001"], covers: screens.map((s) => s.id), acceptance: [{ method: "GET", path: "/health" }] }], screens);
  const r = runScript("check-slice-plan.cjs", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OVERSIZED/);
});

test("GUARANTEE missing-negative-acceptance — a mutating slice with no refusal check is rejected at PLAN time", () => {
  const dir = tmp();
  const screens = [{ id: "screen-a", element_count: 3 }];
  planInputs(dir, [{ id: "s", name: "Slice", story: "a mutating slice with only happy-path checks", addresses: ["REQ-001"], covers: ["screen-a"], acceptance: [{ method: "POST", path: "/x", body: {} }] }], screens);
  const r = runScript("check-slice-plan.cjs", dir);
  assert.equal(r.status, 1, "a POST slice with no 4xx refusal check must be rejected");
  assert.match(r.stderr, /negative check/i);
});

// --- merge-slices: the append/rebase discipline class (waves 1, 3, 4) -------

test("GUARANTEE merge same-line conflict FAILS LOUDLY, never auto-resolves", () => {
  const dir = tmp();
  const base = { "app.js": "// base\nline\n" };
  const mk = (name, files) => { const p = path.join(dir, name); for (const [r, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(p, r)), { recursive: true }); fs.writeFileSync(path.join(p, r), c); } return p; };
  const f = mk("f", base), s2 = mk("s2", { "app.js": "// base\nSLICE2\n" }), s3 = mk("s3", { "app.js": "// base\nSLICE3\n" });
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ app: { path: f }, app_2: { path: s2 }, app_3: { path: s3 }, slice_plan: { data: { slices: [] } } }));
  const r = runScript("merge-slices.cjs", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MERGE CONFLICT/);
  assert.match(r.stderr, /never auto-resolved/);
});

// --- audit-check: the semantic class a regex can't catch (the auth truth) --

test("GUARANTEE audit-check — an unwaived HIGH audit finding BLOCKS the ship", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ audit: { data: { status: "findings", findings: [{ severity: "high", area: "authz", file: "backend/x.py", finding: "identity is self-asserted; anyone can claim officer role" }] } } }));
  const r = runScript("audit-check.cjs", dir);
  assert.equal(r.status, 1, "a HIGH semantic finding must block UAT, not sit advisory");
  assert.match(r.stderr, /audit gate BLOCKED/);
});
