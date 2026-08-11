// Pipeline-control enhancements: interrupted-node reconcile (budget/crash no
// longer hangs "running"), runtime budget overrides (raise a cap and recover
// without a full rebuild), cooperative cancel (stop a run mid-flight), and
// resume-from-failure reusing committed upstream work.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Journal,
  foldState,
  runLoop,
  reopenFailed,
  reconcileInterrupted,
  interruptedNodes,
  effectiveRunBudget,
  effectiveNodeBudget,
  cancelRequested,
  loadProjectType,
} from "../dist/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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

const events = (ctx, type) => ctx.journal.read().filter((e) => e.type === type);

// A mock that "costs" money and only succeeds once a persistent counter reaches
// a threshold — lets us force multiple PAID attempts across reopens.
const COUNTER_MOCK = (threshold, cost) => [
  'const fs = require("node:fs");',
  `const cf = process.env.HARNESS_WORKSPACE + "/attempts-counter.txt";`,
  "let n = 0; try { n = Number(fs.readFileSync(cf, 'utf8')) || 0; } catch {}",
  "n += 1; fs.writeFileSync(cf, String(n));",
  `fs.writeFileSync("cost.json", JSON.stringify({ costUsd: ${cost} }));`,
  `if (n >= ${threshold}) fs.writeFileSync("out.json", JSON.stringify({ ok: true }));`,
].join("\n");

const OUT_SCHEMA = JSON.stringify({ type: "object", required: ["ok"] });

// ---------------------------------------------------------------------------
// #1 — interrupted node reconcile: dangling "running" becomes terminal failed
// ---------------------------------------------------------------------------

test("interruptedNodes: a node.running with no terminal is interrupted; committed/failed are not", () => {
  const evs = [
    { type: "run.created" },
    { type: "node.running", nodeId: "a", attempt: 1 },
    { type: "node.committed", nodeId: "a" },
    { type: "node.running", nodeId: "b", attempt: 1 }, // <- died mid-flight
    { type: "node.running", nodeId: "c", attempt: 1 },
    { type: "node.failed", nodeId: "c" },
  ];
  assert.deepEqual(interruptedNodes(evs), ["b"]);
});

test("reconcileInterrupted: stamps node.failed on a dangling running node, leaves clean state alone", () => {
  const dir = writeFixture(
    tmpDir("recon-pt"),
    `name: r\nversion: 0.0.1\nnodes:\n  - {id: x, kind: verifier, command: "true"}\n`,
  );
  const ws = tmpDir("recon-ws");
  const ctx = makeCtx(ws, dir);
  // Simulate a prior engine that died mid-node x.
  ctx.journal.append({ type: "run.created" });
  ctx.journal.append({ type: "node.running", nodeId: "x", attempt: 1 });

  const reconciled = reconcileInterrupted(ctx);
  assert.deepEqual(reconciled, ["x"]);
  const failed = events(ctx, "node.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, "interrupted");
  assert.ok(foldState(ctx.journal.read()).failed.has("x"), "interrupted node now reads failed, not running");

  // Idempotent + no-op once terminal.
  assert.deepEqual(reconcileInterrupted(ctx), [], "nothing dangling after reconcile");
});

test("crash recovery: a never-committed interrupted node runs on resume; committed upstream reused", async () => {
  const aNode = [
    "  - id: a",
    "    kind: deterministic",
    '    command: node "$HARNESS_PROJECT_DIR/a.cjs"',
    "    outputs: [{name: a, file: a.json}]",
  ];
  const bNode = [
    "  - id: b",
    "    kind: deterministic",
    "    deps: [a]",
    '    command: node "$HARNESS_PROJECT_DIR/b.cjs"',
    "    outputs: [{name: b, file: b.json}]",
  ];
  const files = {
    "a.cjs": 'const fs=require("node:fs"); const c=process.env.HARNESS_WORKSPACE+"/a-runs.txt"; let n=0; try{n=Number(fs.readFileSync(c,"utf8"))||0}catch{} fs.writeFileSync(c,String(n+1)); fs.writeFileSync("a.json","{}");',
    "b.cjs": 'const fs=require("node:fs"); const c=process.env.HARNESS_WORKSPACE+"/b-runs.txt"; let n=0; try{n=Number(fs.readFileSync(c,"utf8"))||0}catch{} fs.writeFileSync(c,String(n+1)); fs.writeFileSync("b.json","{}");',
  };
  // First engine "run" only got 'a' committed (b never started to commit).
  const dirA = writeFixture(tmpDir("crashA-pt"), ["name: crash", "version: 0.0.1", "nodes:", ...aNode].join("\n"), files);
  const ws = tmpDir("crash-ws");
  const seed = makeCtx(ws, dirA);
  assert.equal((await runLoop(seed)).status, "completed");
  const aRunsAfterClean = Number(fs.readFileSync(path.join(ws, "a-runs.txt"), "utf8"));

  // The full pipeline (a + b). Model 'b' as interrupted mid-first-attempt: a
  // node.running with no terminal and NO prior commit — exactly a process kill.
  const dirAB = writeFixture(tmpDir("crashAB-pt"), ["name: crash", "version: 0.0.1", "nodes:", ...aNode, ...bNode].join("\n"), files);
  const ctx2 = makeCtx(ws, dirAB);
  ctx2.journal.append({ type: "node.running", nodeId: "b", attempt: 1 }); // died here, never committed
  assert.deepEqual(interruptedNodes(ctx2.journal.read()), ["b"]);

  reconcileInterrupted(ctx2);
  assert.ok(foldState(ctx2.journal.read()).failed.has("b"), "interrupted 'b' now reads failed");
  reopenFailed(ctx2);
  const resumed = makeCtx(ws, dirAB);
  assert.equal((await runLoop(resumed)).status, "completed");
  assert.equal(
    Number(fs.readFileSync(path.join(ws, "a-runs.txt"), "utf8")),
    aRunsAfterClean,
    "committed upstream 'a' was reused, not re-run",
  );
  assert.equal(
    Number(fs.readFileSync(path.join(ws, "b-runs.txt"), "utf8")),
    1,
    "interrupted 'b' (no valid prior commit) actually ran on resume",
  );
});

// ---------------------------------------------------------------------------
// #1 — runtime budget overrides: raise a cap and recover without a full rebuild
// ---------------------------------------------------------------------------

test("effectiveRunBudget / effectiveNodeBudget: override wins over certified, absent = certified", () => {
  const dir = writeFixture(
    tmpDir("eff-pt"),
    [
      "name: eff",
      "version: 0.0.1",
      "cost: { run_budget_usd: 5, nodes: { work: { budget_usd: 2 } } }",
      "nodes:",
      '  - {id: work, kind: verifier, command: "true"}',
    ].join("\n"),
  );
  const ws = tmpDir("eff-ws");
  const ctx = makeCtx(ws, dir);
  assert.equal(effectiveRunBudget(ctx), 5, "certified run budget when no override");
  assert.equal(effectiveNodeBudget(ctx, "work"), 2, "certified node budget when no override");

  fs.writeFileSync(path.join(ws, "budget-overrides.json"), JSON.stringify({ run_budget_usd: 50, nodes: { work: 20 } }));
  assert.equal(effectiveRunBudget(ctx), 50, "run override honored");
  assert.equal(effectiveNodeBudget(ctx, "work"), 20, "node override honored");
});

test("run-budget override: a run that failed the run cap resumes to completion once raised", async () => {
  const dag = [
    "name: rbov",
    "version: 0.0.1",
    "cost: { run_budget_usd: 0.5 }",
    "nodes:",
    "  - id: work1",
    "    kind: agent",
    "    prompt: p.md",
    '    mock: node "$HARNESS_PROJECT_DIR/m.cjs"',
    "    retries: 0",
    "    outputs: [{name: out1, file: out.json, schema: out.schema.json}]",
    "  - id: work2",
    "    kind: agent",
    "    deps: [work1]",
    "    prompt: p.md",
    '    mock: node "$HARNESS_PROJECT_DIR/m.cjs"',
    "    retries: 0",
    "    outputs: [{name: out2, file: out.json, schema: out.schema.json}]",
  ].join("\n");
  const files = {
    "p.md": "x",
    "out.schema.json": OUT_SCHEMA,
    "m.cjs": [
      'const fs=require("node:fs");',
      'fs.writeFileSync("out.json", JSON.stringify({ ok: true }));',
      'fs.writeFileSync("cost.json", JSON.stringify({ costUsd: 0.6 }));',
    ].join("\n"),
  };
  const dir = writeFixture(tmpDir("rbov-pt"), dag, files);
  const ws = tmpDir("rbov-ws");

  const first = makeCtx(ws, dir);
  const r1 = await runLoop(first);
  assert.equal(r1.status, "failed", "work1 spent 0.6 over the 0.5 run cap; work2 blocked");
  assert.equal(r1.failedNodeId, "work2");
  assert.ok(!fs.existsSync(path.join(ws, "artifacts/work2")), "work2 never ran");

  // Raise the run budget at runtime and resume — no reopen needed since work2
  // was blocked, not failed. It should now dispatch and complete.
  fs.writeFileSync(path.join(ws, "budget-overrides.json"), JSON.stringify({ run_budget_usd: 10 }));
  const resumed = makeCtx(ws, dir);
  assert.equal((await runLoop(resumed)).status, "completed");
  assert.ok(fs.existsSync(path.join(ws, "artifacts/work2/out.json")), "work2 completed under the raised cap");
});

test("node-budget override: a node that failed its cap recovers on reopen once raised", async () => {
  const dag = [
    "name: nbov",
    "version: 0.0.1",
    "cost: { nodes: { work: { budget_usd: 0.4 } } }",
    "nodes:",
    "  - id: work",
    "    kind: agent",
    "    prompt: p.md",
    '    mock: node "$HARNESS_PROJECT_DIR/m.cjs"',
    "    retries: 3",
    "    outputs: [{name: out, file: out.json, schema: out.schema.json}]",
  ].join("\n");
  // Succeeds only on the 3rd lifetime attempt; each attempt costs 0.3.
  const dir = writeFixture(tmpDir("nbov-pt"), dag, {
    "p.md": "x",
    "out.schema.json": OUT_SCHEMA,
    "m.cjs": COUNTER_MOCK(3, 0.3),
  });
  const ws = tmpDir("nbov-ws");

  const first = makeCtx(ws, dir);
  const r1 = await runLoop(first);
  assert.equal(r1.status, "failed", "attempt2's projected spend blows the 0.4 node cap -> fails");
  assert.ok(events(first, "budget.exceeded").some((e) => e.scope === "node"));

  // Raise the node budget and reopen the failed node; the reopen resets the
  // per-cycle spend, and the higher cap lets it retry to success.
  fs.writeFileSync(path.join(ws, "budget-overrides.json"), JSON.stringify({ nodes: { work: 10 } }));
  const second = makeCtx(ws, dir);
  assert.deepEqual(reopenFailed(second), ["work"]);
  assert.equal((await runLoop(second)).status, "completed");
  assert.ok(fs.existsSync(path.join(ws, "artifacts/work/out.json")), "node completed under the raised cap");
});

// ---------------------------------------------------------------------------
// #3 — cooperative cancel: stop a run mid-flight
// ---------------------------------------------------------------------------

test("cancel: a stop requested mid-run halts promptly, records run.cancelled, commits nothing in-flight", async () => {
  const dir = writeFixture(
    tmpDir("cancel-pt"),
    [
      "name: cancel",
      "version: 0.0.1",
      "nodes:",
      "  - id: slow",
      "    kind: deterministic",
      "    retries: 0",
      '    command: node "$HARNESS_PROJECT_DIR/slow.cjs"',
      "    outputs: [{name: out, file: out.json}]",
    ].join("\n"),
    {
      // Sleeps well past the cancel; if it ever finishes it writes the artifact.
      "slow.cjs": 'setTimeout(() => require("node:fs").writeFileSync("out.json", "{}"), 5000);',
    },
  );
  const ws = tmpDir("cancel-ws");
  const ctx = makeCtx(ws, dir);

  // Request the stop shortly after the node starts.
  setTimeout(() => fs.writeFileSync(path.join(ws, "cancel.requested"), ""), 500);
  const t0 = Date.now();
  const result = await runLoop(ctx);
  const elapsed = Date.now() - t0;

  assert.equal(result.status, "cancelled", "the run reports a cancellation, not a failure");
  assert.ok(elapsed < 4000, `stopped promptly (${elapsed}ms) — did not wait out the 5s node`);
  assert.equal(events(ctx, "run.cancelled").length, 1);
  assert.equal(events(ctx, "run.completed").length, 0);
  assert.ok(!fs.existsSync(path.join(ws, "artifacts/slow")), "the interrupted node committed nothing");
  assert.ok(!fs.existsSync(path.join(ws, "cancel.requested")), "the sentinel was consumed");
  assert.ok(!cancelRequested(ctx));
});

test("cancel: a run with the sentinel already present stops before dispatching any node", async () => {
  const dir = writeFixture(
    tmpDir("cancel2-pt"),
    `name: c2\nversion: 0.0.1\nnodes:\n  - {id: a, kind: verifier, command: "true"}\n`,
  );
  const ws = tmpDir("cancel2-ws");
  const ctx = makeCtx(ws, dir);
  fs.writeFileSync(path.join(ws, "cancel.requested"), "");
  assert.equal((await runLoop(ctx)).status, "cancelled");
  assert.equal(events(ctx, "node.running").length, 0, "nothing dispatched");
});

// ---------------------------------------------------------------------------
// #4 — resume after cancel: reopen the cancelled node, reuse committed work
// ---------------------------------------------------------------------------

test("resume after cancel: the cancelled node reopens and completes; committed work is kept", async () => {
  const dir = writeFixture(
    tmpDir("rac-pt"),
    [
      "name: rac",
      "version: 0.0.1",
      "nodes:",
      "  - id: a",
      "    kind: deterministic",
      '    command: node "$HARNESS_PROJECT_DIR/a.cjs"',
      "    outputs: [{name: a, file: a.json}]",
      "  - id: slow",
      "    kind: deterministic",
      "    retries: 0",
      "    deps: [a]",
      '    command: node "$HARNESS_PROJECT_DIR/slow.cjs"',
      "    outputs: [{name: out, file: out.json}]",
    ].join("\n"),
    {
      "a.cjs": 'const fs=require("node:fs"); const c=process.env.HARNESS_WORKSPACE+"/a-runs.txt"; let n=0; try{n=Number(fs.readFileSync(c,"utf8"))||0}catch{} fs.writeFileSync(c,String(n+1)); fs.writeFileSync("a.json","{}");',
      // Slow first time (gets cancelled); fast once a marker exists (resume).
      "slow.cjs": [
        'const fs=require("node:fs");',
        'const m=process.env.HARNESS_WORKSPACE+"/slow-seen.txt";',
        'if (fs.existsSync(m)) { fs.writeFileSync("out.json","{}"); }',
        'else { fs.writeFileSync(m,"1"); setTimeout(()=>fs.writeFileSync("out.json","{}"), 5000); }',
      ].join("\n"),
    },
  );
  const ws = tmpDir("rac-ws");
  const ctx = makeCtx(ws, dir);
  setTimeout(() => fs.writeFileSync(path.join(ws, "cancel.requested"), ""), 500);
  assert.equal((await runLoop(ctx)).status, "cancelled");
  assert.ok(fs.existsSync(path.join(ws, "artifacts/a/a.json")), "upstream 'a' committed before the stop");
  const aRunsAtCancel = Number(fs.readFileSync(path.join(ws, "a-runs.txt"), "utf8"));

  // Resume: reconcile the interrupted 'slow' -> failed -> reopen -> re-run fast.
  const resumed = makeCtx(ws, dir);
  reconcileInterrupted(resumed);
  reopenFailed(resumed);
  assert.equal((await runLoop(resumed)).status, "completed");
  assert.equal(
    Number(fs.readFileSync(path.join(ws, "a-runs.txt"), "utf8")),
    aRunsAtCancel,
    "'a' reused, not re-run",
  );
  assert.ok(fs.existsSync(path.join(ws, "artifacts/slow/out.json")), "cancelled node finished on resume");
});
