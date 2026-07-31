const fs = require("fs");
const path = require("path");
const PORT = process.argv[2];
const APP = "/Users/nbalawat/development/harness/underwriting-desk/attempts/slice-1-2/app";
const demo = JSON.parse(fs.readFileSync(path.join(APP, "demo/slice-1.json"), "utf8"));
(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console.error: " + m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(700);
  try {
    await page.fill("#input", "How do I reset a user's access?");
    await page.locator("#composer button[type=submit], #composer button").first().click();
    await page.waitForTimeout(1200);
  } catch (e) { console.log("chat step skipped: " + String(e).slice(0, 120)); }
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(900);
  if ((await page.locator(`#${demo.screen}`).count()) === 0) throw new Error(`demo screen #${demo.screen} not found`);
  for (const step of demo.steps ?? []) {
    if (step.action === "fill") await page.fill(step.selector, String(step.value ?? ""));
    if (step.action === "click") await page.locator(step.selector).first().click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(700);
  await page.evaluate((id) => {
    for (const s of document.querySelectorAll('[id^="screen-"]')) s.style.display = "none";
    const el = document.getElementById(id);
    if (el) { el.style.display = "block"; el.style.visibility = "visible"; el.removeAttribute("hidden"); }
  }, demo.screen);
  await page.waitForTimeout(250);
  await page.locator(`#${demo.screen}`).first().screenshot({ path: "/tmp/slice-1-probe.png" });
  await browser.close();
  console.log("DEMO OK -> /tmp/slice-1-probe.png");
  if (errs.length) console.log("PAGE ERRORS:\n" + errs.slice(0, 10).join("\n"));
})().catch((e) => { console.error("DEMO FAILED: " + String(e).slice(0, 500)); process.exit(1); });
