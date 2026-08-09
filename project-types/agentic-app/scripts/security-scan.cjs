// Deterministic security gate: zero LLM cost, runs identically on every
// machine. External scanners (semgrep/gitleaks/trivy) bolt on as extra rules.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
// Prefer a healed local ./app (the remediation flow scans its own copy); fall
// back to the committed dependency app for any standalone use.
const appDir = fs.existsSync(path.resolve("app")) ? path.resolve("app") : inputs.app.path;

const RULES = [
  { rule: "hardcoded-secret", severity: "high", ext: null, pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9+\/_-]{12,}["']/i },
  // Python: eval()/exec() are dynamic code execution. JS: RegExp.prototype.exec()
  // is safe — only bare eval() and new Function() are dangerous.
  { rule: "dynamic-eval-py", severity: "high", ext: [".py"], pattern: /\b(?:eval|exec)\s*\(/ },
  { rule: "dynamic-eval-js", severity: "high", ext: [".js", ".html"], pattern: /(?<![.\w])eval\s*\(|new\s+Function\s*\(/ },
  // Fail-open identity: resolving a caller then FABRICATING a persona/role when
  // not found (`identity.find(email) or {"role": "Compliance Officer"}`) hands
  // authority to anyone. Authorization must fail CLOSED — use require_actor/
  // require_role, never a `... or {…role…}` fallback.
  { rule: "fail-open-identity", severity: "high", ext: [".py"], pattern: /\.find\([^)]*\)\s*or\s*\{[^}]{0,200}["']role["']/ },
  // Defaulted decision: a terminal decision/verdict that DEFAULTS to a positive
  // outcome when a field is missing (`inputs.get("decision", "approved")`) lets
  // a malformed request auto-approve. A decision must be explicit, never
  // defaulted — especially never to approve/pass/accept.
  { rule: "defaulted-decision", severity: "high", ext: [".py"], pattern: /\.get\(\s*["'](?:decision|verdict|disposition|outcome|adjudication|determination)["']\s*,\s*["'](?:approv|pass|accept|clear|grant|success|ok\b|yes\b|pai?d)/i },
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

// RBAC backstop (deterministic, no LLM): the class of hole behind the
// /api/{table} audit finding. A MUTATING route whose handler carries no
// identity token at all is either a bug or needs an explicit
// `# public-endpoint: <reason>` marker on its decorator line.
const IDENTITY = /acting_user_email|require_role|ensure_role|current_user|Depends\s*\(|ext_auth\.|resolve_user|x-user-email|req\.(?:actor|by|author|user(?:name)?|email)\b|approved_by|started_by/;
const GUARD = /OPEN_WRITE_TABLES|status_code=40[35]|require_role|acting_user_email/;
function scanMutations(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { scanMutations(p); continue; }
    if (!entry.name.endsWith(".py")) continue;
    const content = fs.readFileSync(p, "utf8");
    const decRe = /@(?:app|router)\.(post|put|delete)\(\s*["']([^"']+)["'][^\n]*/g;
    let m;
    while ((m = decRe.exec(content)) !== null) {
      const decoratorLine = m[0];
      if (/#\s*public-endpoint:/.test(decoratorLine)) continue;
      const rest = content.slice(m.index + m[0].length);
      const next = rest.search(/\n@(?:app|router)\.|(?:\n\ndef |\n\nclass )/);
      const body = next === -1 ? rest.slice(0, 2500) : rest.slice(0, Math.min(next, 2500));
      const rel = path.relative(appDir, p);
      if (m[2] === "/api/{table}" && !GUARD.test(body)) {
        findings.push({ severity: "high", rule: "generic-table-write-unguarded", file: rel, detail: `${m[1].toUpperCase()} /api/{table} without allowlist/role guard` });
        continue;
      }
      if (!IDENTITY.test(decoratorLine + body)) {
        // Slice-authored modules (ext_*.py) are held to the hard bar; other
        // files surface as medium so legacy substrate stays visible, not fatal.
        findings.push({
          severity: /^ext_[a-z0-9_]+\.py$/.test(entry.name) ? "high" : "medium",
          rule: "unauthenticated-mutation",
          file: rel,
          detail: `${m[1].toUpperCase()} ${m[2]} handler carries no identity (add role check via acting_user_email, or an explicit '# public-endpoint: <reason>' marker)`,
        });
      }
    }
  }
}
scanMutations(appDir);

// Opt-out authorization: a guard that only runs when identity is SUPPLIED
// lets anonymous callers skip it. Deterministically greppable.
function scanOptOut(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
    const p2 = path.join(dir, entry.name);
    if (entry.isDirectory()) { scanOptOut(p2); continue; }
    if (!entry.name.endsWith(".py")) continue;
    // Strip comments AND string/docstring bodies so the rule matches real code,
    // not prose that discusses the pattern (a comment saying "never behind an
    // `if acting_user_email:`" must not self-flag). Crude but deterministic.
    const code = fs.readFileSync(p2, "utf8")
      .replace(/#[^\n]*/g, "")
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, "")
      .replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
    if (/^\s*if\s+acting_user_email\s*(?:is not None\s*)?:/m.test(code)) {
      findings.push({ severity: "medium", rule: "opt-out-authz", file: path.relative(appDir, p2), detail: "identity guard runs only when identity is supplied — anonymous callers skip it (default-deny instead)" });
    }
  }
}
scanOptOut(appDir);

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
