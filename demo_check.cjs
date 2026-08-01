const { chromium } = require("playwright-core");
const fs=require('fs');
(async () => {
  const port = process.argv[2];
  const demo = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  const errs=[];
  page.on('pageerror', e=>errs.push('PAGEERROR '+e.message));
  page.on('console', m=>{ if(m.type()==='error') errs.push('CONSOLE '+m.text()); });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(700);
  try { await page.fill("#input","How do I reset a user's access?"); await page.locator("#composer button[type=submit], #composer button").first().click(); await page.waitForTimeout(1200);} catch(e){}
  await page.reload({waitUntil:"load"}); await page.waitForTimeout(900);
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
  await page.locator(`#${demo.screen}`).first().screenshot({ path: "/tmp/slice3-demo.png" });
  console.log("MEMO:", await page.locator("#memo-status").textContent());
  console.log("POLICY:", await page.locator("#policy-status").textContent());
  console.log("META:", await page.locator("#chronicle-meta").textContent());
  console.log("EMPTY:", await page.locator("#chronicle-empty").textContent());
  console.log("ENTRIES:", await page.locator("#chronicle-list li").count());
  console.log("EXCEPTIONS:", await page.locator("#exceptions-list li").count());
  console.log("DEAL:", await page.locator("#chronicle-deal").inputValue());
  console.log("ERRORS:", errs.slice(0,5));
  await browser.close();
})();
