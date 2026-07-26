// Deterministic node: renders README.md from the committed plan artifact.
const fs = require("node:fs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const plan = inputs.plan.data;

const body = [
  `# ${plan.title}`,
  "",
  ...plan.sections.map((s) => `- ${s}`),
  "",
  "_Generated deterministically by the harness demo pipeline._",
].join("\n");

fs.writeFileSync("README.md", body);
