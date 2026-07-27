// Certification pipeline tests: golden replay + digest determinism, tamper
// detection (any change to package behavior fails cert until goldens are
// re-recorded), and static completeness checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEMO_DIR = path.join(REPO_ROOT, "project-types", "demo");
const CLI = path.join(REPO_ROOT, "packages/cli/dist/index.js");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-cert-${prefix}-`));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO_ROOT });
}

function copyDemo() {
  const dir = tmpDir("pkg");
  fs.cpSync(DEMO_DIR, dir, { recursive: true });
  fs.rmSync(path.join(dir, "goldens"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "certification.json"), { force: true });
  return dir;
}

test("certify: records goldens, then repeat runs are byte-deterministic", () => {
  const dir = copyDemo();
  const first = runCli(["certify", dir, "--update-golden"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /CERTIFIED demo-pipeline/);
  assert.ok(fs.existsSync(path.join(dir, "certification.json")), "release record written");
  assert.ok(fs.existsSync(path.join(dir, "goldens", "answers.digest.json")), "golden digest recorded");

  const second = runCli(["certify", dir]);
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /CERTIFIED/, "replay against goldens is deterministic");
});

test("certify: tampering with a mock is caught as artifact drift", () => {
  const dir = copyDemo();
  assert.equal(runCli(["certify", dir, "--update-golden"]).status, 0);

  // A one-character behavioral change to the package...
  const mockPath = path.join(dir, "nodes", "plan", "mock.js");
  fs.appendFileSync(mockPath, "\nrequire('node:fs').appendFileSync('plan.json', ' ');\n");

  const result = runCli(["certify", dir]);
  assert.equal(result.status, 1, "tampered package must not certify");
  assert.match(result.stdout, /artifact drift/);
  assert.match(result.stdout, /NOT CERTIFIED/);
});

test("certify: static completeness — missing schema and missing script are reported", () => {
  const dir = copyDemo();
  // Break a schema reference.
  const dag = fs.readFileSync(path.join(dir, "dag.yaml"), "utf8");
  assert.ok(dag.includes("schemas/"), "demo declares schemas");
  const schemas = fs.readdirSync(path.join(dir, "schemas"));
  fs.rmSync(path.join(dir, "schemas", schemas[0]));

  const result = runCli(["certify", dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /schema missing/);
});

test("certify: missing golden digest is a problem, not a silent pass", () => {
  const dir = copyDemo();
  const result = runCli(["certify", dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no golden digest/);
});
