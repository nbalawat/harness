// A slice's exit criteria: boot the app and run CUMULATIVE acceptance — this
// slice's checks plus every previous slice's (features never regress) — then
// the backend test suite. Runs inside the slice node's retry loop.
const crypto = require("node:crypto");
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
  // The slice's demo declaration is a CONTRACT, not a nicety: without it the
  // user cannot see what this slice added. Missing demo = failed slice.
  const thisSlice = slices[sliceIndex - 1];
  const demoFile = path.join(app, "demo", `slice-${sliceIndex}.json`);
  if (!fs.existsSync(demoFile)) {
    fail(`app/demo/slice-${sliceIndex}.json missing — declare how to DEMONSTRATE this slice (screen + steps + caption); the user sees your slice through it`);
  }
  let demo;
  try {
    demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));
  } catch (e) {
    fail(`app/demo/slice-${sliceIndex}.json is not valid JSON: ${e}`);
  }
  if (!demo.screen || !demo.caption) fail(`app/demo/slice-${sliceIndex}.json must declare "screen" and "caption"`);
  if (Array.isArray(thisSlice.covers) && thisSlice.covers.length && !thisSlice.covers.includes(demo.screen)) {
    fail(`demo targets ${demo.screen} but this slice covers ${thisSlice.covers.join(", ")} — demonstrate a surface THIS slice delivers`);
  }
  // Every screen covered by slices 1..N must exist in the shell: covered
  // screens are the design promise being delivered, never removed.
  const indexHtmlEarly = fs.readFileSync(path.join(app, "frontend/index.html"), "utf8");
  for (const s of slices) {
    for (const screen of s.covers ?? []) {
      if (!indexHtmlEarly.includes(`id="${screen}"`)) {
        fail(`covered design screen '${screen}' (slice ${s.id}) is missing from frontend/index.html — the approved design's screens must all survive`);
      }
    }
  }
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
    if (!up) fail("app did not boot for slice verification:\n" + fs.readFileSync("slice-app.log", "utf8").slice(-1500));

    // The objectives ledger: every check's verdict, recorded into the app
    // artifact so "were the slice objectives met" always has visible evidence.
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
          fail(`[${slice.id}] ${check.method} ${check.path}: status ${res.status}, expected ${wanted}\n${text.slice(0, 400)}`);
        }
        for (const needle of check.expect_contains ?? []) {
          if (!text.toLowerCase().includes(needle.toLowerCase())) {
            fail(`[${slice.id}] ${check.method} ${check.path}: response missing "${needle}"\n${text.slice(0, 400)}`);
          }
        }
        checks.push({ method: check.method, path: check.path, expected_status: wanted, contains: check.expect_contains ?? [], ok: true });
      }
      report.push({ slice: slice.id, name: slice.name, objective: slice.story, addresses: slice.addresses, checks });
      console.log(`acceptance passed: ${slice.id}`);
    }
    fs.writeFileSync(path.join(app, "acceptance_report.json"), JSON.stringify({ proven_through_slice: sliceIndex, slices: report }, null, 2));

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
      fs.mkdirSync(path.join(app, "screenshots"), { recursive: true });

      // THE SLICE'S OWN DEMO (enforced): execute the declared steps, then
      // screenshot the declared screen alone. No composite fallback — a demo
      // that cannot run is a failed slice, because the user would see nothing.
      if ((await page.locator(`#${demo.screen}`).count()) === 0) {
        throw new Error(`demo screen #${demo.screen} not found in the running app`);
      }
      for (const step of demo.steps ?? []) {
        if (step.action === "fill") await page.fill(step.selector, String(step.value ?? ""));
        if (step.action === "click") await page.locator(step.selector).first().click();
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(700);
      await page.evaluate((id) => {
        for (const s of document.querySelectorAll('[id^="screen-"]')) { s.style.display = "none"; }
        const el = document.getElementById(id);
        if (el) { el.style.display = "block"; el.style.visibility = "visible"; el.removeAttribute("hidden"); }
      }, demo.screen);
      await page.waitForTimeout(250);
      const shotPath = path.join(app, "screenshots", `slice-${sliceIndex}.png`);
      await page.locator(`#${demo.screen}`).first().screenshot({ path: shotPath });
      await browser.close();

      // DISTINCTNESS: a screenshot identical to a previous slice's shows the
      // user nothing new — the demo failed its purpose. Fail into the retry
      // loop with feedback instead of shipping a useless shot.
      const newShot = crypto.createHash("sha256").update(fs.readFileSync(shotPath)).digest("hex");
      for (let prev = 1; prev < sliceIndex; prev++) {
        const prevPath = path.join(app, "screenshots", `slice-${prev}.png`);
        if (!fs.existsSync(prevPath)) continue;
        const prevHash = crypto.createHash("sha256").update(fs.readFileSync(prevPath)).digest("hex");
        if (prevHash === newShot) {
          fail(`slice ${sliceIndex}'s demo screenshot is IDENTICAL to slice ${prev}'s — your demo must show the feature THIS slice added (stage data via steps, target your own surface #${demo.screen})`);
        }
      }
      console.log(`demo screenshot: slice ${sliceIndex} -> #${demo.screen} (distinct)`);
    } catch (e) {
      if (String(e).includes("IDENTICAL")) throw e;
      const browserGone = /playwright|browserType|executable|channel/i.test(String(e));
      if (browserGone) {
        console.log("browser unavailable — screenshot enforcement skipped: " + String(e).slice(0, 120));
      } else {
        fail(`slice demo failed to execute: ${String(e).slice(0, 300)} — fix app/demo/slice-${sliceIndex}.json (screen: ${demo.screen})`);
      }
    }
  } finally {
    kill();
  }

  const pytest = spawnSync(
    "uv",
    ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", "--with-requirements", "requirements.txt", "python", "-m", "pytest", "tests", "-q"],
    { cwd: path.join(app, "backend"), encoding: "utf8", timeout: 300000 },
  );
  if (pytest.status !== 0) fail(`backend tests FAILED\n${(pytest.stdout ?? "").slice(-1500)}\n${(pytest.stderr ?? "").slice(-1000)}`);
  spawnSync("find", [app, "-name", "__pycache__", "-type", "d", "-exec", "rm", "-rf", "{}", "+"]);
  console.log(`slice ${sliceIndex} verified: cumulative acceptance + tests green`);
}

main().catch((e) => fail(String(e)));
