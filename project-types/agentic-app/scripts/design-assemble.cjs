// Collects the three CONCURRENTLY built design options into one comparable
// set: copies each option's tree into designs/ and builds designs.json from
// the option.json metadata each option node wrote. Deterministic — pure file
// assembly, no model. design-check then verifies comparability/buildability.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));

// Fresh output every attempt (retry continuity + cpSync overlay would keep stale files).
fs.rmSync("designs", { recursive: true, force: true });

const options = [];
for (let i = 1; i <= 3; i++) {
  const input = inputs[`option_${i}_dir`];
  if (!input) {
    console.error(`design option ${i} missing from inputs — all three concurrent option nodes must commit`);
    process.exit(1);
  }
  const src = path.join(input.path, `option-${i}`);
  if (!fs.existsSync(path.join(src, "index.html"))) {
    console.error(`design option ${i} incomplete: ${src}/index.html missing`);
    process.exit(1);
  }
  const metaFile = path.join(src, "option.json");
  if (!fs.existsSync(metaFile)) {
    console.error(`design option ${i} incomplete: option.json metadata missing`);
    process.exit(1);
  }
  fs.cpSync(src, `designs/option-${i}`, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  options.push({
    id: `option-${i}`,
    name: meta.name,
    screens: meta.screens,
    addresses: meta.addresses ?? [],
    tokens_file: `designs/option-${i}/tokens.css`,
    preview_file: `designs/option-${i}/index.html`,
  });
}

fs.writeFileSync("designs.json", JSON.stringify({ options }, null, 2));
console.log(`assembled ${options.length} design options: ${options.map((o) => `${o.id} (${o.name})`).join(", ")}`);
