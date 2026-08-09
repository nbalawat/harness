// The self-healing audit's exit criterion: read the audit the agent just wrote
// in THIS attempt dir (./audit.json) and fail if any high finding is still
// unresolved and unwaived. This is what turns slice-audit into a loop — the
// agent audits, FIXES the highs in ./app, re-audits, and only commits once this
// passes; a residual high comes back as feedback and the node retries
// (envelope.ts), escalating until it converges or a named human waiver clears
// a genuinely-accepted finding. Mirrors audit-check.cjs, but on the local file.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

// INDEPENDENT CROSS-CHECK (generator/verifier split): the audit's "0 high" is
// the AGENT's own verdict — self-verification produces confident-wrong results
// on repeat. Require an ORTHOGONAL, deterministic scan to AGREE before we accept
// convergence. If the regex authz/security scan finds a high on the healed app
// that the audit "cleared", the audit did not actually converge — fail the loop
// so it fixes the real defect. (In a clean run the scan finds nothing and this
// is a no-op — determinism preserved.)
const projectDir = process.env.HARNESS_PROJECT_DIR;
if (projectDir && fs.existsSync(path.resolve("app"))) {
  const scan = spawnSync("node", [path.join(projectDir, "scripts", "security-scan.cjs")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  if (scan.status !== 0) {
    console.error(
      "self-healing audit: the audit reported 0 high, but the INDEPENDENT security scan disagrees — " +
        "a real authz/security defect remains. Convergence is not self-asserted; fix it in ./app and re-audit:",
    );
    process.stderr.write((scan.stdout || "") + (scan.stderr || ""));
    process.exit(1);
  }
}

console.log(`self-healing audit converged: ${highs.length} high finding(s), all resolved or waived; ${(audit.findings || []).length} total findings recorded (independent scan agrees).`);
