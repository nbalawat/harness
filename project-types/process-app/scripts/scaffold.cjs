// Deterministic scaffold: compose the certified modules into a running process
// app. The console is the UI; default step handlers make it run from build one.
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(process.env.HARNESS_PROJECT_DIR, "..", "..");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const wf = JSON.parse(fs.readFileSync(inputs.workflows.path, "utf8"));
const name = inputs.intake.data.process_name || "Process";

// The reference enterprise architecture, composed from certified modules:
// triggers -> deterministic workflow engine -> agent orchestration -> data &
// context (persistence) -> stubbed enterprise-system integrations -> console.
const MODULES = ["persistence-core", "audit-log", "approval-flow", "agent-runtime",
  "integration-hub", "workflow-engine", "process-triggers", "workflow-console"];
fs.mkdirSync("app/backend", { recursive: true });
fs.mkdirSync("app/frontend", { recursive: true });
fs.mkdirSync("app/workflows", { recursive: true });
for (const m of MODULES) {
  const c = path.join(repoRoot, "modules", m, "compose");
  if (fs.existsSync(c)) fs.cpSync(c, "app", { recursive: true });
}
// the console clean-runtime: direct-prompt agent runtime (no double-wrapping)
fs.copyFileSync(path.join(repoRoot, "apps", "ask-docs", "backend", "agent_runtime.py"), "app/backend/agent_runtime.py");

fs.writeFileSync("app/workflows/workflows.json", JSON.stringify(wf, null, 2));

// default handlers for every deterministic step so the process runs at once
const det = [];
for (const p of wf.workflows) for (const nd of p.nodes) if (nd.kind === "deterministic" && nd.handler) det.push(nd);
const seen = new Set();
// map handler -> integration connector it calls (declared on the process step)
const integ = {};
for (const s of det) if (s.integration) integ[s.handler] = s.integration;
const hl = [
  '"""Generated default step handlers — the process runs from build one; real',
  'logic is refined later. Deterministic steps that touch enterprise systems',
  'call the (stubbed) integration-hub connectors; every call is audited."""',
  "import re", "import workflow_engine", "import integrations", "",
  `_INTEG = ${JSON.stringify(integ)}`, "", "",
  "def intake(ctx):",
  "    i = ctx.get('inputs', {})",
  "    name = (i.get('name') or i.get('title') or 'Item').strip()",
  "    out = {'name': name, 'details': (i.get('details') or i.get('description') or '').strip() or '(no details)', 'ok': True}",
  "    if 'intake' in _INTEG:",
  "        acct = integrations.call(_INTEG['intake'], {'name': name}).get('account', {})",
  "        out.update({'tier': acct.get('tier', 'n/a'), 'since': acct.get('since', 'n/a')})",
  "    return out",
  "", "",
  "def credit(ctx):",
  "    r = integrations.call(_INTEG.get('credit', 'erp.credit_check'), {'name': ctx.get('intake', {}).get('name')})",
  "    return {'rating': r.get('rating', 'n/a'), 'credit_limit': r.get('credit_limit'), 'terms': r.get('terms')}",
  "", "",
  "def score(ctx):",
  "    text = ' '.join(str(ctx.get(k, {}).get('reply', '')) for k in ctx if isinstance(ctx.get(k), dict)).lower()",
  "    s = 90",
  "    for kw, pen in (('sanction',40),('concern',12),('weak',12),('risk',6),('unable',12),('no obvious',-5),('strong',-5)):",
  "        if kw in text: s -= pen",
  "    s = max(5, min(100, s))",
  "    return {'score': s, 'band': 'Low risk' if s>=75 else 'Moderate risk' if s>=50 else 'High risk'}",
  "", "",
  "def activate(ctx):",
  "    return {'activated': True}",
  "", "",
  "def _passthrough(step_id, required):",
  "    def h(ctx):",
  "        return {f: True if f=='ok' else 'done' for f in required} or {'ok': True}",
  "    return h",
  "", "",
];
for (const s of det) {
  if (seen.has(s.handler)) continue;
  seen.add(s.handler);
  if (["intake", "credit", "score", "activate"].includes(s.handler)) {
    hl.push(`workflow_engine.register_handler(${JSON.stringify(s.handler)}, ${s.handler})`);
  } else {
    hl.push(`workflow_engine.register_handler(${JSON.stringify(s.handler)}, _passthrough(${JSON.stringify(s.id)}, ${JSON.stringify((s.output_schema||{}).required||[])}))`);
  }
}
fs.writeFileSync("app/backend/ext_process_handlers.py", hl.join("\n") + "\n");

// roster (transparency) + main.py that mounts every ext router + serves console
fs.mkdirSync("app/agents", { recursive: true });
fs.writeFileSync("app/agents/roster.json", JSON.stringify({ agents: wf.workflows[0].nodes.filter((n)=>n.kind==="agent").map((n)=>({ name: n.label, role: "AI step in " + name })) }, null, 2));
fs.writeFileSync("app/backend/requirements.txt", "fastapi\nuvicorn\n");
fs.writeFileSync("app/backend/main.py", [
  `"""${name} — a business process, agentified. Composed from certified harness modules."""`,
  "import glob, importlib, os",
  "from fastapi import FastAPI",
  "from fastapi.responses import FileResponse",
  "import agent_runtime",
  "import ext_process_handlers  # noqa: F401  (registers step handlers)",
  `app = FastAPI(title=${JSON.stringify(name)})`,
  "_B = os.path.dirname(os.path.abspath(__file__))",
  "_F = os.path.join(_B, '..', 'frontend')",
  "for _e in sorted(glob.glob(os.path.join(_B, 'ext_*.py'))):",
  "    m = importlib.import_module(os.path.basename(_e)[:-3])",
  "    if hasattr(m, 'router'): app.include_router(m.router)",
  "@app.get('/health')",
  "def health(): return {'status': 'ok'}",
  "@app.get('/agent/mode')",
  "def mode(): return agent_runtime.mode()",
  "@app.get('/')",
  "def index(): return FileResponse(os.path.join(_F, 'index.html'))",
  "@app.get('/app.js')",
  "def appjs(): return FileResponse(os.path.join(_F, 'app.js'))",
  "",
].join("\n"));

// INTEGRATION LAYER: copy the simulated enterprise MCP servers into the app and
// write the swappable registry. Point an entry at a real MCP server to go live.
const systems = String((inputs.intake.data.systems) || "crm");
const SIM_SERVERS = { crm: "sim-crm", erp: "sim-erp", servicedesk: "sim-servicedesk" };
const CONNECTORS = {
  "crm.lookup": { system: "crm", server: "sim-crm/server.mjs", tool: "lookup" },
  "erp.credit_check": { system: "erp", server: "sim-erp/server.mjs", tool: "credit_check" },
  "ticketing.create": { system: "servicedesk", server: "sim-servicedesk/server.mjs", tool: "ticket_create" },
  "email.send": { system: "servicedesk", server: "sim-servicedesk/server.mjs", tool: "email_send" },
  "docstore.fetch": { system: "servicedesk", server: "sim-servicedesk/server.mjs", tool: "doc_fetch" },
};
// which connectors the designed process actually references
const used = new Set(Object.values(integ));
// always include the systems the user picked (so their tools are available)
for (const [name, c] of Object.entries(CONNECTORS)) {
  if (systems.includes(c.system)) used.add(name);
}
fs.mkdirSync("app/mcp", { recursive: true });
const registryConnectors = {};
const copiedServers = new Set();
for (const name of used) {
  const c = CONNECTORS[name];
  if (!c) continue;
  const simDir = SIM_SERVERS[c.system];
  if (simDir && !copiedServers.has(simDir)) {
    fs.cpSync(path.join(repoRoot, "mcp", simDir), path.join("app/mcp", simDir), { recursive: true });
    copiedServers.add(simDir);
  }
  registryConnectors[name] = { server: c.server, tool: c.tool, live: false };
}
fs.writeFileSync("app/integrations.registry.json", JSON.stringify({ mcp_dir: "mcp", connectors: registryConnectors }, null, 2));

// TRIGGER surface: record which triggers this process accepts (from intake + design)
const triggers = (wf.workflows[0].triggers || []).map((t) => t.kind);
fs.writeFileSync("app/process.meta.json", JSON.stringify({ name, triggers, systems: [...copiedServers] }, null, 2));

fs.writeFileSync("app/composed_modules.json", JSON.stringify({ modules: MODULES }, null, 2));
console.log(`scaffolded '${name}': ${MODULES.length} modules, ${det.length} handlers, ${copiedServers.size} simulated system(s) via MCP, console UI`);
