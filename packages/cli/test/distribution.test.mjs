// Distribution tests: the single-file bundle runs a full pipeline on its own,
// telemetry records pilot evidence, and self-update guards its context.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEMO_DIR = path.join(REPO_ROOT, "project-types", "demo");
const BUNDLE = path.join(REPO_ROOT, "dist-bundle", "harness.cjs");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-dist-${prefix}-`));
}

test("bundle: harness.cjs exists and completes a full pipeline standalone", () => {
  if (!fs.existsSync(BUNDLE)) {
    const built = spawnSync("node", [path.join(REPO_ROOT, "scripts/bundle.mjs")], { encoding: "utf8", cwd: REPO_ROOT });
    assert.equal(built.status, 0, built.stderr);
  }
  const home = tmpDir("home");
  const ws = tmpDir("ws");
  // Run from an unrelated cwd — the bundle must be fully self-contained.
  const run = spawnSync(
    process.execPath,
    [BUNDLE, "run", DEMO_DIR, "--workspace", ws, "--answers", path.join(DEMO_DIR, "fixtures/answers.json"), "--mock-agents"],
    { encoding: "utf8", cwd: os.tmpdir(), env: { ...process.env, HARNESS_HOME: home } },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /run completed/);

  // Telemetry recorded the run locally...
  const telemetry = fs.readFileSync(path.join(home, "telemetry.jsonl"), "utf8");
  assert.match(telemetry, /"projectType":"demo-pipeline"/);
  assert.match(telemetry, /"status":"completed"/);

  // ...and the summary command aggregates it.
  const summary = spawnSync(process.execPath, [BUNDLE, "telemetry"], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_HOME: home },
  });
  assert.match(summary.stdout, /demo-pipeline@0.1.0/);
  assert.match(summary.stdout, /100% completed/);
});

test("telemetry: HARNESS_TELEMETRY=0 opts out", () => {
  const home = tmpDir("optout");
  const ws = tmpDir("ws2");
  const run = spawnSync(
    process.execPath,
    [BUNDLE, "run", DEMO_DIR, "--workspace", ws, "--answers", path.join(DEMO_DIR, "fixtures/answers.json"), "--mock-agents"],
    { encoding: "utf8", env: { ...process.env, HARNESS_HOME: home, HARNESS_TELEMETRY: "0" } },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!fs.existsSync(path.join(home, "telemetry.jsonl")), "opt-out honored");
});

test("self-update: refuses outside a bundle and explains the source-checkout path", () => {
  const CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");
  const r = spawnSync(process.execPath, [CLI, "self-update"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /git pull && npm install && npm run bundle/);
});

test("engine resolution: a pinned SDK dir drives a real live-mode agent node end to end", () => {
  // A scripted stand-in engine proves the resolution chain (HARNESS_SDK_DIR ->
  // module lookup -> $HARNESS_HOME/runtime) and the whole live agent envelope
  // (session events, cost channel, contract validation) without network calls.
  const sdkDir = tmpDir("sdk");
  const pkg = path.join(sdkDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-scripted", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(pkg, "index.js"), `
import * as fs from "node:fs";
import * as path from "node:path";
export function query({ prompt, options }) {
  return (async function* () {
    yield { type: "system", subtype: "init", tools: ["Write"], agents: [], model: "scripted-engine" };
    fs.writeFileSync(path.join(options.cwd, "plan.json"), JSON.stringify({ title: "Build plan for Demo App", sections: ["Overview", "Backend", "Frontend"] }));
    yield { type: "result", usage: { input_tokens: 12, output_tokens: 7 }, total_cost_usd: 0.0123, result: "plan written" };
  })();
}
`);

  const ws = tmpDir("live-ws");
  const run = spawnSync(
    process.execPath,
    [BUNDLE, "run", DEMO_DIR, "--workspace", ws, "--answers", path.join(DEMO_DIR, "fixtures/answers.json")],
    { encoding: "utf8", env: { ...process.env, HARNESS_HOME: tmpDir("home-sdk"), HARNESS_SDK_DIR: sdkDir } },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /run completed/);

  const journal = fs.readFileSync(path.join(ws, "journal.jsonl"), "utf8");
  assert.match(journal, /"model":"scripted-engine"/, "session info came from the pinned engine");
  assert.match(journal, /0.0123/, "engine-reported cost attributed");
  const plan = JSON.parse(fs.readFileSync(path.join(ws, "artifacts/plan/plan.json"), "utf8"));
  assert.equal(plan.title, "Build plan for Demo App");
});

test("setup: preflight reports the engine and toolchain rows", () => {
  const r = spawnSync(process.execPath, [BUNDLE, "setup"], { encoding: "utf8", env: { ...process.env } });
  assert.match(r.stdout, /Claude Agent SDK \(execution engine\)/);
  assert.match(r.stdout, /node >= 20/);
  assert.match(r.stdout, /agent auth/);
});
