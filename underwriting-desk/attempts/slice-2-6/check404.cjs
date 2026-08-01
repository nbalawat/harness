const port = process.argv[2];
(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  page.on("response", r => { if (r.status() >= 400) console.log(r.status(), r.url()); });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await browser.close();
})();
