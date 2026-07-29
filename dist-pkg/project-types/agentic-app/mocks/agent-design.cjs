const { inputs, writeJson, simulateCost } = require("./_lib.cjs");

const appName = "assistant";
const { clarifications, requirements } = inputs();
const clar = clarifications.data;
const agentReqs = requirements.data.requirements
  .filter((r) => r.category === "agent" && r.confidence !== "unknown")
  .map((r) => r.id);
const workflows = inputs().workflows ? inputs().workflows.data.workflows : [];
const opportunity_map = [];
for (const wf of workflows) {
  for (const node of wf.nodes) {
    if (node.kind === "agent") {
      opportunity_map.push({ slot: `${wf.name}/${node.id}`, source: node.id, decision: "included", rationale: "Advisory drafting step the workflow declares — grounded, cited, human-approved downstream.", agent: appName });
    } else if (node.kind === "deterministic") {
      opportunity_map.push({ slot: `${wf.name}/${node.id}`, source: node.id, decision: "excluded", rationale: "Requirements mandate this step be mechanical; no agent judgment may enter it." });
    } else if (node.kind === "human") {
      opportunity_map.push({ slot: `${wf.name}/${node.id}`, source: node.id, decision: "excluded", rationale: "Decision authority is human by policy; automation of approval is prohibited." });
    }
  }
}
opportunity_map.push({ slot: "chat-surface", source: agentReqs, decision: "included", rationale: "The chat screen's grounded Q&A is served by the roster agent.", agent: appName });

writeJson("agent_roster.json", {
  opportunity_map,
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
