// Extensive tests for the Phase 0 runner: DAG validation, happy path,
// park/resume, retry-with-feedback, contract enforcement, verifier failure,
// cost accounting, resume idempotency, and CLI surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { Journal, foldState, loadProjectType, runLoop } from "../dist/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEMO_DIR = path.join(REPO_ROOT, "project-types", "demo");
const DEMO_ANSWERS = { intake: { project_name: "Demo App" } };

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-${prefix}-`));
}

function writeFixture(dir, dag, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dag.yaml"), dag);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function makeCtx(workspace, projectTypeDir, { answers, mockAgents = true } = {}) {
  fs.mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    projectTypeDir,
    def: loadProjectType(projectTypeDir),
    journal: new Journal(workspace),
    answers,
    mockAgents,
    interactive: false,
  };
}

function events(ctx, type) {
  return ctx.journal.read().filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// DAG structural validation
// ---------------------------------------------------------------------------

test("validation: duplicate node id rejected", () => {
  const dir = writeFixture(
    tmpDir("dup"),
    `name: t\nversion: 0.0.1\nnodes:\n  - {id: a, kind: verifier, command: "true"}\n  - {id: a, kind: verifier, command: "true"}\n`,
  );
  assert.throws(() => loadProjectType(dir), /duplicate node id 'a'/);
});

test("validation: unknown dependency rejected", () => {
  const dir = writeFixture(
    tmpDir("dep"),
    `name: t\nversion: 0.0.1\nnodes:\n  - {id: a, kind: verifier, command: "true", deps: [ghost]}\n`,
  );
  assert.throws(() => loadProjectType(dir), /unknown node 'ghost'/);
});

test("validation: dependency cycle rejected", () => {
  const dir = writeFixture(
    tmpDir("cycle"),
    `name: t\nversion: 0.0.1\nnodes:\n  - {id: a, kind: verifier, command: "true", deps: [b]}\n  - {id: b, kind: verifier, command: "true", deps: [a]}\n`,
  );
  assert.throws(() => loadProjectType(dir), /cycle/);
});

test("validation: kind-specific required fields enforced", () => {
  const agentNoPrompt = writeFixture(
    tmpDir("np"),
    `name: t\nversion: 0.0.1\nnodes:\n  - {id: a, kind: agent}\n`,
  );
  assert.throws(() => loadProjectType(agentNoPrompt), /requires a prompt file/);

  const gateNoQuestions = writeFixture(
    tmpDir("nq"),
    `name: t\nversion: 0.0.1\nnodes:\n  - {id: g, kind: gate, outputs: [{name: x, file: x.json}]}\n`,
  );
  assert.throws(() => loadProjectType(gateNoQuestions), /requires questions/);

  const detNoCommand = writeFixture(
    tmpDir("nc"),
    `name: t\nversion: 0.0.1\nnodes:\n  - {id: d, kind: deterministic}\n`,
  );
  assert.throws(() => loadProjectType(detNoCommand), /requires a command/);
});

test("validation: missing dag.yaml rejected", () => {
  assert.throws(() => loadProjectType(tmpDir("empty")), /missing dag.yaml/);
});

// ---------------------------------------------------------------------------
// Demo pipeline: happy path, artifacts, journal, cost
// ---------------------------------------------------------------------------

test("demo: full run completes with correct artifacts", async () => {
  const ctx = makeCtx(tmpDir("run"), DEMO_DIR, { answers: DEMO_ANSWERS });
  const result = await runLoop(ctx);
  assert.equal(result.status, "completed");

  const readme = fs.readFileSync(path.join(ctx.workspace, "artifacts/render/README.md"), "utf8");
  assert.match(readme, /# Build plan for Demo App/);
  assert.match(readme, /- Overview/);

  const plan = JSON.parse(
    fs.readFileSync(path.join(ctx.workspace, "artifacts/plan/plan.json"), "utf8"),
  );
  assert.equal(plan.title, "Build plan for Demo App");
  assert.ok(plan.sections.length >= 3);

  const intake = JSON.parse(
    fs.readFileSync(path.join(ctx.workspace, "artifacts/intake/intake.json"), "utf8"),
  );
  assert.equal(intake.project_name, "Demo App");
});

test("demo: journal records cost for every node and gate provenance", async () => {
  const ctx = makeCtx(tmpDir("journal"), DEMO_DIR, { answers: DEMO_ANSWERS });
  await runLoop(ctx);

  const costEvents = events(ctx, "cost.recorded");
  assert.equal(costEvents.length, 4, "one cost record per node");
  for (const e of costEvents) {
    assert.ok(e.cost.wallClockMs >= 0);
    assert.equal(e.cost.costUsd, 0, "mock mode spends nothing");
  }

  const gate = events(ctx, "gate.answered")[0];
  assert.equal(gate.source, "recorded", "replayed answers are marked as recorded");

  const state = foldState(ctx.journal.read());
  assert.equal(state.totalCostUsd, 0);
  assert.equal(events(ctx, "run.completed").length, 1);
});

// ---------------------------------------------------------------------------
// Park / resume
// ---------------------------------------------------------------------------

test("gate parks without answers, resumes with them, and resume is idempotent", async () => {
  const workspace = tmpDir("park");

  const parked = await runLoop(makeCtx(workspace, DEMO_DIR, {}));
  assert.equal(parked.status, "parked");
  assert.equal(parked.parkedNodeId, "intake");
  assert.ok(!fs.existsSync(path.join(workspace, "artifacts/intake")), "nothing committed while parked");

  const resumed = makeCtx(workspace, DEMO_DIR, { answers: DEMO_ANSWERS });
  assert.equal((await runLoop(resumed)).status, "completed");

  // Resume of a completed run: immediately completed, zero re-execution.
  const before = events(resumed, "node.running").length;
  const again = makeCtx(workspace, DEMO_DIR, { answers: DEMO_ANSWERS });
  assert.equal((await runLoop(again)).status, "completed");
  assert.equal(events(again, "node.running").length, before, "no node re-ran on idempotent resume");
});

test("mid-run park: committed nodes are skipped on resume", async () => {
  const dir = writeFixture(
    tmpDir("midpark-pt"),
    [
      "name: midpark",
      "version: 0.0.1",
      "nodes:",
      "  - id: first",
      "    kind: deterministic",
      '    command: node "$HARNESS_PROJECT_DIR/first.cjs"',
      "    outputs: [{name: a, file: a.json}]",
      "  - id: ask",
      "    kind: gate",
      "    deps: [first]",
      "    questions: [{id: q, prompt: 'q?'}]",
      "    outputs: [{name: ans, file: ans.json}]",
    ].join("\n"),
    { "first.cjs": 'require("node:fs").writeFileSync("a.json", "{}");' },
  );
  const workspace = tmpDir("midpark-ws");

  const parked = await runLoop(makeCtx(workspace, dir, {}));
  assert.equal(parked.status, "parked");
  assert.equal(parked.parkedNodeId, "ask");

  const resumed = makeCtx(workspace, dir, { answers: { ask: { q: "yes" } } });
  assert.equal((await runLoop(resumed)).status, "completed");
  const firstRuns = events(resumed, "node.running").filter((e) => e.nodeId === "first");
  assert.equal(firstRuns.length, 1, "committed node did not re-run after resume");
});

// ---------------------------------------------------------------------------
// Contract enforcement + retry-with-feedback
// ---------------------------------------------------------------------------

const FLAKY_FILES = {
  "prompt.md": "produce out.json",
  "out.schema.json": JSON.stringify({
    type: "object",
    properties: { ok: { type: "boolean", const: true } },
    required: ["ok"],
  }),
  "mock.cjs": [
    'const fs = require("node:fs");',
    "// First attempt has no feedback and produces a contract-violating artifact;",
    "// the retry sees feedback.md and corrects itself.",
    'if (fs.existsSync("feedback.md")) {',
    '  fs.writeFileSync("out.json", JSON.stringify({ ok: true }));',
    "} else {",
    '  fs.writeFileSync("out.json", JSON.stringify({ wrong: true }));',
    "}",
  ].join("\n"),
};

const FLAKY_DAG = [
  "name: flaky",
  "version: 0.0.1",
  "nodes:",
  "  - id: work",
  "    kind: agent",
  "    prompt: prompt.md",
  '    mock: node "$HARNESS_PROJECT_DIR/mock.cjs"',
  "    retries: 2",
  "    outputs: [{name: out, file: out.json, schema: out.schema.json}]",
].join("\n");

test("retry-with-feedback: contract failure is fed back and the retry succeeds", async () => {
  const dir = writeFixture(tmpDir("flaky-pt"), FLAKY_DAG, FLAKY_FILES);
  const ctx = makeCtx(tmpDir("flaky-ws"), dir, {});
  const result = await runLoop(ctx);

  assert.equal(result.status, "completed");
  assert.equal(events(ctx, "node.attempt_failed").length, 1);
  assert.match(String(events(ctx, "node.attempt_failed")[0].error), /must be equal to constant|ok/);

  const out = JSON.parse(fs.readFileSync(path.join(ctx.workspace, "artifacts/work/out.json"), "utf8"));
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(ctx.workspace, "attempts/work-2/feedback.md")), "retry attempt received feedback");
});

test("retries exhausted: persistent contract violation fails the node and run", async () => {
  const files = { ...FLAKY_FILES, "mock.cjs": 'require("node:fs").writeFileSync("out.json", JSON.stringify({ wrong: true }));' };
  const dir = writeFixture(tmpDir("bad-pt"), FLAKY_DAG.replace("retries: 2", "retries: 1"), files);
  const ctx = makeCtx(tmpDir("bad-ws"), dir, {});
  const result = await runLoop(ctx);

  assert.equal(result.status, "failed");
  assert.equal(result.failedNodeId, "work");
  assert.equal(events(ctx, "node.attempt_failed").length, 2, "retries:1 = 2 attempts");
  assert.equal(events(ctx, "node.failed").length, 1);
  assert.ok(!fs.existsSync(path.join(ctx.workspace, "artifacts/work")), "nothing committed on failure");
});

test("contract: non-JSON output against a schema is rejected", async () => {
  const files = { ...FLAKY_FILES, "mock.cjs": 'require("node:fs").writeFileSync("out.json", "definitely not json");' };
  const dir = writeFixture(tmpDir("nj-pt"), FLAKY_DAG.replace("retries: 2", "retries: 0"), files);
  const ctx = makeCtx(tmpDir("nj-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "failed");
  assert.match(String(events(ctx, "node.attempt_failed")[0].error), /not valid JSON/);
});

test("contract: missing declared artifact is rejected", async () => {
  const files = { ...FLAKY_FILES, "mock.cjs": "// writes nothing" };
  const dir = writeFixture(tmpDir("miss-pt"), FLAKY_DAG.replace("retries: 2", "retries: 0"), files);
  const ctx = makeCtx(tmpDir("miss-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "failed");
  assert.match(String(events(ctx, "node.attempt_failed")[0].error), /missing declared artifact: out.json/);
});

test("gate answers are contract-checked too", async () => {
  const dir = writeFixture(
    tmpDir("gate-pt"),
    [
      "name: gatecheck",
      "version: 0.0.1",
      "nodes:",
      "  - id: intake",
      "    kind: gate",
      "    questions: [{id: name, prompt: 'name?'}]",
      "    outputs: [{name: intake, file: intake.json, schema: intake.schema.json}]",
    ].join("\n"),
    {
      "intake.schema.json": JSON.stringify({
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
      }),
    },
  );
  const ctx = makeCtx(tmpDir("gate-ws"), dir, { answers: { intake: { name: "" } } });
  const result = await runLoop(ctx);
  assert.equal(result.status, "failed", "empty answer violates minLength contract");
  assert.match(String(events(ctx, "node.attempt_failed")[0].error), /fewer than 1 characters|minLength/);
});

// ---------------------------------------------------------------------------
// Verifier + deterministic failure modes
// ---------------------------------------------------------------------------

test("verifier: non-zero exit fails the run with captured output", async () => {
  const dir = writeFixture(
    tmpDir("ver-pt"),
    `name: ver\nversion: 0.0.1\nnodes:\n  - {id: check, kind: verifier, retries: 0, command: node -e "console.error('boom'); process.exit(3)"}\n`,
  );
  const ctx = makeCtx(tmpDir("ver-ws"), dir, {});
  const result = await runLoop(ctx);
  assert.equal(result.status, "failed");
  const err = String(events(ctx, "node.attempt_failed")[0].error);
  assert.match(err, /exited with 3/);
  assert.match(err, /boom/);
});

test("deterministic: crashing command fails cleanly", async () => {
  const dir = writeFixture(
    tmpDir("det-pt"),
    `name: det\nversion: 0.0.1\nnodes:\n  - {id: d, kind: deterministic, retries: 0, command: definitely-not-a-real-command-xyz}\n`,
  );
  const ctx = makeCtx(tmpDir("det-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "failed");
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

function cli(args, opts = {}) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "packages/cli/dist/index.js"), ...args],
    { encoding: "utf8", cwd: REPO_ROOT, ...opts },
  );
}

test("cli: run + status against the demo pipeline", () => {
  const workspace = tmpDir("cli-ws");
  const run = cli([
    "run", DEMO_DIR,
    "--workspace", workspace,
    "--answers", path.join(DEMO_DIR, "fixtures/answers.json"),
    "--mock-agents",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /run completed/);
  assert.match(run.stdout, /total cost: \$0\.0000/);

  const status = cli(["status", workspace]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /verify\s+verifier\s+committed/);
});

test("cli: unknown command exits non-zero, bare invocation prints usage", () => {
  assert.notEqual(cli(["frobnicate"]).status, 0);
  const bare = cli([]);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /usage: harness/);
});

test("cli: failed run exits 1", () => {
  const dir = writeFixture(
    tmpDir("clifail-pt"),
    `name: f\nversion: 0.0.1\nnodes:\n  - {id: x, kind: verifier, retries: 0, command: node -e "process.exit(1)"}\n`,
  );
  const run = cli(["run", dir, "--workspace", tmpDir("clifail-ws")]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /run failed/);
});

// ---------------------------------------------------------------------------
// Budget enforcement (cost envelope is enforced, not advisory)
// ---------------------------------------------------------------------------

const COSTED_FILES = {
  "prompt.md": "produce out.json",
  "out.schema.json": JSON.stringify({ type: "object", required: ["ok"] }),
  "mock.cjs": [
    'const fs = require("node:fs");',
    'fs.writeFileSync("out.json", JSON.stringify({ ok: true }));',
    'fs.writeFileSync("cost.json", JSON.stringify({ costUsd: 0.6, inputTokens: 1000, outputTokens: 200, model: "test-model" }));',
  ].join("\n"),
};

function costedDag({ runBudget, nodeBudget, nodeCount = 1 } = {}) {
  const lines = ["name: costed", "version: 0.0.1"];
  if (runBudget !== undefined || nodeBudget !== undefined) {
    lines.push("cost:");
    if (runBudget !== undefined) lines.push(`  run_budget_usd: ${runBudget}`);
    if (nodeBudget !== undefined) lines.push("  nodes:", `    work1: { budget_usd: ${nodeBudget} }`);
  }
  lines.push("nodes:");
  for (let i = 1; i <= nodeCount; i++) {
    lines.push(
      `  - id: work${i}`,
      "    kind: agent",
      "    prompt: prompt.md",
      '    mock: node "$HARNESS_PROJECT_DIR/mock.cjs"',
      "    retries: 0",
      "    outputs: [{name: out" + i + ", file: out.json, schema: out.schema.json}]",
    );
    if (i > 1) lines.push(`    deps: [work${i - 1}]`);
  }
  return lines.join("\n");
}

test("cost.json from a payload flows into the ledger with full attribution", async () => {
  const dir = writeFixture(tmpDir("cost-pt"), costedDag(), COSTED_FILES);
  const ctx = makeCtx(tmpDir("cost-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "completed");

  const cost = events(ctx, "cost.recorded")[0].cost;
  assert.equal(cost.costUsd, 0.6);
  assert.equal(cost.inputTokens, 1000);
  assert.equal(cost.outputTokens, 200);
  assert.equal(cost.model, "test-model");
  assert.equal(foldState(ctx.journal.read()).totalCostUsd, 0.6);
});

test("node budget: an overspending node escalates without committing or retrying", async () => {
  const dir = writeFixture(tmpDir("nb-pt"), costedDag({ nodeBudget: 0.5 }), COSTED_FILES);
  const ctx = makeCtx(tmpDir("nb-ws"), dir, {});
  const result = await runLoop(ctx);

  assert.equal(result.status, "failed");
  const breach = events(ctx, "budget.exceeded")[0];
  assert.equal(breach.scope, "node");
  assert.equal(breach.nodeId, "work1");
  assert.equal(breach.budgetUsd, 0.5);
  assert.ok(breach.spentUsd > 0.5);
  assert.ok(!fs.existsSync(path.join(ctx.workspace, "artifacts/work1")), "breaching node never commits");
});

test("run budget: pre-dispatch gate blocks the next node once spend reaches the cap", async () => {
  // work1 spends 0.6 against a 0.5 run budget -> work2 must never be dispatched.
  const dir = writeFixture(tmpDir("rb-pt"), costedDag({ runBudget: 0.5, nodeCount: 2 }), COSTED_FILES);
  const ctx = makeCtx(tmpDir("rb-ws"), dir, {});
  const result = await runLoop(ctx);

  assert.equal(result.status, "failed");
  assert.equal(result.failedNodeId, "work2");
  const breach = events(ctx, "budget.exceeded")[0];
  assert.equal(breach.scope, "run");
  assert.equal(breach.blockedNodeId, "work2");
  assert.ok(fs.existsSync(path.join(ctx.workspace, "artifacts/work1")), "work under budget committed");
  assert.equal(events(ctx, "node.running").filter((e) => e.nodeId === "work2").length, 0, "work2 never dispatched");
});

test("budgets absent or generous: runs complete and record spend normally", async () => {
  const dir = writeFixture(tmpDir("ok-pt"), costedDag({ runBudget: 10, nodeBudget: 5, nodeCount: 2 }), COSTED_FILES);
  const ctx = makeCtx(tmpDir("ok-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "completed");
  assert.equal(events(ctx, "budget.exceeded").length, 0);
  assert.equal(foldState(ctx.journal.read()).totalCostUsd, 1.2);
});
