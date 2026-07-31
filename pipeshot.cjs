const { chromium } = require("playwright-core");
(async () => {
  const BASE = process.argv[2];
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  await page.goto(BASE + "/", { waitUntil: "load" });
  await page.waitForTimeout(1200);
  // exercise every pipeline control
  await page.locator('#pipeline-filters button[data-filter="blocked"]').click(); await page.waitForTimeout(300);
  const blocked = await page.locator('#pipeline-rowcount').textContent();
  await page.locator('#pipeline-filters button[data-filter="large"]').click(); await page.waitForTimeout(300);
  const large = await page.locator('#pipeline-rowcount').textContent();
  await page.locator('#pipeline-filters button[data-filter="all"]').click(); await page.waitForTimeout(300);
  await page.locator('#btn-columns').click(); await page.waitForTimeout(250);
  const cols = await page.locator('#btn-columns').textContent();
  await page.locator('#btn-columns').click(); await page.waitForTimeout(250);
  console.log("filters:", JSON.stringify({blocked, large, cols}));
  // row click -> deal screen, then back
  await page.locator('#pipeline-rows .tbl-id').first().click(); await page.waitForTimeout(300);
  const onDeal = await page.locator('#screen-deal').evaluate(e => e.classList.contains('active'));
  await page.locator('.navitem[data-screen="pipeline"]').click(); await page.waitForTimeout(400);
  console.log("row click -> deal screen active:", onDeal);
  await page.evaluate(() => { for (const s of document.querySelectorAll('[id^="screen-"]')) s.style.display="none";
    const el=document.getElementById("screen-pipeline"); el.style.display="block"; });
  await page.waitForTimeout(250);
  await page.locator('#screen-pipeline').screenshot({ path: "/tmp/pipe-shot.png" });
  console.log("ERRORS", JSON.stringify(errors));
  await browser.close();
})();
