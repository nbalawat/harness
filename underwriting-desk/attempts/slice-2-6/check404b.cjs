const port = process.argv[2];
(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  page.on("response", r => { if (r.status() >= 400) console.log(r.status(), r.request().method(), r.url()); });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load" });
  await page.waitForTimeout(700);
  try { await page.fill("#input", "hi"); await page.locator("#composer button").first().click(); await page.waitForTimeout(800);} catch(e){console.log("chat skipped")}
  await page.reload({waitUntil:"load"});
  await page.waitForTimeout(1200);
  await page.locator('.navitem[data-screen="review"]').click();
  await page.waitForTimeout(800);
  await browser.close();
})();
