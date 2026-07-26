const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const appName = "assistant";
const clar = inputs().clarifications.data;
writeJson("agent_roster.json", {
  agents: [
    {
      name: appName,
      role: "Answers user questions over the app's data and takes chat actions.",
      tools: ["conversation_lookup"],
      eval_criteria: ["responds helpfully to a greeting", "identifies itself by name"],
      config: { retention: clar["req-005"] ?? clar["req-004"] ?? "90 days" },
    },
  ],
});
simulateCost(0.6, 12000, 1500);
