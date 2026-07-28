# agent-runtime-strands — agent guide

This app's agent runtime is AWS Strands. The CONTRACT is unchanged: all agent
invocations go through `from agent_runtime import respond`; the roster governs
identity; `mode()` never lies about stub vs live. Execution runs a Strands
Agent whose Model is the harness bridge (stub / claude-cli / anthropic).
Extend behavior by configuring the Agent (system prompt, tools) in
agent_runtime.py — never by importing strands directly in endpoints, and never
by bypassing the identity disclosure the adapter applies (evals enforce it).
