// Governance evidence pack: controls -> proof, generated not written.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const security = inputs.security_report.data;
const integration = inputs.integration_report.data;
const roster = inputs.agent_roster.data;
const rtm = inputs.rtm.data;

fs.writeFileSync(
  "governance.json",
  JSON.stringify(
    {
      standards_profile: "firm-baseline-v0",
      security: {
        high_findings: security.high_count,
        total_findings: security.findings.length,
        files_scanned: security.files_scanned,
        evidence: "security_report.json",
      },
      validation: {
        backend_tests: integration.backend_tests.status,
        agent_evals: integration.evals.status,
        compose_config: integration.compose_config,
        evidence: "integration_report.json",
      },
      requirements: {
        total: rtm.requirements_total,
        covered: rtm.covered_count,
        uncovered: rtm.uncovered.length,
        assumptions: rtm.assumptions.length,
        evidence: "rtm.json",
      },
      agents: {
        count: roster.agents.length,
        names: roster.agents.map((a) => a.name),
        eval_criteria_total: roster.agents.reduce((n, a) => n + a.eval_criteria.length, 0),
      },
    },
    null,
    2,
  ),
);
console.log("governance evidence pack generated");
