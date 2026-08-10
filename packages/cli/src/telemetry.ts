// Pilot telemetry: local-first run summaries (no network, no payloads) in
// $HARNESS_HOME/telemetry.jsonl. Pilots share the file; HARNESS_TELEMETRY=0
// opts out. This is the "how is it going for 5-20 pilots" evidence stream.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldState, type RunContext } from "@harness/runner";
import type { RunResult } from "@harness/spec";
import { storeRoot } from "./registry.js";
import { computeMetrics } from "./metrics.js";

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function recordRun(ctx: RunContext, result: RunResult, command: string): void {
  if (process.env.HARNESS_TELEMETRY === "0") return;
  try {
    const events = ctx.journal.read();
    const state = foldState(events);
    const line = {
      ts: new Date().toISOString(),
      command,
      projectType: ctx.def.name,
      version: ctx.def.version,
      status: result.status,
      costUsd: Number(state.totalCostUsd.toFixed(4)),
      committed: state.committed.size,
      mock: ctx.mockAgents === true,
    };
    fs.mkdirSync(storeRoot(), { recursive: true });
    fs.appendFileSync(path.join(storeRoot(), "telemetry.jsonl"), JSON.stringify(line) + "\n");

    // Business-intelligence dimensions — who built what, cost, quality, and the
    // build EXPERIENCE (questions asked, revisions), mined centrally. Derived
    // from the journal via computeMetrics; never blocks a run.
    const runCfg = readJson(path.join(ctx.workspace, "run.json")) ?? {};
    const intake = readJson(path.join(ctx.workspace, "artifacts", "intake", "intake.json"));
    let bi: Record<string, unknown> = {};
    try {
      const m = computeMetrics(ctx.workspace);
      bi = {
        reworkPct: m.reworkPct,
        totalTokens: m.totalTokens,
        wallMs: m.wallMs,
        auditRounds: m.auditConvergence?.rounds ?? null,
        loopDetections: m.loopDetections.length,
        escalations: m.escalations.length,
        nodeCount: m.nodeCount,
      };
    } catch {
      /* metrics best-effort */
    }
    const identity = (runCfg.owner as string) ?? process.env.HARNESS_IDENTITY ?? `${os.userInfo().username}@firm.local`;

    // Fleet event queue: journal-derived rows for the central collector
    // (DF-3). Offline-first — the queue drains on the next sync.
    const fleetEvent = {
      ts: line.ts,
      event: `run.${result.status}` as const,
      projectType: ctx.def.name,
      version: ctx.def.version,
      command,
      costUsd: line.costUsd,
      mock: line.mock,
      nodeId: result.failedNodeId ?? result.parkedNodeId ?? undefined,
      identity,
      // BI dimensions:
      owner: identity,
      team: (runCfg.team as string) ?? null,
      appName: (intake?.project_name as string) ?? path.basename(ctx.workspace),
      questionsAnswered: events.filter((e) => e.type === "gate.answered").length,
      revisions: events.filter((e) => e.type === "node.reopened").length,
      committed: state.committed.size,
      ...bi,
    };
    fs.appendFileSync(path.join(storeRoot(), "telemetry-queue.jsonl"), JSON.stringify(fleetEvent) + "\n");
  } catch {
    // Telemetry must never break a run.
  }
}

/**
 * Drain the fleet-event queue to the collector (HARNESS_TELEMETRY_URL).
 * Never throws, never blocks long: 2s budget, then the queue waits for the
 * next run or an explicit `harness telemetry --sync`.
 */
export async function syncTelemetry(): Promise<string> {
  const url = process.env.HARNESS_TELEMETRY_URL;
  if (!url) return "no HARNESS_TELEMETRY_URL configured — events stay queued locally";
  const queue = path.join(storeRoot(), "telemetry-queue.jsonl");
  if (!fs.existsSync(queue)) return "queue empty";
  const events = fs.readFileSync(queue, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!events.length) return "queue empty";
  try {
    const res = await fetch(new URL("/v1/events", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-firm-identity": process.env.HARNESS_IDENTITY ?? `${os.userInfo().username}@firm.local`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return `collector rejected batch (${res.status}) — events stay queued`;
    const data = (await res.json()) as { accepted: number; rejected: unknown[] };
    fs.writeFileSync(queue, "");
    return `synced ${data.accepted} event(s) to ${url}`;
  } catch (e) {
    return `collector unreachable — ${events.length} event(s) stay queued (${String(e).slice(0, 80)})`;
  }
}

export function summarize(): string {
  const file = path.join(storeRoot(), "telemetry.jsonl");
  if (!fs.existsSync(file)) return "no runs recorded yet";
  const lines = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { projectType: string; version: string; status: string; costUsd: number; mock: boolean });
  const byType = new Map<string, { runs: number; completed: number; costUsd: number; live: number }>();
  for (const l of lines) {
    const key = `${l.projectType}@${l.version}`;
    const agg = byType.get(key) ?? { runs: 0, completed: 0, costUsd: 0, live: 0 };
    agg.runs += 1;
    if (l.status === "completed") agg.completed += 1;
    agg.costUsd += l.costUsd;
    if (!l.mock) agg.live += 1;
    byType.set(key, agg);
  }
  const rows = [...byType.entries()].map(
    ([key, a]) =>
      `  ${key.padEnd(28)} ${String(a.runs).padStart(4)} runs  ${Math.round((100 * a.completed) / a.runs)}% completed  ${a.live} live  $${a.costUsd.toFixed(2)} total`,
  );
  return `${lines.length} recorded run(s) — ${file}\n${rows.join("\n")}`;
}
