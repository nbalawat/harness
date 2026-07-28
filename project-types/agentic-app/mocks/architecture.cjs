const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const { intake, requirements } = inputs();
const reqs = requirements.data.requirements.filter((r) => r.confidence !== "unknown");
const byCat = (...cats) => reqs.filter((r) => cats.includes(r.category)).map((r) => r.id);
writeJson("architecture.json", {
  modules: ["persistence-core", "chat-shell", "agent-runtime", "audit-log", "approval-flow", "workflow-engine"],
  module_coverage: [
    { module: "persistence-core", addresses: byCat("data") },
    { module: "chat-shell", addresses: byCat("ux", "functional") },
    { module: "agent-runtime", addresses: byCat("agent") },
    { module: "audit-log", addresses: byCat("security", "data") },
    { module: "approval-flow", addresses: byCat("functional", "ux") },
    { module: "workflow-engine", addresses: byCat("functional", "agent") },
  ],
  deploy_target: intake.data.deploy_target,
  build_budget_plan: {
    nodes: { "build-backend": 3.5, "build-agents": 2.5, "build-frontend": 2.0 },
    total_usd: 8.0,
  },
});
simulateCost(0.8, 21000, 1800);
