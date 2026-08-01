import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose", "backend"))
import integrations

_root = os.path.dirname(os.path.dirname(os.path.abspath(integrations.__file__)))  # app root
_mcp = os.path.join(_root, "mcp", "sim-crm")
os.makedirs(_mcp, exist_ok=True)

# a self-contained minimal MCP server (same stdio JSON-RPC contract as the real
# simulated servers) so the test needs nothing from the repo tree.
open(os.path.join(_mcp, "server.mjs"), "w").write(
    'import * as readline from "node:readline";\n'
    'const send=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");\n'
    'const rl=readline.createInterface({input:process.stdin});\n'
    'rl.on("line",(l)=>{let r;try{r=JSON.parse(l)}catch{return}const{id,method,params}=r;\n'
    '  if(method==="initialize")send({jsonrpc:"2.0",id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"sim-crm",version:"0.1.0"}}});\n'
    '  else if(method==="tools/list")send({jsonrpc:"2.0",id,result:{tools:[{name:"lookup",description:"x",inputSchema:{type:"object"}}]}});\n'
    '  else if(method==="tools/call")send({jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify({system:"crm",account:{name:params?.arguments?.name,tier:"Enterprise"}})}]}});\n'
    '  else if(id!==undefined)send({jsonrpc:"2.0",id,result:{}});\n});\n'
)
json.dump(
    {"mcp_dir": "mcp", "connectors": {"crm.lookup": {"server": "sim-crm/server.mjs", "tool": "lookup", "live": False}}},
    open(os.path.join(_root, "integrations.registry.json"), "w"),
)


def test_call_reaches_the_simulated_mcp_server_and_is_swappable():
    assert integrations.registered() == ["crm.lookup"]
    out = integrations.call("crm.lookup", {"name": "Global Widgets"})
    assert out["system"] == "crm" and out["account"]["tier"] == "Enterprise"
    # an unmapped connector degrades gracefully (the swap point exists)
    assert integrations.call("unknown.tool", {}).get("stubbed") is True
