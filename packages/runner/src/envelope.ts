import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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

  // User revision feedback (harness revise / dashboard "Request changes"):
  // consumed once, delivered through the same feedback.md channel retries use.
  const revisionFile = path.join(ctx.workspace, "revisions", `${node.id}.md`);
  const userRevision = fs.existsSync(revisionFile);
  if (userRevision) {
    const requested = fs.readFileSync(revisionFile, "utf8");
    const prior = path.join(ctx.workspace, "artifacts", node.id);
    feedback =
      "The user reviewed this step's previous output and requested changes:\n\n" +
      requested +
      (fs.existsSync(prior)
        ? `\n\nThe previously committed output is at: ${prior}\nStart from it and apply ONLY the requested changes — keep everything else stable.`
        : "");
    fs.renameSync(revisionFile, path.join(ctx.workspace, "revisions", `${node.id}-consumed.md`));
  }

  // Memoization: a node reopened by cascade (not by direct user revision)
  // whose inputs are byte-identical to its last commit re-commits from cache —
  // this is what makes revising an upstream artifact affordable.
  const memo = state.history[node.id];
  const inputsHash = hashInputs(ctx, node, state);
  if (!userRevision && memo?.inputsHash === inputsHash && artifactsIntact(ctx, memo.artifacts)) {
    ctx.journal.append({
      type: "node.committed",
      nodeId: node.id,
      artifacts: memo.artifacts,
      inputsHash,
      cached: true,
    });
    return "committed";
  }

  // Attempt numbering continues across reopens so attempt dirs never collide
  // and telemetry keeps the full history.
  const priorAttempts = ctx.journal
    .read()
    .filter((e) => e.type === "node.running" && e.nodeId === node.id).length;

  for (let seq = 1; seq <= maxAttempts; seq++) {
    const attempt = priorAttempts + seq;
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
      commit(ctx, node, attemptDir, inputsHash);
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
  if (node.params) inputs._params = { path: "", data: node.params };
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
 * Resolve an MCP server ref to its entry script.
 *  "./mcp/x"            -> package-local (part of the certified digest)
 *  "@harness/x[@ver]"   -> HARNESS_MCP_DIR override, repo/store mcp/ dir
 *                          (travels with registry installs), $HARNESS_HOME/mcp
 */
export function resolveMcpServer(ctx: RunContext, ref: string): string {
  const candidates: string[] = [];
  if (ref.startsWith("./") || ref.startsWith("../")) {
    candidates.push(path.resolve(ctx.projectTypeDir, ref));
  } else {
    const m = ref.match(/^@harness\/([a-z0-9-]+)(?:@[\w.-]+)?$/);
    if (!m) throw new Error(`invalid mcp server ref '${ref}'`);
    const name = m[1];
    if (process.env.HARNESS_MCP_DIR) candidates.push(path.join(process.env.HARNESS_MCP_DIR, name));
    candidates.push(path.resolve(ctx.projectTypeDir, "..", "..", "mcp", name));
    const home = process.env.HARNESS_HOME ?? path.join(os.homedir(), ".harness");
    candidates.push(path.join(home, "mcp", name));
  }
  for (const dir of candidates) {
    const entry = path.join(dir, "server.mjs");
    if (fs.existsSync(entry)) return entry;
  }
  throw new Error(`mcp server '${ref}' not found (looked in: ${candidates.join(", ")}) — run: harness setup`);
}

/**
 * The Claude Agent SDK is the harness's EXECUTION ENGINE — every certified
 * agent node runs through it (mocks exist only so certification replay is
 * deterministic). It isn't bundled into harness.cjs, so resolution is:
 *   1. HARNESS_SDK_DIR       — explicit pin (firms, tests)
 *   2. normal module lookup  — source checkouts / npm installs
 *   3. $HARNESS_HOME/runtime — where `harness setup` provisions the engine
 */
export async function loadAgentSdk(): Promise<{ query: (args: unknown) => AsyncIterable<Record<string, unknown>> }> {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const sdkModuleName = "@anthropic-ai/claude-agent-sdk";
  const candidates: (() => Promise<unknown>)[] = [];
  if (process.env.HARNESS_SDK_DIR) {
    const base = path.join(process.env.HARNESS_SDK_DIR, "noop.js");
    candidates.push(async () => import(pathToFileURL(createRequire(base).resolve(sdkModuleName)).href));
  }
  candidates.push(async () => import(sdkModuleName));
  const home = process.env.HARNESS_HOME ?? path.join((await import("node:os")).homedir(), ".harness");
  const runtime = path.join(home, "runtime", "node_modules", "noop.js");
  candidates.push(async () => import(pathToFileURL(createRequire(runtime).resolve(sdkModuleName)).href));

  for (const load of candidates) {
    try {
      return (await load()) as { query: (args: unknown) => AsyncIterable<Record<string, unknown>> };
    } catch {
      /* try the next resolution root */
    }
  }
  throw new Error(
    "Claude Agent SDK (the harness execution engine) is not available. Run: harness setup --install-sdk  (or npm i @anthropic-ai/claude-agent-sdk in a source checkout)",
  );
}

/**
 * Escalate-on-retry: attempt 1 runs the node's pinned (cheaper) model; retries
 * run escalateModel when declared — the failure feedback plus a stronger model
 * is the cost-optimal recovery path.
 */
export function modelForAttempt(node: NodeDef, attempt: number): string | undefined {
  return attempt > 1 && node.escalateModel ? node.escalateModel : node.model;
}

/**
 * Mid-step question bridge: the agent's AskUserQuestion surfaces in the
 * dashboard; the runner waits (bounded) for the human's answer via the
 * workspace filesystem. Unattended runs skip straight to assumptions.
 */
export async function askUserViaWorkspace(
  ctx: RunContext,
  nodeId: string,
  attempt: number,
  input: Record<string, unknown>,
  timeoutMs = 15 * 60 * 1000,
  pollMs = 1500,
): Promise<Record<string, unknown> | null> {
  if (ctx.acceptDefaults || ctx.mockAgents) return null; // unattended: no human to ask
  const id = `${nodeId}-${attempt}-${Date.now()}`;
  const pendingFile = path.join(ctx.workspace, "pending-question.json");
  const answerFile = path.join(ctx.workspace, "pending-answer.json");
  fs.rmSync(answerFile, { force: true });
  fs.writeFileSync(pendingFile, JSON.stringify({ id, nodeId, attempt, questions: input.questions ?? input }, null, 2));
  ctx.journal.append({ type: "agent.question_asked", nodeId, attempt, question: JSON.stringify(input).slice(0, 500) });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (!fs.existsSync(answerFile)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(answerFile, "utf8")) as { id: string; answers: Record<string, unknown> };
        if (parsed.id === id) return parsed.answers;
      } catch {
        /* partial write — retry next poll */
      }
    }
    return null;
  } finally {
    fs.rmSync(pendingFile, { force: true });
    fs.rmSync(answerFile, { force: true });
  }
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
      ? `\nIMPORTANT: ./feedback.md contains required changes (a failed attempt's errors, or explicit user revision requests). Read it FIRST and incorporate it.`
      : "",
  ].join("\n");

  const { query } = await loadAgentSdk();

  // Certified skills: staged from the PACKAGE into the session's project
  // settings dir. Hermeticity holds — the skill bytes are part of the
  // certified digest; user/global skills stay excluded.
  if (node.skills?.length) {
    for (const skill of node.skills) {
      const src = path.join(ctx.projectTypeDir, "skills", skill);
      if (!fs.existsSync(path.join(src, "SKILL.md"))) {
        throw new Error(`certified skill '${skill}' missing (skills/${skill}/SKILL.md)`);
      }
      fs.cpSync(src, path.join(attemptDir, ".claude", "skills", skill), { recursive: true });
    }
  }

  // MCP instances: certified capability servers, stdio-only, launched from
  // harness-controlled code with an explicit env. Resolution mirrors the SDK:
  // package-local path -> repo/store mcp/ dir -> $HARNESS_HOME/mcp.
  const mcpServers: Record<string, unknown> = {};
  for (const name of node.mcp ?? []) {
    const instance = ctx.def.mcp?.[name];
    if (!instance) throw new Error(`mcp instance '${name}' not declared`); // load-validated; belt+braces
    const entry = resolveMcpServer(ctx, instance.server);
    mcpServers[name] = {
      type: "stdio",
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        HARNESS_MCP_CONFIG: JSON.stringify(instance.config ?? {}),
        HARNESS_ATTEMPT_DIR: attemptDir,
        HARNESS_WORKSPACE: ctx.workspace,
        ...((instance.config as { env?: Record<string, string> } | undefined)?.env ?? {}),
      },
    };
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
      ...(node.agents ? { agents: node.agents } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      permissionMode: "acceptEdits",
      // Hermetic: never user/global settings. "project" resolves to the attempt
      // dir we stage ourselves — enabled only to carry certified skills.
      settingSources: node.skills?.length ? ["project"] : [],
      // Agents never get a free channel to interrupt users mid-node: questions
      // are denied with assumption guidance (and journaled for telemetry).
      // Everything else is allowed — the workspace itself is the sandbox.
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === "AskUserQuestion") {
          const answers = await askUserViaWorkspace(ctx, node.id, attempt, input);
          if (answers) {
            ctx.journal.append({ type: "agent.question_answered", nodeId: node.id, attempt, answers });
            return {
              behavior: "deny" as const,
              message:
                "The user answered your question: " +
                JSON.stringify(answers) +
                " — continue using this answer; do not ask again.",
            };
          }
          ctx.journal.append({
            type: "agent.question_denied",
            nodeId: node.id,
            attempt,
            question: JSON.stringify(input).slice(0, 400),
          });
          return {
            behavior: "deny" as const,
            message:
              "No human answer is available. Make a reasonable assumption, record it in your output artifact, and continue.",
          };
        }
        return { behavior: "allow" as const, updatedInput: input };
      },
    },
  });

  for await (const msg of session) {
    if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
      const init = msg as { tools?: unknown; agents?: unknown; model?: unknown; slash_commands?: unknown };
      ctx.journal.append({
        type: "agent.session_info",
        nodeId: node.id,
        attempt,
        tools: init.tools ?? [],
        agents: init.agents ?? [],
        model: init.model ?? null,
      });
    }
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
  // Structured transcript for the dashboard's step inspector: what the agent
  // said, which tools it used, and the final result — no raw payload dumps.
  try {
    const inner = (msg as { message?: { content?: unknown } }).message;
    if ((msg.type === "assistant" || msg.type === "user") && Array.isArray(inner?.content)) {
      const parts = (inner.content as Array<Record<string, unknown>>).map((b) =>
        b.type === "text"
          ? { kind: "text", preview: String(b.text).slice(0, 400) }
          : b.type === "tool_use"
            ? { kind: "tool", label: String(b.name), preview: JSON.stringify(b.input).slice(0, 240) }
            : b.type === "tool_result"
              ? { kind: "tool_result", preview: JSON.stringify(b.content).slice(0, 240) }
              : { kind: String(b.type ?? "other"), preview: "" },
      );
      return { type: msg.type, parts };
    }
    if (msg.type === "result") {
      return { type: "result", preview: String((msg as { result?: unknown }).result ?? "").slice(0, 400) };
    }
    if (msg.type === "system") {
      return { type: "system", preview: String((msg as { subtype?: unknown }).subtype ?? "") };
    }
  } catch {
    /* fall through to generic preview */
  }
  return { type: msg.type, preview: JSON.stringify(msg).slice(0, 240) };
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

function commit(ctx: RunContext, node: NodeDef, attemptDir: string, inputsHash?: string): void {
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
  ctx.journal.append({ type: "node.committed", nodeId: node.id, artifacts, inputsHash });
}

/**
 * Content hash of everything that determines a node's output: resolved inputs
 * (including the bytes of referenced files/directories — a dir artifact's path
 * alone would miss content changes), the prompt, params, and pinned model.
 */
function hashInputs(ctx: RunContext, node: NodeDef, state: RunState): string {
  const h = crypto.createHash("sha256");
  const inputs = buildInputs(ctx, node, state);
  h.update(JSON.stringify(inputs));
  for (const entry of Object.values(inputs)) {
    if (entry.path && fs.existsSync(entry.path)) hashPath(h, entry.path);
  }
  if (node.prompt) h.update(fs.readFileSync(path.join(ctx.projectTypeDir, node.prompt)));
  if (node.command) h.update(node.command);
  if (node.verify) h.update(node.verify);
  if (node.model) h.update(node.model);
  return h.digest("hex");
}

function hashPath(h: crypto.Hash, p: string): void {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(p).sort()) {
      h.update(entry);
      hashPath(h, path.join(p, entry));
    }
  } else {
    h.update(fs.readFileSync(p));
  }
}

function artifactsIntact(ctx: RunContext, artifacts: Record<string, string>): boolean {
  return Object.values(artifacts).every((rel) => fs.existsSync(path.join(ctx.workspace, rel)));
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
  // Per-incarnation: the node budget guards runaway spend within ONE execution
  // cycle. A reopen (retry-after-fix or user revision) starts a fresh cycle —
  // otherwise a single legitimate revision would inevitably bust the cap.
  const events = ctx.journal.read();
  let lastReopen = -1;
  events.forEach((e, i) => {
    if (e.type === "node.reopened" && e.nodeId === nodeId) lastReopen = i;
  });
  return events
    .slice(lastReopen + 1)
    .filter((e) => e.type === "cost.recorded" && e.nodeId === nodeId)
    .reduce((sum, e) => sum + ((e.cost as CostRecord | undefined)?.costUsd ?? 0), 0);
}
