import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import AjvNS from "ajv";

// NodeNext/CJS interop: at runtime the constructor is the module itself,
// but the types expose it under `.default` — normalize once.
const Ajv: typeof AjvNS.default =
  (AjvNS as unknown as { default?: typeof AjvNS.default }).default ??
  (AjvNS as unknown as typeof AjvNS.default);
import type { CostRecord, GateQuestion, NodeDef } from "@harness/spec";
import type { RunContext } from "./context.js";
import type { RunState } from "./scheduler.js";

/**
 * The node envelope — the deterministic wrapper every node runs inside:
 * collect inputs → stage attempt dir → execute payload → validate contract →
 * commit. Non-determinism (agent payloads) cannot leak past validation.
 */
export async function executeNode(
  ctx: RunContext,
  node: NodeDef,
  state: RunState,
): Promise<"committed" | "failed" | "parked"> {
  const maxAttempts = (node.retries ?? 1) + 1;
  let feedback: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    ctx.journal.append({ type: "node.running", nodeId: node.id, attempt });

    const attemptDir = path.join(ctx.workspace, "attempts", `${node.id}-${attempt}`);
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(
      path.join(attemptDir, "inputs.json"),
      JSON.stringify(buildInputs(ctx, node, state), null, 2),
    );
    if (feedback) fs.writeFileSync(path.join(attemptDir, "feedback.md"), feedback);

    let error: string | undefined;
    try {
      switch (node.kind) {
        case "gate": {
          const gate = await runGate(ctx, node, attemptDir);
          if (gate === "parked") {
            ctx.journal.append({ type: "node.parked", nodeId: node.id, attempt });
            return "parked";
          }
          break;
        }
        case "deterministic":
        case "verifier":
          runCommand(ctx, node.command!, attemptDir);
          break;
        case "agent":
          await runAgent(ctx, node, attemptDir, attempt);
          break;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (!error) error = validateOutputs(ctx, node, attemptDir);

    // Per-node verification: executable exit criteria inside the retry loop.
    if (!error && node.verify) {
      try {
        runCommand(ctx, node.verify, attemptDir);
      } catch (e) {
        error = `verification failed:\n${e instanceof Error ? e.message : String(e)}`;
      }
    }

    recordCost(ctx, node, attempt, Date.now() - started, attemptDir);

    // Budget enforcement: a node that breaches its certified budget never
    // commits and never retries — it escalates immediately.
    const budget = ctx.def.cost?.nodes?.[node.id]?.budget_usd;
    if (budget !== undefined) {
      const spent = cumulativeNodeCost(ctx, node.id);
      if (spent > budget) {
        ctx.journal.append({
          type: "budget.exceeded",
          scope: "node",
          nodeId: node.id,
          budgetUsd: budget,
          spentUsd: spent,
        });
        ctx.journal.append({ type: "node.failed", nodeId: node.id });
        return "failed";
      }
    }

    if (!error) {
      commit(ctx, node, attemptDir);
      return "committed";
    }

    ctx.journal.append({ type: "node.attempt_failed", nodeId: node.id, attempt, error });
    feedback = `Attempt ${attempt} failed validation. Fix the following and try again:\n\n${error}`;
  }

  ctx.journal.append({ type: "node.failed", nodeId: node.id });
  return "failed";
}

/** Inputs = every committed artifact of every dependency, with parsed JSON where applicable. */
function buildInputs(
  ctx: RunContext,
  node: NodeDef,
  state: RunState,
): Record<string, { path: string; data?: unknown }> {
  const inputs: Record<string, { path: string; data?: unknown }> = {};
  for (const dep of node.deps ?? []) {
    for (const [name, rel] of Object.entries(state.artifacts[dep] ?? {})) {
      const abs = path.join(ctx.workspace, rel);
      const entry: { path: string; data?: unknown } = { path: abs };
      if (abs.endsWith(".json") && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        entry.data = JSON.parse(fs.readFileSync(abs, "utf8"));
      }
      inputs[name] = entry;
    }
  }
  return inputs;
}

function runCommand(ctx: RunContext, command: string, attemptDir: string): void {
  const result = spawnSync(command, {
    shell: true,
    cwd: attemptDir,
    env: {
      ...process.env,
      HARNESS_PROJECT_DIR: ctx.projectTypeDir,
      HARNESS_WORKSPACE: ctx.workspace,
    },
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  if (result.status !== 0) {
    const tail = (s: string | null) => (s ?? "").split("\n").slice(-20).join("\n");
    throw new Error(
      `command exited with ${result.status}:\n${command}\nstdout:\n${tail(result.stdout)}\nstderr:\n${tail(result.stderr)}`,
    );
  }
}

/** Resolve a gate's question list: static from the DAG, or dynamic from an upstream artifact. */
function resolveQuestions(node: NodeDef, attemptDir: string): GateQuestion[] {
  if (node.questions) return node.questions;
  const { artifact, path: qPath = "questions" } = node.questionsFrom!;
  const inputs = JSON.parse(fs.readFileSync(path.join(attemptDir, "inputs.json"), "utf8")) as Record<
    string,
    { data?: unknown }
  >;
  let value: unknown = inputs[artifact]?.data;
  for (const seg of qPath.split(".")) {
    if (value === null || typeof value !== "object") {
      throw new Error(`gate '${node.id}': questionsFrom path '${qPath}' not found in artifact '${artifact}'`);
    }
    value = (value as Record<string, unknown>)[seg];
  }
  if (!Array.isArray(value)) {
    throw new Error(`gate '${node.id}': questionsFrom '${artifact}.${qPath}' is not an array`);
  }
  return value as GateQuestion[];
}

async function runGate(
  ctx: RunContext,
  node: NodeDef,
  attemptDir: string,
): Promise<"answered" | "parked"> {
  const questions = resolveQuestions(node, attemptDir);

  // Interaction budget: user attention is enforced exactly like dollars.
  // A gate that would over-ask fails loudly rather than nagging the user.
  const maxQuestions = ctx.def.interaction?.max_questions_per_gate;
  if (maxQuestions !== undefined && questions.length > maxQuestions) {
    ctx.journal.append({
      type: "budget.exceeded",
      scope: "questions",
      nodeId: node.id,
      budget: maxQuestions,
      asked: questions.length,
    });
    throw new Error(
      `gate '${node.id}' asks ${questions.length} questions, exceeding the certified budget of ${maxQuestions}`,
    );
  }

  const recorded = ctx.answers?.[node.id] ?? {};
  const answers: Record<string, string> = {};
  const sources = new Set<string>();

  for (const q of questions) {
    if (recorded[q.id] !== undefined) {
      answers[q.id] = recorded[q.id];
      sources.add("recorded");
      continue;
    }
    if (ctx.acceptDefaults && q.default !== undefined) {
      answers[q.id] = q.default; // unattended replay: defaults apply silently
      sources.add("default");
      continue;
    }
    if (!ctx.interactive) return "parked"; // durable park; dashboard/resume answers later
    // Interactive: the human sees the question WITH its default pre-filled —
    // Enter accepts, typing overrides. Defaults are confirmed, never hidden.
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hint = q.default !== undefined ? ` [default: ${q.default}]` : "";
    const why = q.why ? `\n  (why: ${q.why})` : "";
    const raw = await rl.question(`[gate:${node.id}] ${q.prompt}${why}${hint} `);
    rl.close();
    if (raw.trim() === "" && q.default !== undefined) {
      answers[q.id] = q.default;
      sources.add("default");
    } else {
      answers[q.id] = raw;
      sources.add("human");
    }
  }

  const out = node.outputs![0];
  fs.writeFileSync(path.join(attemptDir, out.file), JSON.stringify(answers, null, 2));
  ctx.journal.append({
    type: "gate.answered",
    nodeId: node.id,
    answers,
    source: sources.size === 1 ? [...sources][0] : "mixed",
    questionCount: questions.length,
  });
  return "answered";
}

/**
 * Escalate-on-retry: attempt 1 runs the node's pinned (cheaper) model; retries
 * run escalateModel when declared — the failure feedback plus a stronger model
 * is the cost-optimal recovery path.
 */
export function modelForAttempt(node: NodeDef, attempt: number): string | undefined {
  return attempt > 1 && node.escalateModel ? node.escalateModel : node.model;
}

async function runAgent(
  ctx: RunContext,
  node: NodeDef,
  attemptDir: string,
  attempt: number,
): Promise<void> {
  if (ctx.mockAgents) {
    if (!node.mock) throw new Error(`agent node '${node.id}' has no mock command for --mock-agents mode`);
    runCommand(ctx, node.mock, attemptDir);
    return;
  }

  const promptFile = path.join(ctx.projectTypeDir, node.prompt!);
  const declared = (node.outputs ?? [])
    .map((o) => `- ${o.file}${o.schema ? ` (must validate against ${o.schema})` : ""}`)
    .join("\n");
  const prompt = [
    fs.readFileSync(promptFile, "utf8"),
    "\nYour inputs are listed in ./inputs.json (absolute paths + parsed data for JSON artifacts).",
    `The project-type package directory is: ${ctx.projectTypeDir}`,
    "Relative paths appearing inside input data (e.g. a documents_dir answer) resolve against that package directory.",
    declared ? `\nYou MUST produce these files in the current directory:\n${declared}` : "",
    "Work only inside the current directory. When an input provides an app directory, copy it here first (cp -R <input path> ./app) and modify the copy.",
    fs.existsSync(path.join(attemptDir, "feedback.md"))
      ? `\nA previous attempt failed. Read ./feedback.md and correct the problems.`
      : "",
  ].join("\n");

  // Dynamic non-literal specifier: the SDK is an optional runtime dependency
  // (mock mode and certification replay never need it).
  const sdkModuleName = "@anthropic-ai/claude-agent-sdk";
  let query: (args: unknown) => AsyncIterable<Record<string, unknown>>;
  try {
    ({ query } = (await import(sdkModuleName)) as {
      query: (args: unknown) => AsyncIterable<Record<string, unknown>>;
    });
  } catch {
    throw new Error(
      "Claude Agent SDK not installed. Run: npm i @anthropic-ai/claude-agent-sdk (or use --mock-agents)",
    );
  }

  const model = modelForAttempt(node, attempt);
  const usage = {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };

  const session = query({
    prompt,
    options: {
      cwd: attemptDir,
      model,
      maxTurns: node.maxTurns ?? 30,
      allowedTools: node.allowedTools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: "acceptEdits",
      settingSources: [], // hermetic: no user/global settings leak into certified runs
      // Agents never get a free channel to interrupt users mid-node: questions
      // are denied with assumption guidance (and journaled for telemetry).
      // Everything else is allowed — the workspace itself is the sandbox.
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === "AskUserQuestion") {
          ctx.journal.append({
            type: "agent.question_denied",
            nodeId: node.id,
            attempt,
            question: JSON.stringify(input).slice(0, 400),
          });
          return {
            behavior: "deny" as const,
            message:
              "This run is autonomous — no human is available mid-node. Make a reasonable assumption, record it in your output artifact, and continue. Materially-branching questions belong to the gap-questions stage.",
          };
        }
        return { behavior: "allow" as const, updatedInput: input };
      },
    },
  });

  for await (const msg of session) {
    ctx.journal.append({ type: "agent.message", nodeId: node.id, attempt, message: summarize(msg) });
    if (msg.type === "result") {
      const u = (msg.usage ?? {}) as Record<string, number>;
      usage.inputTokens = u.input_tokens ?? 0;
      usage.outputTokens = u.output_tokens ?? 0;
      usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
      usage.costUsd = (msg.total_cost_usd as number) ?? 0;
    }
  }
  // The payload's cost channel: recordCost() picks this up. Mock commands may
  // write cost.json too, so certification replays can model cost envelopes.
  fs.writeFileSync(path.join(attemptDir, "cost.json"), JSON.stringify(usage, null, 2));
}

function summarize(msg: Record<string, unknown>): Record<string, unknown> {
  // Keep the journal readable: store type + a short preview, not full payloads.
  return { type: msg.type, preview: JSON.stringify(msg).slice(0, 400) };
}

function validateOutputs(ctx: RunContext, node: NodeDef, attemptDir: string): string | undefined {
  const problems: string[] = [];
  const ajv = new Ajv({ allErrors: true });
  for (const out of node.outputs ?? []) {
    const file = path.join(attemptDir, out.file);
    if (!fs.existsSync(file)) {
      problems.push(`missing declared artifact: ${out.file}`);
      continue;
    }
    if (out.dir) {
      if (!fs.statSync(file).isDirectory()) problems.push(`${out.file}: expected a directory`);
      continue;
    }
    if (out.schema) {
      const schema = JSON.parse(
        fs.readFileSync(path.join(ctx.projectTypeDir, out.schema), "utf8"),
      );
      let data: unknown;
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        problems.push(`${out.file}: not valid JSON (${String(e)})`);
        continue;
      }
      const valid = ajv.validate(schema, data);
      if (!valid) problems.push(`${out.file}: ${ajv.errorsText(ajv.errors)}`);
    }
  }
  return problems.length > 0 ? problems.join("\n") : undefined;
}

function commit(ctx: RunContext, node: NodeDef, attemptDir: string): void {
  const artifacts: Record<string, string> = {};
  const destDir = path.join(ctx.workspace, "artifacts", node.id);
  fs.mkdirSync(destDir, { recursive: true });
  for (const out of node.outputs ?? []) {
    const dest = path.join(destDir, out.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (out.dir) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(attemptDir, out.file), dest, { recursive: true });
    } else {
      fs.copyFileSync(path.join(attemptDir, out.file), dest);
    }
    artifacts[out.name] = path.relative(ctx.workspace, dest);
  }
  ctx.journal.append({ type: "node.committed", nodeId: node.id, artifacts });
}

function recordCost(
  ctx: RunContext,
  node: NodeDef,
  attempt: number,
  wallClockMs: number,
  attemptDir: string,
): void {
  // Payloads report spend by writing cost.json into the attempt dir
  // (agent sessions always; mocks optionally, to simulate spend in replays).
  let reported: Partial<CostRecord> = {};
  const costFile = path.join(attemptDir, "cost.json");
  if (fs.existsSync(costFile)) {
    try {
      reported = JSON.parse(fs.readFileSync(costFile, "utf8")) as Partial<CostRecord>;
    } catch {
      // A malformed cost.json never breaks a run; it just records zero spend.
    }
  }
  const cost: CostRecord = {
    nodeId: node.id,
    attempt,
    model: reported.model ?? node.model,
    inputTokens: reported.inputTokens ?? 0,
    outputTokens: reported.outputTokens ?? 0,
    cacheReadTokens: reported.cacheReadTokens ?? 0,
    cacheWriteTokens: reported.cacheWriteTokens ?? 0,
    costUsd: reported.costUsd ?? 0,
    wallClockMs,
  };
  ctx.journal.append({ type: "cost.recorded", nodeId: node.id, attempt, cost });
}

function cumulativeNodeCost(ctx: RunContext, nodeId: string): number {
  return ctx.journal
    .read()
    .filter((e) => e.type === "cost.recorded" && e.nodeId === nodeId)
    .reduce((sum, e) => sum + ((e.cost as CostRecord | undefined)?.costUsd ?? 0), 0);
}
