# agent-runtime-adk — agent guide

This app's agent runtime is Google ADK. The CONTRACT is unchanged: all agent
invocations go through `from agent_runtime import respond`; the roster governs
identity; `mode()` never lies about stub vs live. Execution runs an ADK
LlmAgent through a Runner with sessions. Extend behavior by configuring the
LlmAgent (instructions, tools) in agent_runtime.py — never by importing ADK
directly in endpoints, and never by bypassing the identity disclosure the
adapter applies (evals enforce it).
