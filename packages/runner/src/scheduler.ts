import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerEvent, RunResult, WhenClause } from "@harness/spec";
import type { RunContext } from "./context.js";
import { executeNode } from "./envelope.js";

/** Run state is always a pure fold over the journal — this is what makes resume free. */
export interface RunState {
  committed: Set<string>;
  failed: Set<string>;
  skipped: Set<string>;
  /** nodeId -> artifactName -> path relative to workspace */
  artifacts: Record<string, Record<string, string>>;
  totalCostUsd: number;
}

export function foldState(events: LedgerEvent[]): RunState {
  const state: RunState = {
    committed: new Set(),
    failed: new Set(),
    skipped: new Set(),
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
      case "node.skipped":
        state.skipped.add(e.nodeId!);
        break;
      case "node.reopened":
        state.failed.delete(e.nodeId!);
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
 * Reopen failed nodes so a resume can retry them — the fix-then-resume
 * support workflow. Journal stays append-only; the fold forgets the failure.
 */
export function reopenFailed(ctx: RunContext): string[] {
  const failed = [...foldState(ctx.journal.read()).failed];
  for (const nodeId of failed) ctx.journal.append({ type: "node.reopened", nodeId });
  return failed;
}

/** A dependency is satisfied when its node committed or was conditionally skipped. */
function satisfied(state: RunState, id: string): boolean {
  return state.committed.has(id) || state.skipped.has(id);
}

/**
 * Evaluate a `when` clause against committed artifact data. Pure function of
 * the ledger — never a model call. Missing artifact/path -> not satisfied.
 */
function whenSatisfied(ctx: RunContext, when: WhenClause, state: RunState): boolean {
  for (const artifacts of Object.values(state.artifacts)) {
    const rel = artifacts[when.artifact];
    if (rel === undefined) continue;
    const abs = path.join(ctx.workspace, rel);
    if (!fs.existsSync(abs) || !abs.endsWith(".json")) return false;
    let value: unknown = JSON.parse(fs.readFileSync(abs, "utf8"));
    for (const seg of when.path.split(".")) {
      if (value === null || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[seg];
    }
    if (when.exists !== undefined) return (value !== undefined) === when.exists;
    return value === when.equals;
  }
  return false;
}

/**
 * The deterministic frontier loop. No model anywhere in the control plane:
 * ready = deps committed; execute; fold; repeat. Parking (a gate awaiting a
 * human) exits cleanly — `resume` re-enters and skips committed nodes.
 */
export async function runLoop(ctx: RunContext): Promise<RunResult> {
  for (;;) {
    const state = foldState(ctx.journal.read());

    if (ctx.def.nodes.every((n) => satisfied(state, n.id))) {
      ctx.journal.append({ type: "run.completed" });
      return { status: "completed" };
    }

    const ready = ctx.def.nodes.filter(
      (n) =>
        !satisfied(state, n.id) &&
        !state.failed.has(n.id) &&
        (n.deps ?? []).every((d) => satisfied(state, d)),
    );

    if (ready.length === 0) {
      ctx.journal.append({ type: "run.failed" });
      return { status: "failed" };
    }

    for (const node of ready) {
      // Conditional enablement: unmet `when` -> the node is skipped, and the
      // frontier recomputes. Flow stays a pure function of committed data.
      if (node.when && !whenSatisfied(ctx, node.when, foldState(ctx.journal.read()))) {
        ctx.journal.append({ type: "node.skipped", nodeId: node.id, when: node.when });
        continue;
      }
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
