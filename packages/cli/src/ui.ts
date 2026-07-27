/**
 * Local web dashboard v2 — the human surface of a run.
 * Built for product users, not runner developers:
 * - every step explains itself (description, dependencies, live status)
 * - click a step to inspect it: agent transcript, attempts, cost + tokens
 * - Decisions panel: everything you answered/approved, with sources
 * - Documents panel: curated human-readable outputs (raw files tucked away)
 * - narrated activity; render-only-on-change; zero dependencies; localhost only
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Journal, foldState, loadProjectType, loadProjectTypeFile } from "@harness/runner";
import type { GateQuestion, LedgerEvent, NodeDef, ProjectTypeDef } from "@harness/spec";

interface UiRunConfig {
  projectTypeDir: string;
  answersFile?: string;
  mockAgents: boolean;
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Curated, human-relevant documents (artifact name -> label + why you'd read it). */
const DOC_LABELS: Record<string, { label: string; blurb: string }> = {
  intake: { label: "Intake answers", blurb: "What you told the harness at kickoff" },
  corpus_index: { label: "Evidence index", blurb: "Sources and claims extracted from your documents" },
  requirements: { label: "Requirements", blurb: "Every requirement, with provenance and confidence" },
  gaps: { label: "Clarifying questions", blurb: "The questions the harness needed answered" },
  clarifications: { label: "Your clarifications", blurb: "Your answers, including accepted defaults" },
  architecture: { label: "Architecture & modules", blurb: "Chosen modules, deploy target, build budget plan" },
  designs: { label: "Design options index", blurb: "The generated design directions" },
  design_choice: { label: "Design choice", blurb: "The direction you approved" },
  data_model: { label: "Data model", blurb: "The tables backing your app" },
  agent_roster: { label: "Agent roster", blurb: "Your app's agents: roles, tools, policies, evals" },
  rtm: { label: "Traceability matrix", blurb: "Every requirement mapped to the design that addresses it" },
  design_review: { label: "Design approval", blurb: "Your pre-build confirmation" },
  slice_plan: { label: "Slice plan", blurb: "The feature-by-feature build plan with acceptance checks" },
  integration_report: { label: "Integration report", blurb: "Tests, agent evals, and container checks" },
  security_report: { label: "Security report", blurb: "Scan results and findings" },
  governance: { label: "Governance evidence pack", blurb: "Controls with proof, in one place" },
  uat: { label: "UAT sign-off", blurb: "Your final acceptance" },
};

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readArtifactJson(workspace: string, artifacts: Record<string, Record<string, string>>, name: string): Record<string, unknown> | null {
  for (const byNode of Object.values(artifacts)) {
    if (byNode[name]) return readJsonSafe(path.join(workspace, byNode[name]));
  }
  return null;
}

function readConfig(workspace: string): UiRunConfig {
  return JSON.parse(fs.readFileSync(path.join(workspace, "run.json"), "utf8")) as UiRunConfig;
}

function loadDef(workspace: string, projectTypeDir: string): ProjectTypeDef {
  const snapshot = path.join(workspace, "dag.snapshot.yaml");
  return fs.existsSync(snapshot) ? loadProjectTypeFile(snapshot) : loadProjectType(projectTypeDir);
}

function walk(dir: string, base: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

function resolveQuestions(
  workspace: string,
  node: NodeDef,
  artifacts: Record<string, Record<string, string>>,
): GateQuestion[] {
  if (node.questions) return node.questions;
  if (!node.questionsFrom) return [];
  for (const byNode of Object.values(artifacts)) {
    const rel = byNode[node.questionsFrom.artifact];
    if (!rel) continue;
    try {
      let value: unknown = JSON.parse(fs.readFileSync(path.join(workspace, rel), "utf8"));
      for (const seg of (node.questionsFrom.path ?? "questions").split(".")) {
        value = (value as Record<string, unknown>)?.[seg];
      }
      if (Array.isArray(value)) return value as GateQuestion[];
    } catch {
      /* partial write during live runs */
    }
  }
  return [];
}

/** Human sentence for an event — the Activity feed speaks product, not ledger. */
function narrate(e: LedgerEvent, costs: Map<string, { costUsd: number }>): string | null {
  const id = e.nodeId as string | undefined;
  switch (e.type) {
    case "run.created":
      return "Run started";
    case "run.completed":
      return "Run completed — everything green";
    case "run.parked":
      return `Waiting on you: ${id}`;
    case "run.failed":
      return `Run stopped${id ? ` at ${id}` : ""} — open the step for details`;
    case "node.running":
      return (e.attempt as number) > 1 ? `Retrying ${id} (attempt ${e.attempt})` : `Started ${id}`;
    case "node.committed": {
      const c = costs.get(`${id}`);
      const money = c && c.costUsd > 0 ? ` — $${c.costUsd.toFixed(2)}` : "";
      return `Finished ${id}${money}`;
    }
    case "node.attempt_failed":
      return `${id} attempt ${e.attempt} failed: ${String(e.error).split("\n")[0].slice(0, 110)}`;
    case "node.failed":
      return `${id} failed after all attempts`;
    case "node.skipped":
      return `Skipped ${id} (not needed for this run)`;
    case "node.reopened":
      return `Reopened ${id} for another try`;
    case "gate.answered":
      return `You answered ${id} (${e.source})`;
    case "budget.exceeded":
      return e.scope === "questions"
        ? `${id} tried to over-ask and was blocked`
        : `Budget exceeded (${e.scope}${id ? `: ${id}` : ""})`;
    case "agent.question_denied":
      return `${id} tried to ask a mid-step question — denied; it proceeds on recorded assumptions`;
    default:
      return null; // cost.recorded + agent.message roll up elsewhere
  }
}

export function buildState(workspace: string): Record<string, unknown> {
  const config = readConfig(workspace);
  const def = loadDef(workspace, config.projectTypeDir);
  const events = new Journal(workspace).read();
  const state = foldState(events);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));

  const costs: Record<
    string,
    { costUsd: number; wallClockMs: number; tokensIn: number; tokensOut: number; model?: string }
  > = {};
  let tokensIn = 0;
  let tokensOut = 0;
  for (const e of events) {
    if (e.type !== "cost.recorded") continue;
    const c = e.cost as {
      costUsd: number;
      wallClockMs: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      model?: string;
    };
    const agg = (costs[e.nodeId as string] ??= { costUsd: 0, wallClockMs: 0, tokensIn: 0, tokensOut: 0 });
    agg.costUsd += c.costUsd;
    agg.wallClockMs += c.wallClockMs;
    agg.tokensIn += c.inputTokens + c.cacheReadTokens;
    agg.tokensOut += c.outputTokens;
    if (c.model) agg.model = c.model;
    tokensIn += c.inputTokens + c.cacheReadTokens;
    tokensOut += c.outputTokens;
  }

  const running = new Set<string>();
  const retries: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "node.running") running.add(e.nodeId as string);
    if (e.type === "node.attempt_failed") retries[e.nodeId as string] = (retries[e.nodeId as string] ?? 0) + 1;
  }

  const parkedNodeId =
    events
      .filter((e) => e.type === "node.parked")
      .map((e) => e.nodeId as string)
      .find((id) => !state.committed.has(id)) ?? null;

  const dependents: Record<string, string[]> = {};
  for (const n of def.nodes) {
    for (const d of n.deps ?? []) (dependents[d] ??= []).push(n.id);
  }

  const nodes = def.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    phase: n.phase ?? "Steps",
    description: n.description ?? null,
    deps: n.deps ?? [],
    feeds: dependents[n.id] ?? [],
    model: costs[n.id]?.model ?? n.model ?? null,
    state: state.committed.has(n.id)
      ? "committed"
      : state.skipped.has(n.id)
        ? "skipped"
        : state.failed.has(n.id)
          ? "failed"
          : n.id === parkedNodeId
            ? "parked"
            : running.has(n.id)
              ? "started"
              : "pending",
    cost: costs[n.id] ?? null,
    retries: retries[n.id] ?? 0,
  }));

  // Decisions: every answer/approval you gave, with question text + sources.
  const decisions: unknown[] = [];
  for (const e of events.filter((e) => e.type === "gate.answered")) {
    const node = byId.get(e.nodeId as string);
    if (!node) continue;
    const questions = resolveQuestions(workspace, node, state.artifacts);
    const qById = new Map(questions.map((q) => [q.id, q]));
    decisions.push({
      gate: node.id,
      description: node.description ?? null,
      ts: e.ts,
      source: e.source,
      items: Object.entries(e.answers as Record<string, string>).map(([qid, answer]) => {
        const q = qById.get(qid);
        return {
          prompt: q?.prompt ?? qid,
          answer,
          why: q?.why ?? null,
          defaulted: q?.default !== undefined && answer === q.default,
        };
      }),
    });
  }
  let assumptions: unknown[] = [];
  for (const byNode of Object.values(state.artifacts)) {
    if (byNode.rtm) {
      try {
        assumptions = (JSON.parse(fs.readFileSync(path.join(workspace, byNode.rtm), "utf8")) as { assumptions: unknown[] })
          .assumptions;
      } catch {
        /* live write */
      }
    }
  }

  // Documents: curated human-readable outputs; raw files tucked behind "advanced".
  const documents: { label: string; blurb: string; node: string; href: string; fetch: string }[] = [];
  for (const [nodeId, byName] of Object.entries(state.artifacts)) {
    for (const [name, rel] of Object.entries(byName)) {
      const meta = DOC_LABELS[name];
      if (meta && rel.endsWith(".json")) {
        const clean = rel.replace(/^artifacts\//, "");
        documents.push({ ...meta, node: nodeId, href: `/view/${clean}`, fetch: `/artifact/${clean}` });
      }
    }
  }
  documents.sort(
    (a, b) => def.nodes.findIndex((n) => n.id === a.node) - def.nodes.findIndex((n) => n.id === b.node),
  );
  const docsWithPhase = documents.map((d) => ({ ...d, phase: byId.get(d.node)?.phase ?? "Steps" }));

  // Quality summary — the test/security/coverage results, front and center.
  const integration = readArtifactJson(workspace, state.artifacts, "integration_report");
  const security = readArtifactJson(workspace, state.artifacts, "security_report");
  const governance = readArtifactJson(workspace, state.artifacts, "governance");
  const rtmDoc = readArtifactJson(workspace, state.artifacts, "rtm");
  const slicePlanDoc = readArtifactJson(workspace, state.artifacts, "slice_plan");
  const quality = {
    backendTests: (integration?.backend_tests as { status?: string } | undefined)?.status ?? null,
    backendSummary: (integration?.backend_tests as { summary?: string } | undefined)?.summary ?? null,
    evals: (integration?.evals as { status?: string; passed?: number; total?: number } | undefined) ?? null,
    composeConfig: (integration?.compose_config as string | undefined) ?? null,
    composeSmoke: (integration?.compose_smoke as string | undefined) ?? null,
    securityHigh: (security?.high_count as number | undefined) ?? null,
    securityFindings: Array.isArray(security?.findings) ? (security!.findings as unknown[]).length : null,
    requirementsCovered:
      (governance?.requirements as { covered?: number; total?: number } | undefined) ??
      (rtmDoc ? { covered: rtmDoc.covered_count as number, total: rtmDoc.requirements_total as number } : null),
    assumptionCount: Array.isArray(rtmDoc?.assumptions) ? (rtmDoc!.assumptions as unknown[]).length : null,
    slicesPlanned: Array.isArray(slicePlanDoc?.slices) ? (slicePlanDoc!.slices as unknown[]).length : null,
    slicesDelivered: def.nodes.filter((n) => /^slice-[0-9]+$/.test(n.id) && state.committed.has(n.id)).length,
  };

  const intakeDoc = readArtifactJson(workspace, state.artifacts, "intake");
  const designChoiceDoc = readArtifactJson(workspace, state.artifacts, "design_choice");
  const pendingQuestion = readJsonSafe(path.join(workspace, "pending-question.json"));

  // Slice progress screenshots (shipped inside the app artifact by verify-slice).
  const sliceShots: { slice: string; href: string }[] = [];
  for (const rel of walk(path.join(workspace, "artifacts"), path.join(workspace, "artifacts"))) {
    const m = rel.match(new RegExp("^(slice-[0-9]+)/app/screenshots/(slice-[0-9]+)[.]png$"));
    if (m && m[1] === m[2].replace("slice-", "slice-")) {
      if (rel.startsWith(m[2].split(".")[0])) sliceShots.push({ slice: m[2], href: "/artifact/" + rel });
    }
  }

  let designOptions: unknown = null;
  for (const byNode of Object.values(state.artifacts)) {
    if (byNode.designs) {
      try {
        designOptions = (JSON.parse(fs.readFileSync(path.join(workspace, byNode.designs), "utf8")) as { options: unknown })
          .options;
      } catch {
        /* live write */
      }
    }
  }

  const costMap = new Map(Object.entries(costs).map(([k, v]) => [k, { costUsd: v.costUsd }]));
  const firstTs = events[0]?.ts;
  const lastTs = events[events.length - 1]?.ts;
  const activeMs = Object.values(costs).reduce((sum, c) => sum + c.wallClockMs, 0);

  return {
    projectType: `${def.name}@${def.version}`,
    projectDescription: def.description ?? null,
    runMode: config.mockAgents ? "replay" : "live",
    appName: (intakeDoc?.project_name as string | undefined) ?? null,
    problemStatement: (intakeDoc?.problem_statement as string | undefined) ?? null,
    quality,
    designChoice: (designChoiceDoc?.chosen_option as string | undefined) ?? null,
    pendingQuestion,
    sliceShots,
    workspace,
    totalCostUsd: state.totalCostUsd,
    runBudgetUsd: def.cost?.run_budget_usd ?? null,
    tokensIn,
    tokensOut,
    status: events.some((e) => e.type === "run.completed")
      ? "completed"
      : parkedNodeId
        ? "parked"
        : events[events.length - 1]?.type === "run.failed"
          ? "failed"
          : "running",
    nodes,
    parkedGate:
      parkedNodeId && byId.get(parkedNodeId)
        ? { nodeId: parkedNodeId, questions: resolveQuestions(workspace, byId.get(parkedNodeId)!, state.artifacts) }
        : null,
    decisions,
    assumptions,
    documents: docsWithPhase,
    designOptions,
    elapsedMs: firstTs && lastTs ? Date.parse(String(lastTs)) - Date.parse(String(firstTs)) : 0,
    activeMs,
    startedAt: firstTs ?? null,
    rawArtifacts: walk(path.join(workspace, "artifacts"), path.join(workspace, "artifacts")),
    events: events
      .map((e) => ({ ts: e.ts, type: e.type, nodeId: e.nodeId ?? null, text: narrate(e, costMap) }))
      .filter((e) => e.text !== null)
      .slice(-160),
  };
}

/** Step inspector: attempts, errors, cost/tokens, and the agent's transcript. */
export function buildNodeDetail(workspace: string, nodeId: string): Record<string, unknown> | null {
  const config = readConfig(workspace);
  const def = loadDef(workspace, config.projectTypeDir);
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const events = new Journal(workspace).read().filter((e) => e.nodeId === nodeId);

  const attempts: Record<number, { started?: string; error?: string; costUsd?: number; tokens?: number; wallClockMs?: number }> =
    {};
  for (const e of events) {
    const n = e.attempt as number | undefined;
    if (n === undefined) continue;
    const a = (attempts[n] ??= {});
    if (e.type === "node.running") a.started = e.ts;
    if (e.type === "node.attempt_failed") a.error = String(e.error).slice(0, 1200);
    if (e.type === "cost.recorded") {
      const c = e.cost as {
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        wallClockMs: number;
      };
      a.costUsd = c.costUsd;
      a.tokens = c.inputTokens + c.cacheReadTokens + c.outputTokens;
      a.wallClockMs = c.wallClockMs;
    }
  }

  const transcript = events
    .filter((e) => e.type === "agent.message")
    .slice(-120)
    .map((e) => ({ attempt: e.attempt, message: e.message }));

  const sessionInfoEvent = events.filter((e) => e.type === "agent.session_info").pop();
  const toolCounts: Record<string, number> = {};
  for (const t of transcript) {
    const parts = (t.message as { parts?: { kind: string; label?: string }[] } | undefined)?.parts ?? [];
    for (const p of parts) if (p.kind === "tool" && p.label) toolCounts[p.label] = (toolCounts[p.label] ?? 0) + 1;
  }
  const questions = events
    .filter((e) => e.type === "agent.question_asked" || e.type === "agent.question_answered" || e.type === "agent.question_denied")
    .map((e) => ({ type: e.type, ts: e.ts }));

  const describe = (id: string) => def.nodes.find((n) => n.id === id)?.description ?? null;
  let promptText: string | null = null;
  if (node.prompt) {
    try {
      promptText = fs.readFileSync(path.join(config.projectTypeDir, node.prompt), "utf8").slice(0, 6000);
    } catch {
      promptText = null;
    }
  }
  return {
    prompt: promptText,
    id: node.id,
    kind: node.kind,
    description: node.description ?? null,
    deps: (node.deps ?? []).map((d) => ({ id: d, description: describe(d) })),
    feeds: def.nodes.filter((n) => (n.deps ?? []).includes(nodeId)).map((n) => ({ id: n.id, description: n.description ?? null })),
    model: node.model ?? null,
    escalateModel: node.escalateModel ?? null,
    hasVerify: Boolean(node.verify),
    attempts: Object.entries(attempts).map(([n, a]) => ({ attempt: Number(n), ...a })),
    transcript,
    toolCounts,
    sessionInfo: sessionInfoEvent
      ? { tools: sessionInfoEvent.tools ?? [], agents: sessionInfoEvent.agents ?? [], model: sessionInfoEvent.model ?? null }
      : null,
    questions,
  };
}

function mergeAnswers(workspace: string, nodeId: string, answers: Record<string, string>): string {
  const file = path.join(workspace, "ui-answers.json");
  const config = readConfig(workspace);
  const existing: Record<string, Record<string, string>> = {};
  if (config.answersFile && fs.existsSync(config.answersFile)) {
    Object.assign(existing, JSON.parse(fs.readFileSync(config.answersFile, "utf8")));
  }
  if (fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
    for (const [k, v] of Object.entries(prev)) existing[k] = { ...existing[k], ...v };
  }
  existing[nodeId] = { ...existing[nodeId], ...answers };
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  return file;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address() as net.AddressInfo;
      probe.close(() => resolve(addr.port));
    });
    probe.on("error", reject);
  });
}

interface AppPreview {
  status: "stopped" | "starting" | "running" | "failed";
  port: number | null;
  node: string | null;
  pid: number | null;
  error?: string;
}

/** Scan a directory for run workspaces — the storefront of built apps. */
export function scanRuns(root: string): Record<string, unknown>[] {
  const runs: Record<string, unknown>[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return runs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, "run.json")) || !fs.existsSync(path.join(dir, "journal.jsonl"))) continue;
    try {
      const st = buildState(dir);
      runs.push({
        dir,
        name: entry.name,
        appName: st.appName ?? entry.name,
        projectType: st.projectType,
        status: st.status,
        runMode: st.runMode,
        costUsd: st.totalCostUsd,
        updatedAt: fs.statSync(path.join(dir, "journal.jsonl")).mtime.toISOString(),
      });
    } catch {
      /* unreadable workspace — skip */
    }
  }
  runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return runs.slice(0, 50);
}

export function startUiServer(target: string, port: number): Promise<http.Server> {
  const singleMode = fs.existsSync(path.join(target, "run.json"));
  const root = singleMode ? path.dirname(target) : target;
  let workspace: string | null = singleMode ? target : null;
  let resuming = false;
  const artifactsRoot = () => path.join(workspace ?? target, "artifacts");
  const app: AppPreview = { status: "stopped", port: null, node: null, pid: null };

  function latestAppArtifact(): { node: string; dir: string } | null {
    if (workspace === null) return null;
    const config = readConfig(workspace);
    const def = loadDef(workspace!, config.projectTypeDir);
    const artifactName = def.preview?.artifact ?? "app";
    const state = foldState(new Journal(workspace!).read());
    let found: { node: string; dir: string } | null = null;
    for (const n of def.nodes) {
      const rel = state.artifacts[n.id]?.[artifactName];
      if (rel) found = { node: n.id, dir: path.join(workspace!, rel) };
    }
    return found;
  }

  function stopApp(): void {
    if (app.pid) {
      try {
        process.kill(-app.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    app.status = "stopped";
    app.port = null;
    app.pid = null;
  }

  async function startApp(): Promise<void> {
    stopApp();
    if (workspace === null) return;
    const config = readConfig(workspace);
    const def = loadDef(workspace, config.projectTypeDir);
    const preview = def.preview;
    const latest = latestAppArtifact();
    if (!preview || !latest) {
      app.status = "failed";
      app.error = preview ? "no app artifact committed yet" : "project type declares no preview";
      return;
    }
    const runDir = path.join(workspace, "app-preview");
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.cpSync(latest.dir, runDir, { recursive: true });

    const appPort = await getFreePort();
    app.status = "starting";
    app.node = latest.node;
    app.error = undefined;
    const logFile = path.join(workspace, "app-preview.log");
    const log = fs.openSync(logFile, "w");
    const child = spawn(preview.command, {
      shell: true,
      detached: true,
      cwd: path.join(runDir, preview.cwd ?? "."),
      env: { ...process.env, PORT: String(appPort) },
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    app.pid = child.pid ?? null;
    child.on("exit", () => {
      if (app.pid === child.pid && app.status !== "stopped") {
        app.status = app.status === "running" ? "stopped" : "failed";
        if (app.status === "failed") {
          let tail = "";
          try {
            tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-6).join(" | ");
          } catch {
            /* no log */
          }
          app.error = "app process exited during startup: " + tail.slice(-300);
        }
        app.pid = null;
        app.port = null;
      }
    });
    const healthUrl = "http://127.0.0.1:" + appPort + (preview.health ?? "/");
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (app.pid !== child.pid) return;
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {
          app.status = "running";
          app.port = appPort;
          return;
        }
      } catch {
        /* booting */
      }
    }
    app.status = "failed";
    app.error = "app did not become healthy within 60s";
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      } else if (url.pathname === "/api/runs") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ root, runs: scanRuns(root), selected: workspace }));
      } else if (url.pathname === "/api/select" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { dir } = JSON.parse(body) as { dir: string };
          const abs = path.resolve(dir);
          if (!abs.startsWith(path.resolve(root)) || !fs.existsSync(path.join(abs, "run.json"))) {
            res.writeHead(400).end("not a run workspace under the served root");
            return;
          }
          stopApp();
          workspace = abs;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else if (url.pathname === "/api/deselect" && req.method === "POST") {
        stopApp();
        workspace = null;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (workspace === null && url.pathname.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ selected: false }));
      } else if (url.pathname === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            selected: true,
            ...buildState(workspace!),
            resuming,
            app,
            appAvailable: latestAppArtifact() !== null,
            appStageNode: latestAppArtifact()?.node ?? null,
          }),
        );
      } else if (url.pathname === "/api/agent-answer" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { id, answers } = JSON.parse(body) as { id: string; answers: Record<string, unknown> };
          fs.writeFileSync(path.join(workspace!, "pending-answer.json"), JSON.stringify({ id, answers }, null, 2));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else if (url.pathname.startsWith("/api/node/")) {
        const detail = buildNodeDetail(workspace!, decodeURIComponent(url.pathname.slice("/api/node/".length)));
        if (!detail) {
          res.writeHead(404).end("unknown node");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(detail));
      } else if (url.pathname.startsWith("/view/")) {
        // Pretty document viewer for curated artifacts.
        const rel = decodeURIComponent(url.pathname.slice("/view/".length));
        const abs = path.normalize(path.join(artifactsRoot(), rel));
        if (!abs.startsWith(artifactsRoot() + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        let body = fs.readFileSync(abs, "utf8");
        if (abs.endsWith(".json")) {
          try {
            body = JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            /* show as-is */
          }
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(VIEW_PAGE.replace("__TITLE__", rel).replace("__BODY__", body.replace(/&/g, "&amp;").replace(/</g, "&lt;")));
      } else if (url.pathname.startsWith("/artifact/")) {
        const rel = decodeURIComponent(url.pathname.slice("/artifact/".length));
        const abs = path.normalize(path.join(artifactsRoot(), rel));
        if (!abs.startsWith(artifactsRoot() + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "text/plain; charset=utf-8" });
        res.end(fs.readFileSync(abs));
      } else if (url.pathname === "/api/answer" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { nodeId, answers } = JSON.parse(body) as { nodeId: string; answers: Record<string, string> };
          const answersFile = mergeAnswers(workspace!, nodeId, answers);
          const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));
          resuming = true;
          const child = spawn(process.execPath, [cliEntry, "resume", workspace!, "--answers", answersFile], {
            stdio: "ignore",
            detached: false,
          });
          child.on("exit", () => (resuming = false));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } else if (url.pathname === "/api/app/start" && req.method === "POST") {
        void startApp();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.pathname === "/api/app/stop" && req.method === "POST") {
        stopApp();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });

  server.on("close", stopApp);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const VIEW_PAGE = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>__TITLE__</title>
<style>
body { font: 14px/1.6 system-ui, sans-serif; margin: 0; background: #f9f9f7; color: #0b0b0b; }
@media (prefers-color-scheme: dark) { body { background: #0d0d0d; color: #e6e6e6; } pre { background: #1a1a19 !important; border-color: rgba(255,255,255,.1) !important; } }
header { padding: 1rem 1.5rem; font-weight: 600; }
pre { margin: 0 1.5rem 1.5rem; padding: 1rem 1.2rem; background: #fcfcfb; border: 1px solid rgba(11,11,11,.1); border-radius: 10px; overflow: auto; font: 12.5px/1.55 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
</style></head>
<body><header>__TITLE__</header><pre>__BODY__</pre></body></html>`;

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness</title>
<style>
:root {
  color-scheme: light;
  --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --border:rgba(11,11,11,.10); --accent:#2a78d6; --accent-ink:#ffffff;
  --good:#0ca30c; --warn:#fab219; --serious:#ec835a; --crit:#d03b3b;
  --shadow:0 1px 3px rgba(11,11,11,.06), 0 4px 16px rgba(11,11,11,.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --border:rgba(255,255,255,.10); --accent:#3987e5; --shadow:none;
  }
}
* { box-sizing:border-box; margin:0; }
body { font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--page); color:var(--ink); }
.mono { font-family:ui-monospace,Menlo,monospace; }
.topbar { position:sticky; top:0; z-index:40; background:var(--page); border-bottom:1px solid var(--grid); padding:.8rem clamp(1rem,4vw,2.5rem); display:flex; align-items:center; gap:.9rem; flex-wrap:wrap; }
.topbar h1 { font-size:1.05rem; font-weight:650; cursor:pointer; }
.topbar .mini { color:var(--ink2); font-size:.82rem; }
.pill { display:inline-flex; align-items:center; gap:.45rem; padding:.28rem .8rem; border-radius:999px; border:1px solid var(--border); background:var(--surface); font-weight:550; font-size:.82rem; }
.pill .dot { width:8px; height:8px; border-radius:50%; }
.pill.live { border-color:var(--good); color:var(--good); }
.pill.replay { border-color:var(--warn); }
.tabs { display:flex; gap:.25rem; margin-left:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:.25rem; }
.tabs button { border:0; background:transparent; color:var(--ink2); font:inherit; font-weight:550; padding:.4rem .95rem; border-radius:7px; cursor:pointer; }
.tabs button.active { background:var(--accent); color:var(--accent-ink); }
.tabs button .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--warn); margin-left:.35rem; vertical-align:middle; }
.banner { display:none; align-items:center; gap:.7rem; margin:1rem clamp(1rem,4vw,2.5rem) 0; padding:.7rem 1rem; border:1px solid var(--warn); border-left-width:4px; background:var(--surface); border-radius:10px; }
.banner b { color:var(--warn); }
.banner button { margin-left:auto; }
main { padding:1.2rem clamp(1rem,4vw,2.5rem); }
.tabpane { display:none; }
.tabpane.active { display:block; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:.8rem; margin-bottom:1rem; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:.85rem 1rem; box-shadow:var(--shadow); }
.tile .k { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:.35rem; }
.tile .v { font-size:1.4rem; font-weight:650; letter-spacing:-.01em; }
.tile .sub { font-size:.78rem; color:var(--ink2); margin-top:.1rem; }
.meter { height:6px; border-radius:3px; background:var(--grid); margin-top:.55rem; overflow:hidden; }
.meter > div { height:100%; border-radius:3px; background:var(--accent); transition:width .6s ease; }
.meter > div.over { background:var(--crit); }
.grid2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:1rem; align-items:start; }
@media (max-width:980px){ .grid2 { grid-template-columns:1fr; } }
.card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.15rem; box-shadow:var(--shadow); margin-bottom:1rem; }
.card h2 { font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:.7rem; }
.hint { font-size:.78rem; color:var(--muted); text-transform:none; letter-spacing:0; }
.empty { color:var(--muted); font-size:.84rem; }
.chip { white-space:nowrap; font-size:.68rem; padding:.05rem .5rem; border-radius:999px; border:1px solid var(--border); color:var(--ink2); }
.chip.model { color:var(--accent); border-color:var(--accent); }
.chip.retry { color:var(--serious); border-color:var(--serious); }
.chip.default { color:var(--muted); }
.chip.ok { color:var(--good); border-color:var(--good); }
.chip.bad { color:var(--crit); border-color:var(--crit); }
button.primary { background:var(--accent); color:var(--accent-ink); border:0; border-radius:8px; padding:.55rem 1.1rem; font:inherit; font-weight:560; cursor:pointer; }
button.primary:hover { filter:brightness(1.08); }
button.ghost { background:transparent; border:1px solid var(--border); color:var(--ink2); border-radius:8px; padding:.5rem .9rem; font:inherit; cursor:pointer; }
/* storefront */
.store { max-width:1100px; }
.store .lead { margin:.4rem 0 1.2rem; color:var(--ink2); }
.storegrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:1rem; }
.runcard { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:1.1rem 1.2rem; cursor:pointer; box-shadow:var(--shadow); font:inherit; color:inherit; text-align:left; }
.runcard:hover { border-color:var(--accent); }
.runcard b { font-size:1.02rem; }
.runcard .meta { color:var(--muted); font-size:.78rem; margin-top:.4rem; display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
.newrun { border-style:dashed; }
.newrun code { display:block; background:var(--page); border:1px solid var(--grid); border-radius:8px; padding:.6rem .8rem; font-size:.74rem; margin-top:.6rem; overflow-x:auto; white-space:pre; }
/* about + quality */
.kv { display:grid; grid-template-columns:minmax(140px,190px) 1fr; gap:.25rem 1rem; font-size:.85rem; padding:.16rem 0; }
.kv .k { color:var(--muted); }
.qrow { display:flex; align-items:center; gap:.6rem; padding:.3rem 0; border-bottom:1px solid var(--grid); font-size:.86rem; }
.qrow:last-child { border-bottom:0; }
.qrow .stat { margin-left:auto; color:var(--ink2); font-size:.8rem; }
.qrow .mark { width:20px; text-align:center; }
.qrow .mark.ok { color:var(--good); } .qrow .mark.bad { color:var(--crit); } .qrow .mark.na { color:var(--muted); }
/* slice progress */
.shots { display:flex; gap:.8rem; overflow-x:auto; padding-bottom:.3rem; }
.shot { flex:none; width:260px; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--page); cursor:zoom-in; padding:0; font:inherit; color:inherit; }
.shot:hover { border-color:var(--accent); }
.shot img { width:100%; display:block; }
.shot .cap { padding:.4rem .6rem; font-size:.76rem; color:var(--ink2); }
/* pipeline */
.phase { margin-bottom:1.1rem; }
.phase .phead { display:flex; align-items:center; gap:.7rem; padding:.4rem 0; }
.phase .phead b { font-size:.95rem; }
.phase .phead .bar { flex:1; height:4px; border-radius:2px; background:var(--grid); overflow:hidden; }
.phase .phead .bar div { height:100%; background:var(--good); }
.phase .phead .stat { font-size:.75rem; color:var(--muted); white-space:nowrap; }
.prow { display:grid; grid-template-columns:26px minmax(150px,190px) 110px 1fr 76px 86px 64px; gap:.6rem; align-items:center; padding:.34rem .45rem; border-radius:8px; cursor:pointer; border:1px solid transparent; }
.prow:hover { background:var(--page); border-color:var(--border); }
.prow.header { cursor:default; border:0; padding-top:0; padding-bottom:.15rem; }
.prow.header:hover { background:transparent; }
.prow.header span { font-size:.66rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
.prow .num { text-align:right; font-size:.74rem; color:var(--ink2); }
.prow .icon { width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.7rem; background:var(--surface); border:2px solid var(--grid); color:var(--muted); position:relative; }
.prow.committed .icon { border-color:var(--good); color:var(--good); }
.prow.failed .icon { border-color:var(--crit); background:var(--crit); color:#fff; }
.prow.parked .icon { border-color:var(--warn); color:var(--warn); }
.prow.started .icon { border-color:var(--accent); color:var(--accent); }
.prow.started .icon::after { content:""; position:absolute; inset:-6px; border-radius:50%; border:2px solid var(--accent); opacity:.5; animation:pulse 1.4s ease-out infinite; }
@keyframes pulse { from { transform:scale(.7); opacity:.6; } to { transform:scale(1.15); opacity:0; } }
.prow .id { font-weight:560; overflow:hidden; text-overflow:ellipsis; }
.prow.pending .id, .prow.skipped .id { color:var(--muted); font-weight:450; }
.prow .desc { font-size:.76rem; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* gate + agent question */
.gate { border-left:3px solid var(--warn); }
.gate .q { margin-bottom:.85rem; }
.gate label { display:block; font-weight:560; margin-bottom:.12rem; }
.gate .why { font-size:.78rem; color:var(--ink2); margin-bottom:.35rem; }
.gate input[type=text] { width:100%; background:var(--page); border:1px solid var(--grid); color:var(--ink); border-radius:8px; padding:.55rem .7rem; font:inherit; }
.gate input:focus { outline:2px solid var(--accent); outline-offset:1px; }
.opt { display:flex; gap:.6rem; align-items:flex-start; border:1px solid var(--grid); border-radius:8px; padding:.5rem .7rem; margin:.3rem 0; cursor:pointer; }
.opt:hover { border-color:var(--accent); }
.opt input { margin-top:.2rem; }
.opt .od { font-size:.76rem; color:var(--muted); }
/* designs */
.designs { display:grid; grid-template-columns:repeat(auto-fill,300px); gap:.9rem; }
.design { border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--page); position:relative; }
.design.chosen { border-color:var(--good); box-shadow:0 0 0 2px var(--good); }
.design .sel { position:absolute; top:.5rem; right:.5rem; z-index:2; background:var(--good); color:#fff; font-size:.7rem; font-weight:600; padding:.15rem .6rem; border-radius:99px; }
.design .thumb { height:230px; overflow:hidden; background:#fff; position:relative; }
.design .thumb iframe { width:1200px; height:920px; border:0; transform:scale(0.25); transform-origin:0 0; pointer-events:none; }
.design .thumb a { position:absolute; inset:0; }
.design .bar { display:flex; align-items:center; gap:.45rem .5rem; padding:.5rem .7rem; border-top:1px solid var(--border); flex-wrap:wrap; }
.design .bar b { font-size:.85rem; flex:1 1 100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.design .bar .chip { margin-right:auto; }
.design .bar a { font-size:.78rem; color:var(--accent); text-decoration:none; }
.design .bar button { background:transparent; border:1px solid var(--accent); color:var(--accent); border-radius:6px; padding:.2rem .7rem; font:inherit; font-size:.78rem; cursor:pointer; }
.design .bar button:disabled { opacity:.4; cursor:default; }
/* documents */
.docphase { margin-bottom:1rem; }
.docphase h3 { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:.2rem 0 .3rem; }
.docrow { display:flex; align-items:baseline; gap:.8rem; width:100%; text-align:left; background:transparent; border:0; border-bottom:1px solid var(--grid); padding:.55rem .2rem; cursor:pointer; font:inherit; color:inherit; }
.docrow:hover b { text-decoration:underline; }
.docrow b { color:var(--accent); font-size:.9rem; white-space:nowrap; }
.docrow .blurb { color:var(--ink2); font-size:.8rem; flex:1; }
.docrow .src { color:var(--muted); font-size:.72rem; }
/* decisions */
.dcard { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.15rem; margin-bottom:.9rem; box-shadow:var(--shadow); }
.dcard .dhead { display:flex; align-items:baseline; gap:.6rem; margin-bottom:.5rem; }
.dcard .dhead b { font-size:.95rem; }
.dcard .dhead .when { color:var(--muted); font-size:.74rem; margin-left:auto; }
.qa { display:grid; grid-template-columns:minmax(220px,1.1fr) 1fr; gap:.4rem 1.2rem; padding:.45rem 0; border-top:1px solid var(--grid); align-items:baseline; }
.qa .q { color:var(--ink2); font-size:.84rem; }
.qa .a { font-weight:580; }
@media (max-width:720px){ .qa { grid-template-columns:1fr; } }
/* activity */
.egroup { border-bottom:1px solid var(--grid); }
.egroup summary { list-style:none; display:flex; gap:.6rem; align-items:baseline; padding:.4rem 0; cursor:pointer; font-size:.85rem; }
.egroup summary::-webkit-details-marker { display:none; }
.egroup summary .arrow { color:var(--muted); font-size:.7rem; width:12px; }
.egroup[open] summary .arrow { transform:rotate(90deg); display:inline-block; }
.egroup summary .t { color:var(--muted); font-size:.72rem; width:56px; flex:none; }
.egroup summary .outcome { margin-left:auto; }
.egroup .inner { padding:0 0 .5rem 4.4rem; }
.event { display:flex; gap:.6rem; align-items:baseline; padding:.14rem 0; color:var(--ink2); font-size:.8rem; }
.event .t { color:var(--muted); font-size:.7rem; flex:none; width:56px; }
.event.bad { color:var(--crit); }
/* drawer + modal */
#drawer { position:fixed; top:0; right:-580px; width:min(560px,94vw); height:100vh; background:var(--surface); border-left:1px solid var(--border); box-shadow:-12px 0 40px rgba(0,0,0,.18); transition:right .25s ease; z-index:60; display:flex; flex-direction:column; }
#drawer.open { right:0; }
#drawer .head, #docModal .head { padding:1rem 1.2rem; border-bottom:1px solid var(--grid); display:flex; align-items:center; gap:.6rem; }
#drawer .head b, #docModal .head b { font-size:1rem; }
#drawer .body, #docModal .body { padding:1rem 1.2rem; overflow-y:auto; flex:1; }
#drawer h3, .docsec h3 { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:.9rem 0 .4rem; }
#drawer .depitem { font-size:.82rem; padding:.2rem 0; }
#drawer .depitem .mono { color:var(--accent); }
#drawer .depitem .d { color:var(--muted); font-size:.76rem; }
#drawer .attempt { border:1px solid var(--grid); border-radius:8px; padding:.5rem .7rem; margin-bottom:.5rem; font-size:.8rem; }
#drawer .attempt .err { color:var(--crit); white-space:pre-wrap; font-size:.72rem; margin-top:.3rem; max-height:140px; overflow:auto; }
.tr { border-left:2px solid var(--grid); padding:.25rem 0 .25rem .7rem; margin-bottom:.35rem; font-size:.78rem; }
.tr.tool { border-color:var(--accent); }
.tr .lbl { color:var(--accent); font-weight:560; }
.tr .prev { color:var(--ink2); word-break:break-word; }
.tr.text .prev { color:var(--ink); }
#docModal { position:fixed; inset:0; z-index:70; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.45); }
#docModal.open { display:flex; }
#docModal .sheet { width:min(880px,94vw); max-height:88vh; background:var(--surface); border:1px solid var(--border); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; }
#docModal pre { background:var(--page); border:1px solid var(--grid); border-radius:8px; padding:.8rem 1rem; font:12px/1.5 ui-monospace,Menlo,monospace; overflow:auto; white-space:pre-wrap; }
.doctable { width:100%; border-collapse:collapse; font-size:.8rem; margin:.3rem 0 .6rem; }
.doctable th { text-align:left; color:var(--muted); font-weight:560; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; padding:.35rem .5rem; border-bottom:1px solid var(--grid); }
.doctable td { padding:.4rem .5rem; border-bottom:1px solid var(--grid); vertical-align:top; }
.badgechip { display:inline-block; font-size:.72rem; border:1px solid var(--border); border-radius:99px; padding:.02rem .5rem; margin:.06rem .15rem .06rem 0; color:var(--ink2); }
</style>
</head>
<body>
<div class="topbar">
  <h1 id="title" onclick="goHome()">harness</h1>
  <span class="pill" id="statusPill" style="display:none"><span class="dot" id="statusDot"></span><span id="statusText"></span></span>
  <span class="pill" id="modePill" style="display:none"></span>
  <span class="mini" id="miniStats"></span>
  <nav class="tabs" id="tabs" style="display:none">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="pipeline">Pipeline</button>
    <button data-tab="documents">Documents</button>
    <button data-tab="decisions">Decisions</button>
    <button data-tab="activity">Activity</button>
  </nav>
</div>
<div class="banner" id="banner"><b>Waiting on you</b><span id="bannerText"></span><button class="primary" onclick="showTab('overview');window.scrollTo({top:0,behavior:'smooth'})">Answer now</button></div>
<main>
<section id="storefront" style="display:none" class="store">
  <h2 style="font-size:1.3rem;font-weight:650">Your applications</h2>
  <p class="lead">Every app built with the harness, in one place. Open one to see its full build story — or start a new one.</p>
  <div class="storegrid" id="storeGrid"></div>
</section>
<div id="runview" style="display:none">
<section class="tabpane active" id="tab-overview">
  <div class="card gate" id="agentQPanel" style="display:none"><h2>The agent needs your input</h2><form id="agentQForm"></form></div>
  <div class="card gate" id="gatePanel" style="display:none"><h2>Waiting on you — the run continues after you answer</h2><form id="gateForm"></form></div>
  <div class="tiles">
    <div class="tile"><div class="k">Progress</div><div class="v" id="progressV"></div><div class="meter"><div id="progressBar"></div></div><div class="sub" id="progressSub"></div></div>
    <div class="tile"><div class="k">Cost</div><div class="v" id="costV"></div><div class="meter"><div id="costBar"></div></div><div class="sub" id="costSub"></div></div>
    <div class="tile"><div class="k">Tokens</div><div class="v" id="tokV"></div><div class="sub" id="tokSub"></div></div>
    <div class="tile"><div class="k">Active time</div><div class="v" id="elapsedV"></div><div class="sub" id="elapsedSub"></div></div>
    <div class="tile"><div class="k">Your inputs</div><div class="v" id="attnV" style="font-size:1.02rem"></div><div class="sub" id="attnSub"></div></div>
  </div>
  <div class="grid2">
    <div class="card"><h2>About this build</h2><div id="about"></div></div>
    <div class="card"><h2>Quality &amp; test results</h2><div id="quality"></div></div>
  </div>
  <div class="card" id="shotsPanel" style="display:none"><h2>Watch it grow — one screenshot per slice</h2><div class="shots" id="shots"></div></div>
  <div class="card" id="appPanel" style="display:none">
    <div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">
      <h2 style="margin:0">Your application</h2>
      <span class="chip" id="appStage"></span>
      <span class="pill" style="padding:.2rem .7rem;font-size:.78rem"><span class="dot" id="appDot"></span><span id="appStatus"></span></span>
      <span style="margin-left:auto;display:flex;gap:.5rem;align-items:center">
        <a id="appLink" class="mono" target="_blank" style="color:var(--accent);text-decoration:none;display:none"></a>
        <button class="primary" id="appLaunch">Launch app</button>
        <button class="ghost" id="appStop" style="display:none">Stop</button>
      </span>
    </div>
    <div id="appFrameWrap" style="display:none;margin-top:.9rem;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#fff">
      <iframe id="appFrame" style="width:100%;height:520px;border:0;display:block"></iframe>
    </div>
  </div>
  <div class="card" id="designPanel" style="display:none"><h2 id="designHead">Design options — pick one</h2><div class="designs" id="designs"></div></div>
</section>
<section class="tabpane" id="tab-pipeline">
  <div class="card"><h2>Pipeline <span class="hint">— grouped by phase; click any step to inspect it</span></h2><div id="nodes"></div></div>
</section>
<section class="tabpane" id="tab-documents">
  <div class="card"><h2>Documents <span class="hint">— what the run produced for you to read</span></h2>
    <div id="docs"></div>
    <details style="margin-top:.8rem"><summary class="hint" style="cursor:pointer">Advanced: all raw files</summary><div id="raw" style="margin-top:.4rem"></div></details>
  </div>
</section>
<section class="tabpane" id="tab-decisions">
  <div id="decisions"></div>
</section>
<section class="tabpane" id="tab-activity">
  <div class="card"><h2>Activity <span class="hint">— grouped by step; failures start open</span></h2><div id="events"></div></div>
</section>
</div>
</main>
<aside id="drawer">
  <div class="head"><b id="dTitle"></b><span class="chip" id="dKind"></span><span class="chip" id="dState"></span>
    <button class="ghost" style="margin-left:auto" onclick="closeDrawer()">Close</button></div>
  <div class="body" id="dBody"></div>
</aside>
<div id="docModal" onclick="if(event.target===this)closeDoc()">
  <div class="sheet">
    <div class="head"><b id="docTitle"></b><span class="hint" id="docBlurb"></span>
      <button class="ghost" id="docRawBtn" style="margin-left:auto;padding:.3rem .7rem;font-size:.76rem">View raw</button>
      <button class="ghost" onclick="closeDoc()">Close</button></div>
    <div class="body docsec" id="docBody"></div>
  </div>
</div>
<script>
const STATUS_COLOR = { completed:'var(--good)', running:'var(--accent)', parked:'var(--warn)', failed:'var(--crit)', stopped:'var(--muted)', starting:'var(--warn)' };
const STATE_ICON = { committed:'✓', failed:'✕', parked:'⏸', started:'●', skipped:'↷', pending:'○' };
const prevHtml = {};
function setHTML(id, html) {
  if (prevHtml[id] === html) return false;
  prevHtml[id] = html;
  document.getElementById(id).innerHTML = html;
  return true;
}
function setText(id, txt) {
  const el = document.getElementById(id);
  if (el.textContent !== txt) el.textContent = txt;
}
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
function fmtDur(ms) {
  if (!ms) return '0s';
  if (ms < 950) return (ms/1000).toFixed(1) + 's';
  const s = Math.round(ms/1000);
  if (s < 90) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.round((s%3600)/60) + 'm';
}
function fmtTok(n) { return n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n/1e3) + 'k' : String(n); }
function shortModel(m) { return m ? m.replace('claude-','') : ''; }
function title(k) { return String(k).replace(/_/g,' ').replace(/^./, c => c.toUpperCase()); }

function showTab(name) {
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  location.hash = name;
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
if (location.hash) showTab(location.hash.slice(1));
async function goHome() { await fetch('/api/deselect', { method: 'POST' }); tick(); }
async function openRun(dir) { await fetch('/api/select', { method:'POST', body: JSON.stringify({ dir }) }); showTab('overview'); tick(); }

let openNode = null;
function closeDrawer() { openNode = null; document.getElementById('drawer').classList.remove('open'); }
async function openDrawer(id) {
  if (openNode === id) { closeDrawer(); return; } // same step toggles the panel
  openNode = id;
  document.getElementById('drawer').classList.add('open');
  await refreshDrawer();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeDoc(); } });
async function refreshDrawer() {
  if (!openNode) return;
  const d = await (await fetch('/api/node/' + encodeURIComponent(openNode))).json();
  setText('dTitle', d.id);
  setText('dKind', d.kind);
  const listNode = window.__nodes?.find(n => n.id === d.id);
  setText('dState', listNode ? listNode.state : '');
  const dep = (x) => '<div class="depitem"><span class="mono">' + esc(x.id) + '</span>' + (x.description ? ' — <span class="d">' + esc(x.description) + '</span>' : '') + '</div>';
  const attempts = d.attempts.map(a =>
    '<div class="attempt"><b>Attempt ' + a.attempt + '</b>' +
    (a.costUsd !== undefined ? ' · $' + a.costUsd.toFixed(2) : '') +
    (a.tokens ? ' · ' + fmtTok(a.tokens) + ' tokens' : '') +
    (a.wallClockMs ? ' · ' + fmtDur(a.wallClockMs) : '') +
    (a.error ? '<div class="err">' + esc(a.error) + '</div>' : '') + '</div>'
  ).join('') || '<div class="empty">Not started yet.</div>';
  const caps = d.sessionInfo ?
    '<h3>Session capabilities</h3>' +
    (d.sessionInfo.model ? '<div class="depitem">Model: <span class="mono">' + esc(d.sessionInfo.model) + '</span></div>' : '') +
    (Array.isArray(d.sessionInfo.tools) && d.sessionInfo.tools.length ? '<div class="depitem">Tools: ' + d.sessionInfo.tools.map(t => '<span class="badgechip">' + esc(t) + '</span>').join('') + '</div>' : '') +
    (Array.isArray(d.sessionInfo.agents) && d.sessionInfo.agents.length ? '<div class="depitem">Subagents: ' + d.sessionInfo.agents.map(t => '<span class="badgechip">' + esc(typeof t === 'string' ? t : t.name) + '</span>').join('') + '</div>' : '')
    : '';
  const toolUse = Object.keys(d.toolCounts || {}).length ?
    '<h3>Tool usage</h3><div class="depitem">' + Object.entries(d.toolCounts).map(([t, n]) => '<span class="badgechip">' + esc(t) + ' ×' + n + '</span>').join('') + '</div>' : '';
  const tr = d.transcript.map(t => {
    const m = t.message || {};
    if (m.parts) {
      return m.parts.map(p =>
        p.kind === 'tool'
          ? '<div class="tr tool"><span class="lbl">' + esc(p.label) + '</span> <span class="prev mono">' + esc(p.preview) + '</span></div>'
          : p.kind === 'text'
            ? '<div class="tr text"><span class="prev">' + esc(p.preview) + '</span></div>'
            : ''
      ).join('');
    }
    if (m.type === 'result') return '<div class="tr"><span class="lbl">result</span> <span class="prev">' + esc(m.preview) + '</span></div>';
    return '';
  }).join('');
  setHTML('dBody',
    (d.description ? '<p style="font-size:.9rem">' + esc(d.description) + '</p>' : '') +
    (d.model ? '<h3>Model</h3><div class="depitem mono">' + esc(d.model) + (d.escalateModel ? ' <span class="d">(retries escalate to ' + esc(d.escalateModel) + ')</span>' : '') + '</div>' : '') +
    caps + toolUse +
    '<h3>Waits for</h3>' + (d.deps.map(dep).join('') || '<div class="empty">Nothing — a starting step.</div>') +
    '<h3>Feeds into</h3>' + (d.feeds.map(dep).join('') || '<div class="empty">Nothing — a final step.</div>') +
    '<h3>Attempts</h3>' + attempts +
    (d.prompt ? '<details style="margin-top:.6rem"><summary class="hint" style="cursor:pointer">Prompt used for this step</summary><pre style="background:var(--page);border:1px solid var(--grid);border-radius:8px;padding:.7rem .9rem;font:11.5px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;margin-top:.4rem">' + esc(d.prompt) + '</pre></details>' : '') +
    (tr ? '<h3>What the agent did</h3>' + tr : '')
  );
}

// document reader (formatted; raw toggles inside the same modal)
let docCache = null;
function renderCell(v) {
  if (v === null || v === undefined) return '<span class="hint">—</span>';
  if (Array.isArray(v)) {
    if (v.every(x => typeof x !== 'object')) return v.map(x => '<span class="badgechip">' + esc(x) + '</span>').join('');
    return '<span class="hint">' + v.length + ' item' + (v.length === 1 ? '' : 's') + '</span>';
  }
  if (typeof v === 'object') return '<span class="hint mono">' + esc(JSON.stringify(v).slice(0, 60)) + '</span>';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return esc(String(v));
}
function renderTable(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const shown = cols.slice(0, 7);
  return '<table class="doctable"><thead><tr>' + shown.map(c => '<th>' + esc(title(c)) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + shown.map(c => '<td>' + renderCell(r[c]) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
function renderDoc(data) {
  if (Array.isArray(data)) {
    return data.length && typeof data[0] === 'object' ? renderTable(data) : data.map(x => '<span class="badgechip">' + esc(x) + '</span>').join('');
  }
  if (typeof data !== 'object' || data === null) return '<div class="kv"><span></span><span>' + esc(String(data)) + '</span></div>';
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object') continue;
    out += '<div class="kv"><span class="k">' + esc(title(k)) + '</span><span>' + renderCell(v) + '</span></div>';
  }
  for (const [k, v] of Object.entries(data)) {
    if (v === null || typeof v !== 'object') continue;
    out += '<h3>' + esc(title(k)) + '</h3>';
    if (Array.isArray(v)) out += v.length && typeof v[0] === 'object' ? renderTable(v) : (v.map(x => '<span class="badgechip">' + esc(x) + '</span>').join('') || '<div class="empty">Empty.</div>');
    else out += renderDoc(v);
  }
  return out;
}
async function openDoc(label, blurb, fetchUrl) {
  setText('docTitle', label);
  setText('docBlurb', blurb);
  document.getElementById('docBody').innerHTML = '<div class="empty">Loading…</div>';
  document.getElementById('docModal').classList.add('open');
  const btn = document.getElementById('docRawBtn');
  btn.style.display = '';
  btn.textContent = 'View raw';
  try {
    docCache = await (await fetch(fetchUrl)).json();
    document.getElementById('docBody').innerHTML = renderDoc(docCache);
    btn.onclick = () => {
      const showingRaw = btn.textContent === 'View formatted';
      if (showingRaw) {
        document.getElementById('docBody').innerHTML = renderDoc(docCache);
        btn.textContent = 'View raw';
      } else {
        document.getElementById('docBody').innerHTML = '<pre>' + esc(JSON.stringify(docCache, null, 2)) + '</pre>';
        btn.textContent = 'View formatted';
      }
    };
  } catch (e) {
    document.getElementById('docBody').innerHTML = '<div class="empty">Could not load: ' + esc(e.message) + '</div>';
  }
}
function closeDoc() { document.getElementById('docModal').classList.remove('open'); }

function renderStorefront(data) {
  document.getElementById('storefront').style.display = '';
  document.getElementById('runview').style.display = 'none';
  document.getElementById('tabs').style.display = 'none';
  document.getElementById('statusPill').style.display = 'none';
  document.getElementById('modePill').style.display = 'none';
  document.getElementById('banner').style.display = 'none';
  setText('title', 'harness');
  setText('miniStats', data.runs.length + ' app' + (data.runs.length === 1 ? '' : 's') + ' built');
  setHTML('storeGrid', data.runs.map(r =>
    '<button class="runcard" onclick="openRun(' + esc(JSON.stringify(r.dir)) + ')"><b>' + esc(r.appName) + '</b>' +
    '<div class="meta"><span class="chip">' + esc(r.projectType) + '</span>' +
    '<span class="chip ' + (r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'bad' : '') + '">' + esc(r.status) + '</span>' +
    '<span class="chip ' + (r.runMode === 'live' ? 'ok' : '') + '">' + (r.runMode === 'live' ? 'live agents' : 'replay') + '</span>' +
    '<span>$' + Number(r.costUsd).toFixed(2) + '</span><span>' + esc(String(r.updatedAt).slice(0, 10)) + '</span></div></button>'
  ).join('') +
  '<div class="runcard newrun"><b>Build a new app</b><div class="meta">Run from this directory, then refresh:</div>' +
  '<code>node packages/cli/dist/index.js run project-types/agentic-app \\\\\\n  --workspace my-new-app</code></div>');
}

async function tick() {
  const runsData = await (await fetch('/api/runs')).json();
  if (!runsData.selected) { renderStorefront(runsData); return; }
  const s = await (await fetch('/api/state')).json();
  if (!s.selected) { renderStorefront(runsData); return; }
  document.getElementById('storefront').style.display = 'none';
  document.getElementById('runview').style.display = '';
  document.getElementById('tabs').style.display = '';
  document.getElementById('statusPill').style.display = '';
  window.__nodes = s.nodes;
  setText('title', s.appName ? s.appName : s.projectType);
  setText('statusText', s.resuming ? 'resuming…' : s.status);
  document.getElementById('statusDot').style.background = STATUS_COLOR[s.resuming ? 'running' : s.status] || 'var(--muted)';
  const modePill = document.getElementById('modePill');
  modePill.style.display = '';
  modePill.className = 'pill ' + (s.runMode === 'live' ? 'live' : 'replay');
  modePill.textContent = s.runMode === 'live' ? 'live agents' : 'replay (simulated agents)';
  modePill.title = s.runMode === 'live' ? 'Agent steps ran real Claude sessions' : 'This run replayed deterministic mocks — used for certification and testing. Run without --mock-agents for real agents.';
  const done = s.nodes.filter(n => n.state === 'committed' || n.state === 'skipped').length;
  setText('miniStats', done + '/' + s.nodes.length + ' steps · $' + s.totalCostUsd.toFixed(2) + ' · ' + fmtTok(s.tokensIn + s.tokensOut) + ' tokens');

  const banner = document.getElementById('banner');
  const needsHuman = (s.parkedGate || s.pendingQuestion) && !s.resuming;
  banner.style.display = needsHuman ? 'flex' : 'none';
  setText('attnV', needsHuman ? 'Action needed' : 'Nothing right now');
  setText('attnSub', needsHuman ? 'answer at the top of Overview' : 'questions appear at the top of Overview when the run needs you');
  const ovBtn = document.querySelector('#tabs button[data-tab=overview]');
  const wantBadge = needsHuman ? '<span class="dot"></span>' : '';
  if (ovBtn.innerHTML !== 'Overview' + wantBadge) ovBtn.innerHTML = 'Overview' + wantBadge;
  if (s.pendingQuestion) setText('bannerText', 'the ' + s.pendingQuestion.nodeId + ' agent asked you a question');
  else if (s.parkedGate) setText('bannerText', s.parkedGate.questions.length + ' question' + (s.parkedGate.questions.length===1?'':'s') + ' at ' + s.parkedGate.nodeId);

  setText('progressV', done + ' / ' + s.nodes.length);
  document.getElementById('progressBar').style.width = (100*done/s.nodes.length) + '%';
  setText('progressSub', 'steps complete');
  setText('costV', '$' + s.totalCostUsd.toFixed(2));
  const costBar = document.getElementById('costBar');
  if (s.runBudgetUsd) {
    costBar.style.width = Math.min(100, 100*s.totalCostUsd/s.runBudgetUsd) + '%';
    costBar.className = s.totalCostUsd > s.runBudgetUsd ? 'over' : '';
    setText('costSub', 'of $' + s.runBudgetUsd.toFixed(2) + ' budget');
  } else setText('costSub', 'no budget set');
  setText('tokV', fmtTok(s.tokensIn + s.tokensOut));
  setText('tokSub', fmtTok(s.tokensIn) + ' in · ' + fmtTok(s.tokensOut) + ' out');
  setText('elapsedV', fmtDur(s.activeMs));
  setText('elapsedSub', 'steps working; ' + fmtDur(s.elapsedMs) + ' start to finish');

  // about
  setHTML('about',
    '<div class="kv"><span class="k">Application</span><span><b>' + esc(s.appName ?? '—') + '</b></span></div>' +
    '<div class="kv"><span class="k">Project type</span><span class="mono">' + esc(s.projectType) + '</span></div>' +
    (s.projectDescription ? '<div class="kv"><span class="k">What it builds</span><span>' + esc(s.projectDescription) + '</span></div>' : '') +
    (s.problemStatement ? '<div class="kv"><span class="k">Problem</span><span>' + esc(s.problemStatement) + '</span></div>' : '') +
    '<div class="kv"><span class="k">Agents</span><span>' + (s.runMode === 'live' ? 'real Claude sessions' : 'simulated (certification replay) — run without --mock-agents for real agents') + '</span></div>' +
    (s.designChoice ? '<div class="kv"><span class="k">Design</span><span>' + esc(s.designChoice) + ' <span class="chip ok">locked</span></span></div>' : '') +
    (s.startedAt ? '<div class="kv"><span class="k">Started</span><span>' + esc(String(s.startedAt).slice(0,19).replace('T',' ')) + '</span></div>' : '') +
    '<div class="kv"><span class="k">Workspace</span><span class="mono" style="font-size:.76rem">' + esc(s.workspace) + '</span></div>'
  );

  // quality
  const q = s.quality || {};
  const mark = (ok) => ok === null || ok === undefined ? '<span class="mark na">–</span>' : ok ? '<span class="mark ok">✓</span>' : '<span class="mark bad">✕</span>';
  setHTML('quality',
    '<div class="qrow">' + mark(q.backendTests ? q.backendTests === 'pass' : null) + '<span>Backend test suite</span><span class="stat">' + esc(q.backendSummary ?? 'runs at integration') + '</span></div>' +
    '<div class="qrow">' + mark(q.evals ? q.evals.status === 'pass' : null) + '<span>Agent evals</span><span class="stat">' + (q.evals ? esc(q.evals.passed + '/' + q.evals.total + ' passed') : 'runs at integration') + '</span></div>' +
    '<div class="qrow">' + mark(q.securityHigh === null ? null : q.securityHigh === 0) + '<span>Security scan</span><span class="stat">' + (q.securityHigh === null ? 'runs after build' : q.securityHigh + ' blocking · ' + (q.securityFindings ?? 0) + ' total findings') + '</span></div>' +
    '<div class="qrow">' + mark(q.composeSmoke === null ? null : q.composeSmoke !== 'failed') + '<span>Container boot smoke</span><span class="stat">' + esc(q.composeSmoke ?? '—') + '</span></div>' +
    '<div class="qrow">' + mark(q.requirementsCovered ? q.requirementsCovered.covered === q.requirementsCovered.total : null) + '<span>Requirements covered</span><span class="stat">' + (q.requirementsCovered ? q.requirementsCovered.covered + '/' + q.requirementsCovered.total : 'traceability pending') + '</span></div>' +
    '<div class="qrow">' + mark(q.slicesPlanned ? q.slicesDelivered >= q.slicesPlanned : null) + '<span>Feature slices</span><span class="stat">' + (q.slicesPlanned ? q.slicesDelivered + ' delivered of ' + q.slicesPlanned + ' planned' : '—') + '</span></div>'
  );

  // slice screenshots
  document.getElementById('shotsPanel').style.display = s.sliceShots.length ? '' : 'none';
  const shotsChanged = setHTML('shots', s.sliceShots.map(x =>
    '<button class="shot" data-href="' + x.href + '" data-cap="' + esc(x.slice) + '"><img src="' + x.href + '" loading="lazy"><div class="cap">' + esc(x.slice) + ' — click to view full size</div></button>').join(''));
  if (shotsChanged) document.querySelectorAll('.shot').forEach(b => b.onclick = () => {
    setText('docTitle', b.dataset.cap);
    setText('docBlurb', 'the app as it looked after this slice');
    document.getElementById('docRawBtn').style.display = 'none';
    document.getElementById('docBody').innerHTML = '<img src="' + b.dataset.href + '" style="width:100%;border-radius:8px;border:1px solid var(--grid)">';
    document.getElementById('docModal').classList.add('open');
  });

  // agent mid-step question
  const aq = document.getElementById('agentQPanel');
  if (s.pendingQuestion && !s.resuming) {
    aq.style.display = '';
    const form = document.getElementById('agentQForm');
    if (form.dataset.qid !== s.pendingQuestion.id) {
      form.dataset.qid = s.pendingQuestion.id;
      const qs = Array.isArray(s.pendingQuestion.questions) ? s.pendingQuestion.questions : [];
      form.innerHTML = '<div class="hint" style="margin-bottom:.5rem">Asked by the <b>' + esc(s.pendingQuestion.nodeId) + '</b> step while working.</div>' +
        qs.map((q, i) =>
          '<div class="q"><label>' + esc(q.question ?? q.prompt ?? 'Question') + '</label>' +
          (Array.isArray(q.options) ? q.options.map(o =>
            '<label class="opt"><input type="radio" name="q' + i + '" value="' + esc(o.label) + '"><span><b>' + esc(o.label) + '</b>' +
            (o.description ? '<div class="od">' + esc(o.description) + '</div>' : '') + '</span></label>').join('') : '') +
          '<input type="text" name="q' + i + '_other" placeholder="Or type your own answer">' +
          '</div>').join('') +
        '<button type="submit" class="primary">Send answer to the agent</button>';
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        const answers = {};
        qs.forEach((q, i) => {
          const other = String(fd.get('q' + i + '_other') || '').trim();
          answers[q.question ?? ('q' + i)] = other || String(fd.get('q' + i) || '');
        });
        await fetch('/api/agent-answer', { method:'POST', body: JSON.stringify({ id: s.pendingQuestion.id, answers }) });
        form.dataset.qid = '';
      };
    }
  } else { aq.style.display = 'none'; }

  // pipeline
  const phases = [];
  const byPhase = {};
  for (const n of s.nodes) {
    if (!byPhase[n.phase]) { byPhase[n.phase] = []; phases.push(n.phase); }
    byPhase[n.phase].push(n);
  }
  const header = '<div class="prow header"><span></span><span>Step</span><span>Kind / model</span><span>What it does</span><span class="num">Cost</span><span class="num">Tokens</span><span class="num">Time</span></div>';
  setHTML('nodes', phases.map(ph => {
    const list = byPhase[ph];
    const phDone = list.filter(n => n.state === 'committed' || n.state === 'skipped').length;
    return '<div class="phase"><div class="phead"><b>' + esc(ph) + '</b><div class="bar"><div style="width:' + (100*phDone/list.length) + '%"></div></div><span class="stat">' + phDone + '/' + list.length + '</span></div>' + header +
      list.map(n =>
        '<div class="prow ' + n.state + '" data-id="' + esc(n.id) + '"><span class="icon">' + (STATE_ICON[n.state]||'') + '</span>' +
        '<span class="id mono">' + esc(n.id) + (n.retries ? ' <span class="chip retry">retry ×' + n.retries + '</span>' : '') + '</span>' +
        (n.kind === 'agent' ? '<span class="chip model">' + esc(shortModel(n.model) || 'agent') + '</span>' : '<span class="chip">' + n.kind + '</span>') +
        '<span class="desc">' + esc(n.description ?? '') + '</span>' +
        '<span class="num">' + (n.cost && n.cost.costUsd ? '$' + n.cost.costUsd.toFixed(2) : '') + '</span>' +
        '<span class="num">' + (n.cost && (n.cost.tokensIn + n.cost.tokensOut) ? fmtTok(n.cost.tokensIn + n.cost.tokensOut) : '') + '</span>' +
        '<span class="num">' + (n.cost && n.cost.wallClockMs ? fmtDur(n.cost.wallClockMs) : '') + '</span></div>'
      ).join('') + '</div>';
  }).join(''));
  document.querySelectorAll('#nodes .prow[data-id]').forEach(el => el.onclick = () => openDrawer(el.dataset.id));

  // decisions
  setHTML('decisions',
    (s.decisions.length ? s.decisions.map(d =>
      '<div class="dcard"><div class="dhead"><b>' + esc(title(d.gate)) + '</b><span class="chip">' + esc(d.source) + '</span><span class="when">' + esc((d.ts||'').slice(0,19).replace('T',' ')) + '</span></div>' +
      (d.description ? '<div class="hint" style="margin-bottom:.4rem">' + esc(d.description) + '</div>' : '') +
      d.items.map(i =>
        '<div class="qa"><span class="q">' + esc(i.prompt) + '</span><span class="a">' + esc(i.answer) +
        (i.defaulted ? ' <span class="chip default">default</span>' : '') + '</span></div>').join('') + '</div>'
    ).join('') : '<div class="card"><div class="empty">No decisions yet — gates you answer will appear here.</div></div>') +
    (s.assumptions.length ? '<div class="dcard"><div class="dhead"><b>Assumptions the run proceeded on</b></div>' +
      s.assumptions.map(a => '<div class="qa"><span class="q">' + esc(a.question) + '</span><span class="a">' + esc(a.answer) + ' <span class="chip default">' + esc(a.source) + '</span></span></div>').join('') + '</div>' : '')
  );

  // documents grouped by phase
  const docPhases = [];
  const docsBy = {};
  for (const d of s.documents) {
    if (!docsBy[d.phase]) { docsBy[d.phase] = []; docPhases.push(d.phase); }
    docsBy[d.phase].push(d);
  }
  const docsChanged = setHTML('docs', s.documents.length ? docPhases.map(ph =>
    '<div class="docphase"><h3>' + esc(ph) + '</h3>' +
    docsBy[ph].map(d => '<button class="docrow" data-i="' + s.documents.indexOf(d) + '"><b>' + esc(d.label) + '</b><span class="blurb">' + esc(d.blurb) + '</span><span class="src mono">' + esc(d.node) + '</span></button>').join('') +
    '</div>').join('') : '<div class="empty">Documents appear as steps finish.</div>');
  window.__docs = s.documents;
  if (docsChanged) document.querySelectorAll('.docrow').forEach(b => b.onclick = () => {
    const d = window.__docs[Number(b.dataset.i)];
    openDoc(d.label, d.blurb, d.fetch);
  });
  setHTML('raw', s.rawArtifacts.map(a => '<a class="mono" style="display:block;color:var(--ink2);text-decoration:none;font-size:.74rem;padding:.06rem 0" href="/artifact/' + a + '" target="_blank">' + esc(a) + '</a>').join(''));

  // activity: foldable groups per step
  const groups = [];
  for (const e of s.events) {
    const last = groups[groups.length - 1];
    if (e.nodeId && last && last.nodeId === e.nodeId) last.items.push(e);
    else groups.push({ nodeId: e.nodeId, items: [e] });
  }
  setHTML('events', groups.slice().reverse().map(g => {
    const bad = g.items.some(e => e.type.includes('failed') || e.type.includes('exceeded'));
    const lastE = g.items[g.items.length - 1];
    if (!g.nodeId || g.items.length === 1) {
      return '<div class="egroup"><summary style="cursor:default"><span class="arrow"></span><span class="t mono">' + (lastE.ts||'').slice(11,19) + '</span><span class="' + (bad?'event bad':'') + '">' + esc(lastE.text) + '</span></summary></div>';
    }
    return '<details class="egroup"' + (bad ? ' open' : '') + '><summary><span class="arrow">▶</span><span class="t mono">' + (g.items[0].ts||'').slice(11,19) + '</span><b class="mono">' + esc(g.nodeId) + '</b><span class="hint">' + g.items.length + ' events</span><span class="outcome ' + (bad ? 'chip bad' : 'chip') + '">' + esc(lastE.text.length > 60 ? lastE.text.slice(0,60) + '…' : lastE.text) + '</span></summary>' +
      '<div class="inner">' + g.items.map(e => '<div class="event' + (e.type.includes('failed')||e.type.includes('exceeded') ? ' bad' : '') + '"><span class="t mono">' + (e.ts||'').slice(11,19) + '</span><span>' + esc(e.text) + '</span></div>').join('') + '</div></details>';
  }).join(''));

  // designs (locked once chosen)
  const meta = {};
  for (const o of (s.designOptions || [])) meta[o.id] = o;
  const previews = s.rawArtifacts.filter(a => a.startsWith('design-options/') && a.endsWith('/index.html'));
  document.getElementById('designPanel').style.display = previews.length ? '' : 'none';
  setText('designHead', s.designChoice ? 'Design — ' + s.designChoice + ' chosen and locked' : 'Design options — pick one');
  const designsChanged = setHTML('designs', previews.map(p => {
    const id = p.split('/').slice(-2)[0];
    const name = meta[id] ? meta[id].name : id;
    const chosen = s.designChoice === id;
    return '<div class="design' + (chosen ? ' chosen' : '') + '">' + (chosen ? '<span class="sel">✓ Selected</span>' : '') +
      '<div class="thumb"><iframe src="/artifact/' + p + '" loading="lazy" tabindex="-1"></iframe>' +
      '<a href="/artifact/' + p + '" target="_blank" title="Open ' + esc(name) + ' full size"></a></div>' +
      '<div class="bar"><b>' + esc(name) + '</b><span class="chip mono">' + esc(id) + '</span>' +
      '<a href="/artifact/' + p + '" target="_blank">open</a>' +
      '<button data-id="' + esc(id) + '"' + (s.designChoice ? ' disabled' : '') + '>' + (chosen ? 'Chosen' : 'Choose') + '</button></div></div>';
  }).join(''));
  if (designsChanged) document.querySelectorAll('.design button:not([disabled])').forEach(b => b.onclick = () => {
    const input = document.querySelector('#gateForm input[name="chosen_option"]');
    if (input) { input.value = b.dataset.id; input.scrollIntoView({behavior:'smooth'}); input.focus(); }
    else alert('The design-select gate is not waiting right now.');
  });

  // app panel
  const appPanel = document.getElementById('appPanel');
  // Only offer the app once real features exist (post-scaffold) or it's running.
  const appReady = s.appAvailable && (s.appStageNode !== 'scaffold' || s.app.status === 'running' || s.app.status === 'starting');
  appPanel.style.display = appReady ? '' : 'none';
  if (appReady) {
    const a = s.app;
    document.getElementById('appDot').style.background = STATUS_COLOR[a.status] || 'var(--muted)';
    setText('appStatus', a.status === 'failed' ? 'failed — ' + (a.error||'') : a.status);
    setText('appStage', a.node ? 'built at: ' + a.node : 'ready to launch');
    const launch = document.getElementById('appLaunch');
    const launchTxt = a.status === 'running' ? 'Relaunch latest' : a.status === 'starting' ? 'Starting…' : 'Launch app';
    if (launch.textContent !== launchTxt) launch.textContent = launchTxt;
    launch.disabled = a.status === 'starting';
    launch.onclick = () => fetch('/api/app/start', { method:'POST' });
    const stop = document.getElementById('appStop');
    stop.style.display = a.status === 'running' ? '' : 'none';
    stop.onclick = () => fetch('/api/app/stop', { method:'POST' });
    const link = document.getElementById('appLink');
    const wrap = document.getElementById('appFrameWrap');
    const frame = document.getElementById('appFrame');
    if (a.status === 'running' && a.port) {
      const appUrl = 'http://localhost:' + a.port;
      link.style.display = ''; link.href = appUrl; link.textContent = appUrl;
      wrap.style.display = '';
      if (frame.dataset.url !== appUrl) { frame.dataset.url = appUrl; frame.src = appUrl; }
    } else {
      link.style.display = 'none'; wrap.style.display = 'none'; frame.dataset.url = ''; frame.removeAttribute('src');
    }
  }

  // gate
  const panel = document.getElementById('gatePanel');
  if (s.parkedGate && !s.resuming) {
    panel.style.display = '';
    const form = document.getElementById('gateForm');
    if (form.dataset.node !== s.parkedGate.nodeId) {
      form.dataset.node = s.parkedGate.nodeId;
      form.innerHTML = s.parkedGate.questions.map(q =>
        '<div class="q"><label>' + esc(q.prompt) + '</label>' +
        (q.why ? '<div class="why">' + esc(q.why) + '</div>' : '') +
        '<input type="text" name="' + esc(q.id) + '" value="' + esc(q.default ?? '') + '">' +
        (q.default !== undefined ? '<div class="hint">pre-filled with the default — edit or keep</div>' : '') +
        '</div>').join('') +
        '<button type="submit" class="primary">Answer &amp; resume run</button>';
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const answers = Object.fromEntries(new FormData(form).entries());
        await fetch('/api/answer', { method:'POST', body: JSON.stringify({ nodeId: form.dataset.node, answers }) });
        form.dataset.node = '';
      };
    }
  } else panel.style.display = 'none';

  if (openNode) refreshDrawer();
}
tick(); setInterval(tick, 2500);
</script>
</body>
</html>`;
