// Deterministic scaffold: compose the certified modules into a running process
// app. The console is the UI; default step handlers make it run from build one.
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(process.env.HARNESS_PROJECT_DIR, "..", "..");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const wf = JSON.parse(fs.readFileSync(inputs.workflows.path, "utf8"));
const name = inputs.intake.data.process_name || "Process";

// The agent-orchestration framework is a SWAPPABLE choice — Claude Agent SDK
// (standard) / LangGraph / Google ADK — chosen at intake.
const FRAMEWORKS = { "claude-sdk": "agent-runtime-claude-sdk", "langgraph": "agent-runtime-langgraph", "adk": "agent-runtime-adk" };
const runtimeModule = FRAMEWORKS[String(inputs.intake.data.framework || "claude-sdk")] || "agent-runtime-claude-sdk";

// The reference enterprise architecture, composed from certified modules:
// triggers -> deterministic workflow engine -> AGENT ORCHESTRATION (specialists
// + synthesizer over MCP tools, on the chosen runtime) -> data & context
// (persistence) -> stubbed enterprise-system integrations (MCP) -> console.
// persistence-core (DATABASE_URL-aware) + postgres-adapter give the app a real
// store under the Docker Compose runtime; runtime-compose ships that stack.
const MODULES = ["persistence-core", "postgres-adapter", "audit-log", "approval-flow", runtimeModule,
  "agent-orchestrator", "integration-hub", "workflow-engine", "process-triggers", "workflow-console",
  "runtime-compose"];
fs.mkdirSync("app/backend", { recursive: true });
fs.mkdirSync("app/frontend", { recursive: true });
fs.mkdirSync("app/workflows", { recursive: true });
for (const m of MODULES) {
  const c = path.join(repoRoot, "modules", m, "compose");
  if (fs.existsSync(c)) fs.cpSync(c, "app", { recursive: true });
}

fs.writeFileSync("app/workflows/workflows.json", JSON.stringify(wf, null, 2));

// Real, data-driven step handlers (generic + static): every deterministic step
// produces REAL data — enterprise-system steps call the MCP connector, the
// intake step echoes the submitted fields, downstream fields carry/derive, and a
// step carrying an `orchestration` invokes the multi-agent orchestration. The
// file reads workflows.json at runtime, so it is build-invariant (deterministic).
fs.copyFileSync(
  path.join(process.env.HARNESS_PROJECT_DIR, "templates", "ext_process_handlers.py"),
  "app/backend/ext_process_handlers.py",
);

// roster (transparency) + main.py that mounts every ext router + serves console
fs.mkdirSync("app/agents", { recursive: true });
fs.writeFileSync("app/agents/roster.json", JSON.stringify({ agents: wf.workflows[0].nodes.filter((n)=>n.kind==="agent").map((n)=>({ name: n.label, role: "AI step in " + name })) }, null, 2));
// psycopg is the runtime driver behind the DATABASE_URL store swap (Docker
// Compose runtime). Off Compose (no DATABASE_URL) it's never imported, so bare
// uvicorn / tests / certification stay in-memory and dependency-light.
fs.writeFileSync("app/backend/requirements.txt", "fastapi\nuvicorn\npsycopg[binary]\n");
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
// Wire every connector for the systems the user picked — the handlers infer
// which step calls which connector by intent, so all of a system's tools are
// available (and swappable) to the process.
const used = new Set();
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
const stepCount = wf.workflows.reduce((n, p) => n + (p.nodes || []).length, 0);
console.log(`scaffolded '${name}': ${MODULES.length} modules, ${stepCount} steps, ${copiedServers.size} simulated system(s) via MCP, console UI`);
