const { chromium } = require("playwright-core");
(async () => {
  const BASE = process.argv[2];
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1180, height: 780 } });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(700);
  try {
    await page.fill("#input", "How do I reset a user's access?");
    await page.locator("#composer button[type=submit], #composer button").first().click();
    await page.waitForTimeout(1200);
  } catch (e) { console.log("chat step skipped:", String(e).slice(0,80)); }
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(900);

  const demo = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
  for (const step of demo.steps ?? []) {
    if (step.action === "fill") await page.fill(step.selector, String(step.value ?? ""));
    if (step.action === "click") await page.locator(step.selector).first().click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(700);

  const report = await page.evaluate(() => {
    const t = id => (document.getElementById(id) || {}).textContent;
    return {
      rbac: t("intake-rbac"), triageStatus: t("triage-status"), model: t("triage-model"),
      latency: t("triage-latency"), classChips: t("triage-class"), classHint: t("triage-class-hint"),
      missing: (t("triage-missing")||"").slice(0,180), queueHint: t("triage-queue-hint"),
      preflight: (t("intake-preflight")||"").slice(0,220), tier: t("tier-chip"),
      ltv: (document.getElementById("in-ltv")||{}).value, docNote: t("intake-doc-note"),
      err: t("intake-error"),
      pipelineRows: [...document.querySelectorAll("#pipeline-rows tr")].map(r => r.innerText.replace(/\s+/g," ").slice(0,100)),
      rowcount: t("pipeline-rowcount"), strip: [t("m-queue"), t("m-pending"), t("m-exposure"), t("m-approvals")],
      stageIntake: (document.querySelector('.stagecell[data-stage="intake"] .s-count')||{}).textContent,
      agentRun: t("agent-run-text"),
    };
  });
  console.log(JSON.stringify(report, null, 1));

  await page.evaluate((id) => {
    for (const s of document.querySelectorAll('[id^="screen-"]')) { s.style.display = "none"; }
    const el = document.getElementById(id);
    if (el) { el.style.display = "block"; el.style.visibility = "visible"; el.removeAttribute("hidden"); }
  }, demo.screen);
  await page.waitForTimeout(250);
  await page.locator("#" + demo.screen).first().screenshot({ path: "/tmp/demo-shot.png" });
  console.log("ERRORS", JSON.stringify(errors, null, 1));
  await browser.close();
})();
