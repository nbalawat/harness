const port = process.argv[2];
(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", e => console.log("PAGE ERROR:", String(e).slice(0,200)));
  page.on("console", m => { if (m.type()==="error") console.log("CONSOLE:", m.text().slice(0,160)); });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load" });
  await page.waitForTimeout(900);
  await page.locator('.navitem[data-screen="review"]').click();
  await page.waitForTimeout(600);
  const rows = await page.locator("#review-rows tr").count();
  console.log("all-artifact rows:", rows);
  // select DEAL-2001's pending triage
  await page.locator('#review-rows tr[data-deal-ref="DEAL-2001"]').first().click();
  await page.waitForTimeout(600);
  console.log("selected artifact:", await page.locator("#rev-t-artifact").textContent());
  console.log("accept enabled:", !(await page.locator("#rev-accept").isDisabled()));
  await page.fill("#rev-reason", "Classification and queue match the record.");
  await page.locator("#rev-accept").click();
  await page.waitForTimeout(900);
  console.log("after accept readout:", (await page.locator("#disp-readout").textContent()).slice(0,160));
  console.log("run button:", await page.locator("#review-run-spread").textContent(), "disabled:", await page.locator("#review-run-spread").isDisabled());
  await page.locator("#review-run-spread").click();
  await page.waitForTimeout(1200);
  console.log("after run:", await page.locator("#rev-t-deal").textContent(), await page.locator("#rev-t-artifact").textContent());
  console.log("draft note:", await page.locator("#review-draft-note").textContent());
  console.log("evidence note:", await page.locator("#review-evidence-note").textContent());
  // reject without a reason -> server refuses, hint shows
  await page.fill("#rev-reason", "");
  await page.locator("#rev-reject").click();
  await page.waitForTimeout(800);
  console.log("reject-no-reason hint:", await page.locator("#rev-reason-hint").textContent(), "hidden:", await page.locator("#rev-reason-hint").isHidden());
  // reject with a reason
  await page.fill("#rev-reason", "No financial statements are on file; collect them before spreading.");
  await page.locator("#rev-reject").click();
  await page.waitForTimeout(1000);
  console.log("after reject readout:", (await page.locator("#disp-readout").textContent()).slice(0,200));
  // re-run and edit&accept
  await page.locator("#review-run-spread").click();
  await page.waitForTimeout(1200);
  await page.locator("#rev-edit").click();
  await page.waitForTimeout(300);
  await page.fill("#rev-reason", "");
  console.log("edit row hidden:", await page.locator("#review-edit-row").isHidden());
  await page.selectOption("#review-edit-key", "ebitda");
  await page.fill("#review-edit-value", "1,000,000");
  await page.locator("#review-edit-confirm").click();
  await page.waitForTimeout(900);
  console.log("edit-no-reason hint hidden:", await page.locator("#rev-reason-hint").isHidden(), "|", await page.locator("#rev-reason-hint").textContent());
  await page.fill("#rev-reason", "Statement EBITDA includes a one-off recovery; normalised.");
  await page.locator("#review-edit-confirm").click();
  await page.waitForTimeout(1200);
  console.log("after edit readout:", (await page.locator("#disp-readout").textContent()).slice(0,220));
  console.log("draft box after edit:", (await page.locator("#review-draft").textContent()).slice(0,200));
  // prev/next
  await page.locator("#review-next").click(); await page.waitForTimeout(500);
  console.log("next -> ", await page.locator("#rev-t-deal").textContent(), await page.locator("#rev-t-artifact").textContent());
  await page.locator("#review-prev").click(); await page.waitForTimeout(500);
  console.log("prev -> ", await page.locator("#rev-t-deal").textContent(), await page.locator("#rev-t-artifact").textContent());
  await browser.close();
})().catch(e => { console.error("UI CHECK FAILED:", e); process.exit(1); });
