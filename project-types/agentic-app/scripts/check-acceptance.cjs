// BUILD-TO-GREEN: the builder runs THIS to self-check against the EXACT
// acceptance checks the verifier will grade. It boots the app the same way
// verify-slice does, runs every acceptance check for slices 1..N, and prints
// pass/fail per check — exit 0 only when ALL are green. Run it and iterate to
// green BEFORE finishing; then verify-slice runs the identical checks and you
// pass on the first attempt (no boot-and-verify retry, no model escalation).
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { detach, killTree } = require("./_proc.cjs");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const sliceIndex = inputs._params.data.slice;
const parallel = inputs._params.data.parallel === true;
const plan = inputs.slice_plan.data.slices;
const slices = parallel ? [plan[0], plan[sliceIndex - 1]] : plan.slice(0, sliceIndex);
const app = path.resolve("app");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    probe.on("error", reject);
  });
}

(async () => {
  const port = await freePort();
  const log = fs.openSync("check-acceptance.log", "w");
  const child = spawn(
    `uv run --with fastapi --with uvicorn --with-requirements requirements.txt uvicorn dev:app --host 127.0.0.1 --port ${port}`,
    { shell: true, detached: detach, cwd: path.join(app, "backend"), stdio: ["ignore", log, log] },
  );
  const stop = () => killTree(child);
  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { up = true; break; } } catch { /* booting */ }
  }
  if (!up) {
    stop();
    console.error("✗ app did not boot — fix imports/startup first:\n" + fs.readFileSync("check-acceptance.log", "utf8").slice(-1200));
    process.exit(1);
  }
  let pass = 0, failed = 0;
  for (const slice of slices) {
    for (const c of slice.acceptance || []) {
      const problems = [];
      try {
        const res = await fetch(`http://127.0.0.1:${port}${c.path}`, {
          method: c.method,
          headers: c.body ? { "Content-Type": "application/json" } : undefined,
          body: c.body ? JSON.stringify(c.body) : undefined,
        });
        const text = await res.text();
        const wanted = c.expect_status ?? 200;
        if (res.status !== wanted) problems.push(`status ${res.status} != ${wanted}`);
        for (const needle of c.expect_contains ?? []) {
          if (!text.toLowerCase().includes(needle.toLowerCase())) problems.push(`response missing "${needle}"`);
        }
        if (problems.length && text) problems.push(`| body: ${text.slice(0, 160)}`);
      } catch (e) { problems.push(e.message); }
      if (problems.length) { failed++; console.log(`✗ [${slice.id}] ${c.method} ${c.path} — ${problems.join("; ")}`); }
      else { pass++; console.log(`✓ [${slice.id}] ${c.method} ${c.path}`); }
    }
  }
  stop();
  console.log(`\n${pass} passed, ${failed} failed — ${failed ? "NOT GREEN YET (fix and re-run before finishing)" : "ALL GREEN ✓ (safe to finish — verify-slice runs these exact checks)"}`);
  process.exit(failed ? 1 : 0);
})();
