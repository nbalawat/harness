const fs = require("node:fs");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const src = Object.values(inputs).find((a) => a.path && a.path.endsWith("summary.md"));
if (!src) { console.error("upstream artifact summary.md not found"); process.exit(1); }
const text = fs.readFileSync(src.path, "utf8");
if (!text.includes("Summary")) { console.error(`summary.md missing required content 'Summary'`); process.exit(1); }
console.log("summary.md verified");
