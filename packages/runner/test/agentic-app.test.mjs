// Regression suite for the agentic-app project type: golden-run e2e (the
// certification replay), conditional deploy, park behavior, and negative
// tests for every custom verifier script.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { Journal, foldState, loadProjectType, reviseNode, runLoop } from "../dist/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PT_DIR = path.join(REPO_ROOT, "project-types", "agentic-app");
const CATALOG = JSON.parse(
  fs.readFileSync(path.join(PT_DIR, "catalog.json"), "utf8"),
).modules.map((m) => m.name);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-aa-${prefix}-`));
}

function makeCtx(workspace, answers) {
  fs.mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    projectTypeDir: PT_DIR,
    def: loadProjectType(PT_DIR),
    journal: new Journal(workspace),
    answers,
    mockAgents: true,
    acceptDefaults: true,
    interactive: false,
  };
}

function readAnswers(file) {
  return JSON.parse(fs.readFileSync(path.join(PT_DIR, "fixtures", file), "utf8"));
}

function artifact(ctx, node, file) {
  return path.join(ctx.workspace, "artifacts", node, file);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function events(ctx, type) {
  return ctx.journal.read().filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// Golden run — this IS the certification replay
// ---------------------------------------------------------------------------

let golden; // shared across assertions below; built once for speed

test("golden run: all nodes complete, deploy skipped for local target", async () => {
  golden = makeCtx(tmpDir("golden"), readAnswers("answers.json"));
  const result = await runLoop(golden);
  assert.equal(result.status, "completed");
  assert.deepEqual(
    events(golden, "node.skipped").map((e) => e.nodeId).sort(),
    ["deploy", "review-slice-1", "review-slice-2", "review-slice-3", "review-slice-4", "review-slice-5", "review-slice-6", "slice-4", "slice-5", "slice-6"],
    "unused slices + review checkpoints (gates-only mode) + deploy skip",
  );
  assert.equal(events(golden, "run.completed").length, 1);
});

test("golden run: requirements carry provenance; stated items cite claims", () => {
  const { requirements } = readJson(artifact(golden, "requirements-synthesis", "requirements.json"));
  assert.ok(requirements.length >= 5, "corpus yields a real requirement set");
  for (const req of requirements.filter((r) => r.confidence === "stated")) {
    assert.ok(req.provenance?.source, `${req.id} missing provenance source`);
    assert.ok(req.provenance?.claim, `${req.id} missing provenance claim`);
  }
  assert.ok(requirements.some((r) => r.confidence === "inferred"), "inference is exercised");
  assert.ok(requirements.some((r) => r.confidence === "unknown"), "gaps exist for the question step");

  // Every cited claim must actually exist in the corpus index (no fabricated provenance).
  const { claims } = readJson(artifact(golden, "ingest", "corpus_index.json"));
  const claimIds = new Set(claims.map((c) => c.id));
  for (const req of requirements.filter((r) => r.provenance?.claim)) {
    assert.ok(claimIds.has(req.provenance.claim), `${req.id} cites nonexistent claim`);
  }
});

test("golden run: question budget respected; every question has default + why", () => {
  const { questions } = readJson(artifact(golden, "gap-questions", "gaps.json"));
  const def = loadProjectType(PT_DIR);
  assert.ok(questions.length <= def.interaction.max_questions_per_gate);
  for (const q of questions) {
    assert.ok(q.default, `${q.id} has no default (breaks accept-defaults path)`);
    assert.ok(q.why, `${q.id} has no why`);
  }
  // Clarify gate auto-answered entirely from defaults — zero user friction.
  const clarify = events(golden, "gate.answered").find((e) => e.nodeId === "clarify");
  assert.equal(clarify.source, "default");
});

test("golden run: architecture stays inside the certified catalog and envelope", () => {
  const arch = readJson(artifact(golden, "architecture", "architecture.json"));
  for (const m of arch.modules) assert.ok(CATALOG.includes(m), `unknown module ${m}`);
  const def = loadProjectType(PT_DIR);
  assert.ok(arch.build_budget_plan.total_usd <= def.cost.run_budget_usd);
});

test("golden run: design options are comparable; the CHOSEN DESIGN IS the app frontend", () => {
  const { options } = readJson(artifact(golden, "design-options", "designs.json"));
  assert.equal(options.length, 3);
  const screens = JSON.stringify(options[0].screens);
  for (const o of options) assert.equal(JSON.stringify(o.screens), screens);

  // answers.json chose option-2 ("Forest") — its primary color must be live in the app.
  const tokens = fs.readFileSync(
    path.join(golden.workspace, "artifacts/slice-3/app/frontend/tokens.css"),
    "utf8",
  );
  assert.match(tokens, /#2b8a3e/, "Forest primary token composed into the app");

  // Design SANCTITY: not just tokens — the chosen option's full shell ships.
  const appIndex = fs.readFileSync(path.join(golden.workspace, "artifacts/slice-3/app/frontend/index.html"), "utf8");
  const chosenPreview = fs.readFileSync(
    path.join(golden.workspace, "artifacts/design-options/designs/option-2/index.html"),
    "utf8",
  );
  assert.match(appIndex, /masthead/, "Forest's editorial masthead layout survives into the built app");
  assert.match(chosenPreview, /masthead/, "the marker genuinely comes from the chosen preview");
  for (const id of ["agent-mode", "screen-chat", "messages", "composer", "input", "screen-agents", "agents-list"]) {
    assert.ok(appIndex.includes(`id="${id}"`), `canonical mount point ${id} present in shipped frontend`);
  }
  assert.match(appIndex, /app\.js/, "behavior module wired onto the design shell");
  // Provenance is recorded so any later stage can assert fidelity.
  const provenance = readJson(path.join(golden.workspace, "artifacts/slice-3/app/design.json"));
  assert.equal(provenance.chosen_option, "option-2");
  assert.equal(provenance.name, "Forest");
});

test("golden run: composed app matches the bill of materials and is branded", () => {
  const appDir = path.join(golden.workspace, "artifacts/slice-3/app");
  const composed = readJson(path.join(appDir, "composed_modules.json"));
  const arch = readJson(artifact(golden, "architecture", "architecture.json"));
  assert.deepEqual(composed.modules, arch.modules);

  // Module files actually composed in.
  for (const f of ["backend/db.py", "backend/agent_runtime.py", "frontend/app.js"]) {
    assert.ok(fs.existsSync(path.join(appDir, f)), `missing composed file ${f}`);
  }
  // Branding replaced the placeholder everywhere users see it.
  assert.match(fs.readFileSync(path.join(appDir, "frontend/index.html"), "utf8"), /Support Copilot/);
  assert.match(fs.readFileSync(path.join(appDir, "backend/main.py"), "utf8"), /Support Copilot/);
  assert.doesNotMatch(fs.readFileSync(path.join(appDir, "frontend/index.html"), "utf8"), /__APP_NAME__/);
  // models.py generated from the approved data model.
  const models = fs.readFileSync(path.join(appDir, "backend/models.py"), "utf8");
  assert.match(models, /conversations/);
  assert.match(models, /messages/);
});

test("golden run: validation + security evidence is real and green", () => {
  const integration = readJson(artifact(golden, "integrate", "integration_report.json"));
  assert.equal(integration.backend_tests.status, "pass");
  assert.equal(integration.evals.status, "pass");
  assert.equal(integration.python_compile, "pass");

  const security = readJson(artifact(golden, "security-scan", "security_report.json"));
  assert.equal(security.high_count, 0);
  assert.ok(security.files_scanned >= 15);

  const governance = readJson(artifact(golden, "governance-report", "governance.json"));
  assert.equal(governance.standards_profile, "firm-baseline-v0");
  assert.equal(governance.validation.backend_tests, "pass");
  assert.equal(governance.agents.count, 1);
});

test("golden run: cost fully attributed and inside the envelope", () => {
  const def = loadProjectType(PT_DIR);
  const state = foldState(golden.journal.read());
  assert.ok(state.totalCostUsd > 0, "simulated spend recorded");
  assert.ok(state.totalCostUsd <= def.cost.run_budget_usd, "run stayed inside envelope");

  const skipped = foldState(golden.journal.read()).skipped;
  const agentNodes = def.nodes
    .filter((n) => n.kind === "agent" && !skipped.has(n.id))
    .map((n) => n.id);
  const costs = events(golden, "cost.recorded");
  for (const nodeId of agentNodes) {
    const record = costs.find((e) => e.nodeId === nodeId);
    assert.ok(record.cost.costUsd > 0, `agent node ${nodeId} reported no spend`);
  }
  for (const e of costs.filter((e) => !agentNodes.includes(e.nodeId))) {
    assert.equal(e.cost.costUsd, 0, `non-agent node ${e.nodeId} should be free`);
  }
});

test("golden run: vertical slices trace to requirements and the app evolves per slice", () => {
  const plan = readJson(artifact(golden, "slice-plan", "slice_plan.json"));
  const { requirements } = readJson(artifact(golden, "requirements-synthesis", "requirements.json"));
  const reqIds = new Set(requirements.map((r) => r.id));
  for (const slice of plan.slices) {
    for (const id of slice.addresses) assert.ok(reqIds.has(id), `slice ${slice.id} addresses unknown ${id}`);
    assert.ok(slice.acceptance.length >= 1);
  }

  // Every built slice commits a launchable app; features accumulate.
  const slice1Main = fs.readFileSync(path.join(golden.workspace, "artifacts/slice-1/app/backend/main.py"), "utf8");
  const slice3Main = fs.readFileSync(path.join(golden.workspace, "artifacts/slice-3/app/backend/main.py"), "utf8");
  assert.ok(!slice1Main.includes("/approvals"), "slice-1 predates the approval feature");
  assert.ok(slice3Main.includes("/approvals"), "slice-3 delivers the approval feature");

  const slices = fs.readFileSync(path.join(golden.workspace, "artifacts/slice-3/app/SLICES.md"), "utf8");
  assert.equal((slices.match(/^- slice /gm) ?? []).length, 3, "SLICES.md records each delivered slice");

  // The walking skeleton is already branded and testable at scaffold.
  const scaffoldIndex = fs.readFileSync(path.join(golden.workspace, "artifacts/scaffold/app/frontend/index.html"), "utf8");
  assert.doesNotMatch(scaffoldIndex, /__APP_NAME__/);
  assert.ok(fs.existsSync(path.join(golden.workspace, "artifacts/scaffold/app/backend/models.py")));
});

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

test("cloud-run target: deploy node runs and emits the plan", async () => {
  const ctx = makeCtx(tmpDir("cloudrun"), readAnswers("answers-cloudrun.json"));
  assert.equal((await runLoop(ctx)).status, "completed");
  const skipped = events(ctx, "node.skipped").map((e) => e.nodeId);
  assert.ok(!skipped.includes("deploy"), "deploy runs for cloud-run target");
  assert.deepEqual(skipped.sort(), ["review-slice-1", "review-slice-2", "review-slice-3", "review-slice-4", "review-slice-5", "review-slice-6", "slice-4", "slice-5", "slice-6"]);
  assert.ok(fs.existsSync(artifact(ctx, "deploy", "deploy/service.yaml")));
  assert.match(fs.readFileSync(artifact(ctx, "deploy", "deploy/plan.md"), "utf8"), /Cloud Run/);
});

test("no answers: run parks durably at intake", async () => {
  const ctx = makeCtx(tmpDir("park"), undefined);
  const result = await runLoop(ctx);
  assert.equal(result.status, "parked");
  assert.equal(result.parkedNodeId, "intake");
});

// ---------------------------------------------------------------------------
// Verifier scripts: negative tests (each custom gate must actually bite)
// ---------------------------------------------------------------------------

function runScript(script, dir) {
  return spawnSync("node", [path.join(PT_DIR, "scripts", script)], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, HARNESS_PROJECT_DIR: PT_DIR },
  });
}

test("security-scan: hardcoded secret blocks with a high finding", () => {
  const dir = tmpDir("sec");
  const appDir = path.join(dir, "badapp");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "config.py"), 'api_key = "sk-abcdef1234567890abcdef"\n');
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ app: { path: appDir } }));

  const result = runScript("security-scan.cjs", dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /hardcoded-secret/);
  const report = readJson(path.join(dir, "security_report.json"));
  assert.ok(report.high_count >= 1);
});

test("security-scan: eval() in generated code blocks", () => {
  const dir = tmpDir("sec2");
  const appDir = path.join(dir, "badapp");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "helper.py"), "def run(code):\n    return eval(code)\n");
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ app: { path: appDir } }));
  const result = runScript("security-scan.cjs", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dynamic-eval-py/);
});

test("security-scan: JS RegExp.exec() is NOT flagged (real-run false positive)", () => {
  const dir = tmpDir("sec3");
  const appDir = path.join(dir, "okapp");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "app.js"), "const m = /^(a)$/.exec(input);\n");
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify({ app: { path: appDir } }));
  assert.equal(runScript("security-scan.cjs", dir).status, 0);

  const badDir = tmpDir("sec4");
  const badApp = path.join(badDir, "badapp");
  fs.mkdirSync(badApp, { recursive: true });
  fs.writeFileSync(path.join(badApp, "app.js"), "const out = eval(userInput);\n");
  fs.writeFileSync(path.join(badDir, "inputs.json"), JSON.stringify({ app: { path: badApp } }));
  const bad = runScript("security-scan.cjs", badDir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /dynamic-eval-js/);
});

test("design-check: options with different screen sets are rejected", () => {
  const dir = tmpDir("design");
  const designsDir = path.join(dir, "designs");
  const options = [];
  for (let i = 1; i <= 3; i++) {
    const optDir = path.join(designsDir, `option-${i}`);
    fs.mkdirSync(optDir, { recursive: true });
    fs.writeFileSync(path.join(optDir, "tokens.css"), ":root {}");
    fs.writeFileSync(path.join(optDir, "index.html"), "<html></html>");
    options.push({
      id: `option-${i}`,
      name: `Option ${i}`,
      screens: i === 3 ? ["chat"] : ["chat", "settings"], // option-3 diverges
      tokens_file: `designs/option-${i}/tokens.css`,
      preview_file: `designs/option-${i}/index.html`,
    });
  }
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify({ designs: { data: { options } }, designs_dir: { path: designsDir } }),
  );
  const result = runScript("design-check.cjs", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not comparable/);
});

test("design-check: option that is not a buildable shell is rejected", () => {
  const dir = tmpDir("design2");
  const designsDir = path.join(dir, "designs");
  const options = [];
  for (let i = 1; i <= 3; i++) {
    const optDir = path.join(designsDir, `option-${i}`);
    fs.mkdirSync(optDir, { recursive: true });
    fs.writeFileSync(path.join(optDir, "tokens.css"), ":root {}");
    // Pretty mockup, but no canonical mount points → cannot ship as the app.
    fs.writeFileSync(path.join(optDir, "index.html"), "<html><body><h1>Lovely</h1></body></html>");
    options.push({
      id: `option-${i}`,
      name: `Option ${i}`,
      screens: ["chat"],
      tokens_file: `designs/option-${i}/tokens.css`,
      preview_file: `designs/option-${i}/index.html`,
    });
  }
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify({ designs: { data: { options } }, designs_dir: { path: designsDir } }),
  );
  const result = runScript("design-check.cjs", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a buildable shell/);
});

test("budget-check: plan exceeding the envelope is rejected", () => {
  const dir = tmpDir("budget");
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify({
      architecture: {
        data: { build_budget_plan: { nodes: { "build-backend": 500 }, total_usd: 500 } },
      },
    }),
  );
  const result = runScript("budget-check.cjs", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds run envelope/);
});

test("budget-check: inconsistent plan (nodes vs total) is rejected", () => {
  const dir = tmpDir("budget2");
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify({
      architecture: {
        data: { build_budget_plan: { nodes: { "build-backend": 2 }, total_usd: 8 } },
      },
    }),
  );
  const result = runScript("budget-check.cjs", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inconsistent/);
});

// ---------------------------------------------------------------------------
// Requirements traceability: requirements FLOW into design; user confirms
// ---------------------------------------------------------------------------

test("golden run: RTM covers every non-unknown requirement with named design elements", () => {
  const rtm = readJson(artifact(golden, "traceability", "rtm.json"));
  assert.equal(rtm.uncovered.length, 0, "no requirement may be left unaddressed");
  assert.equal(rtm.covered_count, rtm.requirements_total);

  const { requirements } = readJson(artifact(golden, "requirements-synthesis", "requirements.json"));
  const covered = new Set(rtm.coverage.map((c) => c.id));
  for (const req of requirements.filter((r) => r.confidence !== "unknown")) {
    assert.ok(covered.has(req.id), `${req.id} missing from RTM`);
  }
  for (const entry of rtm.coverage) {
    assert.ok(entry.addressed_by.length >= 1, `${entry.id} has no addressing design element`);
  }
});

test("golden run: assumptions are surfaced and the user confirmed at design-review", () => {
  const rtm = readJson(artifact(golden, "traceability", "rtm.json"));
  assert.ok(rtm.assumptions.some((a) => a.source === "default"), "defaulted answers surfaced as assumptions");
  assert.ok(rtm.assumptions.some((a) => a.source === "inferred"), "inferred requirements surfaced as assumptions");

  const review = events(golden, "gate.answered").find((e) => e.nodeId === "design-review");
  assert.ok(review, "design-review gate was answered");
  assert.equal(review.answers.approve_design, "yes");

  // Build only starts after confirmation: scaffold must run after design-review.
  const order = golden.journal.read().filter((e) => e.type === "node.committed").map((e) => e.nodeId);
  assert.ok(order.indexOf("design-review") < order.indexOf("scaffold"), "no build spend before user confirmation");

  const governance = readJson(artifact(golden, "governance-report", "governance.json"));
  assert.equal(governance.requirements.uncovered, 0);
  assert.equal(governance.requirements.covered, governance.requirements.total);
});

test("traceability: an unaddressed requirement blocks the pipeline", () => {
  const dir = tmpDir("rtm-neg");
  const mkInputs = {
    requirements: { data: { requirements: [
      { id: "REQ-001", text: "must chat", category: "agent", confidence: "stated" },
      { id: "REQ-002", text: "must export reports weekly", category: "functional", confidence: "stated" },
    ] } },
    architecture: { data: { module_coverage: [{ module: "agent-runtime", addresses: ["REQ-001"] }] } },
    data_model: { data: { tables: [] } },
    agent_roster: { data: { agents: [] } },
    designs: { data: { options: [] } },
    gaps: { data: { questions: [] } },
    clarifications: { data: {} },
  };
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify(mkInputs));
  const result = runScript("traceability.cjs", dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRACEABILITY GAP/);
  assert.match(result.stderr, /REQ-002/);
  const rtm = readJson(path.join(dir, "rtm.json"));
  assert.deepEqual(rtm.uncovered, ["REQ-002"]);
});

// ---------------------------------------------------------------------------
// Revision flows: feedback enters at the right artifact, cascades, and
// memoization keeps the cost of a revision proportional to its blast radius.
// ---------------------------------------------------------------------------

test("revision: a change request becomes a requirement with provenance and re-derives to a consistent app", async () => {
  const ctx = makeCtx(tmpDir("revise-e2e"), readAnswers("answers.json"));
  assert.equal((await runLoop(ctx)).status, "completed");

  // --- Flow (b): new requirement via user feedback (the /api/feedback path).
  const feedback =
    "User change request CR-1 (raised after reviewing the built app): Analysts must see which agent produced each reply.\n\n" +
    'Add this as a NEW requirement: provenance source "user-feedback" referencing CR-1, confidence "stated".';
  const { reopened } = reviseNode(ctx, "requirements-synthesis", feedback);
  assert.ok(reopened.includes("slice-plan"), "plan is downstream of requirements");
  assert.ok(reopened.includes("traceability"), "traceability re-verifies");
  assert.ok(!reopened.includes("ingest"), "upstream evidence is untouched");

  assert.equal((await runLoop(ctx)).status, "completed");

  // The CR entered through the front door: a requirement with provenance...
  const { requirements } = readJson(artifact(ctx, "requirements-synthesis", "requirements.json"));
  const crReq = requirements.find((r) => r.provenance?.source === "user-feedback");
  assert.ok(crReq, "change request became a requirement");
  assert.equal(crReq.provenance.claim, "CR-1");
  assert.equal(crReq.confidence, "stated");

  // ...covered by the re-verified RTM (consistency is enforced, not hoped for).
  const rtm = readJson(artifact(ctx, "traceability", "rtm.json"));
  assert.equal(rtm.uncovered.length, 0);
  assert.ok(rtm.coverage.some((c) => c.id === crReq.id), "new requirement is traced");

  // Memoization contained the blast radius: at least one downstream step
  // whose inputs didn't change was re-used rather than re-run.
  const cached = events(ctx, "node.committed").filter((e) => e.cached === true);
  assert.ok(cached.length > 0, "unchanged steps re-used previous results");

  // --- Flow (a): fix a slice (build doesn't match what was agreed).
  const fix = reviseNode(
    ctx,
    "slice-2",
    "The history list should show newest conversations first — it currently shows oldest first.",
  );
  assert.ok(fix.reopened.includes("integrate"), "quality gates re-run after a fix");
  assert.ok(!fix.reopened.includes("slice-1"), "earlier slices untouched");
  assert.equal((await runLoop(ctx)).status, "completed");

  // The fix is visibly applied and carried through to the final app.
  const finalIndex = fs.readFileSync(path.join(ctx.workspace, "artifacts/slice-3/app/frontend/index.html"), "utf8");
  assert.match(finalIndex, /revised per user feedback/);
  const slicesMd = fs.readFileSync(path.join(ctx.workspace, "artifacts/slice-3/app/SLICES.md"), "utf8");
  assert.match(slicesMd, /revised per user feedback/);

  // Revisions are auditable history, not silent edits.
  const revisions = events(ctx, "node.reopened").filter((e) => e.reason === "user_revision");
  assert.deepEqual(revisions.map((e) => e.nodeId), ["requirements-synthesis", "slice-2"]);
});

test("certified subagent teams: design directors + slice reviewer are declared and reachable", () => {
  const def = loadProjectType(PT_DIR);
  const design = def.nodes.find((n) => n.id === "design-options");
  assert.deepEqual(
    Object.keys(design.agents).sort(),
    ["board-director", "console-director", "editorial-director", "terminal-director"],
    "four genuinely distinct design directors",
  );
  assert.ok(design.allowedTools.includes("Task"));
  for (const [name, sub] of Object.entries(design.agents)) {
    assert.match(sub.prompt, /screen-chat/, `${name} carries the buildable-shell contract`);
    assert.ok(!sub.tools.includes("Task"), "directors do not sub-delegate");
  }

  for (const n of def.nodes.filter((x) => /^slice-\d$/.test(x.id))) {
    assert.ok(n.agents["slice-reviewer"], `${n.id} has the reviewer`);
    assert.deepEqual(n.agents["slice-reviewer"].tools, ["Read", "Glob", "Grep"], "reviewer is read-only");
    assert.ok(n.allowedTools.includes("Task"));
  }
});

// ---------------------------------------------------------------------------
// Workflow layer: the factory's architecture shipped inside the app
// ---------------------------------------------------------------------------

test("golden run: workflows are designed, verified, traced, and composed into the app", () => {
  const { workflows } = readJson(artifact(golden, "workflow-design", "workflows.json"));
  assert.ok(workflows.length >= 1);
  const wf = workflows[0];
  const kinds = wf.nodes.map((n) => n.kind);
  assert.ok(kinds.includes("agent") && kinds.includes("human") && kinds.includes("deterministic"), "a real process mixes all three");

  // Traceability: workflow addresses join the RTM.
  const rtm = readJson(artifact(golden, "traceability", "rtm.json"));
  const workflowCovered = rtm.coverage.filter((c) => c.addressed_by.some((a) => a.via === "workflow"));
  assert.ok(workflowCovered.length >= 1, "workflows address requirements in the RTM");

  // The definitions ship inside the app; the engine is composed.
  const appDir = path.join(golden.workspace, "artifacts/slice-3/app");
  const shipped = readJson(path.join(appDir, "workflows/workflows.json"));
  assert.equal(shipped.workflows[0].name, wf.name);
  assert.ok(fs.existsSync(path.join(appDir, "backend/workflow_engine.py")), "engine composed");
  const composed = readJson(path.join(appDir, "composed_modules.json"));
  assert.ok(composed.modules.includes("workflow-engine") && composed.modules.includes("approval-flow"));
});

test("check-workflows: agent-pipe-without-gate and dangling branches are rejected", () => {
  const dir = tmpDir("wfcheck");
  const reqs = { requirements: { data: { requirements: [{ id: "REQ-001" }] } } };

  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify(reqs));
  fs.writeFileSync(
    path.join(dir, "workflows.json"),
    JSON.stringify({ workflows: [{ name: "pipe", addresses: ["REQ-001"], nodes: [{ id: "a", kind: "agent", prompt: "x" }, { id: "b", kind: "agent", prompt: "y" }] }] }),
  );
  const pipe = runScript("check-workflows.cjs", dir);
  assert.equal(pipe.status, 1);
  assert.match(pipe.stderr, /no human gate or condition/);

  fs.writeFileSync(
    path.join(dir, "workflows.json"),
    JSON.stringify({ workflows: [{ name: "dangle", addresses: ["REQ-001"], nodes: [{ id: "a", kind: "condition", path: "x.y", equals: true, on_false: "ghost" }, { id: "h", kind: "human", question: "ok?" }] }] }),
  );
  const dangle = runScript("check-workflows.cjs", dir);
  assert.equal(dangle.status, 1);
  assert.match(dangle.stderr, /unknown node 'ghost'/);

  fs.writeFileSync(
    path.join(dir, "workflows.json"),
    JSON.stringify({ workflows: [{ name: "bad-req", addresses: ["REQ-999"], nodes: [{ id: "h", kind: "human", question: "ok?" }, { id: "d", kind: "deterministic", handler: "do_it" }] }] }),
  );
  assert.match(runScript("check-workflows.cjs", dir).stderr, /unknown requirement REQ-999/);
});

// ---------------------------------------------------------------------------
// Agent-runtime adapters: framework mandates flow through the whole pipeline
// ---------------------------------------------------------------------------

test("ADK mandate: the full pipeline builds and verifies an ADK-runtime app", async () => {
  const ctx = makeCtx(tmpDir("adk-e2e"), readAnswers("scenario-adk.json"));
  assert.equal((await runLoop(ctx)).status, "completed");

  const appDir = path.join(ctx.workspace, "artifacts/slice-3/app");
  const composed = readJson(path.join(appDir, "composed_modules.json"));
  assert.ok(composed.modules.includes("agent-runtime-adk"), "architecture composed the ADK adapter");
  assert.ok(!composed.modules.includes("agent-runtime"), "exactly one runtime");

  const runtime = fs.readFileSync(path.join(appDir, "backend/agent_runtime.py"), "utf8");
  assert.match(runtime, /google\.adk/, "the shipped runtime IS the ADK implementation");
  const reqs = fs.readFileSync(path.join(appDir, "backend/requirements.txt"), "utf8");
  assert.match(reqs, /google-adk/, "framework dependency travels with the app");

  // The same behavioral gate every runtime passes: integration evals were real.
  const integration = readJson(artifact(ctx, "integrate", "integration_report.json"));
  assert.equal(integration.evals.status, "pass");
  assert.equal(integration.backend_tests.status, "pass");
});

test("Strands mandate: the full pipeline builds and verifies a Strands-runtime app", async () => {
  const ctx = makeCtx(tmpDir("strands-e2e"), readAnswers("scenario-strands.json"));
  assert.equal((await runLoop(ctx)).status, "completed");
  const appDir = path.join(ctx.workspace, "artifacts/slice-3/app");
  const composed = readJson(path.join(appDir, "composed_modules.json"));
  assert.ok(composed.modules.includes("agent-runtime-strands") && !composed.modules.includes("agent-runtime"));
  assert.match(fs.readFileSync(path.join(appDir, "backend/agent_runtime.py"), "utf8"), /from strands import Agent/);
  assert.match(fs.readFileSync(path.join(appDir, "backend/requirements.txt"), "utf8"), /strands-agents/);
  const integration = readJson(artifact(ctx, "integrate", "integration_report.json"));
  assert.equal(integration.evals.status, "pass");
});

test("runtime adapters: compat-matrix refuses two runtimes in one selection", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "modules/compat-matrix/check.mjs"), path.join(REPO_ROOT, "modules"),
     "persistence-core", "chat-shell", "agent-runtime-langgraph", "agent-runtime-adk"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicts with/);
});

test("agent design sweeps every workflow slot: included agents + excluded-with-citation", () => {
  const roster = readJson(artifact(golden, "agent-design", "agent_roster.json"));
  assert.ok(Array.isArray(roster.opportunity_map) && roster.opportunity_map.length >= 4, "the sweep is recorded");

  const { workflows } = readJson(artifact(golden, "workflow-design", "workflows.json"));
  const agentNodes = workflows.flatMap((w) => w.nodes.filter((n) => n.kind === "agent").map((n) => `${w.name}/${n.id}`));
  for (const slot of agentNodes) {
    const entry = roster.opportunity_map.find((o) => o.slot === slot);
    assert.ok(entry && entry.decision === "included" && entry.agent, `workflow agent node ${slot} maps to a roster agent`);
    assert.ok(roster.agents.some((a) => a.name === entry.agent), "the mapped agent exists in the roster");
  }
  const excluded = roster.opportunity_map.filter((o) => o.decision === "excluded");
  assert.ok(excluded.length >= 2, "mechanical/human slots were considered and rejected");
  for (const o of excluded) assert.ok(o.rationale.length >= 10, "every exclusion carries a reason");
});

test("slice objectives carry executable evidence: the acceptance report in the app artifact", () => {
  const report = readJson(path.join(golden.workspace, "artifacts/slice-3/app/acceptance_report.json"));
  assert.equal(report.proven_through_slice, 3);
  assert.equal(report.slices.length, 3, "cumulative — every prior slice re-proven");
  for (const sl of report.slices) {
    assert.ok(sl.objective && sl.objective.length > 10, `${sl.slice} carries its objective (story)`);
    assert.ok(sl.checks.length >= 1 && sl.checks.every((c) => c.ok), `${sl.slice} checks all proven`);
    assert.ok(Array.isArray(sl.addresses) && sl.addresses.length >= 1, "objective traces to requirements");
  }
});

test("every-slice supervision: each slice ends in a review window — pause, then proceed on the default", async () => {
  const answers = readAnswers("answers.json");
  answers.intake = { ...answers.intake, supervision: "every-slice" };
  const ctx = makeCtx(tmpDir("supervise"), answers);
  ctx.acceptDefaults = false; // attended run: defaults are offered, not auto-applied

  const parked = await runLoop(ctx);
  assert.equal(parked.status, "parked");
  // It progressed through the earlier gates? No — clarify parks first in attended mode;
  // answer the journey gate by gate until the slice checkpoint proves the point.
  const answerAndResume = async (nodeId, ans) => {
    ctx.answers = { ...ctx.answers, [nodeId]: ans };
    return runLoop(ctx);
  };
  let r = parked;
  for (let guard = 0; guard < 12 && r.status === "parked"; guard++) {
    const node = ctx.def.nodes.find((n) => n.id === r.parkedNodeId);
    const qs = node.questions ?? [{ id: "q" }];
    const auto = { ...(ctx.answers[r.parkedNodeId] ?? {}) };
    for (const q of qs) if (auto[q.id] === undefined) auto[q.id] = q.default ?? "yes";
    if (r.parkedNodeId === "clarify") {
      // dynamic questions: answer them from the gap artifact's own defaults
      const gaps = readJson(artifact(ctx, "gap-questions", "gaps.json"));
      const clarifyAnswers = {};
      for (const q of gaps.questions) clarifyAnswers[q.id] = q.default ?? "yes";
      r = await answerAndResume("clarify", clarifyAnswers);
      continue;
    }
    r = await answerAndResume(r.parkedNodeId, auto);
  }
  // Checkpoints are WINDOWS, not walls: with every question defaulted, the
  // review gate pauses (in live mode: up to its 5-minute window) and then
  // proceeds on approval-by-default — the run never hard-parks on a checkpoint.
  assert.equal(r.status, "completed", "checkpoints never leave the build stranded");
  const final = foldState(ctx.journal.read());
  assert.ok(final.committed.has("review-slice-1") && final.committed.has("slice-3"));
  for (let n = 1; n <= 3; n++) {
    const gate = events(ctx, "gate.answered").find((e) => e.nodeId === `review-slice-${n}`);
    assert.ok(gate, `review-slice-${n} was a real decision point`);
    assert.equal(gate.source, "window", `review-slice-${n} proceeded on the window default — provenance visible`);
  }
});

test("gates-only supervision (default): review checkpoints are skipped, not silently absent", () => {
  const skipped = events(golden, "node.skipped").map((e) => e.nodeId);
  for (let n = 1; n <= 3; n++) assert.ok(skipped.includes(`review-slice-${n}`), `review-slice-${n} visibly skipped`);
});

test("each slice demonstrates ITS increment: demo declarations ship with the app", () => {
  for (let n = 1; n <= 3; n++) {
    const demo = readJson(path.join(golden.workspace, `artifacts/slice-${n}/app/demo/slice-${n}.json`));
    assert.ok(demo.screen && demo.screen.startsWith("screen-"), `slice-${n} targets a real screen`);
    assert.ok(demo.caption && demo.caption.length > 15, `slice-${n} captions its increment`);
  }
  const d1 = readJson(path.join(golden.workspace, "artifacts/slice-1/app/demo/slice-1.json"));
  const d2 = readJson(path.join(golden.workspace, "artifacts/slice-2/app/demo/slice-2.json"));
  assert.notEqual(d1.screen, d2.screen, "different slices demonstrate different surfaces");
});

// ---------------------------------------------------------------------------
// Design delivery: the approved design is an enforced promise
// ---------------------------------------------------------------------------

test("design contract: every screen of the chosen design is inventoried", () => {
  const contract = readJson(artifact(golden, "design-contract", "design_contract.json"));
  assert.equal(contract.totals.screens, 3);
  assert.deepEqual(contract.screens.map((s) => s.id), ["screen-chat", "screen-history", "screen-agents"]);
  assert.ok(contract.totals.elements >= 3, "interactive elements inventoried");
});

test("slice plan covers every approved screen (the verifier enforces it)", () => {
  const plan = readJson(artifact(golden, "slice-plan", "slice_plan.json"));
  const covered = plan.slices.flatMap((s) => s.covers);
  for (const screen of ["screen-chat", "screen-history", "screen-agents"]) {
    assert.ok(covered.includes(screen), `${screen} assigned to a slice`);
  }
});

test("design coverage: the finished app proves every promised screen live, with evidence", () => {
  const cov = readJson(artifact(golden, "design-coverage", "design_coverage.json"));
  assert.equal(cov.totals.screens_present, cov.totals.screens, "no dead mockup screens ship");
  for (const s of cov.screens) {
    assert.ok(s.present, `${s.id} live in the running app`);
    assert.ok(s.covered_by_slice >= 1, `${s.id} attributed to the slice that delivered it`);
    if (s.shot) {
      assert.ok(
        fs.existsSync(path.join(golden.workspace, "artifacts", "design-coverage", s.shot)),
        `${s.id} has its live screenshot`,
      );
    }
  }
});

test("slice screenshots are pairwise DISTINCT — each demonstrates its own increment", async () => {
  const crypto = await import("node:crypto");
  const hashes = new Map();
  for (let n = 1; n <= 3; n++) {
    const p = path.join(golden.workspace, `artifacts/slice-${n}/app/screenshots/slice-${n}.png`);
    if (!fs.existsSync(p)) return; // browser-less environment: enforcement self-disables
    const h = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    assert.ok(!hashes.has(h), `slice-${n} shot duplicates slice-${hashes.get(h)}'s`);
    hashes.set(h, n);
  }
});

test("a slice plan that leaves an approved screen unassigned is REJECTED", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-cov-neg-"));
  const plan = readJson(artifact(golden, "slice-plan", "slice_plan.json"));
  const crippled = { slices: plan.slices.map((s) => ({ ...s, covers: ["screen-chat"] })) }; // history+agents dropped
  fs.writeFileSync(path.join(dir, "slice_plan.json"), JSON.stringify(crippled));
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify({
      requirements: { data: readJson(artifact(golden, "requirements-synthesis", "requirements.json")) },
      design_contract: { data: readJson(artifact(golden, "design-contract", "design_contract.json")) },
    }),
  );
  const out = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "project-types/agentic-app/scripts/check-slice-plan.cjs")],
    { cwd: dir, encoding: "utf8" },
  );
  assert.notEqual(out.status, 0, "unassigned screens must fail the plan");
  assert.match(out.stderr, /unassigned: screen-history, screen-agents/);
});

test("intake questions are typed: choices visible, documents droppable, every-slice the default", () => {
  const def = loadProjectType(PT_DIR);
  const intake = def.nodes.find((n) => n.id === "intake");
  const byId = Object.fromEntries(intake.questions.map((q) => [q.id, q]));
  assert.equal(byId.problem_statement.type, "long", "problem statement is long-form");
  assert.equal(byId.documents_dir.type, "files", "documents get a drop zone");
  for (const id of ["deploy_target", "supervision"]) {
    assert.equal(byId[id].type, "choice", `${id} is a visible choice`);
    assert.ok(byId[id].options.length >= 2, `${id} options enumerated`);
    for (const o of byId[id].options) assert.ok(o.hint, `${id}/${o.value} explains itself`);
  }
  assert.equal(byId.supervision.default, "every-slice", "checkpoints are the default — the build waits for you by default");
  const uat = def.nodes.find((n) => n.id === "uat");
  assert.equal(uat.questions[0].type, "boolean", "UAT approval is a yes/no");
});
