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
assert.equal(init.result.serverInfo.name, "sim-servicedesk");
const list = await rpc("tools/list", {});
assert.ok(list.result.tools.some((t) => t.name === "ticket_create"), "advertises ticket_create");
const call = await rpc("tools/call", { name: "ticket_create", arguments: { queue: "ops" } });
const out = JSON.parse(call.result.content[0].text);
assert.ok(out.ticket_id !== undefined, "ticket_create returns ticket_id");
s.kill();
console.log("sim-servicedesk MCP contract OK");
