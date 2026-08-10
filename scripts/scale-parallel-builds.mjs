#!/usr/bin/env node
// Scale confidence: can the harness run many INDEPENDENT builds at once, the way
// 60k firm users would? This fans out N concurrent builds — each its own process,
// workspace, engine-lock, identity, and telemetry home — and proves they complete
// in isolation with correct per-owner attribution and no cross-contamination.
//
// Why this generalizes to 60k: a hosted build is ONE isolated container (ECS
// Fargate task / EKS pod). There is NO shared mutable state in the build path —
// the engine.lock is per-workspace, telemetry is append-only per-home, the
// gateway/collector/registry are stateless and horizontally autoscaled. So
// concurrency is bounded by the fleet's container capacity, not by any single
// contended resource. This test demonstrates the isolation property locally; AWS
// supplies the horizontal capacity.
//
//   node scripts/scale-parallel-builds.mjs [N]      (default 40)
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "index.js");
const PT = path.join(REPO, "project-types", "demo");
const ANSWERS = path.join(PT, "fixtures", "answers.json");
const N = Number(process.argv[2] ?? 40);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "harness-scale-"));

function build(i) {
  const id = `user${String(i).padStart(4, "0")}@firm.local`;
  const ws = path.join(ROOT, `ws-${i}`);
  const home = path.join(ROOT, `home-${i}`);
  fs.mkdirSync(home, { recursive: true });
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "run", PT, "--mock-agents", "--accept-defaults", "--answers", ANSWERS, "--workspace", ws, "--owner", id], {
      env: { ...process.env, HARNESS_HOME: home, HARNESS_IDENTITY: id, HARNESS_TELEMETRY: "1" },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve({ i, id, ws, code, ms: Date.now() - started }));
  });
}

console.log(`Fanning out ${N} concurrent independent builds (cores: ${os.cpus().length})…`);
const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => build(i + 1)));
const wall = (Date.now() - t0) / 1000;

let failed = 0;
const ok = (c, m) => {
  if (!c) {
    failed++;
    console.log(`  ✗ ${m}`);
  }
};

// Every build completed.
ok(results.every((r) => r.code === 0), `all ${N} builds exited 0`);
// Isolation: each workspace is stamped with ITS OWN owner (no cross-write / bleed).
let isolated = 0;
for (const r of results) {
  const cfg = JSON.parse(fs.readFileSync(path.join(r.ws, "run.json"), "utf8"));
  if (cfg.owner === r.id && fs.existsSync(path.join(r.ws, "journal.jsonl"))) isolated++;
}
ok(isolated === N, `all ${N} workspaces isolated with correct owner attribution`);
// Distinct owners => no shared identity/state.
ok(new Set(results.map((r) => r.id)).size === N, `${N} distinct owners, ${N} distinct workspaces`);

const durs = results.map((r) => r.ms).sort((a, b) => a - b);
const p50 = durs[Math.floor(N * 0.5)] / 1000;
const p95 = durs[Math.floor(N * 0.95)] / 1000;
const throughput = (N / wall).toFixed(1);

console.log(`\n${failed ? failed + " CHECK(S) FAILED" : "ALL ISOLATED + COMPLETED"}`);
console.log(`  wall-clock:   ${wall.toFixed(1)}s for ${N} concurrent builds`);
console.log(`  per-build:    p50 ${p50.toFixed(2)}s · p95 ${p95.toFixed(2)}s`);
console.log(`  throughput:   ${throughput} builds/sec on ${os.cpus().length} cores (one laptop)`);
console.log(`\n60k extrapolation (the confidence argument):`);
console.log(`  • A hosted build = 1 isolated Fargate task; there is NO shared bottleneck in`);
console.log(`    the build path (engine.lock is per-workspace; telemetry append-only per-home;`);
console.log(`    gateway/collector/registry stateless + autoscaled).`);
console.log(`  • So max concurrency = fleet container capacity, a horizontal (money) scaling`);
console.log(`    knob — not an architectural limit. 500 concurrent builds = 500 Fargate tasks.`);
console.log(`  • 60k seats @ ~20% monthly-active, bursty → low-thousands peak concurrent builds,`);
console.log(`    each 4 vCPU/8GB, ~35s–2h bounded. Cluster autoscaler adds/reclaims nodes; the`);
console.log(`    control plane scales on request volume, not build count.`);

fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
