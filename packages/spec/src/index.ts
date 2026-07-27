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
  | "parked"
  | "skipped";

/** An artifact a node declares it will produce (relative to its attempt dir). */
export interface ArtifactDecl {
  name: string;
  file: string;
  /** Path to a JSON Schema (relative to the project-type dir). JSON artifacts only. */
  schema?: string;
  /** True if the artifact is a directory tree (committed recursively). */
  dir?: boolean;
}

export interface GateQuestion {
  id: string;
  prompt: string;
  /** Pre-filled answer used when no recorded/human answer exists (the accept-defaults path). */
  default?: string;
  /** Why we ask — which downstream decision this answer changes. */
  why?: string;
}

/** Gate questions sourced dynamically from an upstream JSON artifact. */
export interface QuestionsFrom {
  artifact: string;
  /** Dot path to the question array inside the artifact (default: "questions"). */
  path?: string;
}

/** Conditional enablement: a pure predicate over a committed artifact field. */
export interface WhenClause {
  artifact: string;
  path: string;
  equals: unknown;
}

/** Interaction budgets — user attention is enforced like dollars. */
export interface InteractionSpec {
  max_questions_per_gate?: number;
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
  /** Stronger model used for retry attempts (escalate-on-retry cost pattern). */
  escalateModel?: string;
  maxTurns?: number;
  allowedTools?: string[];

  // deterministic + verifier nodes
  /** Shell command; runs with cwd = attempt dir. $HARNESS_PROJECT_DIR available. */
  command?: string;

  /**
   * Executable exit criteria run INSIDE the node's envelope, after contract
   * validation and before commit. Failure feeds back into the retry loop —
   * a node that fails its own verification never commits.
   */
  verify?: string;

  // gate nodes
  questions?: GateQuestion[];
  questionsFrom?: QuestionsFrom;

  /** Conditional enablement; unmet condition -> node is skipped, not failed. */
  when?: WhenClause;
}

export interface NodeCostSpec {
  budget_usd?: number;
}

/** Cost envelope — part of what gets certified. Enforced by the runner, not advisory. */
export interface CostSpec {
  run_budget_usd?: number;
  nodes?: Record<string, NodeCostSpec>;
}

/**
 * How to launch the built product for a live preview. Declared by the
 * certified project type; the dashboard's "run the app" button uses it.
 * $PORT in the command is substituted with the assigned port.
 */
export interface PreviewSpec {
  /** Artifact name that contains the app (default "app"; latest committed wins). */
  artifact?: string;
  command: string;
  /** cwd relative to the app artifact root. */
  cwd?: string;
  /** Path polled until it responds 200 (default "/"). */
  health?: string;
}

export interface ProjectTypeDef {
  name: string;
  version: string;
  cost?: CostSpec;
  interaction?: InteractionSpec;
  preview?: PreviewSpec;
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
    | "node.skipped"
    | "gate.answered"
    | "agent.message"
    | "agent.question_denied"
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
