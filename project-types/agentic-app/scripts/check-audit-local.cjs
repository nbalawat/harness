// The self-healing audit's exit criterion: read the audit the agent just wrote
// in THIS attempt dir (./audit.json) and fail if any high finding is still
// unresolved and unwaived. This is what turns slice-audit into a loop — the
// agent audits, FIXES the highs in ./app, re-audits, and only commits once this
// passes; a residual high comes back as feedback and the node retries
// (envelope.ts), escalating until it converges or a named human waiver clears
// a genuinely-accepted finding. Mirrors audit-check.cjs, but on the local file.
const fs = require("node:fs");
const path = require("node:path");

const auditPath = path.resolve("audit.json");
if (!fs.existsSync(auditPath)) {
  console.error("self-healing audit: ./audit.json is missing — the audit step must write its findings here");
  process.exit(1);
}
const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));

// Waivers: an explicit, auditable human decision to accept a specific finding,
// keyed by "<file>:<area>" (line-independent so it survives edits).
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

if (blocking.length > 0) {
  console.error(`self-healing audit: ${blocking.length} high finding(s) still unresolved — FIX them in ./app and re-audit (do not stop with an open high):`);
  for (const f of blocking.slice(0, 20)) {
    console.error(`  [${f.area}] ${f.file}${f.line ? ":" + f.line : ""} — ${String(f.finding).slice(0, 160)}`);
  }
  console.error("\nFix each in ./app, then rewrite ./audit.json from a fresh re-audit. Only a genuinely-accepted finding may be left, and only with a named waiver in <workspace>/audit-waivers.json.");
  process.exit(1);
}
console.log(`self-healing audit converged: ${highs.length} high finding(s), all resolved or waived; ${(audit.findings || []).length} total findings recorded for governance.`);
