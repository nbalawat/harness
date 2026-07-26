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
    assert.ok(state.artifacts.includes("render/README.md"));
    assert.ok(state.events.length > 0);

    // Artifact serving works...
    const readme = await fetch(`${base}/artifact/render/README.md`);
    assert.equal(readme.status, 200);
    assert.match(await readme.text(), /Build plan/);

    // ...and path traversal is blocked.
    const evil = await fetch(`${base}/artifact/..%2Fjournal.jsonl`);
    assert.equal(evil.status, 404);

    // The dashboard page itself renders.
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /harness run/);
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
