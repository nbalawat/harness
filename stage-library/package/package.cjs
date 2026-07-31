const fs = require("node:fs");
const path = require("node:path");
const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
fs.mkdirSync("out", { recursive: true });
for (const [name, a] of Object.entries(inputs)) {
  if (a.path && fs.existsSync(a.path) && fs.statSync(a.path).isFile()) {
    fs.copyFileSync(a.path, path.join("out", path.basename(a.path)));
  }
}
fs.writeFileSync("out/MANIFEST.json", JSON.stringify({ packaged: Object.keys(inputs).sort() }, null, 2));
console.log("packaged " + Object.keys(inputs).length + " input artifact(s)");
