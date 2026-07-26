// Design options must be genuinely comparable: 3-4 options, identical screen
// coverage, and every referenced file actually exists.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const { options } = inputs.designs.data;
const designsDir = inputs.designs_dir.path;

if (options.length < 3 || options.length > 4) {
  console.error(`expected 3-4 design options, got ${options.length}`);
  process.exit(1);
}
const reference = JSON.stringify([...options[0].screens].sort());
for (const option of options) {
  if (JSON.stringify([...option.screens].sort()) !== reference) {
    console.error(`option '${option.id}' covers different screens — options are not comparable`);
    process.exit(1);
  }
  for (const key of ["tokens_file", "preview_file"]) {
    const abs = path.join(designsDir, option[key].replace(/^designs\//, ""));
    if (!fs.existsSync(abs)) {
      console.error(`option '${option.id}' references missing file: ${option[key]}`);
      process.exit(1);
    }
  }
}
console.log(`${options.length} comparable design options verified`);
