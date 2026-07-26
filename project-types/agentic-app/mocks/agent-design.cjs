const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const appName = "assistant";
const { clarifications, requirements } = inputs();
const clar = clarifications.data;
const agentReqs = requirements.data.requirements
  .filter((r) => r.category === "agent" && r.confidence !== "unknown")
  .map((r) => r.id);
writeJson("agent_roster.json", {
  agents: [
    {
      name: appName,
      addresses: agentReqs,
      role: "Answers user questions over the app's data and takes chat actions.",
      tools: ["conversation_lookup"],
      eval_criteria: ["responds helpfully to a greeting", "identifies itself by name"],
      config: { retention: clar["req-005"] ?? clar["req-004"] ?? "90 days" },
    },
  ],
});
simulateCost(0.6, 12000, 1500);
