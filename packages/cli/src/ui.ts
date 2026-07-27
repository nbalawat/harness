/**
 * Local web dashboard: the human surface of a run.
 * - Live DAG progress + per-node cost (polls the journal — the single source of truth)
 * - Event feed, artifact browser, design gallery (served inline)
 * - Gate forms: answering a parked gate merges answers and resumes the run
 * Zero dependencies; binds to localhost only.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Journal, foldState, loadProjectType } from "@harness/runner";
import type { GateQuestion, NodeDef } from "@harness/spec";

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

function readConfig(workspace: string): UiRunConfig {
  return JSON.parse(fs.readFileSync(path.join(workspace, "run.json"), "utf8")) as UiRunConfig;
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

/** Resolve the questions of a parked gate (static or from an upstream artifact). */
function parkedGateQuestions(
  workspace: string,
  node: NodeDef,
  artifacts: Record<string, Record<string, string>>,
): GateQuestion[] | undefined {
  if (node.questions) return node.questions;
  if (!node.questionsFrom) return undefined;
  for (const byNode of Object.values(artifacts)) {
    const rel = byNode[node.questionsFrom.artifact];
    if (!rel) continue;
    let value: unknown = JSON.parse(fs.readFileSync(path.join(workspace, rel), "utf8"));
    for (const seg of (node.questionsFrom.path ?? "questions").split(".")) {
      value = (value as Record<string, unknown>)?.[seg];
    }
    if (Array.isArray(value)) return value as GateQuestion[];
  }
  return undefined;
}

export function buildState(workspace: string): Record<string, unknown> {
  const config = readConfig(workspace);
  const def = loadProjectType(config.projectTypeDir);
  const events = new Journal(workspace).read();
  const state = foldState(events);

  const costs: Record<string, { costUsd: number; wallClockMs: number; tokens: number }> = {};
  for (const e of events) {
    if (e.type !== "cost.recorded") continue;
    const c = e.cost as { costUsd: number; wallClockMs: number; inputTokens: number; outputTokens: number };
    const agg = (costs[e.nodeId as string] ??= { costUsd: 0, wallClockMs: 0, tokens: 0 });
    agg.costUsd += c.costUsd;
    agg.wallClockMs += c.wallClockMs;
    agg.tokens += c.inputTokens + c.outputTokens;
  }

  const running = new Set(
    events.filter((e) => e.type === "node.running").map((e) => e.nodeId as string),
  );
  const retries: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "node.attempt_failed") retries[e.nodeId as string] = (retries[e.nodeId as string] ?? 0) + 1;
  }
  const last = events[events.length - 1];
  const parkedNodeId =
    last?.type === "run.parked" || events.some((e) => e.type === "node.parked" && !state.committed.has(e.nodeId as string))
      ? (events.filter((e) => e.type === "node.parked").map((e) => e.nodeId as string).find((id) => !state.committed.has(id)) ?? null)
      : null;

  const nodes = def.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    deps: n.deps ?? [],
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

  // Design option metadata for the gallery (names, screens), when available.
  let designOptions: unknown = null;
  for (const byNode of Object.values(state.artifacts)) {
    if (byNode.designs) {
      try {
        designOptions = (JSON.parse(fs.readFileSync(path.join(workspace, byNode.designs), "utf8")) as { options: unknown }).options;
      } catch { /* partial write during live runs — ignore */ }
    }
  }
  const firstTs = events[0]?.ts, lastTs = events[events.length - 1]?.ts;

  const parkedNode = def.nodes.find((n) => n.id === parkedNodeId);
  return {
    projectType: `${def.name}@${def.version}`,
    workspace,
    totalCostUsd: state.totalCostUsd,
    runBudgetUsd: def.cost?.run_budget_usd ?? null,
    status: events.some((e) => e.type === "run.completed")
      ? "completed"
      : parkedNodeId
        ? "parked"
        : events[events.length - 1]?.type === "run.failed"
          ? "failed"
          : "running",
    nodes,
    parkedGate: parkedNode
      ? { nodeId: parkedNode.id, questions: parkedGateQuestions(workspace, parkedNode, state.artifacts) ?? [] }
      : null,
    designOptions,
    elapsedMs: firstTs && lastTs ? Date.parse(String(lastTs)) - Date.parse(String(firstTs)) : 0,
    artifacts: walk(path.join(workspace, "artifacts"), path.join(workspace, "artifacts")),
    events: events.filter((e) => e.type !== "agent.message").slice(-80).map((e) => ({
      ts: e.ts,
      type: e.type,
      nodeId: e.nodeId ?? null,
      detail:
        e.type === "cost.recorded"
          ? `$${(e.cost as { costUsd: number }).costUsd.toFixed(3)}`
          : e.type === "node.attempt_failed"
            ? String(e.error).slice(0, 160)
            : e.type === "budget.exceeded"
              ? `scope=${e.scope}`
              : "",
    })),
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

  /** Latest committed app artifact, in DAG order (the freshest build stage wins). */
  function latestAppArtifact(): { node: string; dir: string } | null {
    const config = readConfig(workspace);
    const def = loadProjectType(config.projectTypeDir);
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
        process.kill(-app.pid, "SIGTERM"); // negative pid: kill the shell's process group
      } catch { /* already gone */ }
    }
    app.status = "stopped";
    app.port = null;
    app.pid = null;
  }

  async function startApp(): Promise<void> {
    stopApp();
    const config = readConfig(workspace);
    const def = loadProjectType(config.projectTypeDir);
    const preview = def.preview;
    const latest = latestAppArtifact();
    if (!preview || !latest) {
      app.status = "failed";
      app.error = preview ? "no app artifact committed yet" : "project type declares no preview";
      return;
    }
    // Run against a copy — committed artifacts stay immutable.
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
            tail = fs.readFileSync(path.join(workspace, "app-preview.log"), "utf8").split("\n").slice(-6).join(" | ");
          } catch { /* no log */ }
          app.error = "app process exited during startup: " + tail.slice(-300);
        }
        app.pid = null;
        app.port = null;
      }
    });
    const healthUrl = "http://127.0.0.1:" + appPort + (preview.health ?? "/");
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (app.pid !== child.pid) return; // superseded or died
      try {
        const res = await fetch(healthUrl);
        if (res.ok) {
          app.status = "running";
          app.port = appPort;
          return;
        }
      } catch { /* not up yet */ }
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
      } else if (url.pathname === "/api/app/start" && req.method === "POST") {
        void startApp();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.pathname === "/api/app/stop" && req.method === "POST") {
        stopApp();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
    --grid:#2c2c2a; --border:rgba(255,255,255,.10); --accent:#3987e5;
    --shadow:none;
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
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:.8rem; margin-bottom:1.1rem; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:.85rem 1rem; box-shadow:var(--shadow); }
.tile .k { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:.35rem; }
.tile .v { font-size:1.45rem; font-weight:650; letter-spacing:-.01em; }
.tile .sub { font-size:.78rem; color:var(--ink2); margin-top:.1rem; }
.meter { height:6px; border-radius:3px; background:var(--grid); margin-top:.55rem; overflow:hidden; }
.meter > div { height:100%; border-radius:3px; background:var(--accent); transition:width .6s ease; }
.meter > div.over { background:var(--crit); }
.grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,.85fr); gap:1rem; align-items:start; }
@media (max-width: 900px) { .grid { grid-template-columns:1fr; } }
.card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.15rem; box-shadow:var(--shadow); margin-bottom:1rem; }
.card h2 { font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:.7rem; }
.rail { position:relative; }
.rail::before { content:""; position:absolute; left:11px; top:8px; bottom:8px; width:2px; background:var(--grid); border-radius:1px; }
.node { position:relative; display:flex; align-items:center; gap:.7rem; padding:.32rem 0 .32rem 2rem; }
.node .icon { position:absolute; left:0; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.72rem; background:var(--surface); border:2px solid var(--grid); color:var(--muted); }
.node.committed .icon { border-color:var(--good); color:var(--good); }
.node.failed .icon { border-color:var(--crit); color:var(--crit); background:var(--crit); color:#fff; }
.node.parked .icon { border-color:var(--warn); color:var(--warn); }
.node.started .icon { border-color:var(--accent); color:var(--accent); }
.node.started .icon::after { content:""; position:absolute; inset:-6px; border-radius:50%; border:2px solid var(--accent); opacity:.5; animation:pulse 1.4s ease-out infinite; }
@keyframes pulse { from { transform:scale(.7); opacity:.6; } to { transform:scale(1.15); opacity:0; } }
.node .id { font-weight:560; }
.node.pending .id, .node.skipped .id { color:var(--muted); font-weight:450; }
.chip { white-space:nowrap; font-size:.68rem; padding:.05rem .5rem; border-radius:999px; border:1px solid var(--border); color:var(--ink2); }
.chip.retry { color:var(--serious); border-color:var(--serious); }
.node .cost { margin-left:auto; font-size:.75rem; color:var(--ink2); }
.gate { border-left:3px solid var(--warn); }
.gate .q { margin-bottom:.85rem; }
.gate label { display:block; font-weight:560; margin-bottom:.12rem; }
.gate .why { font-size:.78rem; color:var(--ink2); margin-bottom:.35rem; }
.gate input { width:100%; background:var(--page); border:1px solid var(--grid); color:var(--ink); border-radius:8px; padding:.55rem .7rem; font:inherit; }
.gate input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
.gate .hint { font-size:.72rem; color:var(--muted); margin-top:.2rem; }
button.primary { background:var(--accent); color:var(--accent-ink); border:0; border-radius:8px; padding:.55rem 1.1rem; font:inherit; font-weight:560; cursor:pointer; }
button.primary:hover { filter:brightness(1.08); }
.designs { display:grid; grid-template-columns:repeat(auto-fill,252px); gap:.8rem; }
.design { border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--page); }
.design .thumb { height:220px; overflow:hidden; background:#fff; position:relative; }
.design .thumb iframe { width:1200px; height:1048px; border:0; transform:scale(0.21); transform-origin:0 0; pointer-events:none; }
.design .thumb a { position:absolute; inset:0; }
.design .bar { display:flex; align-items:center; gap:.6rem; padding:.5rem .7rem; border-top:1px solid var(--border); }
.design .bar b { font-size:.85rem; }
.design .bar .chip { margin-right:auto; }
.design .bar a { font-size:.78rem; color:var(--accent); text-decoration:none; }
.design .bar button { background:transparent; border:1px solid var(--accent); color:var(--accent); border-radius:6px; padding:.2rem .7rem; font:inherit; font-size:.78rem; cursor:pointer; }
.events { max-height:340px; overflow-y:auto; font-size:.78rem; }
.event { display:flex; gap:.55rem; align-items:baseline; padding:.14rem 0; color:var(--ink2); }
.event .t { color:var(--muted); font-size:.7rem; flex:none; width:56px; }
.event .d { width:7px; height:7px; border-radius:50%; background:var(--grid); flex:none; align-self:center; }
.event.good .d { background:var(--good); } .event.bad .d { background:var(--crit); }
.event.warn .d { background:var(--warn); } .event.info .d { background:var(--accent); }
.event.bad { color:var(--crit); }
.artifacts { font-size:.8rem; }
.artifacts details { border-bottom:1px solid var(--grid); padding:.3rem 0; }
.artifacts summary { cursor:pointer; color:var(--ink2); font-weight:550; }
.artifacts summary .chip { margin-left:.4rem; }
.artifacts a { display:block; color:var(--accent); text-decoration:none; padding:.12rem 0 .12rem 1rem; }
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
  <div class="tile"><div class="k">Elapsed</div><div class="v" id="elapsedV"></div><div class="sub">wall clock</div></div>
  <div class="tile"><div class="k">Attention</div><div class="v" id="attnV" style="font-size:1.05rem"></div><div class="sub" id="attnSub"></div></div>
</div>
<div class="card" id="appPanel" style="display:none">
  <div style="display:flex;align-items:center;gap:.8rem;flex-wrap:wrap">
    <h2 style="margin:0">Your application</h2>
    <span class="chip" id="appStage"></span>
    <span class="pill" style="margin-left:0;padding:.2rem .7rem;font-size:.78rem"><span class="dot" id="appDot"></span><span id="appStatus"></span></span>
    <span style="margin-left:auto;display:flex;gap:.5rem;align-items:center">
      <a id="appLink" class="mono" target="_blank" style="color:var(--accent);text-decoration:none;display:none"></a>
      <button class="primary" id="appLaunch">Launch app</button>
      <button id="appStop" style="background:transparent;border:1px solid var(--border);color:var(--ink2);border-radius:8px;padding:.55rem .9rem;font:inherit;cursor:pointer;display:none">Stop</button>
    </span>
  </div>
  <div id="appFrameWrap" style="display:none;margin-top: .9rem;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#fff">
    <iframe id="appFrame" style="width:100%;height:520px;border:0;display:block"></iframe>
  </div>
</div>
<div class="grid">
<div>
  <div class="card gate" id="gatePanel" style="display:none"><h2>Waiting on you</h2><form id="gateForm"></form></div>
  <div class="card" id="designPanel" style="display:none"><h2>Design options — pick one</h2><div class="designs" id="designs"></div></div>
  <div class="card"><h2>Pipeline</h2><div class="rail" id="nodes"></div></div>
</div>
<div>
  <div class="card"><h2>Activity</h2><div class="events" id="events"></div></div>
  <div class="card"><h2>Artifacts</h2><div class="artifacts" id="artifacts"></div></div>
</div>
</div>
<script>
const STATUS_COLOR = { completed:'var(--good)', running:'var(--accent)', parked:'var(--warn)', failed:'var(--crit)' };
const STATE_ICON = { committed:'✓', failed:'✕', parked:'⏸', started:'●', skipped:'↷', pending:'○' };
function fmtDur(ms) {
  if (!ms) return '0s';
  const s = Math.round(ms/1000);
  return s < 90 ? s + 's' : Math.floor(s/60) + 'm ' + (s%60) + 's';
}
async function tick() {
  const s = await (await fetch('/api/state')).json();
  document.getElementById('title').textContent = s.projectType;
  document.getElementById('status').textContent = s.workspace;
  const st = s.resuming ? 'running' : s.status;
  document.getElementById('statusText').textContent = s.resuming ? 'resuming…' : s.status;
  document.getElementById('statusDot').style.background = STATUS_COLOR[st] || 'var(--muted)';

  const done = s.nodes.filter(n => n.state === 'committed' || n.state === 'skipped').length;
  document.getElementById('progressV').textContent = done + ' / ' + s.nodes.length;
  document.getElementById('progressBar').style.width = (100*done/s.nodes.length) + '%';
  document.getElementById('progressSub').textContent = 'nodes complete';

  document.getElementById('costV').textContent = '$' + s.totalCostUsd.toFixed(2);
  const costBar = document.getElementById('costBar');
  if (s.runBudgetUsd) {
    const pct = Math.min(100, 100*s.totalCostUsd/s.runBudgetUsd);
    costBar.style.width = pct + '%';
    costBar.className = s.totalCostUsd > s.runBudgetUsd ? 'over' : '';
    document.getElementById('costSub').textContent = 'of $' + s.runBudgetUsd.toFixed(2) + ' budget';
  } else { costBar.style.width='0%'; document.getElementById('costSub').textContent = 'no budget set'; }

  document.getElementById('elapsedV').textContent = fmtDur(s.elapsedMs);
  document.getElementById('attnV').textContent = s.parkedGate ? 'Answer ' + s.parkedGate.questions.length + ' question' + (s.parkedGate.questions.length===1?'':'s') : 'Nothing';
  document.getElementById('attnSub').textContent = s.parkedGate ? 'gate: ' + s.parkedGate.nodeId : 'the run does not need you right now';

  document.getElementById('nodes').innerHTML = s.nodes.map(n =>
    '<div class="node ' + n.state + '"><span class="icon">' + (STATE_ICON[n.state]||'') + '</span>' +
    '<span class="id mono">' + n.id + '</span><span class="chip">' + n.kind + '</span>' +
    (n.retries ? '<span class="chip retry">retry ×' + n.retries + '</span>' : '') +
    '<span class="cost mono">' + (n.cost && (n.cost.costUsd || n.cost.wallClockMs) ? ('$' + n.cost.costUsd.toFixed(2) + ' · ' + fmtDur(n.cost.wallClockMs)) : '') + '</span></div>'
  ).join('');

  document.getElementById('events').innerHTML = s.events.slice().reverse().map(e => {
    const cls = e.type.includes('committed') ? 'good' : (e.type.includes('failed')||e.type.includes('exceeded')) ? 'bad' : e.type.includes('gate')||e.type.includes('parked') ? 'warn' : e.type.includes('agent')||e.type.includes('cost') ? 'info' : '';
    return '<div class="event ' + cls + '"><span class="t mono">' + (e.ts||'').slice(11,19) + '</span><span class="d"></span><span>' + e.type + (e.nodeId ? ' · ' + e.nodeId : '') + (e.detail ? ' · ' + e.detail : '') + '</span></div>';
  }).join('');

  const groups = {};
  for (const a of s.artifacts) { const g = a.split('/')[0]; (groups[g] ??= []).push(a); }
  document.getElementById('artifacts').innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([g, files]) =>
    '<details><summary>' + g + '<span class="chip">' + files.length + '</span></summary>' +
    files.map(f => '<a class="mono" href="/artifact/' + f + '" target="_blank">' + f.slice(g.length+1) + '</a>').join('') + '</details>'
  ).join('') : '<div class="empty">No artifacts yet.</div>';

  const meta = {};
  for (const o of (s.designOptions || [])) meta[o.id] = o;
  const previews = s.artifacts.filter(a => a.startsWith('design-options/') && /\\/index\\.html$/.test(a));
  document.getElementById('designPanel').style.display = previews.length ? '' : 'none';
  document.getElementById('designs').innerHTML = previews.map(p => {
    const id = p.split('/').slice(-2)[0];
    const name = meta[id] ? meta[id].name : id;
    return '<div class="design"><div class="thumb"><iframe src="/artifact/' + p + '" loading="lazy" tabindex="-1"></iframe>' +
      '<a href="/artifact/' + p + '" target="_blank" title="Open ' + name + ' full size"></a></div>' +
      '<div class="bar"><b>' + name + '</b><span class="chip mono">' + id + '</span>' +
      '<a href="/artifact/' + p + '" target="_blank">open</a>' +
      '<button data-id="' + id + '">Choose</button></div></div>';
  }).join('');
  document.querySelectorAll('.design button').forEach(b => b.onclick = () => {
    const input = document.querySelector('#gateForm input[name="chosen_option"]');
    if (input) { input.value = b.dataset.id; input.scrollIntoView({behavior:'smooth'}); input.focus(); }
    else alert('The design-select gate is not waiting right now.');
  });

  const appPanel = document.getElementById('appPanel');
  appPanel.style.display = s.appAvailable ? '' : 'none';
  if (s.appAvailable) {
    const a = s.app;
    const colors = { running:'var(--good)', starting:'var(--warn)', failed:'var(--crit)', stopped:'var(--muted)' };
    document.getElementById('appDot').style.background = colors[a.status] || 'var(--muted)';
    document.getElementById('appStatus').textContent = a.status === 'failed' ? 'failed — ' + (a.error||'') : a.status;
    document.getElementById('appStage').textContent = a.node ? 'built at: ' + a.node : 'ready to launch';
    const launch = document.getElementById('appLaunch');
    launch.textContent = a.status === 'running' ? 'Relaunch latest' : a.status === 'starting' ? 'Starting…' : 'Launch app';
    launch.disabled = a.status === 'starting';
    launch.onclick = () => fetch('/api/app/start', { method:'POST' });
    const stop = document.getElementById('appStop');
    stop.style.display = a.status === 'running' ? '' : 'none';
    stop.onclick = () => fetch('/api/app/stop', { method:'POST' });
    const link = document.getElementById('appLink');
    const wrap = document.getElementById('appFrameWrap');
    const frame = document.getElementById('appFrame');
    if (a.status === 'running' && a.port) {
      const url = 'http://localhost:' + a.port;
      link.style.display = ''; link.href = url; link.textContent = url;
      wrap.style.display = '';
      if (frame.dataset.url !== url) { frame.dataset.url = url; frame.src = url; }
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
        '<div class="q"><label>' + q.prompt + '</label>' +
        (q.why ? '<div class="why">' + q.why + '</div>' : '') +
        '<input name="' + q.id + '" value="' + String(q.default ?? '').replaceAll('"','&quot;') + '">' +
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
}
tick(); setInterval(tick, 1500);
</script>
</body>
</html>`;
