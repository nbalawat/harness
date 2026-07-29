# agent-runtime-langgraph — agent guide

This app's agent runtime is LangGraph. The CONTRACT is unchanged: all agent
invocations go through `from agent_runtime import respond`; the roster
(`agents/roster.json`) governs identity and tools; `mode()` never lies about
stub vs live. What changed is execution: every respond() runs a compiled
StateGraph (ground -> reason -> disclose). Extend agent behavior by adding
GRAPH NODES in agent_runtime.py — never by calling LangChain/LangGraph
directly from endpoints, and never by bypassing the disclose node (replies
must identify the answering agent; evals enforce it).
