const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const { intake } = inputs();
writeJson("architecture.json", {
  modules: ["persistence-core", "chat-shell", "agent-runtime"],
  deploy_target: intake.data.deploy_target,
  build_budget_plan: {
    nodes: { "build-backend": 3.5, "build-agents": 2.5, "build-frontend": 2.0 },
    total_usd: 8.0,
  },
});
simulateCost(0.8, 21000, 1800);
