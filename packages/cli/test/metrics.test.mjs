// harness metrics — the platform observability rollup over the event journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeMetrics, renderCompare } from "../dist/metrics.js";

function fixtureWorkspace(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-metrics-"));
  fs.writeFileSync(path.join(dir, "journal.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

test("metrics: retries, escalation path, self-heal, and doom-loops are surfaced", () => {
  const ws = fixtureWorkspace([
    { type: "run.created" },
    // a slice that failed once then escalated and committed
    { type: "node.running", nodeId: "slice-2", attempt: 1 },
    { type: "agent.session_info", nodeId: "slice-2", attempt: 1, model: "claude-sonnet-5" },
    { type: "node.attempt_failed", nodeId: "slice-2", attempt: 1, error: "verify failed" },
    { type: "node.running", nodeId: "slice-2", attempt: 2 },
    { type: "agent.session_info", nodeId: "slice-2", attempt: 2, model: "claude-opus-5" },
    { type: "cost.recorded", nodeId: "slice-2", attempt: 2, cost: { costUsd: 6.5, inputTokens: 90000, outputTokens: 10000, wallClockMs: 120000 } },
    { type: "node.committed", nodeId: "slice-2", artifacts: {} },
    // an audit that self-heals: reopened, looped once, then converged
    { type: "node.running", nodeId: "slice-audit", attempt: 1 },
    { type: "node.attempt_failed", nodeId: "slice-audit", attempt: 1, error: "3 high findings" },
    { type: "node.loop_detected", nodeId: "slice-audit", attempt: 1, strikes: 1, reason: "repeated_failure" },
    { type: "node.reopened", nodeId: "slice-audit", reason: "user_revision" },
    { type: "node.running", nodeId: "slice-audit", attempt: 2 },
    { type: "cost.recorded", nodeId: "slice-audit", attempt: 2, cost: { costUsd: 12.0, inputTokens: 50000, outputTokens: 5000, wallClockMs: 300000 } },
    { type: "node.committed", nodeId: "slice-audit", artifacts: {} },
    { type: "run.completed" },
  ]);
  const r = computeMetrics(ws);

  assert.equal(r.status, "completed");
  const slice2 = r.nodes.find((n) => n.nodeId === "slice-2");
  assert.equal(slice2.retries, 1, "one retry recorded");
  assert.deepEqual(slice2.models, ["claude-sonnet-5", "claude-opus-5"], "escalation path captured");
  assert.ok(slice2.escalated);

  const audit = r.nodes.find((n) => n.nodeId === "slice-audit");
  assert.equal(audit.loopStrikes, 1, "doom-loop strike surfaced");
  assert.equal(audit.reopens, 1, "self-heal reopen counted");
  assert.ok(r.selfHealedNodes.includes("slice-audit"), "slice-audit reported as self-healed");
  assert.equal(r.loopDetections.length, 1);
  assert.equal(r.escalations.length, 1);
  assert.equal(r.totalCostUsd, 18.5);
  assert.equal(r.auditConvergence.rounds, 2, "audit ran 2 rounds to converge");

  fs.rmSync(ws, { recursive: true, force: true });
});

test("metrics --compare: A/B renders a measurable delta between two runs", () => {
  const wsA = fixtureWorkspace([
    { type: "run.created" },
    { type: "node.running", nodeId: "slice-1", attempt: 1 },
    { type: "node.attempt_failed", nodeId: "slice-1", attempt: 1, error: "x" },
    { type: "node.running", nodeId: "slice-1", attempt: 2 },
    { type: "cost.recorded", nodeId: "slice-1", attempt: 2, cost: { costUsd: 10, wallClockMs: 1000 } },
    { type: "run.failed" },
  ]);
  const wsB = fixtureWorkspace([
    { type: "run.created" },
    { type: "node.running", nodeId: "slice-1", attempt: 1 },
    { type: "cost.recorded", nodeId: "slice-1", attempt: 1, cost: { costUsd: 6, wallClockMs: 800 } },
    { type: "node.committed", nodeId: "slice-1", artifacts: {} },
    { type: "run.completed" },
  ]);
  const out = renderCompare(computeMetrics(wsA), computeMetrics(wsB));
  assert.match(out, /failed → completed/);
  assert.match(out, /total cost/);
  assert.match(out, /▼\$4\.00/, "candidate is $4 cheaper");
  fs.rmSync(wsA, { recursive: true, force: true });
  fs.rmSync(wsB, { recursive: true, force: true });
});
