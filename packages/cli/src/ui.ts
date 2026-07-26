/**
 * Local web dashboard: the human surface of a run.
 * - Live DAG progress + per-node cost (polls the journal — the single source of truth)
 * - Event feed, artifact browser, design gallery (served inline)
 * - Gate forms: answering a parked gate merges answers and resumes the run
 * Zero dependencies; binds to localhost only.
 */
import * as fs from "node:fs";
import * as http from "node:http";
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
  }));

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
    artifacts: walk(path.join(workspace, "artifacts"), path.join(workspace, "artifacts")),
    events: events.slice(-80).map((e) => ({
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

export function startUiServer(workspace: string, port: number): Promise<http.Server> {
  const artifactsRoot = path.join(workspace, "artifacts");
  let resuming = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      } else if (url.pathname === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...buildState(workspace), resuming }));
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

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><title>harness run</title>
<style>
:root { --bg:#0f1115; --panel:#171a21; --fg:#e6e6e6; --dim:#8a919e; --ok:#3fb950; --warn:#d29922; --err:#f85149; --accent:#58a6ff; }
* { box-sizing:border-box; margin:0; }
body { font:14px/1.5 ui-monospace,Menlo,monospace; background:var(--bg); color:var(--fg); padding:1.2rem; }
h1 { font-size:1.05rem; margin-bottom:.2rem; } h2 { font-size:.9rem; color:var(--dim); margin:.9rem 0 .4rem; text-transform:uppercase; letter-spacing:.06em; }
.grid { display:grid; grid-template-columns: 1.2fr .8fr; gap:1rem; align-items:start; }
.panel { background:var(--panel); border:1px solid #262b36; border-radius:8px; padding: .8rem 1rem; margin-bottom:1rem; }
.node { display:flex; gap:.6rem; align-items:baseline; padding:.18rem 0; }
.node .id { width:200px; } .node .kind { width:110px; color:var(--dim); } .node .cost { margin-left:auto; color:var(--dim); }
.badge { padding:0 .45rem; border-radius:99px; font-size:.75rem; }
.committed { color:var(--ok); } .failed { color:var(--err); } .parked { color:var(--warn); } .started { color:var(--accent); } .pending,.skipped { color:var(--dim); }
.total { font-size:1rem; } .total b { color:var(--accent); }
.events { max-height:300px; overflow-y:auto; font-size:.78rem; color:var(--dim); }
.events .err { color:var(--err); }
a { color:var(--accent); text-decoration:none; }
.artifacts { max-height:280px; overflow-y:auto; font-size:.8rem; }
.designs { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:.6rem; }
.designs iframe { width:100%; height:190px; border:1px solid #262b36; border-radius:6px; background:#fff; }
form.gate { display:flex; flex-direction:column; gap:.5rem; }
form.gate label { color:var(--dim); font-size:.8rem; }
form.gate input { background:var(--bg); border:1px solid #333a47; color:var(--fg); border-radius:6px; padding:.45rem .6rem; font:inherit; }
form.gate button { align-self:flex-start; background:var(--accent); color:#08131f; border:0; border-radius:6px; padding:.45rem .9rem; font:inherit; cursor:pointer; }
.statusline { color:var(--dim); }
</style>
</head>
<body>
<h1 id="title">harness</h1>
<div class="statusline" id="status"></div>
<div class="grid">
<div>
  <div class="panel"><h2>DAG</h2><div id="nodes"></div><div class="total" id="total"></div></div>
  <div class="panel" id="gatePanel" style="display:none"><h2>Waiting on you</h2><form class="gate" id="gateForm"></form></div>
  <div class="panel" id="designPanel" style="display:none"><h2>Design options</h2><div class="designs" id="designs"></div></div>
</div>
<div>
  <div class="panel"><h2>Events</h2><div class="events" id="events"></div></div>
  <div class="panel"><h2>Artifacts</h2><div class="artifacts" id="artifacts"></div></div>
</div>
</div>
<script>
async function tick() {
  const s = await (await fetch('/api/state')).json();
  document.getElementById('title').textContent = s.projectType + ' — ' + s.status + (s.resuming ? ' (resuming…)' : '');
  document.getElementById('status').textContent = s.workspace;
  document.getElementById('nodes').innerHTML = s.nodes.map(n =>
    '<div class="node"><span class="id">' + n.id + '</span><span class="kind">' + n.kind + '</span>' +
    '<span class="badge ' + n.state + '">' + n.state + '</span>' +
    '<span class="cost">' + (n.cost ? ('$' + n.cost.costUsd.toFixed(3) + ' · ' + Math.round(n.cost.wallClockMs/1000) + 's') : '') + '</span></div>'
  ).join('');
  document.getElementById('total').innerHTML = 'total <b>$' + s.totalCostUsd.toFixed(3) + '</b>' +
    (s.runBudgetUsd ? ' / budget $' + s.runBudgetUsd.toFixed(2) : '');
  document.getElementById('events').innerHTML = s.events.slice().reverse().map(e =>
    '<div class="' + (e.type.includes('failed') || e.type.includes('exceeded') ? 'err' : '') + '">' +
    (e.ts || '').slice(11,19) + ' ' + e.type + (e.nodeId ? ' [' + e.nodeId + ']' : '') + ' ' + e.detail + '</div>'
  ).join('');
  document.getElementById('artifacts').innerHTML = s.artifacts.map(a =>
    '<div><a href="/artifact/' + a + '" target="_blank">' + a + '</a></div>').join('');

  const previews = s.artifacts.filter(a => /designs\\/option-[0-9]+\\/index.html$/.test(a));
  document.getElementById('designPanel').style.display = previews.length ? '' : 'none';
  document.getElementById('designs').innerHTML = previews.map(p => '<iframe src="/artifact/' + p + '"></iframe>').join('');

  const panel = document.getElementById('gatePanel');
  if (s.parkedGate && !s.resuming) {
    panel.style.display = '';
    const form = document.getElementById('gateForm');
    if (form.dataset.node !== s.parkedGate.nodeId) {
      form.dataset.node = s.parkedGate.nodeId;
      form.innerHTML = '<div>gate: <b>' + s.parkedGate.nodeId + '</b></div>' + s.parkedGate.questions.map(q =>
        '<label>' + q.prompt + (q.why ? ' — <i>' + q.why + '</i>' : '') + '</label>' +
        '<input name="' + q.id + '" value="' + (q.default ?? '') + '">').join('') +
        '<button type="submit">Answer &amp; resume</button>';
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const answers = Object.fromEntries(new FormData(form).entries());
        await fetch('/api/answer', { method: 'POST', body: JSON.stringify({ nodeId: form.dataset.node, answers }) });
        form.dataset.node = '';
      };
    }
  } else panel.style.display = 'none';
}
tick(); setInterval(tick, 1500);
</script>
</body>
</html>`;
