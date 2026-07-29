// Pilot telemetry: local-first run summaries (no network, no payloads) in
// $HARNESS_HOME/telemetry.jsonl. Pilots share the file; HARNESS_TELEMETRY=0
// opts out. This is the "how is it going for 5-20 pilots" evidence stream.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { foldState, type RunContext } from "@harness/runner";
import type { RunResult } from "@harness/spec";
import { storeRoot } from "./registry.js";

export function recordRun(ctx: RunContext, result: RunResult, command: string): void {
  if (process.env.HARNESS_TELEMETRY === "0") return;
  try {
    const state = foldState(ctx.journal.read());
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
      identity: process.env.HARNESS_IDENTITY ?? `${os.userInfo().username}@firm.local`,
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
