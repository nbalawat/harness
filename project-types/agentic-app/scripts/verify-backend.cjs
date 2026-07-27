// Build-backend's own exit criteria: python compiles + the generated test
// suite passes. Runs inside the build node's retry loop — failures become
// feedback to the building agent.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const app = path.resolve("app");
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 300000, ...opts });
}
function fail(stage, r) {
  console.error(`${stage} FAILED\n${(r.stdout ?? "").slice(-2000)}\n${(r.stderr ?? "").slice(-2000)}`);
  process.exit(1);
}
function pyFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...pyFiles(p));
    else if (e.name.endsWith(".py")) out.push(p);
  }
  return out;
}

const py = run("python3", ["-m", "py_compile", ...pyFiles(app)]);
if (py.status !== 0) fail("python compile", py);

const pytest = run(
  "uv",
  ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", "python", "-m", "pytest", "tests", "-q"],
  { cwd: path.join(app, "backend") },
);
if (pytest.status !== 0) fail("backend tests", pytest);

// Keep the committed artifact clean.
run("find", [app, "-name", "__pycache__", "-type", "d", "-exec", "rm", "-rf", "{}", "+"]);
console.log("backend verified:", (pytest.stdout ?? "").trim().split("\n").pop());
