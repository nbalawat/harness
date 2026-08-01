// Contract test: real MCP stdio round-trip against the simulated server.
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const here = path.dirname(fileURLToPath(import.meta.url));
const s = spawn(process.execPath, [path.join(here, "..", "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const pending = new Map(); let nid = 1;
s.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); if (pending.has(m.id)) pending.get(m.id)(m); } } });
const rpc = (method, params) => new Promise((res) => { const id = nid++; pending.set(id, res); s.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const init = await rpc("initialize", {});
assert.equal(init.result.serverInfo.name, "sim-erp");
const list = await rpc("tools/list", {});
assert.ok(list.result.tools.some((t) => t.name === "credit_check"), "advertises credit_check");
const call = await rpc("tools/call", { name: "credit_check", arguments: { name: "Acme" } });
const out = JSON.parse(call.result.content[0].text);
assert.ok(out.rating !== undefined, "credit_check returns rating");
s.kill();
console.log("sim-erp MCP contract OK");
