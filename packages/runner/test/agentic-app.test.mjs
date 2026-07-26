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

import { Journal, foldState, loadProjectType, runLoop } from "../dist/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PT_DIR = path.join(REPO_ROOT, "project-types", "agentic-app");
const CATALOG = ["persistence-core", "chat-shell", "agent-runtime"];

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
    events(golden, "node.skipped").map((e) => e.nodeId),
    ["deploy"],
    "deploy skips when deploy_target=local",
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

test("golden run: design options are comparable; chosen tokens reach the app", () => {
  const { options } = readJson(artifact(golden, "design-options", "designs.json"));
  assert.equal(options.length, 3);
  const screens = JSON.stringify(options[0].screens);
  for (const o of options) assert.equal(JSON.stringify(o.screens), screens);

  // answers.json chose option-2 ("Forest") — its primary color must be live in the app.
  const tokens = fs.readFileSync(
    path.join(golden.workspace, "artifacts/build-frontend/app/frontend/tokens.css"),
    "utf8",
  );
  assert.match(tokens, /#2b8a3e/, "Forest primary token composed into the app");
});

test("golden run: composed app matches the bill of materials and is branded", () => {
  const appDir = path.join(golden.workspace, "artifacts/build-frontend/app");
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

  const agentNodes = def.nodes.filter((n) => n.kind === "agent").map((n) => n.id);
  const costs = events(golden, "cost.recorded");
  for (const nodeId of agentNodes) {
    const record = costs.find((e) => e.nodeId === nodeId);
    assert.ok(record.cost.costUsd > 0, `agent node ${nodeId} reported no spend`);
  }
  for (const e of costs.filter((e) => !agentNodes.includes(e.nodeId))) {
    assert.equal(e.cost.costUsd, 0, `non-agent node ${e.nodeId} should be free`);
  }
});

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

test("cloud-run target: deploy node runs and emits the plan", async () => {
  const ctx = makeCtx(tmpDir("cloudrun"), readAnswers("answers-cloudrun.json"));
  assert.equal((await runLoop(ctx)).status, "completed");
  assert.equal(events(ctx, "node.skipped").length, 0);
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
  assert.match(result.stderr, /dynamic-eval/);
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

test("budget-check: plan exceeding the envelope is rejected", () => {
  const dir = tmpDir("budget");
  fs.writeFileSync(
    path.join(dir, "inputs.json"),
    JSON.stringify({
      architecture: {
        data: { build_budget_plan: { nodes: { "build-backend": 30 }, total_usd: 30 } },
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
