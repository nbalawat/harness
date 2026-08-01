// Integration verifier: real checks, executable exit criteria.
// Runs against a COPY of the committed app so artifacts stay immutable.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
fs.cpSync(inputs.app.path, "app-verify", { recursive: true });
const app = path.resolve("app-verify");

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 300000, ...opts });
}
function fail(stage, result) {
  console.error(`${stage} FAILED\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  process.exit(1);
}

function walk(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// 1. Python syntax across the whole app
const pyFiles = walk(app, ".py");
const py = run("python3", ["-m", "py_compile", ...pyFiles]);
if (py.status !== 0) fail("python compile", py);

// 2. Frontend JS syntax
for (const js of walk(path.join(app, "frontend"), ".js")) {
  const check = run("node", ["--check", js]);
  if (check.status !== 0) fail(`js check ${js}`, check);
}

// 3. docker compose config (skipped only when docker itself is unavailable)
let composeStatus = "skipped";
const dockerProbe = run("docker", ["info"]);
if (dockerProbe.status === 0) {
  const compose = run("docker", ["compose", "config", "-q"], { cwd: app });
  if (compose.status !== 0) fail("docker compose config", compose);
  composeStatus = "pass";
}

// 3b. Full container boot smoke — opt-in (HARNESS_SMOKE_DOCKER=1) because it
// builds images; certification runs enable it, fast local runs skip it.
let composeSmoke = "skipped";
if (process.env.HARNESS_SMOKE_DOCKER === "1" && dockerProbe.status === 0) {
  const up = run("docker", ["compose", "up", "-d", "--build"], { cwd: app });
  if (up.status !== 0) fail("docker compose up", up);
  let smoke = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    run("sleep", ["1"]);
    smoke = run("curl", ["-s", "-X", "POST", "http://localhost:8080/chat", "-H", "Content-Type: application/json", "-d", '{"message":"smoke"}']);
    if (smoke.status === 0 && (smoke.stdout ?? "").includes("reply")) break;
  }
  run("docker", ["compose", "down"], { cwd: app });
  if (!smoke || !(smoke.stdout ?? "").includes("reply")) fail("compose smoke (/chat via nginx)", smoke ?? { stdout: "", stderr: "no response" });
  composeSmoke = "pass";
}

// 4. Backend tests — the generated app's own harness, in an isolated env
const pytest = run(
  "uv",
  ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", "--with-requirements", "requirements.txt", "python", "-m", "pytest", "tests", "-q"],
  { cwd: path.join(app, "backend") },
);
if (pytest.status !== 0) fail("backend tests", pytest);

// 5. Agent evals — executable exit criteria for agent behavior. Live builds
// eval LIVE agents (a stub pass proves nothing about real grounding); mock
// runs stay deterministic on stubs.
const evals = run(
  "uv",
  ["run", "--with-requirements", path.join(app, "backend", "requirements.txt"), "python", path.join(app, "agents", "run_evals.py")],
  { env: { ...process.env, ...(process.env.HARNESS_RUN_MODE === "live" ? {} : { HARNESS_AGENT_MODE: "stub" }) } },
);
if (evals.status !== 0) fail("agent evals", evals);

const evalResults = JSON.parse(fs.readFileSync(path.join(app, "agents", "eval_results.json"), "utf8"));
fs.writeFileSync(
  "integration_report.json",
  JSON.stringify(
    {
      python_compile: "pass",
      js_check: "pass",
      compose_config: composeStatus,
      compose_smoke: composeSmoke,
      // Timing stripped: certified artifacts must be byte-deterministic.
      backend_tests: { status: "pass", summary: ((pytest.stdout ?? "").trim().split("\n").pop() ?? "").replace(/ in [0-9.]+s$/, "") },
      evals: { status: "pass", passed: evalResults.passed, total: evalResults.total },
    },
    null,
    2,
  ),
);
console.log("integration verified");
