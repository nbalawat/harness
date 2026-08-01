# integration-hub — build guide

The enterprise systems a process integrates with, reached as **MCP servers** so
any connector is swappable for a real system with no app change.

## Use it
- `integrations.call("crm.lookup", {"name": "..."})` from any deterministic step —
  returns the tool's result (dict). Every call is written to the audit trail.
- `integrations.registered()` — the connectors currently mapped.
- `GET /api/integrations` — the connector surface (for the UI).

## The registry (swap point)
`integrations.registry.json` at the app root maps each connector to an MCP
server + tool:
```json
{ "mcp_dir": "mcp", "connectors": {
  "crm.lookup": { "server": "sim-crm/server.mjs", "tool": "lookup", "live": false } } }
```
Today `server` points at a SIMULATED MCP server under `app/mcp/`. To go live,
point it at a real MCP server command and set `live: true` — the process,
handlers, and steps are unchanged. Calls are stdio JSON-RPC 2.0 (the harness MCP
protocol): initialize, then tools/call.

## Contract
A connector returns a JSON object; `{"error": ...}` signals a failed call. Keep
step handlers tolerant of a connector being unavailable (degrade, don't crash).
