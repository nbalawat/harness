// Contract test: speak real MCP over stdio to the server, boot a real
// (dependency-free) app, probe it, stop it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));
fs.mkdirSync(path.join(attemptDir, "app"), { recursive: true });
fs.writeFileSync(path.join(attemptDir, "app", "hello.txt"), "sandbox works");

const server = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: {
    ...process.env,
    HARNESS_ATTEMPT_DIR: attemptDir,
    HARNESS_MCP_CONFIG: JSON.stringify({ boot: "python3 -m http.server $PORT", health: "/", cwd: "." }),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const call = async (name, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);

const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
assert.equal(init.result.serverInfo.name, "app-sandbox");

const tools = (await rpc("tools/list")).result.tools.map((t) => t.name);
assert.deepEqual(tools.sort(), ["logs", "request", "run_tests", "start_app", "stop_app"]);

const probe = await call("request", { path: "/" });
assert.ok(probe.error, "request before start_app fails helpfully");

const started = await call("start_app");
assert.equal(started.status, "running", JSON.stringify(started));

const page = await call("request", { path: "/hello.txt" });
assert.equal(page.status, 200);
assert.match(page.body, /sandbox works/);

const missing = await call("request", { path: "/nope.txt" });
assert.equal(missing.status, 404, "structured status, not an exception");

const stopped = await call("stop_app");
assert.equal(stopped.stopped, true);

server.kill();
console.log("app-sandbox contract OK");
