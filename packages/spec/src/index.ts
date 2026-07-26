/**
 * @harness/spec — the shared vocabulary of the platform.
 * One definition of every event, contract, and structure, imported by
 * runner, CLI, and (later) the dashboard. This is the engine-agnostic core:
 * nothing in here knows about the Claude Agent SDK.
 */

export type NodeKind = "agent" | "deterministic" | "gate" | "verifier";

export type NodeState =
  | "pending"
  | "running"
  | "committed"
  | "failed"
  | "parked";

/** An artifact a node declares it will produce (relative to its attempt dir). */
export interface ArtifactDecl {
  name: string;
  file: string;
  /** Path to a JSON Schema (relative to the project-type dir). JSON artifacts only. */
  schema?: string;
}

export interface GateQuestion {
  id: string;
  prompt: string;
}

export interface NodeDef {
  id: string;
  kind: NodeKind;
  deps?: string[];
  outputs?: ArtifactDecl[];
  /** Extra payload attempts after the first failure (default 1). */
  retries?: number;

  // agent nodes
  /** Prompt file, relative to the project-type dir. */
  prompt?: string;
  /** Command used in --mock-agents mode (certification/deterministic testing). */
  mock?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];

  // deterministic + verifier nodes
  /** Shell command; runs with cwd = attempt dir. $HARNESS_PROJECT_DIR available. */
  command?: string;

  // gate nodes
  questions?: GateQuestion[];
}

export interface NodeCostSpec {
  budget_usd?: number;
}

/** Cost envelope — part of what gets certified. Enforced by the runner, not advisory. */
export interface CostSpec {
  run_budget_usd?: number;
  nodes?: Record<string, NodeCostSpec>;
}

export interface ProjectTypeDef {
  name: string;
  version: string;
  cost?: CostSpec;
  nodes: NodeDef[];
}

/** Cost attribution — one record per node attempt (agent attempts carry tokens). */
export interface CostRecord {
  nodeId: string;
  attempt: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  wallClockMs: number;
}

/** Every ledger entry. State is a pure fold over these. */
export interface LedgerEvent {
  type:
    | "run.created"
    | "run.completed"
    | "run.parked"
    | "run.failed"
    | "node.running"
    | "node.attempt_failed"
    | "node.committed"
    | "node.failed"
    | "node.parked"
    | "gate.answered"
    | "agent.message"
    | "cost.recorded"
    | "budget.exceeded";
  ts?: string;
  nodeId?: string;
  attempt?: number;
  [key: string]: unknown;
}

export interface RunResult {
  status: "completed" | "parked" | "failed";
  failedNodeId?: string;
  parkedNodeId?: string;
}
