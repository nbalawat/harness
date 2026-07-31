const fs = require("node:fs");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const src = Object.values(inputs).find((a) => a.path && a.path.endsWith("{{file}}"));
if (!src) { console.error("upstream artifact {{file}} not found"); process.exit(1); }
const text = fs.readFileSync(src.path, "utf8");
if (!text.includes("{{require}}")) { console.error(`{{file}} missing required content '{{require}}'`); process.exit(1); }
console.log("{{file}} verified");
