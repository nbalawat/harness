const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const { intake, requirements } = inputs();
const reqs = requirements.data.requirements.filter((r) => r.confidence !== "unknown");
const byCat = (...cats) => reqs.filter((r) => cats.includes(r.category)).map((r) => r.id);
// The agent-layer framework is an EXPLICIT choice (default = portable, neutral,
// API-key-first — no framework lock-in, runs in any environment). Teams that
// standardize on a framework opt into it.
const FRAMEWORKS = { standard: "agent-runtime", "claude-sdk": "agent-runtime-claude-sdk", langgraph: "agent-runtime-langgraph", adk: "agent-runtime-adk", strands: "agent-runtime-strands" };
const runtime = FRAMEWORKS[String(intake.data.agent_framework || "standard")] || "agent-runtime";
writeJson("architecture.json", {
  // The flagship stack: the app substrate + the enterprise-process layer —
  // triggers start process instances, the workflow engine orchestrates, a
  // deterministic step can fan out to a multi-agent orchestration, and agents
  // reach enterprise systems through swappable (simulated) MCP integrations.
  modules: ["persistence-core", "chat-shell", runtime, "audit-log", "approval-flow", "workflow-engine",
    "process-triggers", "agent-orchestrator", "integration-hub", "runtime-compose"],
  module_coverage: [
    { module: "persistence-core", addresses: byCat("data") },
    { module: "chat-shell", addresses: byCat("ux", "functional") },
    { module: runtime, addresses: byCat("agent") },
    { module: "audit-log", addresses: byCat("security", "data") },
    { module: "approval-flow", addresses: byCat("functional", "ux") },
    { module: "workflow-engine", addresses: byCat("functional", "agent") },
    { module: "process-triggers", addresses: byCat("functional", "ux") },
    { module: "agent-orchestrator", addresses: byCat("agent", "functional") },
    { module: "integration-hub", addresses: byCat("functional", "data") },
    { module: "runtime-compose", addresses: byCat("data") },
  ],
  deploy_target: intake.data.deploy_target,
  build_budget_plan: {
    nodes: { "build-backend": 3.5, "build-agents": 2.5, "build-frontend": 2.0 },
    total_usd: 8.0,
  },
});
simulateCost(0.8, 21000, 1800);
