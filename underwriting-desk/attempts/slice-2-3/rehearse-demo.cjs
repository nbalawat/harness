// Rehearses app/demo/slice-<N>.json exactly the way scripts/verify-slice.cjs does,
// so a demo that cannot run is caught here rather than in a failed boot cycle.
const fs = require("fs"), path = require("path");
const app = path.join(__dirname, "app");
const port = process.argv[2], sliceIndex = process.argv[3] || "2";

(async () => {
  const demo = JSON.parse(fs.readFileSync(path.join(app, "demo", `slice-${sliceIndex}.json`), "utf8"));
  const { chromium } = require("/Users/nbalawat/development/harness/node_modules/playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(700);
  try {
    await page.fill("#input", "How do I reset a user's access?");
    await page.locator("#composer button[type=submit], #composer button").first().click();
    await page.waitForTimeout(1200);
  } catch (e) {
    console.log("chat step skipped (expected: #input sits on the hidden chat screen)");
  }
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(900);
  if ((await page.locator(`#${demo.screen}`).count()) === 0) {
    throw new Error(`demo screen #${demo.screen} not found in the running app`);
  }
  for (const [i, step] of (demo.steps ?? []).entries()) {
    try {
      if (step.action === "fill") await page.fill(step.selector, String(step.value ?? ""));
      if (step.action === "click") await page.locator(step.selector).first().click();
      await page.waitForTimeout(500);
      console.log(`step ${i} OK: ${step.action} ${step.selector}`);
    } catch (e) {
      console.log(`step ${i} FAILED: ${step.selector} -> ${String(e).split("\n")[0].slice(0, 160)}`);
      throw e;
    }
  }
  await page.waitForTimeout(700);
  console.log("signed-in identity:", await page.locator("#user-name").first().textContent(),
              "/", await page.locator("#role-readout").first().textContent());
  await page.evaluate((id) => {
    for (const s of document.querySelectorAll('[id^="screen-"]')) s.style.display = "none";
    const el = document.getElementById(id);
    if (el) { el.style.display = "block"; el.style.visibility = "visible"; el.removeAttribute("hidden"); }
  }, demo.screen);
  await page.waitForTimeout(250);
  const shot = path.join(__dirname, `rehearsal-slice-${sliceIndex}.png`);
  await page.locator(`#${demo.screen}`).first().screenshot({ path: shot });
  await browser.close();
  const prev = path.join(app, "screenshots", "slice-1.png");
  if (fs.existsSync(prev)) {
    console.log("identical to slice-1?", fs.readFileSync(prev).equals(fs.readFileSync(shot)));
  }
  console.log("page errors:", errors);
  console.log("shot bytes:", fs.statSync(shot).size);
})().catch(e => { console.log("REHEARSAL FAILED:", String(e).slice(0, 300)); process.exit(1); });
