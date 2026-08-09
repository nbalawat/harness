# agent-runtime-claude-sdk — the standard agent runtime

The produced app's agent steps run on the **Claude Agent SDK** — the same engine
the harness itself builds on. `respond(prompt)` drives Claude headlessly (Claude
Code = the Agent SDK agentic loop: multi-turn, tool use, MCP), or the Anthropic
API, or a deterministic stub for tests. Enterprise MCP servers attach as agent
tools via `mcp.agent.json` at the app root.

This is one of three interchangeable runtimes (default): swap for
`agent-runtime-langgraph` or `agent-runtime-adk` to change the framework — the
process, the orchestration, and every step stay the same (contract: `respond`).
