"""integration-hub: the enterprise systems a process integrates with, reached
as MCP servers so any one can be SWAPPED for a real system with no app change.

Each connector name ("crm.lookup") maps, via integrations.registry.json, to an
MCP server command + a tool. Calls are stdio JSON-RPC 2.0 (the harness MCP
protocol). Today the registry points at SIMULATED servers under app/mcp/; point
it at a real MCP server binary to go live. Every call is audited.
"""
import json
import os
import shutil
import subprocess

from ext_audit import record as audit

_BASE = os.path.dirname(os.path.abspath(__file__))
_APP = os.path.dirname(_BASE)


def _registry():
    p = os.path.join(_APP, "integrations.registry.json")
    return json.load(open(p)) if os.path.exists(p) else {"connectors": {}, "mcp_dir": "mcp"}


def registered():
    return sorted(_registry().get("connectors", {}))


def _node():
    return os.environ.get("NODE") or shutil.which("node") or "node"


def _mcp_call(server_cmd, tool, arguments):
    """One stdio JSON-RPC round-trip: initialize, then tools/call."""
    proc = subprocess.Popen(server_cmd, cwd=_APP, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    try:
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}) + "\n")
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                     "params": {"name": tool, "arguments": arguments}}) + "\n")
        proc.stdin.flush()
        result = None
        for _ in range(6):
            line = proc.stdout.readline()
            if not line:
                break
            msg = json.loads(line)
            if msg.get("id") == 2:
                result = msg
                break
        if not result or "result" not in result:
            return {"error": "no result from MCP server", "connector": tool}
        text = result["result"]["content"][0]["text"]
        return json.loads(text)
    finally:
        try:
            proc.stdin.close(); proc.terminate()
        except Exception:
            pass


def call(name, params=None):
    params = params or {}
    reg = _registry()
    conn = reg.get("connectors", {}).get(name)
    if not conn:
        audit("integration.call", {"connector": name, "ok": False, "note": "not in registry"})
        return {"stubbed": True, "connector": name, "note": "no MCP server mapped"}
    server_path = os.path.join(_APP, reg.get("mcp_dir", "mcp"), conn["server"])
    result = _mcp_call([_node(), server_path], conn["tool"], params)
    audit("integration.call", {"connector": name, "server": conn["server"], "tool": conn["tool"],
                               "live": bool(conn.get("live")), "ok": "error" not in result})
    return result
