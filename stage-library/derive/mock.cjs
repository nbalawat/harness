// Deterministic stand-in for certification replay: derives output purely from inputs.
const fs = require("node:fs");
const crypto = require("node:crypto");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
// Seed from input CONTENT only — paths differ per workspace and would break
// certification's byte-determinism.
const content = Object.entries(inputs).sort().map(([k, a]) => k + ":" + JSON.stringify(a.data ?? null));
const seed = crypto.createHash("sha256").update(content.join("|")).digest("hex").slice(0, 12);
fs.writeFileSync("{{output}}", `# {{id}} (deterministic mock)\n\nInstruction: {{instruction}}\n\nDerived from inputs ${seed}.\n`);
