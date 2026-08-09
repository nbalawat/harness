// THE NON-REPEAT GUARANTEE, enforced at CERTIFICATION.
// Every failure class that ever cost a remediation wave has an adversarial
// fixture here, asserted to be caught by its gate. `harness certify` runs this;
// a version whose gates stopped catching a known class CANNOT be released.
// Add a case for every lesson `harness lessons` promotes. See
// docs/IMPROVEMENT-LOOP.md ("The non-repeat guarantee").
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PT = process.env.HARNESS_PROJECT_DIR || path.resolve(__dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gate-reg-"));
const run = (script, dir, env = {}) =>
  spawnSync("node", [path.join(PT, "scripts", script)], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, HARNESS_PROJECT_DIR: PT, HARNESS_WORKSPACE: dir, ...env },
  });

function appDir(files) {
  const dir = tmp();
  const app = path.join(dir, "app");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(app, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ app: { path: app } }));
  return dir;
}

const failures = [];
function guarantee(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// --- security-scan: authz classes (waves 2/4/6/7) --------------------------
guarantee("opt-out authorization is flagged (the `if acting_user_email:` bypass)", () => {
  const dir = appDir({ "backend/ext_x.py": "def read(acting_user_email=None):\n    if acting_user_email:\n        scope()\n    return rows()\n" });
  run("security-scan.cjs", dir);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "security_report.json"), "utf8"));
  assert(rep.findings.some((f) => f.rule === "opt-out-authz"), "opt-out-authz not flagged");
});
guarantee("opt-out rule does NOT false-positive on prose", () => {
  const dir = appDir({ "backend/ext_x.py": '"""Never guard behind `if acting_user_email:`."""\ndef read(u):\n    require_actor(u)\n' });
  run("security-scan.cjs", dir);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "security_report.json"), "utf8"));
  assert(!rep.findings.some((f) => f.rule === "opt-out-authz"), "false positive on a comment");
});
guarantee("an unauthenticated mutating slice route BLOCKS", () => {
  const dir = appDir({ "backend/ext_x.py": '@router.post("/approve")\ndef approve(item_id: int):\n    return do_it(item_id)\n' });
  assert(run("security-scan.cjs", dir).status === 1, "unauthenticated POST did not block");
});
guarantee("the generic /api/{table} write hole BLOCKS", () => {
  const dir = appDir({ "backend/main.py": '@app.post("/api/{table}")\ndef c(table: str, row: dict):\n    return store.insert(table, row)\n' });
  assert(run("security-scan.cjs", dir).status === 1, "generic table write did not block");
});
guarantee("an explicit # public-endpoint marker is allowed (no false block)", () => {
  const dir = appDir({ "backend/ext_x.py": '@router.post("/feedback")  # public-endpoint: anonymous by design\ndef fb(b: dict):\n    return save(b)\n' });
  assert(run("security-scan.cjs", dir).status === 0, "a justified public endpoint was blocked");
});
guarantee("fail-open identity (fabricating a role when the persona is absent) BLOCKS", () => {
  const dir = appDir({ "backend/ext_x.py": 'def act(email):\n    actor = identity.find(email) or {"email": email, "role": "Compliance Officer"}\n    return actor\n' });
  run("security-scan.cjs", dir);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "security_report.json"), "utf8"));
  assert(rep.findings.some((f) => f.rule === "fail-open-identity"), "fail-open identity fabrication not flagged");
});
guarantee("a decision that DEFAULTS to approved BLOCKS", () => {
  const dir = appDir({ "backend/ext_x.py": 'def decide(inputs):\n    decision = inputs.get("decision", "approved")\n    return decision\n' });
  assert(run("security-scan.cjs", dir).status === 1, "a decision defaulting to approved did not block");
});
guarantee("a legitimate non-terminal default (status -> pending) is NOT flagged", () => {
  const dir = appDir({ "backend/ext_x.py": 'def mk(inputs):\n    status = inputs.get("status", "pending")\n    return status\n' });
  run("security-scan.cjs", dir);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, "security_report.json"), "utf8"));
  assert(!rep.findings.some((f) => f.rule === "defaulted-decision"), "false positive on a benign status default");
});

// --- check-slice-plan: plan-time classes (cheapest) ------------------------
function planDir(slices, screens) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "slice_plan.json"), JSON.stringify({ slices }));
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify({ requirements: { data: { requirements: [{ id: "REQ-001" }] } }, design_contract: { data: { screens } } }),
  );
  return dir;
}
guarantee("an OVERSIZED slice is rejected at plan time (the $41 turn-exhaustion class)", () => {
  const screens = ["a", "b", "c", "d"].map((x) => ({ id: "screen-" + x, element_count: 5 }));
  const dir = planDir([{ id: "everything", name: "Everything", story: "one slice builds the whole app at once", addresses: ["REQ-001"], covers: screens.map((s) => s.id), acceptance: [{ method: "GET", path: "/health" }] }], screens);
  assert(run("check-slice-plan.cjs", dir).status === 1, "oversized slice not rejected");
});
guarantee("a mutating slice with NO refusal check is rejected at plan time", () => {
  const dir = planDir([{ id: "s", name: "Slice", story: "a mutating slice with only happy-path checks here", addresses: ["REQ-001"], covers: ["screen-a"], acceptance: [{ method: "POST", path: "/x", body: {} }] }], [{ id: "screen-a", element_count: 3 }]);
  assert(run("check-slice-plan.cjs", dir).status === 1, "missing negative-acceptance not rejected");
});

// --- merge-slices: append/rebase discipline (waves 1/3/4) ------------------
guarantee("a same-line merge conflict FAILS LOUDLY (never auto-resolved)", () => {
  const dir = tmp();
  const mk = (n, files) => { const p = path.join(dir, n); for (const [r, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(p, r)), { recursive: true }); fs.writeFileSync(path.join(p, r), c); } return p; };
  const f = mk("f", { "app.js": "// base\nx\n" }), s2 = mk("s2", { "app.js": "// base\nS2\n" }), s3 = mk("s3", { "app.js": "// base\nS3\n" });
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ app: { path: f }, app_2: { path: s2 }, app_3: { path: s3 }, slice_plan: { data: { slices: [] } } }));
  const r = run("merge-slices.cjs", dir);
  assert(r.status === 1 && /MERGE CONFLICT/.test(r.stderr), "same-line conflict did not fail loudly");
});

// --- audit-check: the semantic class a regex can't catch -------------------
guarantee("an unwaived HIGH audit finding BLOCKS the ship", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ audit: { data: { status: "findings", findings: [{ severity: "high", area: "authz", file: "backend/x.py", finding: "identity self-asserted; anyone can claim officer" }] } } }));
  assert(run("audit-check.cjs", dir).status === 1, "unwaived high audit finding did not block");
});

console.log("");
if (failures.length) {
  console.error(`NON-REPEAT GUARANTEE BROKEN: ${failures.length} gate(s) stopped catching their class:`);
  for (const f of failures) console.error("  - " + f);
  console.error("\nA past remediation-wave class can recur. Fix the gate before releasing.");
  process.exit(1);
}
console.log("non-repeat guarantee holds: every past wave-class is caught by its gate.");
