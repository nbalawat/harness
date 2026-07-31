(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  const bad = new Set();
  page.on("response", (r) => { if (r.status() >= 400) bad.add(r.status() + " " + r.request().method() + " " + r.url()); });
  await page.goto("http://127.0.0.1:" + process.argv[2], { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await page.locator('.navitem[data-screen="intake"]').first().click();
  await page.waitForTimeout(1200);
  await page.locator('.navitem[data-screen="pipeline"]').first().click();
  await page.waitForTimeout(1500);
  await browser.close();
  console.log([...bad].join("\n") || "no failing requests");
})();
