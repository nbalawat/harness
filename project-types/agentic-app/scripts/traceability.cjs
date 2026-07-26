// Requirements Traceability Matrix (RTM): the join of requirements against
// every design artifact's `addresses` declarations. This is how collected
// requirements FLOW into later stages — and the design-review gate is where
// the user confirms the mapping before any build spend.
// Deterministic; exits 1 if any stated/inferred requirement is unaddressed.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const requirements = inputs.requirements.data.requirements;
const architecture = inputs.architecture.data;
const dataModel = inputs.data_model.data;
const roster = inputs.agent_roster.data;
const designs = inputs.designs.data;
const gaps = inputs.gaps.data;
const clarifications = inputs.clarifications.data;

// Some requirement categories are satisfied by pipeline stages, not app design.
const PIPELINE_COVERAGE = {
  security: "security-scan (pipeline stage) + composed security policy",
  ops: "integrate + deploy (pipeline stages)",
};

const addressedBy = {}; // reqId -> [{via, item}]
function cover(reqId, via, item) {
  (addressedBy[reqId] ??= []).push({ via, item });
}

for (const entry of architecture.module_coverage ?? []) {
  for (const reqId of entry.addresses) cover(reqId, "module", entry.module);
}
for (const table of dataModel.tables) {
  for (const reqId of table.addresses ?? []) cover(reqId, "table", table.name);
}
for (const agent of roster.agents) {
  for (const reqId of agent.addresses ?? []) cover(reqId, "agent", agent.name);
}
for (const option of designs.options) {
  for (const reqId of option.addresses ?? []) cover(reqId, "design", option.id);
}

const coverage = [];
const uncovered = [];
for (const req of requirements) {
  if (req.confidence === "unknown") continue; // became a clarify question instead
  let entries = addressedBy[req.id] ?? [];
  if (entries.length === 0 && PIPELINE_COVERAGE[req.category]) {
    entries = [{ via: "pipeline", item: PIPELINE_COVERAGE[req.category] }];
  }
  if (entries.length === 0) uncovered.push(req.id);
  coverage.push({ id: req.id, text: req.text, category: req.category, confidence: req.confidence, addressed_by: entries });
}

// Assumptions the user is confirming: defaulted answers + inferred requirements.
const assumptions = (gaps.questions ?? []).map((q) => ({
  question: q.prompt,
  answer: clarifications[q.id],
  source: clarifications[q.id] === q.default ? "default" : "user",
  why: q.why,
}));
for (const req of requirements.filter((r) => r.confidence === "inferred")) {
  assumptions.push({ question: `Inferred requirement: ${req.text}`, answer: "assumed true", source: "inferred", why: req.id });
}

fs.writeFileSync(
  "rtm.json",
  JSON.stringify(
    {
      requirements_total: coverage.length,
      covered_count: coverage.length - uncovered.length,
      uncovered,
      coverage,
      assumptions,
    },
    null,
    2,
  ),
);

if (uncovered.length > 0) {
  console.error(`TRACEABILITY GAP: ${uncovered.length} requirement(s) not addressed by any design element: ${uncovered.join(", ")}`);
  process.exit(1);
}
console.log(`traceability: ${coverage.length}/${coverage.length} requirements addressed; ${assumptions.length} assumption(s) surfaced for confirmation`);
