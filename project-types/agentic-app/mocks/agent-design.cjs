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
      denied_tools: ["outbound_email", "data_deletion"],
      system_prompt:
        "Answer only from the app's own documents and data. If the answer is not grounded there, say so plainly instead of guessing. Keep replies short and professional.",
      eval_criteria: ["responds helpfully to a greeting", "identifies itself by name"],
      config: { retention: clar["req-005"] ?? clar["req-004"] ?? "90 days" },
    },
  ],
});
simulateCost(0.6, 12000, 1500);
