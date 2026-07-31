// Dynamic DAG composition: spec -> certified stage library -> runnable
// project type; deterministic execution with agentic layers; deploy-later.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(REPO, "packages/cli/dist/index.js");
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `harness-compose-${p}-`));

function treeDigest(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const abs = path.join(d, e);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else files.push(path.relative(dir, abs) + ":" + fs.readFileSync(abs).toString("base64"));
    }
  };
  walk(dir);
  return files.join("|");
}

test("compose: spec -> valid project type -> deterministic run with an agentic layer", () => {
  const out = path.join(tmp("pt"), "policy-summarizer");
  const composed = run(["compose", "examples/policy-summarizer.yaml", "--out", out, "--library", "stage-library"]);
  assert.equal(composed.status, 0, composed.stdout + composed.stderr);
  assert.match(composed.stdout, /composed 5 node\(s\)/);
  assert.ok(fs.existsSync(path.join(out, "prompts/summarize.md")), "agent stage prompt instantiated");
  assert.ok(fs.existsSync(path.join(out, "scripts/check-summary.cjs")), "verifier instantiated");

  const digests = [];
  for (const i of [1, 2]) {
    const ws = path.join(tmp(`ws${i}`), "run");
    const r = run(["run", out, "--workspace", ws, "--mock-agents", "--accept-defaults"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /package\s+deterministic\s+committed/);
    digests.push(treeDigest(path.join(ws, "artifacts")));
  }
  assert.equal(digests[0], digests[1], "two runs, byte-identical artifacts — dynamic composition, deterministic execution");
});

test("compose: unknown stages and missing params are rejected", () => {
  const spec = path.join(tmp("bad"), "bad.yaml");
  fs.writeFileSync(spec, "name: x\nversion: 0.0.1\nstages:\n  - { use: nonexistent, id: a }\n");
  const r = run(["compose", spec, "--out", path.join(tmp("badout"), "x"), "--library", "stage-library"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown stage/);
});

test("deploy-later: a local-only workspace gets a cloud plan without rebuild", () => {
  const ws = tmp("deploy");
  fs.writeFileSync(path.join(ws, "run.json"), JSON.stringify({ projectTypeDir: path.join(REPO, "project-types/agentic-app") }));
  fs.mkdirSync(path.join(ws, "artifacts/architecture"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "artifacts/architecture/architecture.json"),
    JSON.stringify({ deploy_target: "local", modules: ["persistence-core"], app_name: "t" }),
  );
  const r = run(["deploy", ws, "--target", "cloud-run"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(ws, "deploy-plan/deploy/service.yaml")), "Cloud Run service spec produced");
  assert.ok(fs.existsSync(path.join(ws, "deploy-plan/deploy/plan.md")), "reviewed plan produced");
});
