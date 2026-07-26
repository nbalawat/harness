// Deterministic security gate: zero LLM cost, runs identically on every
// machine. External scanners (semgrep/gitleaks/trivy) bolt on as extra rules.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const appDir = inputs.app.path;

const RULES = [
  { rule: "hardcoded-secret", severity: "high", ext: null, pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9+\/_-]{12,}["']/i },
  { rule: "dynamic-eval", severity: "high", ext: [".py", ".js"], pattern: /\beval\s*\(|\bexec\s*\(/ },
  { rule: "inner-html", severity: "medium", ext: [".js", ".html"], pattern: /\.innerHTML\s*=/ },
  { rule: "insecure-http", severity: "low", ext: null, pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/ },
];

const findings = [];
let filesScanned = 0;

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(p);
      continue;
    }
    const ext = path.extname(entry.name);
    if (![".py", ".js", ".html", ".css", ".yml", ".yaml", ".json", ".md", ".txt", ".example"].includes(ext)) continue;
    filesScanned++;
    const content = fs.readFileSync(p, "utf8");
    for (const r of RULES) {
      if (r.ext && !r.ext.includes(ext)) continue;
      const match = content.match(r.pattern);
      if (match) {
        findings.push({
          severity: r.severity,
          rule: r.rule,
          file: path.relative(appDir, p),
          detail: String(match[0]).slice(0, 80),
        });
      }
    }
  }
}
scan(appDir);

const high = findings.filter((f) => f.severity === "high");
fs.writeFileSync(
  "security_report.json",
  JSON.stringify({ files_scanned: filesScanned, findings, high_count: high.length }, null, 2),
);
if (high.length > 0) {
  console.error(`security scan BLOCKED: ${high.length} high-severity finding(s)`);
  for (const f of high) console.error(`  [${f.rule}] ${f.file}: ${f.detail}`);
  process.exit(1);
}
console.log(`security scan passed: ${filesScanned} files, ${findings.length} non-blocking finding(s)`);
