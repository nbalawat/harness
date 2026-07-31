(async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  await page.goto("http://127.0.0.1:" + process.argv[2], { waitUntil: "load" });
  await page.waitForTimeout(2000);
  await page.locator('.navitem[data-screen="intake"]').first().click();
  await page.waitForTimeout(1200);
  const txt = await page.locator("#screen-intake").innerText();
  const leaks = ["D. Whitfield", "A. Boone", "K. Osei", "J. Farrow", "POL-GUAR-01", "Complexity: HIGH", "CLEAR 2026", "C&I / Med-tech"];
  console.log("FABRICATED CONTENT STILL ON SCREEN:", leaks.filter((l) => txt.includes(l)).join(" | ") || "none");
  console.log("---- triage panel text ----");
  console.log((await page.locator("#triage-banner").innerText()).slice(0, 200));
  console.log((await page.locator("#triage-missing").innerText()).slice(0, 200));
  console.log("---- preflight ----");
  console.log((await page.locator("#intake-preflight").innerText()).slice(0, 300));
  await page.locator("#screen-intake").screenshot({ path: "/tmp/fresh-intake.png" });
  await browser.close();
})();
