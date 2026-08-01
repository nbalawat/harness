const fs = require("node:fs");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const name = (inputs.intake.data.process_name || "Business Process").trim();
const kebab = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// A faithful enterprise process: triggers, a dependency graph with parallel AI
// steps, deterministic steps that call STUBBED enterprise systems (crm/erp/
// ticketing/email), a human decision, and recording. This is the shape a live
// process-design agent produces from the description.
const wf = { workflows: [{
  name: kebab,
  description: `${name}: triggered from multiple sources, AI assessments run in parallel with enterprise-system context, a deterministic score, a human approval, then activation across systems.`,
  triggers: [
    { kind: "human.internal", label: "Ops team starts onboarding" },
    { kind: "human.external", label: "Vendor submits application via portal" },
    { kind: "event", label: "New-vendor event from the procurement system" },
    { kind: "schedule", label: "Nightly batch of pending applications" },
  ],
  nodes: [
    { id: "intake", kind: "deterministic", handler: "intake", label: "Intake & enrich (CRM)", deps: [], integration: "crm.lookup", output_schema: { required: ["name", "ok"] } },
    { id: "risk", kind: "agent", label: "Operational risk (AI)", deps: ["intake"], prompt: "You are a vendor risk analyst. In 1-2 sentences give the single most important operational risk for \"${intake.name}\". Account context: tier ${intake.tier}, since ${intake.since}. Requester detail: ${intake.details}." },
    { id: "compliance", kind: "agent", label: "Compliance screen (AI)", deps: ["intake"], prompt: "You are a compliance officer. In 1-2 sentences, flag any compliance/sanctions/reputational concern for \"${intake.name}\", or state clearly none is apparent. Context: ${intake.details}." },
    { id: "credit", kind: "deterministic", handler: "credit", label: "Credit check (ERP)", deps: ["intake"], integration: "erp.credit_check", output_schema: { required: ["rating"] } },
    { id: "score", kind: "deterministic", handler: "score", label: "Risk score", deps: ["risk", "compliance", "credit"], output_schema: { required: ["score", "band"] } },
    { id: "approve", kind: "human", label: "Manager approval", deps: ["score"], question: "Approve \"${intake.name}\"? Score ${score.score}/100 (${score.band}); ERP credit rating ${credit.rating}.\n\nRisk: ${risk.reply}\nCompliance: ${compliance.reply}" },
    { id: "activate", kind: "deterministic", handler: "activate", label: "Activate (ticketing + email)", deps: ["approve"], integration: "ticketing.create", output_schema: { required: ["activated"] } },
  ],
}]};
fs.writeFileSync("workflows.json", JSON.stringify(wf, null, 2));
fs.writeFileSync("cost.json", JSON.stringify({ costUsd: 0.9, inputTokens: 11000, outputTokens: 3000, model: "mock" }));
console.log(`designed enterprise process '${kebab}': ${wf.workflows[0].nodes.length} steps, ${wf.workflows[0].triggers.length} triggers, integrations wired`);
