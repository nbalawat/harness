// The remediation gate's exit criteria: the SAME deterministic checks the
// remediation agent drove, re-run against its healed ./app to ADMIT the work.
// This is what makes remediation self-healing rather than advisory — the agent
// only commits once these pass; a still-dead control or unauthenticated
// mutation comes back as feedback and the node retries (envelope.ts). Runs the
// exact standalone gate scripts so a verdict here is identical to the gate's.
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const projectDir = process.env.HARNESS_PROJECT_DIR;
if (!fs.existsSync(path.resolve("app"))) {
  console.error("remediation gate: ./app is missing — the remediation step must output the hardened app here");
  process.exit(1);
}

// Each gate script resolves ./app itself (security-scan prefers a local ./app;
// check-ui-interactivity uses path.resolve("app")). Run them in THIS cwd so
// they see the healed copy, streaming their output through for the feedback log.
function gate(label, script) {
  const res = spawnSync("node", [path.join(projectDir, "scripts", script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  process.stdout.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
  if (res.status !== 0) {
    console.error(`remediation gate FAILED at: ${label} — fix the finding(s) above in ./app and re-run.`);
    return false;
  }
  console.log(`remediation gate OK: ${label}`);
  return true;
}

// Security first (static, cheap), then usability (boots + drives the app;
// self-skips in mock so certification stays deterministic).
const okSecurity = gate("security scan (no unauthenticated mutation, no unsafe code)", "security-scan.cjs");
const okUsability = gate("usability drive (no dead controls; identity-gated apps are operable)", "check-ui-interactivity.cjs");

if (!okSecurity || !okUsability) process.exit(1);
console.log("remediation verified: the merged app is secure and usable");
