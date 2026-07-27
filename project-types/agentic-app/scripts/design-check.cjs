// Design options must be genuinely comparable: 3-4 options, identical screen
// coverage, every referenced file exists, and every option is a BUILDABLE
// application shell — the chosen one ships verbatim as the app's frontend.
const fs = require("node:fs");
const path = require("node:path");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const { options } = inputs.designs.data;
const designsDir = inputs.designs_dir.path;

if (options.length < 3 || options.length > 4) {
  console.error(`expected 3-4 design options, got ${options.length}`);
  process.exit(1);
}

// Pass 1: comparability — every option must cover the same screens.
const reference = JSON.stringify([...options[0].screens].sort());
for (const option of options) {
  if (JSON.stringify([...option.screens].sort()) !== reference) {
    console.error(`option '${option.id}' covers different screens — options are not comparable`);
    process.exit(1);
  }
}

// Pass 2: buildability — files exist and canonical mount points are present,
// so scaffold can ship the chosen option as the real frontend.
for (const option of options) {
  for (const key of ["tokens_file", "preview_file"]) {
    const abs = path.join(designsDir, option[key].replace(/^designs\//, ""));
    if (!fs.existsSync(abs)) {
      console.error(`option '${option.id}' references missing file: ${option[key]}`);
      process.exit(1);
    }
  }
  const html = fs.readFileSync(path.join(designsDir, option.preview_file.replace(/^designs\//, "")), "utf8");
  for (const id of ["agent-mode", "screen-chat", "messages", "composer", "input"]) {
    if (!html.includes('id="' + id + '"')) {
      console.error(`option '${option.id}' is not a buildable shell: missing id="${id}"`);
      process.exit(1);
    }
  }
  for (const screen of option.screens) {
    if (!html.includes('id="screen-' + screen + '"')) {
      console.error(`option '${option.id}' missing container for declared screen '${screen}' (id="screen-${screen}")`);
      process.exit(1);
    }
  }
}
console.log(`${options.length} comparable, buildable design options verified`);
