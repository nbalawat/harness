const { inputs, writeJson, simulateCost, copyApp, fs, path } = require("./_lib.cjs");
const { spawnSync } = require("node:child_process");

// The mock remediation: the certified scaffold + slice mocks already produce a
// secure, usable app, so there is nothing to heal — this replays that clean
// path deterministically. It copies the merged app forward untouched and runs
// the same gate scripts the live verify runs (security is real on the stub;
// usability self-skips in mock), so certification exercises the real gates.
copyApp(inputs().app.path);

const projectDir = process.env.HARNESS_PROJECT_DIR;
for (const script of ["security-scan.cjs", "check-ui-interactivity.cjs"]) {
  const res = spawnSync("node", [path.join(projectDir, "scripts", script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  if (res.status !== 0) {
    // A failure here means the certified stub app itself is not clean — surface
    // it loudly rather than masking a broken substrate behind the mock.
    process.stderr.write((res.stdout || "") + (res.stderr || ""));
    throw new Error(`mock remediation: gate ${script} failed on the certified stub app`);
  }
}
// Belt-and-braces: ensure both reports exist even if a script's contract changes.
if (!fs.existsSync("security_report.json")) writeJson("security_report.json", { files_scanned: 0, findings: [], high_count: 0 });
if (!fs.existsSync("ui_interactivity.json")) writeJson("ui_interactivity.json", { mode: "mock", skipped: true, ok: true });

writeJson("remediation.json", { step: "remediate", healed: false, security_fixes: [], usability_fixes: [], hardening_fixes: [], lessons: [] });
simulateCost(0.5, 40000, 3000);
