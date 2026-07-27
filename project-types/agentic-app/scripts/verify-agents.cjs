// Build-agents' own exit criteria: roster + eval cases exist and the eval
// suite passes against the composed agent runtime.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const app = path.resolve("app");
for (const f of ["agents/roster.json", "agents/evals/cases.json"]) {
  if (!fs.existsSync(path.join(app, f))) {
    console.error(`missing required agent artifact: ${f}`);
    process.exit(1);
  }
}
const evals = spawnSync("python3", [path.join(app, "agents", "run_evals.py")], {
  encoding: "utf8",
  timeout: 120000,
});
if (evals.status !== 0) {
  console.error(`agent evals FAILED\n${evals.stdout}\n${evals.stderr}`);
  process.exit(1);
}
spawnSync("find", [app, "-name", "__pycache__", "-type", "d", "-exec", "rm", "-rf", "{}", "+"]);
console.log((evals.stdout ?? "").trim());
