// Registry v1 tests: install a certified tag from a git registry (tamper-proof
// digest gate), list installs, and run by name@version from the store.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-reg-${prefix}-`));
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO_ROOT, env: { ...process.env, ...env } });
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r;
}

/** Build a local git registry containing a freshly certified demo package, tagged. */
function makeRegistry() {
  const repo = tmpDir("registry");
  const pkg = path.join(repo, "project-types", "demo-pipeline");
  fs.cpSync(DEMO_DIR, pkg, { recursive: true });
  fs.rmSync(path.join(pkg, "goldens"), { recursive: true, force: true });
  fs.rmSync(path.join(pkg, "certification.json"), { force: true });
  assert.equal(runCli(["certify", pkg, "--update-golden"]).status, 0);

  git(repo, "init", "-q");
  git(repo, "config", "user.email", "cert@harness.local");
  git(repo, "config", "user.name", "Harness Certifier");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "certified demo-pipeline@0.1.0");
  git(repo, "tag", "demo-pipeline@0.1.0");
  return repo;
}

test("registry: install certified tag, list it, and run by name@version", () => {
  const registry = makeRegistry();
  const home = tmpDir("home");

  const install = runCli(["install", "demo-pipeline@0.1.0", "--registry", registry], { HARNESS_HOME: home });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.match(install.stdout, /installed demo-pipeline@0.1.0 \(certified /);

  const list = runCli(["list"], { HARNESS_HOME: home });
  assert.match(list.stdout, /demo-pipeline@0.1.0/);

  // Consumers run the certified version by name — no repo checkout involved.
  const ws = tmpDir("ws");
  const run = runCli(
    ["run", "demo-pipeline@0.1.0", "--workspace", ws, "--answers", path.join(DEMO_DIR, "fixtures/answers.json"), "--mock-agents"],
    { HARNESS_HOME: home },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /run completed/);
});

test("registry: a tag whose content does not match its certification is refused", () => {
  const registry = makeRegistry();
  // Tamper AFTER certification, re-tag the tampered tree under a new version.
  fs.appendFileSync(path.join(registry, "project-types", "demo-pipeline", "nodes", "plan", "mock.js"), "\n// evil\n");
  git(registry, "add", "-A");
  git(registry, "commit", "-q", "-m", "tampered");
  git(registry, "tag", "demo-pipeline@0.1.1");
  // Fake the version so the spec parses; certification.json still holds 0.1.0's digest.

  const home = tmpDir("home2");
  const install = runCli(["install", "demo-pipeline@0.1.1", "--registry", registry], { HARNESS_HOME: home });
  assert.equal(install.status, 1);
  assert.match(install.stderr, /TAMPER CHECK FAILED/);
});

test("registry: uncertified package is refused", () => {
  const repo = tmpDir("uncert");
  const pkg = path.join(repo, "project-types", "demo-pipeline");
  fs.cpSync(DEMO_DIR, pkg, { recursive: true });
  fs.rmSync(path.join(pkg, "certification.json"), { force: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "x@x");
  git(repo, "config", "user.name", "x");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "uncertified");
  git(repo, "tag", "demo-pipeline@0.9.0");

  const install = runCli(["install", "demo-pipeline@0.9.0", "--registry", repo], { HARNESS_HOME: tmpDir("home3") });
  assert.equal(install.status, 1);
  assert.match(install.stderr, /not certified/);
});
