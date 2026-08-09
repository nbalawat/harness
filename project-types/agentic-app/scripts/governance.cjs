// Governance evidence pack: controls -> proof, generated not written.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const security = inputs.security_report.data;
const integration = inputs.integration_report.data;
const roster = inputs.agent_roster.data;
// rtm is absent on pre-0.2.0 runs still in flight — tolerate it.
const rtm = inputs.rtm?.data ?? null;
// audit is absent on pre-0.12.0 runs — tolerate it.
const audit = inputs.audit?.data ?? null;
// Functional validation via a real headless browser (Playwright): design-coverage
// proves every approved screen renders live; the interactivity drive proves every
// self-acting control does real work (0 dead controls). Absent on older runs.
const coverage = inputs.design_coverage?.data ?? null;
const ui = inputs.ui_interactivity?.data ?? null;

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
      requirements: rtm
        ? {
            total: rtm.requirements_total,
            covered: rtm.covered_count,
            uncovered: rtm.uncovered.length,
            assumptions: rtm.assumptions.length,
            evidence: "rtm.json",
          }
        : { total: 0, covered: 0, uncovered: 0, assumptions: 0, evidence: "n/a (pre-0.2.0 run)" },
      agents: {
        count: roster.agents.length,
        names: roster.agents.map((a) => a.name),
        eval_criteria_total: roster.agents.reduce((n, a) => n + a.eval_criteria.length, 0),
      },
      code_audit: audit
        ? {
            status: audit.status,
            findings: audit.findings.length,
            high_findings: audit.findings.filter((f) => f.severity === "high").length,
            files_checked: audit.checked.files,
            // Convergence QUALITY, not just a pass: how many findings the
            // self-healing audit FIXED vs left for a named waiver. A gate that
            // "converges" only by waiving is a plateau in disguise — surfacing
            // fixed-vs-waived keeps "fix by default, waive by exception" honest.
            convergence: {
              fixed: Array.isArray(audit.resolved) ? audit.resolved.length : 0,
              remaining_high: audit.findings.filter((f) => f.severity === "high").length,
              converged_by: Array.isArray(audit.resolved) && audit.resolved.length > 0 ? "self-healing-fix" : "clean-first-pass",
            },
            evidence: "audit.json",
          }
        : null,
      // Functional validation: a real browser drove the finished app.
      functional_validation:
        coverage || ui
          ? {
              method: "headless-browser (playwright)",
              screens_promised: coverage?.totals?.screens ?? null,
              screens_proven_live: coverage?.totals?.screens_present ?? (coverage ? (coverage.screens ?? []).filter((s) => s.present === true).length : null),
              controls_driven: ui ? ui.controlsProbed ?? null : null,
              dead_controls: ui ? (ui.deadControls ?? []).length : null,
              unreachable_screens: ui ? (ui.unnavigable ?? []).length : null,
              usable: ui ? ui.ok === true : null,
              evidence: ["design_coverage.json", "ui_interactivity.json"],
            }
          : null,
    },
    null,
    2,
  ),
);
console.log("governance evidence pack generated");
