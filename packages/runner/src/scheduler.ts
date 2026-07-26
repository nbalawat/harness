import type { LedgerEvent, RunResult } from "@harness/spec";
import type { RunContext } from "./context.js";
import { executeNode } from "./envelope.js";

/** Run state is always a pure fold over the journal — this is what makes resume free. */
export interface RunState {
  committed: Set<string>;
  failed: Set<string>;
  /** nodeId -> artifactName -> path relative to workspace */
  artifacts: Record<string, Record<string, string>>;
  totalCostUsd: number;
}

export function foldState(events: LedgerEvent[]): RunState {
  const state: RunState = {
    committed: new Set(),
    failed: new Set(),
    artifacts: {},
    totalCostUsd: 0,
  };
  for (const e of events) {
    switch (e.type) {
      case "node.committed":
        state.committed.add(e.nodeId!);
        state.artifacts[e.nodeId!] = e.artifacts as Record<string, string>;
        break;
      case "node.failed":
        state.failed.add(e.nodeId!);
        break;
      case "cost.recorded": {
        const cost = e.cost as { costUsd?: number } | undefined;
        state.totalCostUsd += cost?.costUsd ?? 0;
        break;
      }
    }
  }
  return state;
}

/**
 * The deterministic frontier loop. No model anywhere in the control plane:
 * ready = deps committed; execute; fold; repeat. Parking (a gate awaiting a
 * human) exits cleanly — `resume` re-enters and skips committed nodes.
 */
export async function runLoop(ctx: RunContext): Promise<RunResult> {
  for (;;) {
    const state = foldState(ctx.journal.read());

    if (ctx.def.nodes.every((n) => state.committed.has(n.id))) {
      ctx.journal.append({ type: "run.completed" });
      return { status: "completed" };
    }

    const ready = ctx.def.nodes.filter(
      (n) =>
        !state.committed.has(n.id) &&
        !state.failed.has(n.id) &&
        (n.deps ?? []).every((d) => state.committed.has(d)),
    );

    if (ready.length === 0) {
      ctx.journal.append({ type: "run.failed" });
      return { status: "failed" };
    }

    for (const node of ready) {
      // Run-budget gate: once cumulative spend reaches the certified run
      // budget, no further node is dispatched.
      const runBudget = ctx.def.cost?.run_budget_usd;
      if (runBudget !== undefined) {
        const spent = foldState(ctx.journal.read()).totalCostUsd;
        if (spent >= runBudget) {
          ctx.journal.append({
            type: "budget.exceeded",
            scope: "run",
            budgetUsd: runBudget,
            spentUsd: spent,
            blockedNodeId: node.id,
          });
          ctx.journal.append({ type: "run.failed" });
          return { status: "failed", failedNodeId: node.id };
        }
      }
      const outcome = await executeNode(ctx, node, foldState(ctx.journal.read()));
      if (outcome === "parked") {
        ctx.journal.append({ type: "run.parked", nodeId: node.id });
        return { status: "parked", parkedNodeId: node.id };
      }
      if (outcome === "failed") {
        ctx.journal.append({ type: "run.failed", nodeId: node.id });
        return { status: "failed", failedNodeId: node.id };
      }
    }
  }
}
