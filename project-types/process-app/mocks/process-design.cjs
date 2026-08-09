const fs = require("node:fs");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const name = (inputs.intake.data.process_name || "Business Process").trim();
const kebab = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// A faithful enterprise process. The assessment is a DETERMINISTIC step that
// invokes an AGENT ORCHESTRATION — specialist agents (using enterprise MCP
// tools) plus a synthesizer — the two-level orchestration model.
const wf = { workflows: [{
  name: kebab,
  description: `${name}: triggered from multiple sources; a deterministic step orchestrates specialist AI agents (using enterprise systems via MCP) to assess the case; a deterministic score; a human approval; activation across systems.`,
  triggers: [
    { kind: "human.internal", label: "Ops team starts it" },
    { kind: "human.external", label: "Applicant submits via portal" },
    { kind: "event", label: "Event from the source system" },
    { kind: "schedule", label: "Nightly batch of pending items" },
  ],
  nodes: [
    { id: "intake", kind: "deterministic", handler: "intake", label: "Intake & enrich (CRM)", deps: [], integration: "crm.lookup", output_schema: { required: ["name", "ok"] } },
    { id: "assess", kind: "deterministic", handler: "assess", label: "AI assessment (agent orchestration)", deps: ["intake"],
      output_schema: { required: ["recommendation"] },
      orchestration: {
        name: "case-assessment",
        agents: [
          { role: "operational risk", prompt: "You are a risk analyst. In 1-2 sentences give the single most important operational risk for \"${intake.name}\". Detail: ${intake.details}.", tools: ["crm.lookup"] },
          { role: "compliance", prompt: "You are a compliance officer. In 1-2 sentences flag any compliance/sanctions/reputational concern for \"${intake.name}\", or state none is apparent. Detail: ${intake.details}." },
          { role: "credit", prompt: "You are a credit analyst. In 1-2 sentences give a creditworthiness read on \"${intake.name}\" for standard terms.", tools: ["erp.credit_check"] },
        ],
        synthesis: { prompt: "Synthesize the specialists into a single 2-3 sentence recommendation for \"${intake.name}\", stating approve/hold and why." },
      } },
    { id: "score", kind: "deterministic", handler: "score", label: "Risk score", deps: ["assess"], output_schema: { required: ["score", "band"] } },
    { id: "approve", kind: "human", label: "Manager approval", deps: ["score"], question: "Approve \"${intake.name}\"? Score ${score.score}/100 (${score.band}).\n\nAI recommendation: ${assess.recommendation}" },
    { id: "activate", kind: "deterministic", handler: "activate", label: "Activate (ticketing + email)", deps: ["approve"], integration: "ticketing.create", output_schema: { required: ["activated"] } },
  ],
}]};
fs.writeFileSync("workflows.json", JSON.stringify(wf, null, 2));
fs.writeFileSync("cost.json", JSON.stringify({ costUsd: 0.9, inputTokens: 12000, outputTokens: 3200, model: "mock" }));
console.log(`designed process '${kebab}': ${wf.workflows[0].nodes.length} steps incl. an agent orchestration, ${wf.workflows[0].triggers.length} triggers`);
