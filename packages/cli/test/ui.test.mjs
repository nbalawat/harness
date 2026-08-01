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
    // q() is the per-tab URL helper used all over tick(); ANY local `q`
    // declaration in the page script shadows it function-wide (TDZ) and
    // crashes every selected-run render. Syntax checks can't catch it.
    const script = page.slice(page.indexOf("<script>"), page.indexOf("</script>"));
    assert.ok(!/\b(const|let|var)\s+q\s*=/.test(script), "page script must not shadow the q() URL helper");
    // Every onclick handler must actually be defined — a dropped function
    // (like startNewApp in the storefront redesign) makes a button dead silently.
    for (const m of page.matchAll(/onclick="(\w+)\(/g)) {
      const fn = m[1];
      if (fn === "if") continue; // inline conditionals aren't function refs
      assert.ok(new RegExp("function " + fn + "\\b").test(script), `onclick references undefined function ${fn}()`);
    }
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
    assert.equal(state.app.node, "merge-slices", "the merged app wins");

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

  // Slice rows carry their PLANNED identity, not "slice N".
  const slice1 = state.nodes.find((n) => n.id === "slice-1");
  assert.match(slice1.description, /Core chat|—/, "slice description comes from the plan");
  assert.ok(!/Builds feature slice 1 across every layer/.test(slice1.description), "generic description replaced");
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

test("intake uploads: /api/upload stores documents in the run workspace", async () => {
  const ws = tmpDir("upload");
  fs.writeFileSync(path.join(ws, "run.json"), JSON.stringify({ projectType: "demo" }));
  fs.writeFileSync(path.join(ws, "journal.jsonl"), "");
  await withServer(ws, async (base) => {
    const resp = await (await fetch(`${base}/api/upload`, {
      method: "POST",
      body: JSON.stringify({
        files: [
          { name: "kyc-policy.md", data: Buffer.from("# Policy\nAll cases require review.").toString("base64") },
          { name: "../../evil.sh", data: Buffer.from("rm -rf /").toString("base64") },
        ],
      }),
    })).json();
    assert.equal(resp.dir, path.join(ws, "inputs"));
    assert.deepEqual(resp.saved, ["kyc-policy.md", "evil.sh"], "path traversal stripped to a basename");
    assert.equal(fs.readFileSync(path.join(ws, "inputs", "kyc-policy.md"), "utf8"), "# Policy\nAll cases require review.");
    assert.ok(!fs.existsSync(path.join(ws, "..", "evil.sh")), "nothing escapes the workspace");
    // The page ships the picker so intake can consume what was just uploaded.
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes("docUpload"), "intake gate renders the document picker");
    assert.ok(page.includes("windowPanel"), "checkpoint window banner present in the page");
  });
});

test("distribution: storefront offers the certified catalog shipped with the install, from any empty dir", async () => {
  const emptyRoot = tmpDir("anywhere");
  await withServer(emptyRoot, async (base) => {
    const runs = await (await fetch(`${base}/api/runs`)).json();
    const names = runs.projectTypes.map((p) => p.name);
    assert.ok(names.includes("agentic-app"), `packaged catalog discovered (got: ${names.join(", ")})`);
    assert.deepEqual(runs.runs, [], "no runs yet in a fresh dir");
  });
});

test("remediation waves: per-wave state is IN-SPAN and index-exact (adversarial multi-wave journal)", () => {
  // A hand-built journal exercising the hard cases at once:
  //  - original build completes
  //  - wave 1: user revises slice-2; it rebuilds, then merge FAILS (handoff)
  //  - wave 2: a BATCH of two revisions (slice-1 + slice-2, no engine activity
  //    between) rebuild — slice-2 CACHED — then the run COMPLETES
  //  - several events share a millisecond ts (index-exact boundaries required)
  const ws = tmpDir("waves");
  fs.writeFileSync(path.join(ws, "run.json"), JSON.stringify({ projectTypeDir: DEMO_DIR, mockAgents: true }));
  const T = "2026-08-01T10:00:00.000Z"; // reused ts on purpose (same millisecond)
  const ev = (o) => JSON.stringify({ ts: T, ...o });
  const lines = [
    ev({ type: "run.created" }),
    ev({ type: "node.committed", nodeId: "slice-1", artifacts: {} }),
    ev({ type: "cost.recorded", nodeId: "slice-1", cost: { costUsd: 5 } }),
    ev({ type: "node.committed", nodeId: "slice-2", artifacts: {} }),
    ev({ type: "node.committed", nodeId: "merge-slices", artifacts: {} }),
    ev({ type: "run.completed" }),
    // ---- wave 1: revise slice-2 -> rebuild -> merge FAILS ----
    ev({ type: "node.reopened", nodeId: "slice-2", reason: "user_revision", revisionOf: "slice-2", feedback: "merge conflict: fix app.js append" }),
    ev({ type: "node.reopened", nodeId: "merge-slices", reason: "upstream_revised", revisionOf: "slice-2" }),
    ev({ type: "node.running", nodeId: "slice-2", attempt: 2 }),
    ev({ type: "cost.recorded", nodeId: "slice-2", cost: { costUsd: 2 } }),
    ev({ type: "node.committed", nodeId: "slice-2", artifacts: {} }),
    ev({ type: "node.running", nodeId: "merge-slices", attempt: 2 }),
    ev({ type: "node.attempt_failed", nodeId: "merge-slices", attempt: 2, error: "MERGE CONFLICT: SLICES.md rewritten" }),
    ev({ type: "node.failed", nodeId: "merge-slices" }),
    ev({ type: "run.failed", nodeId: "merge-slices" }),
    // ---- wave 2: BATCH revise slice-1 + slice-2 -> rebuild (slice-2 cached) -> COMPLETE ----
    ev({ type: "node.reopened", nodeId: "slice-1", reason: "user_revision", revisionOf: "slice-1", feedback: "security: fail-closed identity" }),
    ev({ type: "node.reopened", nodeId: "slice-2", reason: "user_revision", revisionOf: "slice-2", feedback: "security: opt-out reads" }),
    ev({ type: "node.reopened", nodeId: "merge-slices", reason: "upstream_revised", revisionOf: "slice-1" }),
    ev({ type: "node.running", nodeId: "slice-1", attempt: 2 }),
    ev({ type: "cost.recorded", nodeId: "slice-1", cost: { costUsd: 3 } }),
    ev({ type: "node.committed", nodeId: "slice-1", artifacts: {} }),
    ev({ type: "node.committed", nodeId: "slice-2", artifacts: {}, cached: true }), // reused
    ev({ type: "node.running", nodeId: "merge-slices", attempt: 3 }),
    ev({ type: "node.committed", nodeId: "merge-slices", artifacts: {} }),
    ev({ type: "run.completed" }),
  ];
  fs.writeFileSync(path.join(ws, "journal.jsonl"), lines.join("\n") + "\n");

  const s = buildState(ws);
  assert.equal(s.remediation.length, 2, "two distinct waves (batched revisions collapse into one)");

  const [w1, w2] = s.remediation;
  // Wave 1: ended in a merge FAILURE — must NOT show green because wave 2 later fixed merge.
  assert.equal(w1.wave, 1);
  assert.equal(w1.ended.kind, "failed", "wave 1 ended failed IN ITS OWN SPAN");
  assert.equal(w1.ended.nodeId, "merge-slices");
  assert.match(w1.ended.summary, /MERGE CONFLICT/);
  const w1merge = w1.actions.find((a) => a.nodeId === "merge-slices");
  assert.equal(w1merge.outcome, "failed", "merge shows FAILED in wave 1's lens (not its current committed state)");
  const w1s2 = w1.actions.find((a) => a.nodeId === "slice-2");
  assert.equal(w1s2.outcome, "committed");
  assert.equal(w1s2.cached, false);
  assert.equal(w1s2.costUsd, 2, "wave-1 cost attributed in-span, not lifetime");

  // Wave 2: a batch of two feedbacks; slice-2 reused; ended in completion.
  assert.equal(w2.feedbacks.length, 2, "batched revisions are one wave with both feedbacks");
  assert.deepEqual(w2.feedbacks.map((f) => f.nodeId).sort(), ["slice-1", "slice-2"]);
  assert.equal(w2.ended.kind, "completed", "wave 2 ran through to completion");
  const w2s2 = w2.actions.find((a) => a.nodeId === "slice-2");
  assert.equal(w2s2.cached, true, "unchanged step reused, not re-paid");
  const w2merge = w2.actions.find((a) => a.nodeId === "merge-slices");
  assert.equal(w2merge.outcome, "committed");
});

test("remediation vs enhancement: a new-requirement wave is NOT labelled remediation", () => {
  const ws = tmpDir("kind");
  // agentic-app project type so the requirements node ('requirements-synthesis') is known.
  const AA = path.join(REPO_ROOT, "project-types", "agentic-app");
  fs.writeFileSync(path.join(ws, "run.json"), JSON.stringify({ projectTypeDir: AA, mockAgents: true }));
  const T = "2026-08-01T10:00:00.000Z";
  const ev = (o) => JSON.stringify({ ts: T, ...o });
  fs.writeFileSync(path.join(ws, "journal.jsonl"), [
    ev({ type: "run.completed" }),
    // DEFECT fix routed to a slice -> remediation
    ev({ type: "node.reopened", nodeId: "slice-2", reason: "user_revision", feedback: "MERGE CONFLICT: pure append." }),
    ev({ type: "node.running", nodeId: "slice-2" }),
    ev({ type: "node.committed", nodeId: "slice-2", artifacts: {} }),
    // NEW REQUIREMENT routed to the requirements front door -> enhancement
    ev({ type: "node.reopened", nodeId: "requirements-synthesis", reason: "user_revision", feedback: "User change request CR-5: also add an export-to-Excel button." }),
  ].join("\n") + "\n");

  const s = buildState(ws);
  assert.equal(s.remediation.length, 2);
  const [w1, w2] = s.remediation;
  assert.equal(w1.kind, "remediation", "a defect fix on a slice is a remediation");
  assert.equal(w2.kind, "enhancement", "a new requirement via the front door is an enhancement, not remediation");
});

test("remediation waves: robust across a MESSY span (multiple terminals + recovery)", () => {
  // The real-world failure the boundary-fold fixes: a wave's span contains a
  // failure, then a resume, then completion, then another completion (audit
  // refresh) — and the wave RECOVERED after a budget-bump. Heuristic
  // terminal-scanning got this wrong; folding to the boundary does not.
  const ws = tmpDir("messy");
  fs.writeFileSync(path.join(ws, "run.json"), JSON.stringify({ projectTypeDir: DEMO_DIR, mockAgents: true }));
  const T = "2026-08-01T10:00:00.000Z";
  const ev = (o) => JSON.stringify({ ts: T, ...o });
  const L = [
    ev({ type: "node.committed", nodeId: "intake", artifacts: {} }),
    // wave 1: revise -> fail (budget) -> resume -> complete -> complete again
    ev({ type: "node.reopened", nodeId: "intake", reason: "user_revision", feedback: "fix it" }),
    ev({ type: "node.running", nodeId: "intake", attempt: 2 }),
    ev({ type: "budget.exceeded", scope: "run" }),
    ev({ type: "run.failed", nodeId: "intake" }),
    // operator bump + resume: engine runs again, no new terminal fail
    ev({ type: "node.running", nodeId: "intake", attempt: 3 }),
    ev({ type: "node.committed", nodeId: "intake", artifacts: {} }),
  ];
  fs.writeFileSync(path.join(ws, "journal.jsonl"), L.join("\n") + "\n");
  let s = buildState(ws);
  assert.equal(s.remediation.length, 1);
  assert.equal(s.remediation[0].ended.kind, "active", "recovered after the budget failure — not stuck on the stale 'failed'");
  const a = s.remediation[0].actions.find((x) => x.nodeId === "intake");
  assert.equal(a.outcome, "committed", "boundary fold shows the node rebuilt, not failed");

  // Now the same wave truly completes.
  fs.appendFileSync(path.join(ws, "journal.jsonl"), ev({ type: "run.completed" }) + "\n");
  s = buildState(ws);
  assert.equal(s.remediation[0].ended.kind, "completed");
  assert.equal(s.remediation[0].remaining.length, 0);
});

test("no phantom 'in progress': a COMPLETED run shows zero active waves (regression)", () => {
  // The exact brittleness: after boundary-fold, a failed historical wave has
  // remaining>0 forever. 'Active' must mean the LATEST wave with the run still
  // running (ended:active) — never a dead wave's boundary remainder.
  const ws = tmpDir("phantom");
  fs.writeFileSync(path.join(ws, "run.json"), JSON.stringify({ projectTypeDir: DEMO_DIR, mockAgents: true }));
  const T = "2026-08-01T10:00:00.000Z";
  const ev = (o) => JSON.stringify({ ts: T, ...o });
  fs.writeFileSync(path.join(ws, "journal.jsonl"), [
    ev({ type: "node.committed", nodeId: "intake", artifacts: {} }),
    // wave A: fails at merge, leaving downstream unfinished (remaining>0 forever)
    ev({ type: "node.reopened", nodeId: "intake", reason: "user_revision", feedback: "fix" }),
    ev({ type: "node.reopened", nodeId: "render", reason: "upstream_revised", revisionOf: "intake" }),
    ev({ type: "node.running", nodeId: "intake", attempt: 2 }),
    ev({ type: "node.committed", nodeId: "intake", artifacts: {} }),
    ev({ type: "node.running", nodeId: "render", attempt: 2 }),
    ev({ type: "node.attempt_failed", nodeId: "render", attempt: 2, error: "boom" }),
    ev({ type: "run.failed", nodeId: "render" }),
    // wave B: a fresh revision that completes the run
    ev({ type: "node.reopened", nodeId: "intake", reason: "user_revision", feedback: "fix again" }),
    ev({ type: "node.running", nodeId: "intake", attempt: 3 }),
    ev({ type: "node.committed", nodeId: "intake", artifacts: {} }),
    ev({ type: "node.committed", nodeId: "render", artifacts: {} }),
    ev({ type: "run.completed" }),
  ].join("\n") + "\n");
  const s = buildState(ws);
  assert.equal(s.remediationActive, false, "a completed run has NO wave in progress");
  // wave A retains its historical boundary remaining, but is not 'active'.
  assert.ok(s.remediation[0].remaining.length > 0, "historical wave keeps its boundary remainder");
  assert.notEqual(s.remediation[0].ended.kind, "active", "a dead wave is never active");
  assert.ok(s.remediation.every((r) => r.ended.kind !== "active"), "no wave is active on a completed run");
});
