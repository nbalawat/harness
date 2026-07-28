// MCP server certification + scaffolding — the capability layer's equivalent
// of certify-modules and module-sdk. Adding a server is: new-mcp <name>,
// implement handlers in one file, declare an instance in a dag. Done.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import AjvNS from "ajv";

const Ajv: typeof AjvNS.default =
  (AjvNS as unknown as { default?: typeof AjvNS.default }).default ??
  (AjvNS as unknown as typeof AjvNS.default);

export interface McpReport {
  name: string;
  ok: boolean;
  problems: string[];
  tools: string[];
}

/** Speak just enough MCP to prove the server honors the protocol contract. */
function probeServer(entry: string, timeoutMs = 15000): Promise<{ serverName?: string; tools: string[]; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, HARNESS_MCP_CONFIG: "{}", HARNESS_ATTEMPT_DIR: path.dirname(entry) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ tools: [], error: "server did not answer initialize/tools list in time" });
    }, timeoutMs);
    let buffer = "";
    let serverName: string | undefined;
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string }; tools?: { name: string }[] } };
          if (msg.id === 1) {
            serverName = msg.result?.serverInfo?.name;
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
          } else if (msg.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolve({ serverName, tools: (msg.result?.tools ?? []).map((t) => t.name) });
          }
        } catch {
          /* partial line */
        }
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ tools: [], error: String(e) });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
  });
}

export async function certifyMcp(mcpDir: string): Promise<{ ok: boolean; servers: McpReport[] }> {
  const servers: McpReport[] = [];
  const names = fs.existsSync(mcpDir)
    ? fs.readdirSync(mcpDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  for (const name of names) {
    const dir = path.join(mcpDir, name);
    const problems: string[] = [];
    let tools: string[] = [];

    const manifestPath = path.join(dir, "server.json");
    if (!fs.existsSync(manifestPath)) {
      problems.push("missing server.json");
    } else {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: string; version?: string; description?: string; config_schema?: object };
        if (manifest.name !== name) problems.push(`server.json name '${manifest.name}' != directory '${name}'`);
        for (const field of ["version", "description"] as const) if (!manifest[field]) problems.push(`server.json missing ${field}`);
        if (manifest.config_schema) new Ajv().compile(manifest.config_schema);
      } catch (e) {
        problems.push(`server.json invalid: ${String(e).slice(0, 120)}`);
      }
    }
    if (!fs.existsSync(path.join(dir, "server.mjs"))) {
      problems.push("missing server.mjs");
    } else {
      const probe = await probeServer(path.join(dir, "server.mjs"));
      if (probe.error) problems.push(`protocol probe failed: ${probe.error}`);
      else {
        tools = probe.tools;
        if (probe.serverName !== name) problems.push(`serverInfo.name '${probe.serverName}' != '${name}'`);
        if (tools.length === 0) problems.push("server exposes no tools");
      }
    }
    const testFile = path.join(dir, "test", "test.mjs");
    if (fs.existsSync(testFile)) {
      const test = spawnSync(process.execPath, [testFile], { encoding: "utf8", timeout: 300000 });
      if (test.status !== 0) problems.push(`contract tests failed:\n${(test.stderr ?? "").slice(-400)}`);
    } else {
      problems.push("no test/test.mjs — every server must prove its contract");
    }
    servers.push({ name, ok: problems.length === 0, problems, tools });
  }
  return { ok: servers.every((s) => s.ok), servers };
}

/** Scaffold a new server that passes certify-mcp immediately. */
export function scaffoldMcp(name: string, mcpDir: string): string {
  if (!/^[a-z][a-z0-9-]+$/.test(name)) throw new Error("mcp server names are lowercase-kebab");
  const dir = path.join(mcpDir, name);
  if (fs.existsSync(dir)) throw new Error(`${name} already exists`);
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "server.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        description: "TODO: one line on the capability this server packages",
        config_schema: { type: "object", properties: {}, additionalProperties: false },
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "server.mjs"),
    `// @harness/${name} — TODO describe. Stdio MCP (newline-delimited JSON-RPC).
import * as readline from "node:readline";

const CONFIG = JSON.parse(process.env.HARNESS_MCP_CONFIG || "{}");

const TOOLS = [
  {
    name: "ping",
    description: "TODO: replace with real tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ pong: true, config_keys: Object.keys(CONFIG) }),
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "${name}", version: "0.1.0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  } else if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } }); return; }
    try {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(await tool.handler(params?.arguments ?? {})) }] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: String(e).slice(0, 300) }) }], isError: true } });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
`,
  );
  fs.writeFileSync(
    path.join(dir, "test", "test.mjs"),
    `import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, HARNESS_MCP_CONFIG: "{}" },
  stdio: ["pipe", "pipe", "inherit"],
});
let nextId = 1;
const pending = new Map();
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); }
  }
});
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
});

const init = await rpc("initialize", {});
assert.equal(init.result.serverInfo.name, "${name}");
const list = await rpc("tools/list");
assert.ok(list.result.tools.length >= 1);
const ping = JSON.parse((await rpc("tools/call", { name: "ping", arguments: {} })).result.content[0].text);
assert.equal(ping.pong, true);
server.kill();
console.log("${name} contract OK");
`,
  );
  return dir;
}
