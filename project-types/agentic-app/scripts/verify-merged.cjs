// The merged app's exit criteria: EVERY slice's acceptance re-proven against
// one running app (parallel slices verified only foundation + self in their
// own trees — this is where the union is shown to work as a whole), then the
// full backend test suite. Rewrites acceptance_report.json for the final app.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const slices = inputs.slice_plan.data.slices;
const app = path.resolve("app");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
    probe.on("error", reject);
  });
}

async function main() {
  const indexHtml = fs.readFileSync(path.join(app, "frontend/index.html"), "utf8");
  if (indexHtml.includes("__APP_NAME__")) fail("branding placeholder __APP_NAME__ present in merged app");
  for (const id of ["agent-mode", "screen-chat", "messages", "composer", "input"]) {
    if (!indexHtml.includes('id="' + id + '"')) {
      fail(`design fidelity broken after merge: canonical mount point id="${id}" missing from frontend/index.html`);
    }
  }
  if (!indexHtml.includes("app.js")) fail("design fidelity broken after merge: index.html no longer loads app.js");
  for (const s of slices) {
    for (const screen of s.covers ?? []) {
      if (!indexHtml.includes(`id="${screen}"`)) {
        fail(`covered design screen '${screen}' (${s.id}) is missing from the merged frontend — every approved screen must survive the merge`);
      }
    }
  }
  // Every slice's demo declaration must have survived the merge.
  for (let n = 1; n <= slices.length; n++) {
    if (!fs.existsSync(path.join(app, "demo", `slice-${n}.json`))) {
      fail(`app/demo/slice-${n}.json missing from the merged app — each slice's demo declaration must merge through`);
    }
  }

  const port = await freePort();
  const log = fs.openSync("merged-app.log", "w");
  const child = spawn(
    `uv run --with fastapi --with uvicorn --with-requirements requirements.txt uvicorn dev:app --host 127.0.0.1 --port ${port}`,
    { shell: true, detached: true, cwd: path.join(app, "backend"), env: { ...process.env, HARNESS_AGENT_MODE: "stub" }, stdio: ["ignore", log, log] },
  );
  fs.closeSync(log);
  const kill = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  };

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { up = true; break; }
      } catch { /* booting */ }
    }
    if (!up) fail("merged app did not boot:\n" + fs.readFileSync("merged-app.log", "utf8").slice(-1500));

    const report = [];
    for (const slice of slices) {
      const checks = [];
      for (const check of slice.acceptance) {
        const res = await fetch(`http://127.0.0.1:${port}${check.path}`, {
          method: check.method,
          headers: check.body ? { "Content-Type": "application/json" } : undefined,
          body: check.body ? JSON.stringify(check.body) : undefined,
        });
        const text = await res.text();
        const wanted = check.expect_status ?? 200;
        if (res.status !== wanted) {
          fail(`[${slice.id}] ${check.method} ${check.path}: status ${res.status}, expected ${wanted} — the merge broke this slice\n${text.slice(0, 400)}`);
        }
        for (const needle of check.expect_contains ?? []) {
          if (!text.toLowerCase().includes(needle.toLowerCase())) {
            fail(`[${slice.id}] ${check.method} ${check.path}: response missing "${needle}" — the merge broke this slice\n${text.slice(0, 400)}`);
          }
        }
        checks.push({ method: check.method, path: check.path, expected_status: wanted, contains: check.expect_contains ?? [], ok: true });
      }
      report.push({ slice: slice.id, name: slice.name, objective: slice.story, addresses: slice.addresses, checks });
      console.log(`acceptance passed: ${slice.id}`);
    }
    fs.writeFileSync(
      path.join(app, "acceptance_report.json"),
      JSON.stringify({ proven_through_slice: slices.length, merged: true, slices: report }, null, 2),
    );
  } finally {
    kill();
  }

  const pytest = spawnSync(
    "uv",
    ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", "--with-requirements", "requirements.txt", "python", "-m", "pytest", "tests", "-q"],
    { cwd: path.join(app, "backend"), encoding: "utf8", timeout: 300000 },
  );
  if (pytest.status !== 0) fail(`backend tests FAILED on the merged app\n${(pytest.stdout ?? "").slice(-1500)}\n${(pytest.stderr ?? "").slice(-1000)}`);
  spawnSync("find", [app, "-name", "__pycache__", "-type", "d", "-exec", "rm", "-rf", "{}", "+"]);
  console.log(`merged app verified: all ${slices.length} slice(s) acceptance + tests green`);
}

main().catch((e) => fail(String(e)));
