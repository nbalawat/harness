// Build-frontend's own exit criteria: JS parses, branding applied (no
// placeholder left), and the approved design tokens are present.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const app = path.resolve("app");
const frontend = path.join(app, "frontend");

for (const f of fs.readdirSync(frontend).filter((f) => f.endsWith(".js"))) {
  const check = spawnSync("node", ["--check", path.join(frontend, f)], { encoding: "utf8" });
  if (check.status !== 0) {
    console.error(`js check FAILED for ${f}\n${check.stderr}`);
    process.exit(1);
  }
}
const index = fs.readFileSync(path.join(frontend, "index.html"), "utf8");
if (index.includes("__APP_NAME__")) {
  console.error("branding incomplete: __APP_NAME__ placeholder still present in index.html");
  process.exit(1);
}
if (!fs.existsSync(path.join(frontend, "tokens.css"))) {
  console.error("approved design tokens missing: frontend/tokens.css");
  process.exit(1);
}
console.log("frontend verified: js parses, branding applied, tokens present");
