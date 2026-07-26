// Deterministic scaffold: base templates + certified module composition +
// approved design tokens. Zero LLM calls — this is the compose-ratio at work.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const projectDir = process.env.HARNESS_PROJECT_DIR;
const repoRoot = path.resolve(projectDir, "..", "..");

const architecture = inputs.architecture.data;
const appName = inputs.intake.data.project_name;

// 1. Base skeleton (includes the test harness — tests exist before any agent builds).
fs.cpSync(path.join(projectDir, "templates", "base"), "app", { recursive: true });

// 2. Compose certified modules: overlay each module's compose/ tree.
for (const moduleName of architecture.modules) {
  const overlay = path.join(repoRoot, "modules", moduleName, "compose");
  if (!fs.existsSync(overlay)) {
    console.error(`unknown module in bill of materials: ${moduleName}`);
    process.exit(1);
  }
  fs.cpSync(overlay, "app", { recursive: true });
}
fs.writeFileSync(
  "app/composed_modules.json",
  JSON.stringify({ modules: architecture.modules }, null, 2),
);

// 3. Apply the approved design option's tokens.
const chosen = inputs.design_choice.data.chosen_option;
const option = inputs.designs.data.options.find((o) => o.id === chosen);
if (!option) {
  console.error(`design choice '${chosen}' is not one of the generated options`);
  process.exit(1);
}
const tokensAbs = path.join(inputs.designs_dir.path, option.tokens_file.replace(/^designs\//, ""));
fs.copyFileSync(tokensAbs, "app/frontend/tokens.css");

// 4. Brand backend + README (frontend branding happens in build-frontend).
for (const rel of ["backend/main.py", "README.md"]) {
  const file = path.join("app", rel);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("__APP_NAME__", appName));
}

console.log(`scaffolded '${appName}' with modules: ${architecture.modules.join(", ")}`);
