// #4 self-improve (weakness mining) + #3 optimize (certification-gated).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");
const DEMO = path.join(REPO_ROOT, "project-types", "demo");
const runCli = (args, cwd = REPO_ROOT) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });

function seedRun(dir, events) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ projectTypeDir: "x" }));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("self-improve: mines recurring weaknesses across runs and ranks the worst node", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "si-"));
  // Two runs. 'flaky' retries + reopens repeatedly; 'clean' commits first try.
  const flakyRun = [
    { type: "run.created", projectType: "t", projectTypeVersion: "1" },
    { type: "node.running", nodeId: "clean", attempt: 1 },
    { type: "node.committed", nodeId: "clean", attempt: 1 },
    { type: "node.running", nodeId: "flaky", attempt: 1 },
    { type: "node.attempt_failed", nodeId: "flaky", attempt: 1 },
    { type: "node.loop_detected", nodeId: "flaky", strikes: 2, reason: "same failure" },
    { type: "node.running", nodeId: "flaky", attempt: 2 },
    { type: "node.committed", nodeId: "flaky", attempt: 2 },
    { type: "node.reopened", nodeId: "flaky" },
    { type: "node.running", nodeId: "flaky", attempt: 3 },
    { type: "node.committed", nodeId: "flaky", attempt: 3 },
    { type: "run.completed" },
  ];
  seedRun(path.join(root, "run1"), flakyRun);
  seedRun(path.join(root, "run2"), flakyRun);

  const r = runCli(["self-improve", root, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.scanned, 2, "scanned both runs");
  assert.ok(out.proposals.length >= 1, "produced proposals");
  assert.equal(out.proposals[0].nodeId, "flaky", "the flaky node ranks first");
  assert.ok(out.proposals[0].loopStrikes >= 2, "doom-loops mined");
  assert.ok(out.proposals[0].reopens >= 2, "reopens mined");
  assert.ok(out.proposals[0].proposal.change.length > 0, "bounded proposal text present");
  // 'clean' never surfaces (score 0).
  assert.ok(!out.proposals.some((p) => p.nodeId === "clean"), "clean nodes are not proposed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("self-improve: no runs -> clear error", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "si-empty-"));
  const r = runCli(["self-improve", empty]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no run workspaces/);
  fs.rmSync(empty, { recursive: true, force: true });
});

test("optimize: rejects a non-agent/unknown node; accepts an identical candidate that still certifies", () => {
  // Guard: unknown node.
  const bad = runCli(["optimize", DEMO, "--node", "nope", "--candidates", "/tmp"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not an agent node/);

  // A candidate identical to the current prompt must certify (structure + held-out intact).
  const cand = fs.mkdtempSync(path.join(os.tmpdir(), "cand-"));
  fs.copyFileSync(path.join(DEMO, "nodes", "plan", "prompt.md"), path.join(cand, "plan.md"));
  const r = runCli(["optimize", DEMO, "--node", "plan", "--candidates", cand]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS\s+plan\.md/, "identical candidate certifies");
  assert.match(r.stdout, /1 of 1 candidate\(s\).*CERTIFY/, "reports it as safe to adopt");
  // The original prompt is restored (nothing applied).
  const restored = fs.readFileSync(path.join(DEMO, "nodes", "plan", "prompt.md"), "utf8");
  assert.equal(restored, fs.readFileSync(path.join(cand, "plan.md"), "utf8"), "original restored, nothing changed");
  fs.rmSync(cand, { recursive: true, force: true });
});
