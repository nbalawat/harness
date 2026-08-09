// `harness metrics <workspace>` — the platform team's observability rollup.
//
// Graph engineering makes a run inspectable; this reads the event-sourced
// journal (read-only — it never touches the certified execution path) and
// distills it into per-node and run-level signals: retries, doom-loops, model
// escalations, self-heal cycles, convergence rounds, and cost/token/time. These
// are the "quantifiable metrics, not anecdotes" that let the platform team spot
// plateaus, cost outliers, and which gates actually heal — the raw material for
// improving the factory itself.
import * as fs from "node:fs";
import * as path from "node:path";
import { Journal, foldState } from "@harness/runner";
import type { LedgerEvent } from "@harness/spec";

interface NodeMetric {
  nodeId: string;
  attempts: number;
  retries: number;
  loopStrikes: number;
  reopens: number; // self-heal / revision cycles
  models: string[]; // in escalation order
  escalated: boolean;
  costUsd: number;
  tokens: number;
  wallMs: number;
  status: "committed" | "failed" | "skipped" | "running";
}

export interface RunMetrics {
  workspace: string;
  status: string;
  nodeCount: number;
  totalCostUsd: number;
  reworkUsd: number;
  reworkPct: number;
  totalTokens: number;
  wallMs: number;
  selfHealedNodes: string[]; // nodes that reopened (a wave) and still committed
  loopDetections: { nodeId: string; strikes: number; reason: string }[];
  escalations: { nodeId: string; models: string[] }[];
  budgetEvents: number;
  auditConvergence: { rounds: number } | null; // slice-audit re-derivation waves
  nodes: NodeMetric[];
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

export function computeMetrics(workspace: string): RunMetrics {
  const events = new Journal(workspace).read() as LedgerEvent[];
  const state = foldState(events);
  // Run status = the last terminal run.* event (foldState tracks node sets, not
  // a run-level status field).
  let runStatus = "running";
  for (const e of events) {
    if (e.type === "run.completed") runStatus = "completed";
    else if (e.type === "run.failed") runStatus = "failed";
    else if (e.type === "run.parked") runStatus = "parked";
  }

  const m = new Map<string, NodeMetric>();
  const nm = (id: string): NodeMetric => {
    let x = m.get(id);
    if (!x) {
      x = { nodeId: id, attempts: 0, retries: 0, loopStrikes: 0, reopens: 0, models: [], escalated: false, costUsd: 0, tokens: 0, wallMs: 0, status: "running" };
      m.set(id, x);
    }
    return x;
  };

  const loopDetections: RunMetrics["loopDetections"] = [];
  let budgetEvents = 0;
  // A reopen starts a fresh "wave" — cost after the LAST reopen of a node is the
  // committed cost; everything before it (that a reopen invalidated) is rework.
  const costByAttempt: { nodeId: string; costUsd: number; afterReopen: boolean }[] = [];
  const reopenedSoFar = new Set<string>();

  for (const e of events) {
    const id = (e.nodeId as string) ?? "";
    switch (e.type) {
      case "node.running":
        nm(id).attempts += 1;
        break;
      case "node.attempt_failed":
        nm(id).retries += 1;
        break;
      case "node.loop_detected": {
        const strikes = num((e as Record<string, unknown>).strikes);
        nm(id).loopStrikes = Math.max(nm(id).loopStrikes, strikes);
        loopDetections.push({ nodeId: id, strikes, reason: String((e as Record<string, unknown>).reason ?? "") });
        break;
      }
      case "node.reopened":
        nm(id).reopens += 1;
        reopenedSoFar.add(id);
        break;
      case "agent.session_info": {
        const model = (e as Record<string, unknown>).model;
        if (typeof model === "string" && !nm(id).models.includes(model)) nm(id).models.push(model);
        break;
      }
      case "cost.recorded": {
        const c = (e as Record<string, unknown>).cost as Record<string, unknown> | undefined;
        const cost = num(c?.costUsd);
        nm(id).costUsd += cost;
        nm(id).tokens += num(c?.inputTokens) + num(c?.outputTokens);
        nm(id).wallMs += num(c?.wallClockMs);
        costByAttempt.push({ nodeId: id, costUsd: cost, afterReopen: reopenedSoFar.has(id) });
        break;
      }
      case "budget.exceeded":
        budgetEvents += 1;
        break;
      default:
        break;
    }
  }

  for (const x of m.values()) {
    x.escalated = x.models.length > 1;
    x.status = state.committed.has(x.nodeId) ? "committed" : state.failed.has(x.nodeId) ? "failed" : state.skipped.has(x.nodeId) ? "skipped" : "running";
  }

  const totalCostUsd = [...m.values()].reduce((s, x) => s + x.costUsd, 0);
  // Rework = spend on nodes that were later reopened (invalidated by a heal /
  // revision wave). Approximation: cost recorded on a node before its final
  // reopen. Simpler robust proxy: total cost of reopened nodes' non-final waves.
  const reworkUsd = costByAttempt.filter((c) => reopenedSoFar.has(c.nodeId) && !c.afterReopen).reduce((s, c) => s + c.costUsd, 0);

  const selfHealedNodes = [...m.values()].filter((x) => x.reopens > 0 && x.status === "committed").map((x) => x.nodeId);
  const auditNode = m.get("slice-audit");
  const auditConvergence = auditNode ? { rounds: auditNode.attempts } : null;

  return {
    workspace: path.resolve(workspace),
    status: runStatus,
    nodeCount: m.size,
    totalCostUsd: Number(totalCostUsd.toFixed(2)),
    reworkUsd: Number(reworkUsd.toFixed(2)),
    reworkPct: totalCostUsd > 0 ? Math.round((100 * reworkUsd) / totalCostUsd) : 0,
    totalTokens: [...m.values()].reduce((s, x) => s + x.tokens, 0),
    wallMs: [...m.values()].reduce((s, x) => s + x.wallMs, 0),
    selfHealedNodes,
    loopDetections,
    escalations: [...m.values()].filter((x) => x.escalated).map((x) => ({ nodeId: x.nodeId, models: x.models })),
    budgetEvents,
    auditConvergence,
    nodes: [...m.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const mnt = Math.floor(s / 60);
  return `${mnt}m ${s % 60}s`;
}

export function renderMetrics(r: RunMetrics): string {
  const L: string[] = [];
  L.push(`harness metrics — ${path.basename(r.workspace)}  [${r.status}]`);
  L.push(
    `  ${r.nodeCount} nodes · $${r.totalCostUsd.toFixed(2)} spent (${r.reworkPct}% on rework) · ` +
      `${(r.totalTokens / 1e6).toFixed(1)}M tokens · ${fmtMs(r.wallMs)} node-time`,
  );
  L.push(
    `  self-healed: ${r.selfHealedNodes.length ? r.selfHealedNodes.join(", ") : "none"} · ` +
      `loop-detections: ${r.loopDetections.length} · escalations: ${r.escalations.length} · budget events: ${r.budgetEvents}` +
      (r.auditConvergence ? ` · audit rounds: ${r.auditConvergence.rounds}` : ""),
  );
  L.push("");
  L.push(`  ${"STEP".padEnd(22)} ${"KIND".padEnd(10)} ${"ATT".padStart(3)} ${"RTY".padStart(3)} ${"LOOP".padStart(4)} ${"COST".padStart(8)} ${"TOKENS".padStart(8)} ${"TIME".padStart(7)}  MODELS`);
  for (const n of r.nodes) {
    if (n.costUsd === 0 && n.retries === 0 && n.reopens === 0) continue; // skip zero-signal deterministic nodes
    L.push(
      `  ${n.nodeId.padEnd(22)} ${n.status.padEnd(10)} ${String(n.attempts).padStart(3)} ${String(n.retries).padStart(3)} ` +
        `${String(n.loopStrikes || "").padStart(4)} ${("$" + n.costUsd.toFixed(2)).padStart(8)} ${((n.tokens / 1000).toFixed(0) + "k").padStart(8)} ${fmtMs(n.wallMs).padStart(7)}  ` +
        `${n.models.join(" → ") || "—"}`,
    );
  }
  return L.join("\n");
}

/**
 * A-B the factory: diff two runs of the same problem statement so a change to
 * the harness (a prompt, an expertise rule, a model-tier pin) can be measured,
 * not guessed. Byte-deterministic certification makes the control-plane
 * comparable; this quantifies the outcome delta (cost, rework, retries,
 * escalations, convergence) the research says is the primary reliability lever.
 */
export function renderCompare(base: RunMetrics, cand: RunMetrics): string {
  const d = (a: number, b: number, money = false) => {
    const delta = b - a;
    const s = money ? `$${Math.abs(delta).toFixed(2)}` : String(Math.abs(delta));
    return delta === 0 ? "  ±0" : `${delta < 0 ? "▼" : "▲"}${s}`;
  };
  const L: string[] = [];
  L.push(`harness A/B — ${path.basename(base.workspace)}  →  ${path.basename(cand.workspace)}`);
  L.push("");
  L.push(`  ${"METRIC".padEnd(22)} ${"BASE".padStart(10)} ${"CANDIDATE".padStart(10)}   DELTA`);
  const row = (label: string, a: number, b: number, money = false) =>
    L.push(`  ${label.padEnd(22)} ${(money ? "$" + a.toFixed(2) : String(a)).padStart(10)} ${(money ? "$" + b.toFixed(2) : String(b)).padStart(10)}   ${d(a, b, money)}`);
  row("total cost", base.totalCostUsd, cand.totalCostUsd, true);
  row("rework %", base.reworkPct, cand.reworkPct);
  row("retries (all nodes)", base.nodes.reduce((s, n) => s + n.retries, 0), cand.nodes.reduce((s, n) => s + n.retries, 0));
  row("loop-detections", base.loopDetections.length, cand.loopDetections.length);
  row("model escalations", base.escalations.length, cand.escalations.length);
  row("self-healed nodes", base.selfHealedNodes.length, cand.selfHealedNodes.length);
  row("budget events", base.budgetEvents, cand.budgetEvents);
  if (base.auditConvergence && cand.auditConvergence) row("audit rounds", base.auditConvergence.rounds, cand.auditConvergence.rounds);
  L.push("");
  L.push(`  status: ${base.status} → ${cand.status}   (lower cost/rework/retries/rounds is better)`);
  return L.join("\n");
}

/** CLI entry: `harness metrics <workspace> [--json]` or `--compare <a> <b>`. */
export function metricsCommand(workspace: string, asJson: boolean, compareWith?: string): number {
  if (!fs.existsSync(path.join(workspace, "journal.jsonl"))) {
    console.error(`no run journal at ${workspace} — is this a harness workspace?`);
    return 1;
  }
  const r = computeMetrics(workspace);
  if (compareWith) {
    if (!fs.existsSync(path.join(compareWith, "journal.jsonl"))) {
      console.error(`no run journal at ${compareWith}`);
      return 1;
    }
    const c = computeMetrics(compareWith);
    console.log(asJson ? JSON.stringify({ base: r, candidate: c }, null, 2) : renderCompare(r, c));
    return 0;
  }
  console.log(asJson ? JSON.stringify(r, null, 2) : renderMetrics(r));
  return 0;
}
