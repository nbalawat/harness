// A slice's exit criteria: boot the app and run CUMULATIVE acceptance — this
// slice's checks plus every previous slice's (features never regress) — then
// the backend test suite. Runs inside the slice node's retry loop.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const sliceIndex = inputs._params.data.slice;
const slices = inputs.slice_plan.data.slices.slice(0, sliceIndex);
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
  // Fast static checks first.
  const indexHtml = fs.readFileSync(path.join(app, "frontend/index.html"), "utf8");
  if (indexHtml.includes("__APP_NAME__")) {
    fail("branding placeholder __APP_NAME__ present");
  }
  // Design-fidelity guard: the frontend IS the chosen design. A slice may
  // extend it but must never replace its shell or break its mount points.
  for (const id of ["agent-mode", "screen-chat", "messages", "composer", "input"]) {
    if (!indexHtml.includes('id="' + id + '"')) {
      fail(`design fidelity broken: frontend/index.html lost canonical mount point id="${id}" — restore the chosen design's shell`);
    }
  }
  if (!indexHtml.includes("app.js")) fail("design fidelity broken: frontend/index.html no longer loads app.js");
  const port = await freePort();
  const log = fs.openSync("slice-app.log", "w");
  const child = spawn(
    `uv run --with fastapi --with uvicorn uvicorn dev:app --host 127.0.0.1 --port ${port}`,
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
    if (!up) fail("app did not boot for slice verification:\n" + fs.readFileSync("slice-app.log", "utf8").slice(-1500));

    for (const slice of slices) {
      for (const check of slice.acceptance) {
        const res = await fetch(`http://127.0.0.1:${port}${check.path}`, {
          method: check.method,
          headers: check.body ? { "Content-Type": "application/json" } : undefined,
          body: check.body ? JSON.stringify(check.body) : undefined,
        });
        const text = await res.text();
        const wanted = check.expect_status ?? 200;
        if (res.status !== wanted) {
          fail(`[${slice.id}] ${check.method} ${check.path}: status ${res.status}, expected ${wanted}\n${text.slice(0, 400)}`);
        }
        for (const needle of check.expect_contains ?? []) {
          if (!text.toLowerCase().includes(needle.toLowerCase())) {
            fail(`[${slice.id}] ${check.method} ${check.path}: response missing "${needle}"\n${text.slice(0, 400)}`);
          }
        }
      }
      console.log(`acceptance passed: ${slice.id}`);
    }

    // Progress screenshot (best-effort): ships inside the app artifact so the
    // dashboard can show the app evolving slice by slice. FULL PAGE, after a
    // demo interaction — a fixed top-of-page viewport would show the same
    // header for every slice and hide exactly the growth we want to show.
    try {
      const { chromium } = require("playwright-core");
      const browser = await chromium.launch({ channel: "chrome" });
      const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load", timeout: 15000 });
      await page.waitForTimeout(700); // let app.js populate agents/history panels
      try {
        // Exercise the chat so the thread shows real content in every shot.
        await page.fill("#input", "How do I reset a user's access?");
        await page.locator("#composer button[type=submit], #composer button").first().click();
        await page.waitForTimeout(1200);
      } catch {
        /* demo interaction is best-effort — layout may vary */
      }
      // Reload so panels re-render with the DATA the acceptance checks and the
      // demo chat just created — state growth is the visible slice progress.
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(900);
      // Designs often show one screen at a time (tabs). The progress shot is a
      // COMPOSITE: force every screen section visible so what each slice added
      // (approvals, history, roster...) is actually in the picture.
      await page.evaluate(() => {
        for (const s of document.querySelectorAll('[id^="screen-"]')) {
          s.style.display = "block";
          s.style.visibility = "visible";
          s.removeAttribute("hidden");
        }
      });
      await page.waitForTimeout(300);
      fs.mkdirSync(path.join(app, "screenshots"), { recursive: true });
      await page.screenshot({ path: path.join(app, "screenshots", `slice-${sliceIndex}.png`), fullPage: true });
      await browser.close();
      console.log(`progress screenshot captured for slice ${sliceIndex} (full page)`);
    } catch (e) {
      console.log("progress screenshot skipped: " + String(e).slice(0, 120));
    }
  } finally {
    kill();
  }

  const pytest = spawnSync(
    "uv",
    ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", "python", "-m", "pytest", "tests", "-q"],
    { cwd: path.join(app, "backend"), encoding: "utf8", timeout: 300000 },
  );
  if (pytest.status !== 0) fail(`backend tests FAILED\n${(pytest.stdout ?? "").slice(-1500)}\n${(pytest.stderr ?? "").slice(-1000)}`);
  spawnSync("find", [app, "-name", "__pycache__", "-type", "d", "-exec", "rm", "-rf", "{}", "+"]);
  console.log(`slice ${sliceIndex} verified: cumulative acceptance + tests green`);
}

main().catch((e) => fail(String(e)));
