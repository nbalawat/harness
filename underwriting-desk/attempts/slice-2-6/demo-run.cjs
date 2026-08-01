const fs = require("fs");
const path = require("path");
const port = process.argv[2];
const sliceIndex = Number(process.argv[3] || 2);
const app = path.resolve("app");
const demo = JSON.parse(fs.readFileSync(path.join(app, "demo", `slice-${sliceIndex}.json`), "utf8"));
(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE ERROR:", m.text()); });
  page.on("pageerror", e => console.log("PAGE ERROR:", String(e).slice(0,300)));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(700);
  try {
    await page.fill("#input", "How do I reset a user's access?");
    await page.locator("#composer button[type=submit], #composer button").first().click();
    await page.waitForTimeout(1200);
  } catch (e) { console.log("chat step skipped"); }
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(900);
  if ((await page.locator(`#${demo.screen}`).count()) === 0) throw new Error("screen missing");
  for (const step of demo.steps ?? []) {
    if (step.action === "fill") await page.fill(step.selector, String(step.value ?? ""));
    if (step.action === "click") await page.locator(step.selector).first().click();
    await page.waitForTimeout(500);
    console.log("step ok:", step.action, step.selector);
  }
  await page.waitForTimeout(700);
  await page.evaluate((id) => {
    for (const s of document.querySelectorAll('[id^="screen-"]')) s.style.display = "none";
    const el = document.getElementById(id);
    if (el) { el.style.display = "block"; el.style.visibility = "visible"; el.removeAttribute("hidden"); }
  }, demo.screen);
  await page.waitForTimeout(250);
  fs.mkdirSync("/tmp/shots", { recursive: true });
  await page.locator(`#${demo.screen}`).first().screenshot({ path: `/tmp/shots/slice-${sliceIndex}.png` });
  console.log("queue rows:", await page.locator("#review-rows tr").count());
  console.log("selected:", await page.locator("#rev-t-deal").textContent(), "|", await page.locator("#rev-t-artifact").textContent());
  console.log("draft text:", (await page.locator("#review-draft").textContent()).slice(0, 400));
  console.log("evidence:", (await page.locator("#review-evidence").textContent()).slice(0, 200));
  console.log("readout:", await page.locator("#disp-readout").textContent());
  await browser.close();
})().catch(e => { console.error("DEMO FAILED:", e); process.exit(1); });
