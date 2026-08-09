const { inputs, writeJson, simulateCost, copyApp, fs, path } = require("./_lib.cjs");

// The mock self-healing audit: the certified scaffold + slice mocks already
// produce a clean app, so there is nothing to heal — it copies the app forward
// untouched and reports clean. (Live builds audit, FIX every high, and re-audit
// to convergence; the mock replays that already-converged state deterministically.)
copyApp(inputs().app.path);
let files = 0;
const rec = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === "__pycache__") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) rec(p);
    else files++;
  }
};
rec("app");

writeJson("audit.json", {
  status: "clean",
  findings: [],
  resolved: [],
  checked: { files, axes: ["contracts", "fsi-hardening"] },
});
simulateCost(0.6, 40000, 3000);
