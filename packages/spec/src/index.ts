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
  /**
   * Input shape the UI renders. "choice" makes the answer space VISIBLE
   * (option cards with hints), "boolean" renders yes/no, "long" a textarea,
   * "files" a document drop zone. Default: free text.
   */
  type?: "text" | "long" | "choice" | "boolean" | "files";
  /** For type "choice": every possible answer, each explained. */
  options?: Array<{ value: string; label?: string; hint?: string }>;
  placeholder?: string;
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
  /** Satisfied when the value strictly equals this. */
  equals?: unknown;
  /** Satisfied when the value's existence matches (for data-driven fan-out). */
  exists?: boolean;
}

/** Interaction budgets — user attention is enforced like dollars. */
export interface InteractionSpec {
  max_questions_per_gate?: number;
}

export interface NodeDef {
  id: string;
  kind: NodeKind;
  /** Plain-language explanation of what this step does — shown to users. */
  description?: string;
  /** Display grouping for the pipeline (e.g. Requirements, Design, Build). */
  phase?: string;
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
  /** Subagent definitions passed through to the Agent SDK (name -> config). */
  agents?: Record<string, unknown>;
  /**
   * Certified skills: names of skills/<name>/ dirs in the project-type package,
   * staged into the session's project settings — never loaded from user machines.
   */
  skills?: string[];
  /** MCP server instances (names from ProjectTypeDef.mcp) attached to this node's session. */
  mcp?: string[];

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
  /**
   * Review window (seconds): instead of parking, the gate WAITS this long for
   * a dashboard answer, then proceeds on defaults (provenance: "window").
   * Awareness without obligation — only questions with defaults qualify.
   */
  window?: number;

  /** Conditional enablement; unmet condition -> node is skipped, not failed. */
  when?: WhenClause;

  /** Static per-node parameters, surfaced to payloads as inputs._params (e.g. slice index). */
  params?: Record<string, unknown>;
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

/** What `harness certify` exercises beyond golden scenarios. */
export interface CertificationSpec {
  /**
   * Revision drill: after the first golden scenario completes, revise this
   * node with the given feedback and require the run to re-derive to green.
   * Certifies the feedback loop, cascade, and memoization for this type.
   */
  revision_drill?: { node: string; feedback: string };
}

/** An MCP server instance: a versioned server ref + this type's configuration. */
export interface McpInstanceDef {
  /** "./mcp/<name>" (package-local) or "@harness/<name>[@version]" (platform/registry). */
  server: string;
  /** Type-specific configuration, validated against the server's config schema. */
  config?: Record<string, unknown>;
}

export interface ProjectTypeDef {
  name: string;
  version: string;
  /** Plain-language description of what this project type builds. */
  description?: string;
  cost?: CostSpec;
  interaction?: InteractionSpec;
  preview?: PreviewSpec;
  certification?: CertificationSpec;
  /** MCP server instances this type defines (nodes attach them by name). */
  mcp?: Record<string, McpInstanceDef>;
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
    | "node.reopened"
    | "gate.answered"
    | "gate.window_open"
    | "agent.message"
    | "agent.question_asked"
    | "agent.question_answered"
    | "agent.question_denied"
    | "agent.session_info"
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
