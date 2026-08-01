const { inputs, writeJson, simulateCost, fs, path } = require("./_lib.cjs");

// The mock audit walks the real merged tree (deterministic file count) and
// reports clean — the certified conventions are what the scaffold + mocks
// produce, so a finding here would indicate a broken merge.
const appDir = inputs().app.path;
let files = 0;
const rec = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === "__pycache__") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) rec(p);
    else files++;
  }
};
rec(appDir);

writeJson("audit.json", {
  status: "clean",
  findings: [],
  checked: { files, axes: ["contracts", "fsi-hardening"] },
});
simulateCost(0.4, 30000, 2500);
