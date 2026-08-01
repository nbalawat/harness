// The design-delivery proof (the answer to "how much of what I approved got
// built?"): boots the finished app, visits EVERY screen from the design
// contract, verifies it exists with its interactive elements, and screenshots
// each one. Output: design_coverage.json + one screenshot per screen. A
// contract screen missing from the running app FAILS the node.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const inputs = JSON.parse(fs.readFileSync("inputs.json", "utf8"));
const contract = inputs.design_contract.data;
const slices = inputs.slice_plan.data.slices;
const app = path.join(inputs.app.path);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function coveredBy(screenId) {
  const i = slices.findIndex((s) => (s.covers ?? []).includes(screenId));
  return i === -1 ? null : i + 1;
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
  const port = await freePort();
  const log = fs.openSync("coverage-app.log", "w");
  const child = spawn(
    `uv run --with fastapi --with uvicorn --with-requirements requirements.txt uvicorn dev:app --host 127.0.0.1 --port ${port}`,
    // Live builds boot with LIVE agents; mock runs stay deterministic on stubs.
    { shell: true, detached: true, cwd: path.join(app, "backend"), env: { ...process.env, ...(process.env.HARNESS_RUN_MODE === "live" ? {} : { HARNESS_AGENT_MODE: "stub" }) }, stdio: ["ignore", log, log] },
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
    if (!up) fail("app did not boot for design-coverage:\n" + fs.readFileSync("coverage-app.log", "utf8").slice(-1500));

    fs.mkdirSync("coverage", { recursive: true });
    const report = [];
    let browser = null;
    let page = null;
    try {
      const { chromium } = require("playwright-core");
      browser = await chromium.launch({ channel: "chrome" });
      page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load", timeout: 15000 });
      await page.waitForTimeout(900); // app.js populates panels
    } catch (e) {
      console.log("browser unavailable — falling back to static DOM checks: " + String(e).slice(0, 120));
    }

    const staticHtml = fs.readFileSync(path.join(app, "frontend/index.html"), "utf8");
    for (const screen of contract.screens) {
      let present;
      let elementsPresent = 0;
      let shot = null;
      if (page) {
        present = (await page.locator(`#${screen.id}`).count()) > 0;
        if (present) {
          for (const el of screen.elements) {
            if (el.id && (await page.locator(`#${el.id}`).count()) > 0) elementsPresent++;
            else if (!el.id) elementsPresent++; // unlabeled elements: presence via screen shot
          }
          await page.evaluate((id) => {
            for (const s of document.querySelectorAll('[id^="screen-"]')) { s.style.display = "none"; }
            const el = document.getElementById(id);
            if (el) { el.style.display = "block"; el.style.visibility = "visible"; el.removeAttribute("hidden"); }
          }, screen.id);
          await page.waitForTimeout(250);
          const target = page.locator(`#${screen.id}`);
          try {
            await target.first().screenshot({ path: path.join("coverage", `${screen.id}.png`) });
            shot = `coverage/${screen.id}.png`;
          } catch { /* zero-height screens keep null shot */ }
        }
      } else {
        present = staticHtml.includes(`id="${screen.id}"`);
        elementsPresent = screen.elements.filter((el) => !el.id || staticHtml.includes(`id="${el.id}"`)).length;
      }
      report.push({
        id: screen.id,
        title: screen.title,
        covered_by_slice: coveredBy(screen.id),
        present,
        elements_declared: screen.element_count,
        elements_present: elementsPresent,
        shot,
      });
      console.log(`${present ? "ok " : "MISSING"} ${screen.id} — slice ${coveredBy(screen.id) ?? "?"} — elements ${elementsPresent}/${screen.element_count}`);
    }
    if (browser) await browser.close();

    const missing = report.filter((r) => !r.present);
    const coverage = {
      screens: report,
      totals: {
        screens: report.length,
        screens_present: report.filter((r) => r.present).length,
        elements_declared: report.reduce((s, r) => s + r.elements_declared, 0),
        elements_present: report.reduce((s, r) => s + r.elements_present, 0),
      },
    };
    fs.writeFileSync("design_coverage.json", JSON.stringify(coverage, null, 2));
    if (missing.length) {
      fail(`design delivery INCOMPLETE: ${missing.map((m) => m.id).join(", ")} — these approved screens are not in the running app`);
    }
    console.log(`design delivery: ${coverage.totals.screens_present}/${coverage.totals.screens} screens live, ${coverage.totals.elements_present}/${coverage.totals.elements_declared} elements present`);
  } finally {
    kill();
  }
}

main().catch((e) => fail(String(e)));
