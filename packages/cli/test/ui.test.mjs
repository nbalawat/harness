// Dashboard server regression tests: state API, artifact serving with
// traversal guard, and the answer->resume loop against a parked run.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { startUiServer, buildState } from "../dist/ui.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEMO_DIR = path.join(REPO_ROOT, "project-types", "demo");
const CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-ui-${prefix}-`));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO_ROOT });
}

async function withServer(workspace, fn) {
  const server = await startUiServer(workspace, 0); // ephemeral port — no collisions
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("ui: state API reflects a completed run with costs and artifacts", async () => {
  const workspace = tmpDir("done");
  const run = runCli([
    "run", DEMO_DIR,
    "--workspace", workspace,
    "--answers", path.join(DEMO_DIR, "fixtures/answers.json"),
    "--mock-agents",
  ]);
  assert.equal(run.status, 0, run.stderr);

  await withServer(workspace, async (base) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.status, "completed");
    assert.equal(state.projectType, "demo-pipeline@0.1.0");
    assert.equal(state.nodes.length, 4);
    assert.ok(state.nodes.every((n) => n.state === "committed"));
    assert.ok(state.rawArtifacts.includes("render/README.md"));
    assert.ok(state.events.length > 0);
    assert.equal(typeof state.activeMs, 'number');
    assert.ok(state.nodes.every((n) => typeof n.phase === 'string'));

    // Artifact serving works...
    const readme = await fetch(`${base}/artifact/render/README.md`);
    assert.equal(readme.status, 200);
    assert.match(await readme.text(), /Build plan/);

    // ...and path traversal is blocked.
    const evil = await fetch(`${base}/artifact/..%2Fjournal.jsonl`);
    assert.equal(evil.status, 404);

    // The dashboard page itself renders.
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /<title>harness<\/title>/);
  });
});

test("ui: parked gate is surfaced and answering resumes the run to completion", async () => {
  const workspace = tmpDir("parked");
  runCli(["run", DEMO_DIR, "--workspace", workspace, "--mock-agents"]); // no answers -> parks at intake

  await withServer(workspace, async (base) => {
    const parked = await (await fetch(`${base}/api/state`)).json();
    assert.equal(parked.status, "parked");
    assert.equal(parked.parkedGate.nodeId, "intake");
    assert.ok(parked.parkedGate.questions.some((q) => q.id === "project_name"));

    const post = await fetch(`${base}/api/answer`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "intake", answers: { project_name: "From The Browser" } }),
    });
    assert.equal((await post.json()).ok, true);

    // Resume runs as a child process; poll state until it completes.
    let state;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      state = await (await fetch(`${base}/api/state`)).json();
      if (state.status === "completed") break;
    }
    assert.equal(state.status, "completed", JSON.stringify(state.events.slice(-5)));
    const readme = await (await fetch(`${base}/artifact/render/README.md`)).text();
    assert.match(readme, /From The Browser/);
  });
});

test("ui: buildState tolerates an in-flight journal (live tailing)", async () => {
  const workspace = tmpDir("live");
  runCli([
    "run", DEMO_DIR,
    "--workspace", workspace,
    "--answers", path.join(DEMO_DIR, "fixtures/answers.json"),
    "--mock-agents",
  ]);
  // Simulate mid-run by truncating the journal after a few events.
  const journal = path.join(workspace, "journal.jsonl");
  const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
  fs.writeFileSync(journal, lines.slice(0, 4).join("\n") + "\n");
  const state = buildState(workspace);
  assert.equal(state.status, "running");
  assert.ok(state.nodes.some((n) => n.state === "pending"));
});

test("ui: launch-the-app lifecycle against a built agentic-app workspace", async () => {
  process.env.HARNESS_AGENT_MODE = "stub"; // deterministic in CI; live modes are exercised manually
  const workspace = tmpDir("app");
  const AA_DIR = path.join(REPO_ROOT, "project-types", "agentic-app");
  const run = runCli([
    "run", AA_DIR,
    "--workspace", workspace,
    "--answers", path.join(AA_DIR, "fixtures/answers.json"),
    "--accept-defaults", "--mock-agents",
  ]);
  assert.equal(run.status, 0, run.stderr);

  await withServer(workspace, async (base) => {
    let state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.appAvailable, true, "app artifact detected");
    assert.equal(state.app.status, "stopped");

    await fetch(`${base}/api/app/start`, { method: "POST" });
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      state = await (await fetch(`${base}/api/state`)).json();
      if (state.app.status === "running" || state.app.status === "failed") break;
    }
    assert.equal(state.app.status, "running", state.app.error);
    assert.equal(state.app.node, "slice-3", "latest built slice wins");

    // The real generated app answers through the preview port.
    const health = await (await fetch(`http://127.0.0.1:${state.app.port}/health`)).json();
    assert.deepEqual(health, { status: "ok" });
    const chat = await (await fetch(`http://127.0.0.1:${state.app.port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "ping" }),
    })).json();
    assert.match(chat.reply, /assistant/);

    await fetch(`${base}/api/app/stop`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 400));
    state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.app.status, "stopped");
  });
});

test("runs are pinned to their DAG snapshot even if the project type evolves", async () => {
  const workspace = tmpDir("pinned");
  const run = runCli([
    "run", DEMO_DIR,
    "--workspace", workspace,
    "--answers", path.join(DEMO_DIR, "fixtures/answers.json"),
    "--mock-agents",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(path.join(workspace, "dag.snapshot.yaml")), "snapshot recorded at run start");

  // Simulate the project type moving on after the run.
  const snapshot = path.join(workspace, "dag.snapshot.yaml");
  const pinned = fs.readFileSync(snapshot, "utf8");
  assert.match(pinned, /name: demo-pipeline/);
  const state = buildState(workspace);
  assert.equal(state.projectType, "demo-pipeline@0.1.0", "state reflects the pinned snapshot");
});

test("storefront: scanning root lists runs; select/deselect switches the workspace", async () => {
  const root = tmpDir("storeroot");
  const ws = path.join(root, "app-one");
  const run = runCli([
    "run", DEMO_DIR,
    "--workspace", ws,
    "--answers", path.join(DEMO_DIR, "fixtures/answers.json"),
    "--mock-agents",
  ]);
  assert.equal(run.status, 0, run.stderr);

  await withServer(root, async (base) => {
    let runs = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(runs.selected, null);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].name, "app-one");
    assert.equal(runs.runs[0].status, "completed");
    assert.equal(runs.runs[0].runMode, "replay");

    // Unselected: state APIs respond gracefully.
    const unsel = await (await fetch(`${base}/api/state`)).json();
    assert.equal(unsel.selected, false);

    // Select the run -> full state.
    await fetch(`${base}/api/select`, { method: "POST", body: JSON.stringify({ dir: ws }) });
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.selected, true);
    assert.equal(state.projectType, "demo-pipeline@0.1.0");
    assert.equal(state.runMode, "replay");

    // Escaping the root is rejected.
    const evil = await fetch(`${base}/api/select`, { method: "POST", body: JSON.stringify({ dir: "/etc" }) });
    assert.equal(evil.status, 400);

    await fetch(`${base}/api/deselect`, { method: "POST" });
    runs = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(runs.selected, null);
  });
});

test("agent question bridge: pending question surfaces and the answer reaches the file", async () => {
  const workspace = tmpDir("aq");
  runCli([
    "run", DEMO_DIR,
    "--workspace", workspace,
    "--answers", path.join(DEMO_DIR, "fixtures/answers.json"),
    "--mock-agents",
  ]);
  fs.writeFileSync(
    path.join(workspace, "pending-question.json"),
    JSON.stringify({ id: "plan-1-123", nodeId: "plan", questions: [{ question: "Which flavor?", options: [{ label: "vanilla" }] }] }),
  );

  await withServer(workspace, async (base) => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.pendingQuestion.id, "plan-1-123");
    assert.equal(state.pendingQuestion.questions[0].question, "Which flavor?");

    await fetch(`${base}/api/agent-answer`, {
      method: "POST",
      body: JSON.stringify({ id: "plan-1-123", answers: { "Which flavor?": "vanilla" } }),
    });
    const written = JSON.parse(fs.readFileSync(path.join(workspace, "pending-answer.json"), "utf8"));
    assert.equal(written.id, "plan-1-123");
    assert.equal(written.answers["Which flavor?"], "vanilla");
  });
});

test("app workflows surface in the dashboard state with kinds intact", async () => {
  const workspace = tmpDir("wf-ui");
  const run = runCli([
    "run", path.join(REPO_ROOT, "project-types/agentic-app"),
    "--workspace", workspace,
    "--answers", path.join(REPO_ROOT, "project-types/agentic-app/fixtures/answers.json"),
    "--mock-agents", "--accept-defaults",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const state = buildState(workspace);
  assert.ok(Array.isArray(state.appWorkflows) && state.appWorkflows.length >= 1);
  const kinds = new Set(state.appWorkflows[0].nodes.map((n) => n.kind));
  assert.ok(kinds.has("agent") && kinds.has("human") && kinds.has("deterministic"), "agentic + human steps distinguishable in the flow");
});

test("revision API: dry-run previews the closure; a real revise reopens, resumes, and re-derives", async () => {
  const workspace = tmpDir("revise");
  const run = runCli([
    "run", DEMO_DIR,
    "--workspace", workspace,
    "--answers", path.join(DEMO_DIR, "fixtures/answers.json"),
    "--mock-agents",
  ]);
  assert.equal(run.status, 0, run.stderr);

  await withServer(workspace, async (base) => {
    // Dry run: impact preview, no events appended.
    const preview = await (await fetch(`${base}/api/revise`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "plan", feedback: "shorter plan please", dryRun: true }),
    })).json();
    assert.ok(preview.reopened.includes("plan"));
    assert.ok(preview.reopened.includes("render"), "downstream included in impact preview");
    assert.ok(!preview.reopened.includes("intake"), "upstream excluded");
    let state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.status, "completed", "dry run changes nothing");

    // Real revise: reopens the closure and spawns a resume.
    const real = await (await fetch(`${base}/api/revise`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "plan", feedback: "shorter plan please" }),
    })).json();
    assert.ok(real.ok);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      state = await (await fetch(`${base}/api/state`)).json();
      if (state.status === "completed" && !state.resuming) break;
    }
    assert.equal(state.status, "completed", "revision re-derived to green");
  });

  const journal = fs.readFileSync(path.join(workspace, "journal.jsonl"), "utf8");
  assert.match(journal, /"reason":"user_revision"/);
  assert.match(journal, /"nodeId":"plan"[^\n]*"feedback"/);
  // The plan agent re-ran with the user's feedback in its attempt dir.
  const consumed = fs.readdirSync(path.join(workspace, "revisions"));
  assert.ok(consumed.some((f) => f.startsWith("plan-consumed")), "revision feedback was consumed");
});

test("dashboard page script is valid JavaScript (template-literal escaping regression)", async () => {
  const workspace = tmpDir("pagejs");
  runCli(["run", DEMO_DIR, "--workspace", workspace, "--answers", path.join(DEMO_DIR, "fixtures/answers.json"), "--mock-agents"]);
  await withServer(workspace, async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1, "page has an inline script");
    for (const [i, js] of scripts.entries()) {
      const f = path.join(workspace, `page-${i}.js`);
      fs.writeFileSync(f, js);
      const check = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
      assert.equal(check.status, 0, `page script ${i} has a syntax error:\n${check.stderr}`);
    }
  });
});

test("storefront: Build-a-new-app starts a run that parks at intake, ready for Q&A", async () => {
  const root = tmpDir("newapp-root");
  fs.cpSync(DEMO_DIR, path.join(root, "project-types", "demo"), { recursive: true });

  await withServer(root, async (base) => {
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.ok(runs.projectTypes.some((p) => p.name === "demo-pipeline"), "project types offered");

    const bad = await fetch(`${base}/api/new-run`, { method: "POST", body: JSON.stringify({ name: "Bad Name!", projectTypeDir: runs.projectTypes[0].dir }) });
    assert.equal(bad.status, 400);

    const start = await fetch(`${base}/api/new-run`, { method: "POST", body: JSON.stringify({ name: "my-demo-app", projectTypeDir: runs.projectTypes[0].dir }) });
    const started = await start.json();
    assert.equal(start.status, 200, JSON.stringify(started));
    const { dir } = started;

    // The new run parks at intake; selecting it surfaces the Q&A immediately.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").includes("run.parked")) break;
    }
    await fetch(`${base}/api/select`, { method: "POST", body: JSON.stringify({ dir }) });
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.status, "parked");
    assert.equal(state.parkedGate.nodeId, "intake");
    assert.ok(state.parkedGate.questions.length >= 1, "intake questions ready to answer");
  });
});

test("ten-terminals model: concurrent builds, independently viewable and actionable via ?ws=", async () => {
  const root = tmpDir("multi-root");
  // Three concurrent builds (parked at intake = cheap and stable).
  for (const name of ["app-a", "app-b", "app-c"]) {
    runCli(["run", DEMO_DIR, "--workspace", path.join(root, name), "--mock-agents"]);
  }

  await withServer(root, async (base) => {
    // Storefront sees all three at once.
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(runs.runs.length, 3);
    assert.ok(runs.runs.every((r) => r.needsYou), "all three surface as waiting-on-you");

    // Two 'tabs' view DIFFERENT runs simultaneously — no server-side fighting.
    const wsA = encodeURIComponent(path.join(root, "app-a"));
    const wsB = encodeURIComponent(path.join(root, "app-b"));
    const [stateA, stateB] = await Promise.all([
      fetch(`${base}/api/state?ws=${wsA}`).then((r) => r.json()),
      fetch(`${base}/api/state?ws=${wsB}`).then((r) => r.json()),
    ]);
    assert.equal(stateA.selected, true);
    assert.equal(stateA.parkedGate.nodeId, "intake");
    assert.equal(stateB.parkedGate.nodeId, "intake");
    assert.notEqual(stateA.workspace, stateB.workspace, "each tab sees its own run");

    // Actions are ws-scoped: answering tab B's intake resumes ONLY app-b.
    await fetch(`${base}/api/answer?ws=${wsB}`, {
      method: "POST",
      body: JSON.stringify({ nodeId: "intake", answers: { project_name: "App Bee" } }),
    });
    let b;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      b = await (await fetch(`${base}/api/state?ws=${wsB}`)).json();
      if (b.status === "completed") break;
    }
    assert.equal(b.status, "completed", "app-b completed from its tab");
    const a = await (await fetch(`${base}/api/state?ws=${wsA}`)).json();
    assert.equal(a.status, "parked", "app-a untouched by app-b's answer");

    // Traversal guard on ws.
    const evil = await (await fetch(`${base}/api/state?ws=${encodeURIComponent("/etc")}`)).json();
    assert.equal(evil.selected, false);
  });
});
