const { simulateCost } = require("./_lib.cjs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Mock for the merge-slices agent node: run the REAL deterministic merge
// (the certified byte-stable union — the agent's first and usually only act)
// then simulate the cheap agent turn's spend so certification exercises cost
// attribution. Live builds run the agent, whose SDK reports real spend.
const r = spawnSync("node", [path.join(process.env.HARNESS_PROJECT_DIR, "scripts", "merge-slices.cjs")], {
  stdio: "inherit",
  env: process.env,
});
if (r.status !== 0) process.exit(r.status || 1);
simulateCost(0.3, 25000, 1500);
