// @harness/sim-servicedesk — SIMULATED enterprise system as a stdio MCP server.
// Zero-dep, newline-delimited JSON-RPC 2.0. Canned but faithful data. Swap this
// server's command for a real sim-servicedesk MCP server to go live — the process is unchanged.
import * as readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const TOOLS = [
  { name: "ticket_create", description: "Open a ticket.", inputSchema: { type: "object", properties: { queue: { type: "string" }, subject: { type: "string" } } },
    handler: (a) => ({ system: "ticketing", ticket_id: "TICK-" + (1000 + Math.floor(Math.abs([...JSON.stringify(a)].reduce((h,c)=>h*31+c.charCodeAt(0),7)) % 9000)), queue: a.queue||"ops", status: "open" }) },
  { name: "email_send", description: "Send a notification email.", inputSchema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" } } },
    handler: (a) => ({ system: "email", sent: true, to: a.to||"unknown@example.com", subject: a.subject||"(no subject)" }) },
  { name: "doc_fetch", description: "Fetch documents for a party.", inputSchema: { type: "object", properties: { name: { type: "string" } } },
    handler: (a) => ({ system: "docstore", documents: [{ name: "master-agreement.pdf", pages: 12 }, { name: "w9.pdf", pages: 1 }] }) }
];
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sim-servicedesk", version: "0.1.0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  } else if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool '${params?.name}'` } }); return; }
    try { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(tool.handler(params?.arguments ?? {})) }] } }); }
    catch (e) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: String(e).slice(0,200) }) }], isError: true } }); }
  } else if (id !== undefined) { send({ jsonrpc: "2.0", id, result: {} }); }
});
