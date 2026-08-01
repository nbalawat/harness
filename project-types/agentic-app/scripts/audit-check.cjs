// The audit is not advisory. HIGH findings from the merged-app code audit
// BLOCK the build — the same bar as the deterministic security scan — because
// a semantic authorization/human-gate/financial-integrity defect is exactly
// what a regex scan cannot catch (it is why an "all green" build once shipped
// a borrower-identity leak). A high finding is cleared one of two ways: fix it
// (revise the owning slice), or a NAMED human waives it with a rationale in
// audit-waivers.json — never by ignoring it.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const audit = inputs.audit.data;

// Waivers: an explicit, auditable human decision to accept a specific finding.
// Keyed by "<file>:<area>" (line-independent so a waiver survives edits).
const wsWaivers = path.join(process.env.HARNESS_WORKSPACE || ".", "audit-waivers.json");
let waivers = [];
try {
  waivers = JSON.parse(fs.readFileSync(wsWaivers, "utf8")).waivers || [];
} catch {
  /* none */
}
const waived = (f) => waivers.some((w) => w.file === f.file && w.area === f.area && w.rationale);

const highs = (audit.findings || []).filter((f) => f.severity === "high");
const blocking = highs.filter((f) => !waived(f));
const waivedCount = highs.length - blocking.length;

fs.writeFileSync(
  "audit_gate.json",
  JSON.stringify(
    {
      status: blocking.length === 0 ? "pass" : "blocked",
      high_total: highs.length,
      high_blocking: blocking.length,
      high_waived: waivedCount,
      medium: (audit.findings || []).filter((f) => f.severity === "medium").length,
      low: (audit.findings || []).filter((f) => f.severity === "low").length,
    },
    null,
    2,
  ),
);

if (blocking.length > 0) {
  console.error(`audit gate BLOCKED: ${blocking.length} unwaived high-severity finding(s) in the merged app`);
  for (const f of blocking.slice(0, 20)) {
    console.error(`  [${f.area}] ${f.file}${f.line ? ":" + f.line : ""} — ${String(f.finding).slice(0, 140)}`);
  }
  console.error(
    "\nClear each one: fix it (revise the owning slice), or record a named human waiver with rationale in " +
      "<workspace>/audit-waivers.json (\"waivers\": [{\"file\":\"...\",\"area\":\"...\",\"rationale\":\"...\",\"by\":\"...\"}]). " +
      "A semantic security finding never ships silently.",
  );
  process.exit(1);
}
console.log(
  `audit gate passed: ${highs.length} high finding(s), all cleared (${waivedCount} waived); ` +
    `${(audit.findings || []).length} total findings recorded for governance.`,
);
