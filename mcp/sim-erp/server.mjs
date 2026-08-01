// @harness/sim-erp — SIMULATED enterprise system as a stdio MCP server.
// Zero-dep, newline-delimited JSON-RPC 2.0. Canned but faithful data. Swap this
// server's command for a real sim-erp MCP server to go live — the process is unchanged.
import * as readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const TOOLS = [
  { name: "credit_check", description: "Credit rating, limit and terms for a party.", inputSchema: { type: "object", properties: { name: { type: "string" } } },
    handler: (a) => { const q = String(a.name||"").toLowerCase(); const rating = q.includes("late")?"B":q.includes("global")?"A":"B+"; return { system: "erp", rating, credit_limit: rating==="A"?500000:250000, outstanding: 18000, terms: "net-30" }; } }
];
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sim-erp", version: "0.1.0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  } else if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool '${params?.name}'` } }); return; }
    try { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(tool.handler(params?.arguments ?? {})) }] } }); }
    catch (e) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: String(e).slice(0,200) }) }], isError: true } }); }
  } else if (id !== undefined) { send({ jsonrpc: "2.0", id, result: {} }); }
});
