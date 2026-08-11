import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerEvent, NodeDef, RunResult, WhenClause } from "@harness/spec";
import type { RunContext } from "./context.js";
import { executeNode } from "./envelope.js";

/** Run state is always a pure fold over the journal — this is what makes resume free. */
export interface RunState {
  committed: Set<string>;
  failed: Set<string>;
  skipped: Set<string>;
  /** nodeId -> artifactName -> path relative to workspace */
  artifacts: Record<string, Record<string, string>>;
  /**
   * Last commit per node, surviving reopens — the memoization record: if a
   * reopened node's inputs hash to the same value, its prior commit is reused.
   */
  history: Record<string, { inputsHash?: string; artifacts: Record<string, string> }>;
  totalCostUsd: number;
}

export function foldState(events: LedgerEvent[]): RunState {
  const state: RunState = {
    committed: new Set(),
    failed: new Set(),
    skipped: new Set(),
    artifacts: {},
    history: {},
    totalCostUsd: 0,
  };
  for (const e of events) {
    switch (e.type) {
      case "node.committed":
        state.committed.add(e.nodeId!);
        state.artifacts[e.nodeId!] = e.artifacts as Record<string, string>;
        state.history[e.nodeId!] = {
          inputsHash: e.inputsHash as string | undefined,
          artifacts: e.artifacts as Record<string, string>,
        };
        break;
      case "node.failed":
        state.failed.add(e.nodeId!);
        break;
      case "node.skipped":
        state.skipped.add(e.nodeId!);
        break;
      case "node.reopened":
        // Reopening forgets the outcome — committed, failed, or skipped — so
        // the frontier re-runs the node. History survives for memoization.
        state.failed.delete(e.nodeId!);
        state.committed.delete(e.nodeId!);
        state.skipped.delete(e.nodeId!);
        delete state.artifacts[e.nodeId!];
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

/**
 * Interrupted nodes: a `node.running` with no following terminal event
 * (committed / failed / skipped / parked / reopened). This can only happen
 * across a process death — a node was mid-flight when the engine was killed
 * (crash, SIGKILL, a hard stop, an orchestrator budget kill on a cloud build).
 * The live engine always writes a terminal for every node it dispatches, so on
 * a clean run this set is empty.
 */
export function interruptedNodes(events: LedgerEvent[]): string[] {
  const last = new Map<string, "running" | "terminal">();
  for (const e of events) {
    if (!e.nodeId) continue;
    if (e.type === "node.running") last.set(e.nodeId, "running");
    else if (
      e.type === "node.committed" ||
      e.type === "node.failed" ||
      e.type === "node.skipped" ||
      e.type === "node.parked" ||
      e.type === "node.reopened"
    ) {
      last.set(e.nodeId, "terminal");
    }
  }
  return [...last].filter(([, s]) => s === "running").map(([id]) => id);
}

/**
 * Reconcile a workspace whose previous engine died mid-node: give every
 * interrupted node a terminal `node.failed` so its status stops reading
 * "running" forever and it becomes reopenable (a resume can retry it). We only
 * call this while holding the engine lock, so any dangling "running" is
 * genuinely from a dead process, never a live sibling. No-op on a clean run.
 */
export function reconcileInterrupted(ctx: RunContext): string[] {
  const ids = interruptedNodes(ctx.journal.read());
  for (const nodeId of ids) {
    ctx.journal.append({ type: "node.failed", nodeId, reason: "interrupted" });
  }
  return ids;
}

/**
 * Runtime budget overrides (`budget-overrides.json` in the workspace) let an
 * operator raise a cap that a run hit — per node or run-wide — WITHOUT editing
 * the certified DAG. Absent file = certified values, so this is invisible to
 * certification. Shape: `{ run_budget_usd?: number, nodes?: { <id>: number } }`.
 */
function budgetOverrides(ctx: RunContext): { run_budget_usd?: number; nodes?: Record<string, number> } {
  const f = path.join(ctx.workspace, "budget-overrides.json");
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

/** The run budget after any operator override; undefined if neither is set. */
export function effectiveRunBudget(ctx: RunContext): number | undefined {
  const o = budgetOverrides(ctx);
  return typeof o.run_budget_usd === "number" ? o.run_budget_usd : ctx.def.cost?.run_budget_usd;
}

/** A node's budget after any operator override; undefined if neither is set. */
export function effectiveNodeBudget(ctx: RunContext, nodeId: string): number | undefined {
  const o = budgetOverrides(ctx);
  const ov = o.nodes?.[nodeId];
  return typeof ov === "number" ? ov : ctx.def.cost?.nodes?.[nodeId]?.budget_usd;
}

/** A user has requested a cooperative stop of this run. */
export function cancelRequested(ctx: RunContext): boolean {
  return fs.existsSync(path.join(ctx.workspace, "cancel.requested"));
}

function clearCancel(ctx: RunContext): void {
  fs.rmSync(path.join(ctx.workspace, "cancel.requested"), { force: true });
}

/** A dependency is satisfied when its node committed or was conditionally skipped. */
function satisfied(state: RunState, id: string): boolean {
  return state.committed.has(id) || state.skipped.has(id);
}

/**
 * Evaluate a `when` clause against committed artifact data. Pure function of
 * the ledger — never a model call. Missing artifact/path -> not satisfied.
 * `all` conjoins sub-clauses (e.g. "supervision on AND this slice exists").
 */
function whenSatisfied(ctx: RunContext, when: WhenClause, state: RunState): boolean {
  if (when.all) return when.all.every((sub) => whenSatisfied(ctx, sub, state));
  for (const artifacts of Object.values(state.artifacts)) {
    const rel = artifacts[when.artifact!];
    if (rel === undefined) continue;
    const abs = path.join(ctx.workspace, rel);
    if (!fs.existsSync(abs) || !abs.endsWith(".json")) return false;
    let value: unknown = JSON.parse(fs.readFileSync(abs, "utf8"));
    for (const seg of (when.path ?? "").split(".")) {
      if (value === null || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[seg];
    }
    if (when.exists !== undefined) return (value !== undefined) === when.exists;
    if (when.in !== undefined) return when.in.includes(value);
    return value === when.equals;
  }
  return false;
}

/**
 * The deterministic frontier loop. No model anywhere in the control plane:
 * ready = deps committed; execute; fold; repeat. Parking (a gate awaiting a
 * human) exits cleanly — `resume` re-enters and skips committed nodes.
 *
 * CONCURRENCY: within a frontier round, non-gate nodes with no dependency on
 * each other run in parallel (bounded pool) — this is what makes parallel
 * slice builds wall-clock = max(slice), not sum. Gates still run one at a
 * time (stdin, park semantics). Determinism holds because each node's inputs
 * are its deps' committed artifacts, all sealed before the round starts; the
 * journal is append-only and state is an order-insensitive fold per node.
 */
export async function runLoop(ctx: RunContext): Promise<RunResult> {
  // SINGLE-ENGINE LOCK: two engines driving one workspace can interleave a
  // stale round's commits with a revision's rebuild (observed live: an audit
  // committed against a pre-revision merge). One journal, one writer.
  const lockFile = path.join(ctx.workspace, "engine.lock");
  try {
    const holder = Number(fs.readFileSync(lockFile, "utf8"));
    if (holder && holder !== process.pid) {
      try {
        process.kill(holder, 0); // throws when the holder is gone
        throw new Error(
          `another engine (pid ${holder}) is driving this workspace — wait for it or stop it before resuming`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; // holder alive (or EPERM)
        // stale lock from a dead process — take over
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.writeFileSync(lockFile, String(process.pid));
  try {
    return await runLoopLocked(ctx);
  } finally {
    try {
      if (Number(fs.readFileSync(lockFile, "utf8")) === process.pid) fs.rmSync(lockFile, { force: true });
    } catch {
      /* already gone */
    }
  }
}

/** Fail every interrupted node, drop the sentinel, record run.cancelled. */
function finishCancelled(ctx: RunContext): RunResult {
  clearCancel(ctx);
  reconcileInterrupted(ctx);
  ctx.journal.append({ type: "run.cancelled" });
  return { status: "cancelled" };
}

async function runLoopLocked(ctx: RunContext): Promise<RunResult> {
  // Crash recovery: a prior engine may have died mid-node. Give any interrupted
  // node a terminal failure so it stops reading "running" and is reopenable.
  // No-op on a clean run (nothing dangling).
  reconcileInterrupted(ctx);

  // Cooperative cancel: while we drive, expose an AbortSignal that in-flight
  // command/agent nodes honor, and poll for the `cancel.requested` sentinel so
  // a stop takes effect within a node, not only between rounds. Both are
  // dormant unless a stop is actually requested — invisible to a normal run.
  const ac = new AbortController();
  ctx.signal = ac.signal;
  const cancelPoll = setInterval(() => {
    if (cancelRequested(ctx)) ac.abort();
  }, 400);
  if (typeof cancelPoll.unref === "function") cancelPoll.unref();
  try {
    return await driveFrontier(ctx, ac);
  } finally {
    clearInterval(cancelPoll);
    ctx.signal = undefined;
  }
}

async function driveFrontier(ctx: RunContext, ac: AbortController): Promise<RunResult> {
  for (;;) {
    // Stop requested before dispatching the next round — the clean checkpoint.
    if (ac.signal.aborted || cancelRequested(ctx)) return finishCancelled(ctx);

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

    // Conditional enablement: unmet `when` -> the node is skipped, and the
    // frontier recomputes. Flow stays a pure function of committed data.
    const runnable: NodeDef[] = [];
    for (const node of ready) {
      if (node.when && !whenSatisfied(ctx, node.when, foldState(ctx.journal.read()))) {
        ctx.journal.append({ type: "node.skipped", nodeId: node.id, when: node.when });
        continue;
      }
      runnable.push(node);
    }
    if (runnable.length === 0) continue; // skips changed the frontier — recompute

    // Run-budget gate: once cumulative spend reaches the certified run
    // budget (or an operator's raised override), no further round is dispatched.
    const runBudget = effectiveRunBudget(ctx);
    if (runBudget !== undefined) {
      const spent = foldState(ctx.journal.read()).totalCostUsd;
      if (spent >= runBudget) {
        ctx.journal.append({
          type: "budget.exceeded",
          scope: "run",
          budgetUsd: runBudget,
          spentUsd: spent,
          blockedNodeId: runnable[0].id,
        });
        ctx.journal.append({ type: "run.failed" });
        return { status: "failed", failedNodeId: runnable[0].id };
      }
    }

    const gates = runnable.filter((n) => n.kind === "gate");
    const workers = runnable.filter((n) => n.kind !== "gate");
    const outcomes: Array<{ node: NodeDef; outcome: "committed" | "failed" | "parked" }> = [];

    // Bounded worker pool. Every worker's inputs were committed before this
    // round, so execution order within the round cannot change any output.
    const limit = Math.max(
      1,
      Number(process.env.HARNESS_CONCURRENCY ?? ctx.def.concurrency ?? 4) || 1,
    );
    const queue = [...workers];
    const pool = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let node = queue.shift(); node; node = queue.shift()) {
        outcomes.push({ node, outcome: await executeNode(ctx, node, state) });
      }
    });

    // Gates run sequentially while workers proceed — a park never strands
    // sibling work: everything dispatched this round finishes and commits.
    for (const gate of gates) {
      outcomes.push({ node: gate, outcome: await executeNode(ctx, gate, state) });
    }
    await Promise.all(pool);

    // A stop that landed mid-round: nodes interrupted by the abort report
    // "failed", but the run's verdict is a cancellation, not a build failure.
    if (ac.signal.aborted || cancelRequested(ctx)) return finishCancelled(ctx);

    const failed = outcomes.find((o) => o.outcome === "failed");
    if (failed) {
      ctx.journal.append({ type: "run.failed", nodeId: failed.node.id });
      return { status: "failed", failedNodeId: failed.node.id };
    }
    const parked = outcomes.find((o) => o.outcome === "parked");
    if (parked) {
      ctx.journal.append({ type: "run.parked", nodeId: parked.node.id });
      return { status: "parked", parkedNodeId: parked.node.id };
    }
  }
}
