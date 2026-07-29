// @harness/app-sandbox — the app-under-build as a managed service.
// Stdio MCP server (newline-delimited JSON-RPC 2.0), zero dependencies.
// Config (HARNESS_MCP_CONFIG): { boot, health?, app_dir?, cwd?, env? }
//   boot:    shell command with $PORT substituted (run inside app_dir/cwd)
//   health:  path polled until 200 (default "/")
//   app_dir: where the app lives relative to the attempt dir (default "app")
//   cwd:     subdir of app_dir to boot from (default ".")
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const CONFIG = JSON.parse(process.env.HARNESS_MCP_CONFIG || "{}");
const ATTEMPT_DIR = process.env.HARNESS_ATTEMPT_DIR || process.cwd();

let app = { child: null, port: null, logFile: null };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
    probe.on("error", reject);
  });
}

function appDir() {
  return path.resolve(ATTEMPT_DIR, CONFIG.app_dir ?? "app");
}

function stopApp() {
  if (app.child) {
    try {
      process.kill(-app.child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  const wasRunning = app.child !== null;
  app = { child: null, port: null, logFile: app.logFile };
  return { stopped: wasRunning };
}
process.on("exit", stopApp);

async function startApp() {
  stopApp();
  if (!CONFIG.boot) return { error: "no boot command configured for this project type" };
  if (!fs.existsSync(appDir())) return { error: `app directory not found: ${appDir()} — copy the app first (cp -R <input> ./app)` };
  const port = await freePort();
  const logFile = path.join(ATTEMPT_DIR, "sandbox-app.log");
  const log = fs.openSync(logFile, "w");
  const child = spawn(CONFIG.boot.replaceAll("$PORT", String(port)), {
    shell: true,
    detached: true,
    cwd: path.join(appDir(), CONFIG.cwd ?? "."),
    env: { ...process.env, PORT: String(port), ...(CONFIG.env ?? {}) },
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  app = { child, port, logFile };
  const health = CONFIG.health ?? "/";
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}${health}`);
      if (res.ok) return { status: "running", port, health_checked: health };
    } catch {
      /* booting */
    }
    if (child.exitCode !== null) break;
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-1500) : "";
  stopApp();
  return { error: "app did not become healthy", log_tail: tail };
}

async function request({ method = "GET", path: reqPath = "/", body = null }) {
  if (!app.port) return { error: "app not running — call start_app first" };
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}${reqPath}`, {
      method,
      headers: body !== null ? { "Content-Type": "application/json" } : undefined,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 4000) };
  } catch (e) {
    return { error: String(e).slice(0, 300) };
  }
}

function logs({ tail = 40 } = {}) {
  if (!app.logFile || !fs.existsSync(app.logFile)) return { lines: [] };
  return { lines: fs.readFileSync(app.logFile, "utf8").split("\n").slice(-tail) };
}

function runTests() {
  const backend = path.join(appDir(), "backend");
  if (!fs.existsSync(path.join(backend, "tests"))) return { error: "no backend/tests directory" };
  const result = spawnSync(
    "uv",
    ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", "python", "-m", "pytest", "tests", "-q", "--tb=line"],
    { cwd: backend, encoding: "utf8", timeout: 300000, env: { ...process.env, HARNESS_AGENT_MODE: "stub" } },
  );
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  const failures = out.split("\n").filter((l) => /^(FAILED|ERROR) |^.+:\d+: /.test(l)).slice(0, 20);
  const summary = out.trim().split("\n").filter(Boolean).pop() ?? "";
  return { passed: result.status === 0, summary: summary.replace(/ in [0-9.]+s.*$/, ""), failures };
}

const TOOLS = [
  {
    name: "start_app",
    description: "Boot the app under build (from ./app) on a free port and wait until healthy. Returns the port or the boot log on failure.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: startApp,
  },
  {
    name: "request",
    description: "Send an HTTP request to the running app; returns structured {status, body}. Far cheaper than a failed verification cycle.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
        path: { type: "string" },
        body: { description: "JSON body for POST/PUT" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: request,
  },
  {
    name: "logs",
    description: "Tail the running app's log (boot errors, tracebacks).",
    inputSchema: { type: "object", properties: { tail: { type: "integer" } }, additionalProperties: false },
    handler: logs,
  },
  {
    name: "run_tests",
    description: "Run the app's backend test suite (stub mode); returns pass/fail with the failing lines.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: runTests,
  },
  {
    name: "stop_app",
    description: "Stop the running app (always safe to call).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: stopApp,
  },
];

// ---- minimal MCP over stdio (newline-delimited JSON-RPC 2.0) ----
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "app-sandbox", version: "0.1.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
    });
  } else if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool '${params?.name}'` } });
      return;
    }
    try {
      const result = await tool.handler(params?.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: String(e).slice(0, 300) }) }], isError: true } });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
