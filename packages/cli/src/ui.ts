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
  const documents: { label: string; blurb: string; node: string; href: string }[] = [];
  for (const [nodeId, byName] of Object.entries(state.artifacts)) {
    for (const [name, rel] of Object.entries(byName)) {
      const meta = DOC_LABELS[name];
      if (meta && rel.endsWith(".json")) {
        documents.push({ ...meta, node: nodeId, href: `/view/${rel.replace(/^artifacts\//, "")}` });
      }
    }
  }
  documents.sort(
    (a, b) => def.nodes.findIndex((n) => n.id === a.node) - def.nodes.findIndex((n) => n.id === b.node),
  );

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

  return {
    projectType: `${def.name}@${def.version}`,
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
    documents,
    designOptions,
    elapsedMs: firstTs && lastTs ? Date.parse(String(lastTs)) - Date.parse(String(firstTs)) : 0,
    rawArtifacts: walk(path.join(workspace, "artifacts"), path.join(workspace, "artifacts")),
    events: events
      .map((e) => ({ ts: e.ts, type: e.type, text: narrate(e, costMap) }))
      .filter((e) => e.text !== null)
      .slice(-80),
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

  const describe = (id: string) => def.nodes.find((n) => n.id === id)?.description ?? null;
  return {
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

export function startUiServer(workspace: string, port: number): Promise<http.Server> {
  const artifactsRoot = path.join(workspace, "artifacts");
  let resuming = false;
  const app: AppPreview = { status: "stopped", port: null, node: null, pid: null };

  function latestAppArtifact(): { node: string; dir: string } | null {
    const config = readConfig(workspace);
    const def = loadDef(workspace, config.projectTypeDir);
    const artifactName = def.preview?.artifact ?? "app";
    const state = foldState(new Journal(workspace).read());
    let found: { node: string; dir: string } | null = null;
    for (const n of def.nodes) {
      const rel = state.artifacts[n.id]?.[artifactName];
      if (rel) found = { node: n.id, dir: path.join(workspace, rel) };
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
      } else if (url.pathname === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...buildState(workspace), resuming, app, appAvailable: latestAppArtifact() !== null }));
      } else if (url.pathname.startsWith("/api/node/")) {
        const detail = buildNodeDetail(workspace, decodeURIComponent(url.pathname.slice("/api/node/".length)));
        if (!detail) {
          res.writeHead(404).end("unknown node");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(detail));
      } else if (url.pathname.startsWith("/view/")) {
        // Pretty document viewer for curated artifacts.
        const rel = decodeURIComponent(url.pathname.slice("/view/".length));
        const abs = path.normalize(path.join(artifactsRoot, rel));
        if (!abs.startsWith(artifactsRoot + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
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
        const abs = path.normalize(path.join(artifactsRoot, rel));
        if (!abs.startsWith(artifactsRoot + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
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
          const answersFile = mergeAnswers(workspace, nodeId, answers);
          const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));
          resuming = true;
          const child = spawn(process.execPath, [cliEntry, "resume", workspace, "--answers", answersFile], {
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
<title>harness run</title>
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
body { font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--page); color:var(--ink); padding:1.4rem clamp(1rem,4vw,2.5rem); }
.mono { font-family:ui-monospace,Menlo,monospace; }
.hero { display:flex; align-items:flex-start; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
.hero h1 { font-size:1.35rem; font-weight:650; letter-spacing:-.01em; }
.hero .ws { color:var(--muted); font-size:.78rem; margin-top:.15rem; }
.pill { margin-left:auto; display:inline-flex; align-items:center; gap:.45rem; padding:.35rem .85rem; border-radius:999px; border:1px solid var(--border); background:var(--surface); font-weight:550; font-size:.85rem; box-shadow:var(--shadow); }
.pill .dot { width:9px; height:9px; border-radius:50%; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:.8rem; margin-bottom:1.1rem; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:.85rem 1rem; box-shadow:var(--shadow); }
.tile .k { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:.35rem; }
.tile .v { font-size:1.4rem; font-weight:650; letter-spacing:-.01em; }
.tile .sub { font-size:.78rem; color:var(--ink2); margin-top:.1rem; }
.meter { height:6px; border-radius:3px; background:var(--grid); margin-top:.55rem; overflow:hidden; }
.meter > div { height:100%; border-radius:3px; background:var(--accent); transition:width .6s ease; }
.meter > div.over { background:var(--crit); }
.grid { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,.9fr); gap:1rem; align-items:start; }
@media (max-width: 980px) { .grid { grid-template-columns:1fr; } }
.card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.15rem; box-shadow:var(--shadow); margin-bottom:1rem; }
.card h2 { font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:.7rem; }
.hint { font-size:.78rem; color:var(--muted); }
.rail { position:relative; }
.rail::before { content:""; position:absolute; left:11px; top:8px; bottom:8px; width:2px; background:var(--grid); border-radius:1px; }
.node { position:relative; display:flex; align-items:center; gap:.6rem; padding:.34rem .4rem .34rem 2rem; border-radius:8px; cursor:pointer; }
.node:hover { background:var(--page); }
.node .icon { position:absolute; left:0; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.72rem; background:var(--surface); border:2px solid var(--grid); color:var(--muted); }
.node.committed .icon { border-color:var(--good); color:var(--good); }
.node.failed .icon { border-color:var(--crit); background:var(--crit); color:#fff; }
.node.parked .icon { border-color:var(--warn); color:var(--warn); }
.node.started .icon { border-color:var(--accent); color:var(--accent); }
.node.started .icon::after { content:""; position:absolute; inset:-6px; border-radius:50%; border:2px solid var(--accent); opacity:.5; animation:pulse 1.4s ease-out infinite; }
@keyframes pulse { from { transform:scale(.7); opacity:.6; } to { transform:scale(1.15); opacity:0; } }
.node .id { font-weight:560; }
.node.pending .id, .node.skipped .id { color:var(--muted); font-weight:450; }
.node .desc { font-size:.75rem; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.chip { white-space:nowrap; font-size:.68rem; padding:.05rem .5rem; border-radius:999px; border:1px solid var(--border); color:var(--ink2); }
.chip.retry { color:var(--serious); border-color:var(--serious); }
.node .cost { font-size:.72rem; color:var(--ink2); white-space:nowrap; }
.gate { border-left:3px solid var(--warn); }
.gate .q { margin-bottom:.85rem; }
.gate label { display:block; font-weight:560; margin-bottom:.12rem; }
.gate .why { font-size:.78rem; color:var(--ink2); margin-bottom:.35rem; }
.gate input { width:100%; background:var(--page); border:1px solid var(--grid); color:var(--ink); border-radius:8px; padding:.55rem .7rem; font:inherit; }
.gate input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
button.primary { background:var(--accent); color:var(--accent-ink); border:0; border-radius:8px; padding:.55rem 1.1rem; font:inherit; font-weight:560; cursor:pointer; }
button.primary:hover { filter:brightness(1.08); }
button.ghost { background:transparent; border:1px solid var(--border); color:var(--ink2); border-radius:8px; padding:.5rem .9rem; font:inherit; cursor:pointer; }
.designs { display:grid; grid-template-columns:repeat(auto-fill,252px); gap:.8rem; }
.design { border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--page); }
.design .thumb { height:200px; overflow:hidden; background:#fff; position:relative; }
.design .thumb iframe { width:1200px; height:952px; border:0; transform:scale(0.21); transform-origin:0 0; pointer-events:none; }
.design .thumb a { position:absolute; inset:0; }
.design .bar { display:flex; align-items:center; gap:.5rem; padding:.5rem .7rem; border-top:1px solid var(--border); }
.design .bar b { font-size:.85rem; }
.design .bar .chip { margin-right:auto; }
.design .bar a { font-size:.78rem; color:var(--accent); text-decoration:none; }
.design .bar button { background:transparent; border:1px solid var(--accent); color:var(--accent); border-radius:6px; padding:.2rem .7rem; font:inherit; font-size:.78rem; cursor:pointer; }
.events { max-height:320px; overflow-y:auto; font-size:.8rem; }
.event { display:flex; gap:.55rem; align-items:baseline; padding:.16rem 0; color:var(--ink2); }
.event .t { color:var(--muted); font-size:.7rem; flex:none; width:52px; }
.event .d { width:7px; height:7px; border-radius:50%; background:var(--grid); flex:none; align-self:center; }
.event.good .d { background:var(--good); } .event.bad .d { background:var(--crit); }
.event.warn .d { background:var(--warn); } .event.info .d { background:var(--accent); }
.event.bad { color:var(--crit); }
.decision { border-bottom:1px solid var(--grid); padding:.55rem 0; }
.decision:last-child { border-bottom:0; }
.decision .head { display:flex; gap:.5rem; align-items:baseline; font-weight:560; }
.decision .head .chip { margin-left:auto; }
.decision .item { font-size:.82rem; margin-top:.3rem; }
.decision .item .p { color:var(--ink2); }
.decision .item .a { font-weight:560; }
.docs a.doc { display:block; text-decoration:none; color:inherit; padding:.5rem .6rem; border-radius:8px; }
.docs a.doc:hover { background:var(--page); }
.docs .doc b { color:var(--accent); font-size:.88rem; }
.docs .doc .blurb { font-size:.76rem; color:var(--muted); }
.advanced summary { cursor:pointer; color:var(--muted); font-size:.78rem; }
.advanced a { display:block; color:var(--ink2); text-decoration:none; font-size:.74rem; padding:.08rem 0 .08rem .8rem; }
/* Step inspector drawer */
#drawer { position:fixed; top:0; right:-560px; width:min(540px,92vw); height:100vh; background:var(--surface); border-left:1px solid var(--border); box-shadow:-12px 0 40px rgba(0,0,0,.18); transition:right .25s ease; z-index:50; display:flex; flex-direction:column; }
#drawer.open { right:0; }
#drawer .head { padding:1rem 1.2rem; border-bottom:1px solid var(--grid); display:flex; align-items:center; gap:.6rem; }
#drawer .head b { font-size:1rem; }
#drawer .body { padding:1rem 1.2rem; overflow-y:auto; flex:1; }
#drawer h3 { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin:.9rem 0 .4rem; }
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
.empty { color:var(--muted); font-size:.82rem; }
</style>
</head>
<body>
<header class="hero">
  <div><h1 id="title">harness</h1><div class="ws mono" id="status"></div></div>
  <span class="pill"><span class="dot" id="statusDot"></span><span id="statusText"></span></span>
</header>
<div class="tiles">
  <div class="tile"><div class="k">Progress</div><div class="v" id="progressV"></div><div class="meter"><div id="progressBar"></div></div><div class="sub" id="progressSub"></div></div>
  <div class="tile"><div class="k">Cost</div><div class="v" id="costV"></div><div class="meter"><div id="costBar"></div></div><div class="sub" id="costSub"></div></div>
  <div class="tile"><div class="k">Tokens</div><div class="v" id="tokV"></div><div class="sub" id="tokSub"></div></div>
  <div class="tile"><div class="k">Elapsed</div><div class="v" id="elapsedV"></div><div class="sub">wall clock</div></div>
  <div class="tile"><div class="k">Attention</div><div class="v" id="attnV" style="font-size:1.02rem"></div><div class="sub" id="attnSub"></div></div>
</div>
<div class="card" id="appPanel" style="display:none">
  <div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">
    <h2 style="margin:0">Your application</h2>
    <span class="chip" id="appStage"></span>
    <span class="pill" style="margin-left:0;padding:.2rem .7rem;font-size:.78rem"><span class="dot" id="appDot"></span><span id="appStatus"></span></span>
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
<div class="grid">
<div>
  <div class="card gate" id="gatePanel" style="display:none"><h2>Waiting on you</h2><form id="gateForm"></form></div>
  <div class="card" id="designPanel" style="display:none"><h2>Design options — pick one</h2><div class="designs" id="designs"></div></div>
  <div class="card"><h2>Pipeline <span class="hint" style="text-transform:none;letter-spacing:0">— click any step to inspect it</span></h2><div class="rail" id="nodes"></div></div>
</div>
<div>
  <div class="card"><h2>Your decisions</h2><div id="decisions"><div class="empty">No decisions yet.</div></div></div>
  <div class="card docs"><h2>Documents</h2><div id="docs"><div class="empty">Documents appear as steps finish.</div></div>
    <details class="advanced" style="margin-top:.6rem"><summary>Advanced: all raw files</summary><div id="raw"></div></details>
  </div>
  <div class="card"><h2>Activity</h2><div class="events" id="events"></div></div>
</div>
</div>
<aside id="drawer">
  <div class="head"><b id="dTitle"></b><span class="chip" id="dKind"></span><span class="chip" id="dState"></span>
    <button class="ghost" style="margin-left:auto" onclick="closeDrawer()">Close</button></div>
  <div class="body" id="dBody"></div>
</aside>
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
  const s = Math.round(ms/1000);
  return s < 90 ? s + 's' : Math.floor(s/60) + 'm ' + (s%60) + 's';
}
function fmtTok(n) { return n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n/1e3) + 'k' : String(n); }

let openNode = null;
function closeDrawer() { openNode = null; document.getElementById('drawer').classList.remove('open'); }
async function openDrawer(id) {
  openNode = id;
  document.getElementById('drawer').classList.add('open');
  await refreshDrawer();
}
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
    '<h3>Waits for</h3>' + (d.deps.map(dep).join('') || '<div class="empty">Nothing — a starting step.</div>') +
    '<h3>Feeds into</h3>' + (d.feeds.map(dep).join('') || '<div class="empty">Nothing — a final step.</div>') +
    '<h3>Attempts' + (d.hasVerify ? ' <span style="text-transform:none;letter-spacing:0">(each attempt must pass this step\\'s own verification)</span>' : '') + '</h3>' + attempts +
    (tr ? '<h3>What the agent did</h3>' + tr : '')
  );
}

async function tick() {
  const s = await (await fetch('/api/state')).json();
  window.__nodes = s.nodes;
  setText('title', s.projectType);
  setText('status', s.workspace);
  setText('statusText', s.resuming ? 'resuming…' : s.status);
  document.getElementById('statusDot').style.background = STATUS_COLOR[s.resuming ? 'running' : s.status] || 'var(--muted)';

  const done = s.nodes.filter(n => n.state === 'committed' || n.state === 'skipped').length;
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
  setText('elapsedV', fmtDur(s.elapsedMs));
  setText('attnV', s.parkedGate ? 'Answer ' + s.parkedGate.questions.length + ' question' + (s.parkedGate.questions.length===1?'':'s') : 'Nothing');
  setText('attnSub', s.parkedGate ? 'gate: ' + s.parkedGate.nodeId : 'the run does not need you right now');

  setHTML('nodes', s.nodes.map(n =>
    '<div class="node ' + n.state + '" data-id="' + esc(n.id) + '"><span class="icon">' + (STATE_ICON[n.state]||'') + '</span>' +
    '<span class="id mono">' + esc(n.id) + '</span><span class="chip">' + n.kind + '</span>' +
    (n.retries ? '<span class="chip retry">retry ×' + n.retries + '</span>' : '') +
    '<span class="desc">' + esc(n.description ?? '') + '</span>' +
    '<span class="cost mono">' + (n.cost && (n.cost.costUsd || n.cost.wallClockMs) ? ('$' + n.cost.costUsd.toFixed(2) + ' · ' + fmtTok(n.cost.tokensIn + n.cost.tokensOut) + ' tok · ' + fmtDur(n.cost.wallClockMs)) : '') + '</span></div>'
  ).join(''));
  document.querySelectorAll('#nodes .node').forEach(el => el.onclick = () => openDrawer(el.dataset.id));

  setHTML('decisions',
    (s.decisions.length ? s.decisions.map(d =>
      '<div class="decision"><div class="head"><span class="mono">' + esc(d.gate) + '</span><span class="chip">' + esc(d.source) + '</span></div>' +
      d.items.map(i =>
        '<div class="item"><span class="p">' + esc(i.prompt) + '</span><br><span class="a">' + esc(i.answer) + '</span>' +
        (i.defaulted ? ' <span class="chip">default</span>' : '') + '</div>').join('') + '</div>'
    ).join('') : '<div class="empty">No decisions yet.</div>') +
    (s.assumptions.length ? '<div class="decision"><div class="head">Assumptions the run proceeded on</div>' +
      s.assumptions.map(a => '<div class="item"><span class="p">' + esc(a.question) + '</span><br><span class="a">' + esc(a.answer) + '</span> <span class="chip">' + esc(a.source) + '</span></div>').join('') + '</div>' : '')
  );

  setHTML('docs', s.documents.length ? s.documents.map(d =>
    '<a class="doc" href="' + d.href + '" target="_blank"><b>' + esc(d.label) + '</b><div class="blurb">' + esc(d.blurb) + '</div></a>'
  ).join('') : '<div class="empty">Documents appear as steps finish.</div>');
  setHTML('raw', s.rawArtifacts.map(a => '<a class="mono" href="/artifact/' + a + '" target="_blank">' + esc(a) + '</a>').join(''));

  setHTML('events', s.events.slice().reverse().map(e => {
    const cls = e.type.includes('committed') || e.type === 'run.completed' ? 'good'
      : e.type.includes('failed') || e.type.includes('exceeded') ? 'bad'
      : e.type.includes('gate') || e.type.includes('parked') ? 'warn'
      : e.type.includes('running') || e.type.includes('reopened') ? 'info' : '';
    return '<div class="event ' + cls + '"><span class="t mono">' + (e.ts||'').slice(11,19) + '</span><span class="d"></span><span>' + esc(e.text) + '</span></div>';
  }).join(''));

  const meta = {};
  for (const o of (s.designOptions || [])) meta[o.id] = o;
  const previews = s.rawArtifacts.filter(a => a.startsWith('design-options/') && a.endsWith('/index.html'));
  document.getElementById('designPanel').style.display = previews.length ? '' : 'none';
  const designsChanged = setHTML('designs', previews.map(p => {
    const id = p.split('/').slice(-2)[0];
    const name = meta[id] ? meta[id].name : id;
    return '<div class="design"><div class="thumb"><iframe src="/artifact/' + p + '" loading="lazy" tabindex="-1"></iframe>' +
      '<a href="/artifact/' + p + '" target="_blank" title="Open ' + esc(name) + ' full size"></a></div>' +
      '<div class="bar"><b>' + esc(name) + '</b><span class="chip mono">' + esc(id) + '</span>' +
      '<a href="/artifact/' + p + '" target="_blank">open</a>' +
      '<button data-id="' + esc(id) + '">Choose</button></div></div>';
  }).join(''));
  if (designsChanged) document.querySelectorAll('.design button').forEach(b => b.onclick = () => {
    const input = document.querySelector('#gateForm input[name="chosen_option"]');
    if (input) { input.value = b.dataset.id; input.scrollIntoView({behavior:'smooth'}); input.focus(); }
    else alert('The design-select gate is not waiting right now.');
  });

  const appPanel = document.getElementById('appPanel');
  appPanel.style.display = s.appAvailable ? '' : 'none';
  if (s.appAvailable) {
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

  const panel = document.getElementById('gatePanel');
  if (s.parkedGate && !s.resuming) {
    panel.style.display = '';
    const form = document.getElementById('gateForm');
    if (form.dataset.node !== s.parkedGate.nodeId) {
      form.dataset.node = s.parkedGate.nodeId;
      form.innerHTML = s.parkedGate.questions.map(q =>
        '<div class="q"><label>' + esc(q.prompt) + '</label>' +
        (q.why ? '<div class="why">' + esc(q.why) + '</div>' : '') +
        '<input name="' + esc(q.id) + '" value="' + esc(q.default ?? '') + '">' +
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
