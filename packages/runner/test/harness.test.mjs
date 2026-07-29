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

import { Journal, downstreamClosure, foldState, loadProjectType, reviseNode, runLoop } from "../dist/index.js";

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

function makeCtx(workspace, projectTypeDir, { answers, mockAgents = true, acceptDefaults = true } = {}) {
  fs.mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    projectTypeDir,
    def: loadProjectType(projectTypeDir),
    journal: new Journal(workspace),
    answers,
    mockAgents,
    acceptDefaults,
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

test("node budget: finished work commits even over budget; the breach is recorded loudly", async () => {
  const dir = writeFixture(tmpDir("nb-pt"), costedDag({ nodeBudget: 0.5 }), COSTED_FILES);
  const ctx = makeCtx(tmpDir("nb-ws"), dir, {});
  const result = await runLoop(ctx);

  // The attempt cost 0.6 against a 0.5 cap — but the work FINISHED and
  // validated. Discarding it would double the loss; it commits, with the
  // overrun visible in the ledger.
  assert.equal(result.status, "completed");
  assert.ok(fs.existsSync(path.join(ctx.workspace, "artifacts/work1")), "bought-and-finished work is never shredded");
  const breach = events(ctx, "budget.exceeded")[0];
  assert.equal(breach.scope, "node");
  assert.equal(breach.committed, true);
  assert.ok(breach.spentUsd > 0.5);
});

test("node budget: exhausted budget blocks the NEXT attempt from starting", async () => {
  // The mock fails validation (bad artifact) while spending 0.6 of a 0.5 cap;
  // retries are configured but the budget gate must refuse attempt 2.
  const dir = writeFixture(tmpDir("nbf-pt"), costedDag({ nodeBudget: 0.5 }).replace("retries: 0", "retries: 3"), {
    ...COSTED_FILES,
    "mock.cjs": COSTED_FILES["mock.cjs"].replace('{ ok: true }', '{ wrong_field: 1 }'),
  });
  const ctx = makeCtx(tmpDir("nbf-ws"), dir, {});
  const result = await runLoop(ctx);

  assert.equal(result.status, "failed");
  assert.equal(events(ctx, "node.running").length, 1, "only one attempt ran — budget gated the second");
  const breach = events(ctx, "budget.exceeded")[0];
  assert.equal(breach.blockedAttempt, 2);
});

test("retry continuity: attempt 2 continues from attempt 1's working files", async () => {
  const dir = writeFixture(
    tmpDir("cont-pt"),
    [
      "name: cont",
      "version: 0.0.1",
      "nodes:",
      "  - id: work",
      "    kind: agent",
      "    prompt: p.md",
      '    mock: node "$HARNESS_PROJECT_DIR/mock.cjs"',
      "    retries: 2",
      "    outputs: [{name: out, file: out.json}]",
    ].join("\n"),
    {
      "p.md": "build",
      // Attempt 1: leaves partial work, produces no artifact (fails validation).
      // Attempt 2: finds the partial work and completes it — only possible
      // because the working tree carried over.
      "mock.cjs": `const fs = require("node:fs");
if (!fs.existsSync("partial.txt")) {
  fs.writeFileSync("partial.txt", "expensive groundwork from attempt 1");
} else {
  fs.writeFileSync("out.json", JSON.stringify({ continued_from: fs.readFileSync("partial.txt", "utf8") }));
}
`,
    },
  );
  const ctx = makeCtx(tmpDir("cont-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "completed");
  assert.equal(events(ctx, "node.running").length, 2, "took exactly two attempts");
  const out = JSON.parse(fs.readFileSync(path.join(ctx.workspace, "artifacts/work/out.json"), "utf8"));
  assert.equal(out.continued_from, "expensive groundwork from attempt 1", "attempt 2 built on attempt 1's files");
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

// ---------------------------------------------------------------------------
// Phase 1 runner features: dir artifacts, gate defaults, dynamic questions,
// question budgets, conditional skipping
// ---------------------------------------------------------------------------

test("directory artifacts: validated and committed recursively", async () => {
  const dir = writeFixture(
    tmpDir("dir-pt"),
    [
      "name: dirs",
      "version: 0.0.1",
      "nodes:",
      "  - id: make",
      "    kind: deterministic",
      '    command: node "$HARNESS_PROJECT_DIR/make.cjs"',
      "    outputs: [{name: tree, file: out, dir: true}]",
      "  - id: use",
      "    kind: verifier",
      "    deps: [make]",
      '    command: node "$HARNESS_PROJECT_DIR/use.cjs"',
    ].join("\n"),
    {
      "make.cjs": [
        'const fs = require("node:fs");',
        'fs.mkdirSync("out/nested", { recursive: true });',
        'fs.writeFileSync("out/a.txt", "alpha");',
        'fs.writeFileSync("out/nested/b.txt", "beta");',
      ].join("\n"),
      "use.cjs": [
        'const fs = require("node:fs");',
        'const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));',
        'const base = inputs.tree.path;',
        'if (fs.readFileSync(base + "/nested/b.txt", "utf8") !== "beta") process.exit(1);',
      ].join("\n"),
    },
  );
  const ctx = makeCtx(tmpDir("dir-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "completed");
  assert.equal(
    fs.readFileSync(path.join(ctx.workspace, "artifacts/make/out/nested/b.txt"), "utf8"),
    "beta",
  );
});

test("dir artifact contract: file where directory expected is rejected", async () => {
  const dir = writeFixture(
    tmpDir("dirbad-pt"),
    [
      "name: dirbad",
      "version: 0.0.1",
      "nodes:",
      "  - id: make",
      "    kind: deterministic",
      "    retries: 0",
      '    command: node "$HARNESS_PROJECT_DIR/make.cjs"',
      "    outputs: [{name: tree, file: out, dir: true}]",
    ].join("\n"),
    { "make.cjs": 'require("node:fs").writeFileSync("out", "just a file");' },
  );
  const ctx = makeCtx(tmpDir("dirbad-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "failed");
  assert.match(String(events(ctx, "node.attempt_failed")[0].error), /expected a directory/);
});

test("gate defaults: unanswered questions with defaults auto-answer (accept-defaults path)", async () => {
  const dir = writeFixture(
    tmpDir("def-pt"),
    [
      "name: defaults",
      "version: 0.0.1",
      "nodes:",
      "  - id: ask",
      "    kind: gate",
      "    questions:",
      "      - {id: name, prompt: 'name?'}",
      "      - {id: mode, prompt: 'mode?', default: local, why: 'decides deploy path'}",
      "    outputs: [{name: ans, file: ans.json}]",
    ].join("\n"),
  );
  const ctx = makeCtx(tmpDir("def-ws"), dir, { answers: { ask: { name: "X" } } });
  assert.equal((await runLoop(ctx)).status, "completed");
  const ans = JSON.parse(fs.readFileSync(path.join(ctx.workspace, "artifacts/ask/ans.json"), "utf8"));
  assert.equal(ans.mode, "local", "default filled in");
  assert.equal(events(ctx, "gate.answered")[0].source, "mixed");

  // No recorded answers at all -> defaults alone answer what they can; the
  // defaultless question parks the run.
  const ctx2 = makeCtx(tmpDir("def-ws2"), dir, {});
  assert.equal((await runLoop(ctx2)).status, "parked");
});

test("questionsFrom: gate reads dynamic questions from an upstream artifact", async () => {
  const dir = writeFixture(
    tmpDir("qf-pt"),
    [
      "name: qf",
      "version: 0.0.1",
      "nodes:",
      "  - id: gaps",
      "    kind: deterministic",
      '    command: node "$HARNESS_PROJECT_DIR/gaps.cjs"',
      "    outputs: [{name: gaps, file: gaps.json}]",
      "  - id: clarify",
      "    kind: gate",
      "    deps: [gaps]",
      "    questionsFrom: {artifact: gaps}",
      "    outputs: [{name: answers, file: answers.json}]",
    ].join("\n"),
    {
      "gaps.cjs":
        'require("node:fs").writeFileSync("gaps.json", JSON.stringify({ questions: [' +
        '{id: "auth", prompt: "Need auth?", default: "yes", why: "decides auth module"},' +
        '{id: "region", prompt: "Which region?", default: "us-central1", why: "decides deploy config"}' +
        "] }));",
    },
  );
  const ctx = makeCtx(tmpDir("qf-ws"), dir, { answers: { clarify: { auth: "no" } } });
  assert.equal((await runLoop(ctx)).status, "completed");
  const ans = JSON.parse(
    fs.readFileSync(path.join(ctx.workspace, "artifacts/clarify/answers.json"), "utf8"),
  );
  assert.equal(ans.auth, "no", "recorded answer wins over default");
  assert.equal(ans.region, "us-central1", "default fills the rest");
});

test("question budget: an over-asking gate fails certification-style, never nags", async () => {
  const dir = writeFixture(
    tmpDir("qb-pt"),
    [
      "name: qb",
      "version: 0.0.1",
      "interaction: {max_questions_per_gate: 2}",
      "nodes:",
      "  - id: gaps",
      "    kind: deterministic",
      '    command: node "$HARNESS_PROJECT_DIR/gaps.cjs"',
      "    outputs: [{name: gaps, file: gaps.json}]",
      "  - id: clarify",
      "    kind: gate",
      "    retries: 0",
      "    deps: [gaps]",
      "    questionsFrom: {artifact: gaps}",
      "    outputs: [{name: answers, file: answers.json}]",
    ].join("\n"),
    {
      "gaps.cjs":
        'require("node:fs").writeFileSync("gaps.json", JSON.stringify({ questions: ' +
        'Array.from({length: 5}, (_, i) => ({id: "q" + i, prompt: "?" + i, default: "d"})) }));',
    },
  );
  const ctx = makeCtx(tmpDir("qb-ws"), dir, {});
  const result = await runLoop(ctx);
  assert.equal(result.status, "failed");
  const breach = events(ctx, "budget.exceeded")[0];
  assert.equal(breach.scope, "questions");
  assert.equal(breach.budget, 2);
  assert.equal(breach.asked, 5);
});

test("when: unmet condition skips the node; met condition runs it", async () => {
  const dag = (target) =>
    [
      "name: cond",
      "version: 0.0.1",
      "nodes:",
      "  - id: config",
      "    kind: deterministic",
      `    command: node "$HARNESS_PROJECT_DIR/config.cjs" ${target}`,
      "    outputs: [{name: config, file: config.json}]",
      "  - id: deploy",
      "    kind: deterministic",
      "    deps: [config]",
      "    when: {artifact: config, path: deploy_target, equals: cloud-run}",
      '    command: node "$HARNESS_PROJECT_DIR/deploy.cjs"',
      "    outputs: [{name: deployed, file: deployed.json}]",
    ].join("\n");
  const files = {
    "config.cjs":
      'require("node:fs").writeFileSync("config.json", JSON.stringify({ deploy_target: process.argv[2] }));',
    "deploy.cjs": 'require("node:fs").writeFileSync("deployed.json", "{}");',
  };

  const skipDir = writeFixture(tmpDir("when-skip-pt"), dag("local"), files);
  const skipCtx = makeCtx(tmpDir("when-skip-ws"), skipDir, {});
  assert.equal((await runLoop(skipCtx)).status, "completed");
  assert.equal(events(skipCtx, "node.skipped")[0].nodeId, "deploy");
  assert.ok(!fs.existsSync(path.join(skipCtx.workspace, "artifacts/deploy")));

  const runDir = writeFixture(tmpDir("when-run-pt"), dag("cloud-run"), files);
  const runCtx = makeCtx(tmpDir("when-run-ws"), runDir, {});
  assert.equal((await runLoop(runCtx)).status, "completed");
  assert.equal(events(runCtx, "node.skipped").length, 0);
  assert.ok(fs.existsSync(path.join(runCtx.workspace, "artifacts/deploy/deployed.json")));
});

test("defaults require confirmation: without acceptDefaults a defaulted gate parks for the human", async () => {
  const dir = writeFixture(
    tmpDir("confirm-pt"),
    [
      "name: confirm",
      "version: 0.0.1",
      "nodes:",
      "  - id: ask",
      "    kind: gate",
      "    questions:",
      "      - {id: mode, prompt: 'mode?', default: local}",
      "    outputs: [{name: ans, file: ans.json}]",
    ].join("\n"),
  );
  // Unattended replay: default applies silently.
  const replay = makeCtx(tmpDir("confirm-ws1"), dir, { acceptDefaults: true });
  assert.equal((await runLoop(replay)).status, "completed");
  assert.equal(events(replay, "gate.answered")[0].source, "default");

  // Human-in-the-loop (non-TTY, e.g. dashboard): parks so the form can show
  // the default for confirmation instead of silently assuming it.
  const hitl = makeCtx(tmpDir("confirm-ws2"), dir, { acceptDefaults: false });
  assert.equal((await runLoop(hitl)).status, "parked");
});

test("model tiering: escalate-on-retry picks the stronger model only for retries", async () => {
  const { modelForAttempt } = await import("../dist/index.js");
  const node = { id: "x", kind: "agent", model: "claude-sonnet-5", escalateModel: "claude-opus-5" };
  assert.equal(modelForAttempt(node, 1), "claude-sonnet-5");
  assert.equal(modelForAttempt(node, 2), "claude-opus-5");
  assert.equal(modelForAttempt(node, 3), "claude-opus-5");
  assert.equal(modelForAttempt({ ...node, escalateModel: undefined }, 2), "claude-sonnet-5");
  assert.equal(modelForAttempt({ id: "y", kind: "agent" }, 1), undefined);
});

test("per-node verify: failing exit criteria feed the retry loop and block commit", async () => {
  const dir = writeFixture(
    tmpDir("verify-pt"),
    [
      "name: nodeverify",
      "version: 0.0.1",
      "nodes:",
      "  - id: work",
      "    kind: agent",
      "    prompt: prompt.md",
      '    mock: node "$HARNESS_PROJECT_DIR/mock.cjs"',
      '    verify: node "$HARNESS_PROJECT_DIR/check.cjs"',
      "    retries: 2",
      "    outputs: [{name: out, file: out.txt}]",
    ].join("\n"),
    {
      "prompt.md": "produce out.txt",
      // First attempt writes a failing artifact; the retry (seeing feedback) corrects.
      "mock.cjs": [
        'const fs = require("node:fs");',
        'fs.writeFileSync("out.txt", fs.existsSync("feedback.md") ? "VALID" : "BROKEN");',
      ].join("\n"),
      "check.cjs": [
        'const fs = require("node:fs");',
        'if (fs.readFileSync("out.txt", "utf8") !== "VALID") { console.error("content check failed: not VALID"); process.exit(1); }',
      ].join("\n"),
    },
  );
  const ctx = makeCtx(tmpDir("verify-ws"), dir, {});
  assert.equal((await runLoop(ctx)).status, "completed");
  const fail = events(ctx, "node.attempt_failed")[0];
  assert.match(String(fail.error), /verification failed/);
  assert.match(String(fail.error), /not VALID/);
  assert.equal(fs.readFileSync(path.join(ctx.workspace, "artifacts/work/out.txt"), "utf8"), "VALID");

  // Always-failing verification: node never commits.
  const badDir = writeFixture(
    tmpDir("verify-bad-pt"),
    [
      "name: nv2",
      "version: 0.0.1",
      "nodes:",
      "  - id: work",
      "    kind: agent",
      "    prompt: prompt.md",
      '    mock: node "$HARNESS_PROJECT_DIR/mock.cjs"',
      '    verify: node -e "process.exit(1)"',
      "    retries: 0",
      "    outputs: [{name: out, file: out.txt}]",
    ].join("\n"),
    { "prompt.md": "x", "mock.cjs": 'require("node:fs").writeFileSync("out.txt", "anything");' },
  );
  const badCtx = makeCtx(tmpDir("verify-bad-ws"), badDir, {});
  assert.equal((await runLoop(badCtx)).status, "failed");
  assert.ok(!fs.existsSync(path.join(badCtx.workspace, "artifacts/work")), "never commits on failed verification");
});

test("reopen-on-resume: a failed node retries after the environment is fixed", async () => {
  const dir = writeFixture(
    tmpDir("reopen-pt"),
    [
      "name: reopen",
      "version: 0.0.1",
      "nodes:",
      "  - id: fragile",
      "    kind: verifier",
      "    retries: 0",
      '    command: test -f "$HARNESS_PROJECT_DIR/fixed.marker"',
    ].join("\n"),
  );
  const workspace = tmpDir("reopen-ws");

  const first = makeCtx(workspace, dir, {});
  assert.equal((await runLoop(first)).status, "failed");

  // "Fix the issue" (here: create the marker), then resume with reopen.
  fs.writeFileSync(path.join(dir, "fixed.marker"), "");
  const second = makeCtx(workspace, dir, {});
  const { reopenFailed } = await import("../dist/index.js");
  assert.deepEqual(reopenFailed(second), ["fragile"]);
  assert.equal((await runLoop(second)).status, "completed");

  // Attempt numbering continued across the reopen (no attempt-dir collision).
  const attempts = events(second, "node.running").map((e) => e.attempt);
  assert.deepEqual(attempts, [1, 2]);
});

test("askUserViaWorkspace: resolves when the dashboard writes the matching answer", async () => {
  const { askUserViaWorkspace, Journal } = await import("../dist/index.js");
  const workspace = tmpDir("askuser");
  const ctx = { workspace, journal: new Journal(workspace), acceptDefaults: false, mockAgents: false };

  const waiter = askUserViaWorkspace(ctx, "build", 1, { questions: [{ question: "Proceed?" }] }, 8000, 100);
  // Simulate the dashboard: read the pending file, write the answer.
  await new Promise((r) => setTimeout(r, 300));
  const pending = JSON.parse(fs.readFileSync(path.join(workspace, "pending-question.json"), "utf8"));
  assert.equal(pending.nodeId, "build");
  fs.writeFileSync(
    path.join(workspace, "pending-answer.json"),
    JSON.stringify({ id: pending.id, answers: { "Proceed?": "yes" } }),
  );
  const answers = await waiter;
  assert.deepEqual(answers, { "Proceed?": "yes" });
  assert.ok(!fs.existsSync(path.join(workspace, "pending-question.json")), "pending file cleaned up");

  // Unattended contexts never wait.
  const none = await askUserViaWorkspace({ ...ctx, acceptDefaults: true }, "x", 1, {}, 500, 50);
  assert.equal(none, null);
});

// ---------------------------------------------------------------------------
// User-initiated revision: cascade reopen + feedback delivery + memoization
// ---------------------------------------------------------------------------

const REVISE_DAG = `name: rev
version: 0.0.1
nodes:
  - id: a
    kind: deterministic
    command: "echo run >> \\"$HARNESS_WORKSPACE/a-runs.txt\\" && printf '{\\"v\\":1}' > out.json"
    outputs: [{name: aout, file: out.json}]
  - id: b
    kind: deterministic
    deps: [a]
    command: "echo run >> \\"$HARNESS_WORKSPACE/b-runs.txt\\" && if [ -f feedback.md ]; then cp feedback.md \\"$HARNESS_WORKSPACE/b-feedback-seen.md\\"; fi && printf '{\\"w\\":2}' > out.json"
    outputs: [{name: bout, file: out.json}]
  - id: c
    kind: deterministic
    deps: [b]
    command: "echo run >> \\"$HARNESS_WORKSPACE/c-runs.txt\\" && printf done > done.txt"
    outputs: [{name: cout, file: done.txt}]
`;

function runCount(ws, node) {
  const f = path.join(ws, `${node}-runs.txt`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").length : 0;
}

test("revise: cascade reopens the node + downstream, delivers feedback, and re-uses unchanged results", async () => {
  const dir = writeFixture(tmpDir("revise"), REVISE_DAG);
  const ws = tmpDir("revise-ws");
  const ctx = makeCtx(ws, dir);
  assert.equal((await runLoop(ctx)).status, "completed");
  assert.deepEqual([runCount(ws, "a"), runCount(ws, "b"), runCount(ws, "c")], [1, 1, 1]);

  // Closure math: revising b touches b and c, never a.
  assert.deepEqual(downstreamClosure(ctx.def, "b"), ["b", "c"]);

  const { reopened } = reviseNode(ctx, "b", "please tweak the output");
  assert.deepEqual(reopened, ["b", "c"]);
  const state = foldState(ctx.journal.read());
  assert.ok(state.committed.has("a"), "upstream stays committed");
  assert.ok(!state.committed.has("b") && !state.committed.has("c"), "closure reopened");

  assert.equal((await runLoop(ctx)).status, "completed");
  // b re-ran WITH the user's feedback; its output was byte-identical, so c
  // was re-used from cache (memoization) instead of re-running.
  assert.deepEqual([runCount(ws, "a"), runCount(ws, "b"), runCount(ws, "c")], [1, 2, 1]);
  const seen = fs.readFileSync(path.join(ws, "b-feedback-seen.md"), "utf8");
  assert.match(seen, /please tweak the output/);
  assert.match(seen, /previously committed output/, "prior artifact offered as the starting point");
  const cached = ctx.journal.read().filter((e) => e.type === "node.committed" && e.cached === true);
  assert.deepEqual(cached.map((e) => e.nodeId), ["c"], "only the unchanged dependent is cached");
});

test("revise: guards — unknown node and never-run node are rejected", async () => {
  const dir = writeFixture(tmpDir("revise-g"), REVISE_DAG);
  const ws = tmpDir("revise-g-ws");
  const ctx = makeCtx(ws, dir);
  assert.throws(() => reviseNode(ctx, "nope", "x"), /unknown node/);
  assert.throws(() => reviseNode(ctx, "a", "x"), /has not run yet/);
});

test("revise: a revised gate re-asks — its recorded dashboard answer is dropped", async () => {
  const dir = writeFixture(
    tmpDir("revise-gate"),
    `name: rg
version: 0.0.1
nodes:
  - id: g
    kind: gate
    questions: [{id: q, prompt: "Proceed?", default: "yes"}]
    outputs: [{name: ans, file: answers.json}]
`,
  );
  const ws = tmpDir("revise-gate-ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "ui-answers.json"), JSON.stringify({ g: { q: "yes" }, other: { x: "1" } }));
  const ctx = makeCtx(ws, dir, { answers: { g: { q: "yes" } } });
  assert.equal((await runLoop(ctx)).status, "completed");

  reviseNode(ctx, "g", "I want to reconsider this decision");
  const ui = JSON.parse(fs.readFileSync(path.join(ws, "ui-answers.json"), "utf8"));
  assert.equal(ui.g, undefined, "revised gate's recorded answer dropped");
  assert.deepEqual(ui.other, { x: "1" }, "other answers untouched");
});

// ---------------------------------------------------------------------------
// Subagent teams: certified data, validated at load
// ---------------------------------------------------------------------------

test("validation: a subagent team without the Task tool is rejected (unreachable team)", () => {
  const dir = writeFixture(
    tmpDir("team-notask"),
    [
      "name: t",
      "version: 0.0.1",
      "nodes:",
      "  - id: a",
      "    kind: agent",
      "    prompt: p.md",
      "    agents:",
      "      helper: {description: helps, prompt: help me}",
      "    outputs: [{name: x, file: x.json}]",
    ].join("\n"),
    { "p.md": "do" },
  );
  assert.throws(() => loadProjectType(dir), /Task/);
});

test("validation: malformed subagent (missing prompt) is rejected", () => {
  const dir = writeFixture(
    tmpDir("team-bad"),
    [
      "name: t",
      "version: 0.0.1",
      "nodes:",
      "  - id: a",
      "    kind: agent",
      "    prompt: p.md",
      "    allowedTools: [Read, Task]",
      "    agents:",
      "      helper: {description: helps}",
      "    outputs: [{name: x, file: x.json}]",
    ].join("\n"),
    { "p.md": "do" },
  );
  assert.throws(() => loadProjectType(dir), /subagent 'helper'/);
});

test("validation: a well-formed subagent team loads", () => {
  const dir = writeFixture(
    tmpDir("team-ok"),
    [
      "name: t",
      "version: 0.0.1",
      "nodes:",
      "  - id: a",
      "    kind: agent",
      "    prompt: p.md",
      "    allowedTools: [Read, Write, Task]",
      "    agents:",
      "      helper: {description: helps, prompt: help me, tools: [Read]}",
      "    outputs: [{name: x, file: x.json}]",
    ].join("\n"),
    { "p.md": "do" },
  );
  const def = loadProjectType(dir);
  assert.equal(Object.keys(def.nodes[0].agents).length, 1);
});

test("validation: certified skills without the Skill tool are rejected; well-formed loads", () => {
  const base = [
    "name: t",
    "version: 0.0.1",
    "nodes:",
    "  - id: a",
    "    kind: agent",
    "    prompt: p.md",
    "    skills: [conventions]",
  ];
  const noTool = writeFixture(tmpDir("skill-notool"), [...base, "    outputs: [{name: x, file: x.json}]"].join("\n"), { "p.md": "do" });
  assert.throws(() => loadProjectType(noTool), /Skill/);

  const ok = writeFixture(
    tmpDir("skill-ok"),
    [...base, "    allowedTools: [Read, Skill]", "    outputs: [{name: x, file: x.json}]"].join("\n"),
    { "p.md": "do" },
  );
  assert.deepEqual(loadProjectType(ok).nodes[0].skills, ["conventions"]);
});

// ---------------------------------------------------------------------------
// MCP instances: declared capability, validated attachment
// ---------------------------------------------------------------------------

const MCP_BASE = [
  "name: t",
  "version: 0.0.1",
  "mcp:",
  '  sandbox: {server: "@harness/app-sandbox", config: {boot: "x $PORT"}}',
  "nodes:",
  "  - id: a",
  "    kind: agent",
  "    prompt: p.md",
];

test("validation: mcp attachment rules (unknown instance, no tools, orphan tool, dead config)", () => {
  const load = (extra) =>
    loadProjectType(writeFixture(tmpDir("mcp-v"), [...MCP_BASE, ...extra].join("\n"), { "p.md": "x" }));

  assert.throws(() => load(["    mcp: [ghost]", "    allowedTools: [mcp__ghost__go]", "    outputs: [{name: x, file: x.json}]"]), /unknown mcp instance 'ghost'/);
  assert.throws(() => load(["    mcp: [sandbox]", "    allowedTools: [Read]", "    outputs: [{name: x, file: x.json}]"]), /allowlists none of its tools/);
  assert.throws(() => load(["    allowedTools: [mcp__sandbox__request]", "    outputs: [{name: x, file: x.json}]"]), /without attaching mcp instance/);
  // declared but never attached = dead config
  assert.throws(() => load(["    outputs: [{name: x, file: x.json}]"]), /no node attaches it/);

  const def = load(["    mcp: [sandbox]", "    allowedTools: [Read, mcp__sandbox__request]", "    outputs: [{name: x, file: x.json}]"]);
  assert.deepEqual(def.nodes[0].mcp, ["sandbox"]);
});

// ---------------------------------------------------------------------------
// Review windows: awareness without obligation
// ---------------------------------------------------------------------------

const WINDOW_DAG = [
  "name: win",
  "version: 0.0.1",
  "nodes:",
  "  - id: work",
  "    kind: deterministic",
  '    command: node -e "require(String.fromCharCode(110,111,100,101,58,102,115)).writeFileSync(\'out.json\',\'{}\')"',
  "    outputs: [{name: out, file: out.json}]",
  "  - id: checkpoint",
  "    kind: gate",
  "    window: 3",
  "    deps: [work]",
  "    questions: [{id: verdict, prompt: 'Continue?', default: 'yes'}]",
  "    outputs: [{name: review, file: review.json}]",
].join("\n");

test("review window: unanswered checkpoint proceeds on the default after the window", async () => {
  const dir = writeFixture(tmpDir("win-pt"), WINDOW_DAG);
  const ctx = makeCtx(tmpDir("win-ws"), dir, { acceptDefaults: false, mockAgents: false });
  const t0 = Date.now();
  const result = await runLoop(ctx);
  assert.equal(result.status, "completed", "the run kept moving — no park, no human required");
  assert.ok(Date.now() - t0 >= 2500, "but it genuinely waited out the window first");
  const gate = events(ctx, "gate.answered").find((e) => e.nodeId === "checkpoint");
  assert.equal(gate.source, "window", "provenance shows this was approval-by-default, not a human");
  assert.ok(events(ctx, "gate.window_open").length === 1);
});

test("review window: an answer arriving during the window wins over the default", async () => {
  const dir = writeFixture(tmpDir("win2-pt"), WINDOW_DAG.replace("window: 3", "window: 8"));
  const ws = tmpDir("win2-ws");
  const ctx = makeCtx(ws, dir, { acceptDefaults: false, mockAgents: false });
  // Simulate the dashboard answering 1.5s into the window.
  setTimeout(() => {
    fs.writeFileSync(path.join(ws, "ui-answers.json"), JSON.stringify({ checkpoint: { verdict: "no - hold the line" } }));
  }, 1500);
  const t0 = Date.now();
  const result = await runLoop(ctx);
  assert.equal(result.status, "completed");
  assert.ok(Date.now() - t0 < 7000, "did not wait out the full window once answered");
  const gate = events(ctx, "gate.answered").find((e) => e.nodeId === "checkpoint");
  assert.equal(gate.answers.verdict, "no - hold the line", "the human's answer was used");
  assert.equal(gate.source, "recorded");
});
