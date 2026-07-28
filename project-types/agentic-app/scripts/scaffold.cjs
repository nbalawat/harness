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

// 3. The approved design IS the frontend. Copy the chosen option's entire
// shell (index.html + tokens.css + any assets) over the composed frontend so
// the app the user gets is the app they chose — full layout, not just colors.
// chat-shell's app.js survives the overlay and wires behavior onto the
// design's canonical mount points (enforced upstream by design-check).
const chosen = inputs.design_choice.data.chosen_option;
const option = inputs.designs.data.options.find((o) => o.id === chosen);
if (!option) {
  console.error(`design choice '${chosen}' is not one of the generated options`);
  process.exit(1);
}
const designDir = path.join(inputs.designs_dir.path, chosen);
for (const entry of fs.readdirSync(designDir)) {
  fs.cpSync(path.join(designDir, entry), path.join("app/frontend", entry), { recursive: true });
}
// Guarantee the behavior module loads even if the design omitted the tag.
const indexPath = "app/frontend/index.html";
let indexHtml = fs.readFileSync(indexPath, "utf8");
if (!indexHtml.includes("app.js")) {
  indexHtml = indexHtml.replace("</body>", '<script src="app.js" defer></script>\n</body>');
  fs.writeFileSync(indexPath, indexHtml);
}
// Provenance: which design shipped, so every later stage (and the dashboard)
// can assert fidelity against the choice.
fs.writeFileSync(
  "app/design.json",
  JSON.stringify({ chosen_option: chosen, name: option.name, screens: option.screens, addresses: option.addresses }, null, 2),
);

// 4a. models.py is approved deterministic content (data-design artifact).
const tables = inputs.data_model.data.tables;
fs.writeFileSync(
  "app/backend/models.py",
  [
    '"""Generated from the approved data model (data_model.json). Do not hand-edit."""',
    "",
    "TABLES = {",
    ...tables.map((t) => `    "${t.name}": [${t.columns.map((c) => `"${c.name}"`).join(", ")}],`),
    "}",
    "",
  ].join("\n"),
);
fs.writeFileSync("app/SLICES.md", `# ${appName} — slices\n\n`);

// 4a-bis. Business processes: the approved workflow definitions ship with the
// app when the workflow-engine is composed — slices implement the handlers.
if (architecture.modules.includes("workflow-engine") && inputs.workflows) {
  fs.mkdirSync("app/workflows", { recursive: true });
  fs.copyFileSync(inputs.workflows.path, "app/workflows/workflows.json");
}

// 4b. Agents scaffolding — the roster is approved deterministic content
// (agent-design artifact), so it composes here; build-agents refines evals
// and glue. Every stage after scaffold is self-consistent and testable.
const roster = inputs.agent_roster.data;
fs.mkdirSync("app/agents/evals", { recursive: true });
fs.writeFileSync("app/agents/roster.json", JSON.stringify(roster, null, 2));
const firstAgent = roster.agents[0];
fs.writeFileSync(
  "app/agents/evals/cases.json",
  JSON.stringify(
    {
      cases: [
        { id: "greeting", input: "hello there", expect_contains: ["help"] },
        { id: "identity", input: "who am I talking to?", expect_contains: [firstAgent.name] },
      ],
    },
    null,
    2,
  ),
);

// 5. Brand everything user-visible — the walking skeleton is fully branded.
for (const rel of ["backend/main.py", "README.md", "frontend/index.html"]) {
  const file = path.join("app", rel);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("__APP_NAME__", appName));
}

console.log(`scaffolded '${appName}' with modules: ${architecture.modules.join(", ")}`);
