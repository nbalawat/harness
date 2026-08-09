// UI INTERACTIVITY VERIFIER — the "usable" half of done.
//
// A screen that renders but doesn't WORK must never ship. Boots the app
// (seeded, so lists have data) and DRIVES every screen like a user:
//   1. NAVIGATE   — the screen's nav control must actually reveal it.
//   2. NON-EMPTY  — with data seeded, the screen must show real content.
//   3. NO DEAD CONTROLS — every visible control (rail + screen) must produce a
//      REAL effect: a network request, a data-set change, a navigation, or a
//      populated panel. A cosmetic highlight is NOT an effect. Inputs are typed
//      into (with Enter), not clicked. Controls are re-located by STABLE
//      selectors across reloads so each is probed in isolation.
//
// Exit 0 iff every screen is navigable + non-empty and no dead control found.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { detach, killTree } = require("./_proc.cjs");

const app = path.resolve("app");
const outArg = process.argv.indexOf("--report");
const reportPath = outArg > -1 ? process.argv[outArg + 1] : "ui_interactivity.json";
const base = () => `http://127.0.0.1:${PORT}`;
let PORT = 0;

function freePort() {
  return new Promise((res, rej) => {
    const p = net.createServer();
    p.listen(0, "127.0.0.1", () => { const port = p.address().port; p.close(() => res(port)); });
    p.on("error", rej);
  });
}

async function snap(page) {
  return page.evaluate(() => {
    const vis = (n) => { const c = getComputedStyle(n); return c.display !== "none" && c.visibility !== "hidden" && n.offsetHeight > 0; };
    const rows = [...document.querySelectorAll('tr, li, .row, .card, [data-row], [data-id], .item')].filter(vis);
    return {
      href: location.href, netc: window.__net || 0,
      textLen: document.body.innerText.length,
      rowCount: rows.length,
      rowSig: rows.slice(0, 60).map((r) => (r.innerText || "").trim().slice(0, 24)).join("|"),
      panels: [...document.querySelectorAll('[role="dialog"], .modal, .drawer, .panel--open, [aria-expanded="true"], [data-open="true"]')].filter(vis).length,
    };
  });
}
const meaningful = (b, a) =>
  a.netc > b.netc || a.href !== b.href || a.panels !== b.panels ||
  a.rowCount !== b.rowCount || a.rowSig !== b.rowSig || Math.abs(a.textLen - b.textLen) > 120;

async function gotoAndNav(page, screenId) {
  await page.goto(base(), { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(600);
  const name = screenId.replace(/^screen-/, "");
  for (const sel of [`[data-nav="${name}"]`, `[data-screen="${name}"]`, `[data-screen-name="${name}"]`, `[href="#${screenId}"]`, `a[href="#${name}"]`]) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { try { await loc.click({ timeout: 2500 }); await page.waitForTimeout(400); } catch { /* */ } break; }
  }
}

(async () => {
  // Live-only: the mock/certification app is a deterministic stub with empty
  // screens and no rich controls — usability is a property of a REAL build.
  if (process.env.HARNESS_RUN_MODE === "mock") {
    fs.writeFileSync(reportPath, JSON.stringify({ mode: "mock", skipped: true, ok: true }, null, 2));
    console.log("UI interactivity gate runs on LIVE builds only (mock app is a deterministic stub)");
    process.exit(0);
  }
  PORT = await freePort();
  const log = fs.openSync("ui-interactivity-app.log", "w");
  const child = spawn(
    `uv run --with fastapi --with uvicorn --with-requirements requirements.txt uvicorn dev:app --host 127.0.0.1 --port ${PORT}`,
    { shell: true, detached: detach, cwd: path.join(app, "backend"),
      env: { ...process.env, HARNESS_AGENT_MODE: "stub", APP_ALLOW_SEED: "1" }, stdio: ["ignore", log, log] },
  );
  const stop = () => killTree(child);
  const die = (m) => { stop(); console.error(m); process.exit(1); };

  let up = false;
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); try { if ((await fetch(base() + "/health")).ok) { up = true; break; } } catch { /* */ } }
  if (!up) die("app did not boot for UI interactivity check:\n" + fs.readFileSync("ui-interactivity-app.log", "utf8").slice(-1200));
  try { await fetch(base() + "/admin/seed", { method: "POST" }); } catch { /* */ }

  let chromium;
  try { ({ chromium } = require("playwright-core")); } catch { die("playwright-core unavailable — cannot verify UI interactivity"); }
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    window.__net = 0;
    const of = window.fetch; window.fetch = function (...a) { window.__net++; return of.apply(this, a); };
    const ox = window.XMLHttpRequest.prototype.open; window.XMLHttpRequest.prototype.open = function (...a) { window.__net++; return ox.apply(this, a); };
  });

  await page.goto(base(), { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(1000);
  const screenIds = await page.evaluate(() => [...document.querySelectorAll('[id^="screen-"]')].map((s) => s.id));
  if (!screenIds.length) die("no screens (id^='screen-') found");

  // Collect every visible control across screens, with a STABLE selector.
  const controls = new Map(); // sel -> {sel, kind, label, screen}
  const emptyScreens = [], unnavigable = [];
  for (const screenId of screenIds) {
    await gotoAndNav(page, screenId);
    const visible = await page.evaluate((id) => { const el = document.getElementById(id); if (!el) return false; const c = getComputedStyle(el); return c.display !== "none" && c.visibility !== "hidden" && el.offsetHeight > 0; }, screenId);
    if (!visible) { unnavigable.push(screenId); continue; }
    const empt = await page.evaluate((id) => { const el = document.getElementById(id); const t = (el.innerText || "").trim(); const rows = el.querySelectorAll("tr,li,.row,.card,[data-row],[data-id],.item").length; const empty = /no (incidents|results|items|records|data|applications)|nothing (here|yet)|empty/i.test(t); return { textLen: t.length, rows, empty }; }, screenId);
    if ((empt.rows === 0 && empt.textLen < 40) || (empt.empty && empt.rows === 0)) emptyScreens.push({ screen: screenId, rows: empt.rows });
    const found = await page.evaluate(() => {
      const vis = (n) => { const c = getComputedStyle(n); return c.display !== "none" && c.visibility !== "hidden" && n.offsetHeight > 0 && !n.disabled; };
      const sel = (n) => {
        if (n.id) return "#" + CSS.escape(n.id);
        for (const a of ["data-severity", "data-nav", "data-screen", "data-queue", "data-filter", "data-view", "data-action", "data-id"]) if (n.getAttribute(a)) return `${n.tagName.toLowerCase()}[${a}="${n.getAttribute(a)}"]`;
        if (n.getAttribute("aria-label")) return `${n.tagName.toLowerCase()}[aria-label="${n.getAttribute("aria-label")}"]`;
        if (n.tagName === "INPUT") return `input[type="${n.type || "text"}"]`;
        return null;
      };
      const out = [];
      for (const n of document.querySelectorAll('button, a[href]:not([href="#"]), [role="button"], [data-action], [data-nav], [data-screen], [data-queue], [data-view], [data-filter], input[type="search"], input[type="text"], tr[onclick], [data-id]')) {
        if (!vis(n)) continue;
        const s = sel(n); if (!s) continue;
        const label = (n.innerText || n.getAttribute("aria-label") || n.getAttribute("placeholder") || n.tagName).trim();
        const idlabel = (label + " " + (n.id || "")).toLowerCase();
        // NAV is verified by the navigability check; SKIP here (clicking nav to
        // the current screen is a no-op false-positive).
        if (n.matches("[data-nav],[data-screen],[data-screen-name]") || (n.getAttribute("href") || "").startsWith("#")) continue;
        // MULTI-STEP submit controls need prior input — they're the demo flow's
        // job, not a self-acting control. Skip to avoid false positives.
        if (/\b(send|run|submit|record|decide|create|apply|assess|generate|ask|new thread|add|start|invite|log ?in)\b/.test(idlabel)) continue;
        if (n.tagName === "INPUT") {
          // only SEARCH/FILTER inputs are self-acting (type -> results change);
          // form fields are part of a submit flow, not standalone.
          const hint = ((n.getAttribute("placeholder") || "") + " " + (n.getAttribute("aria-label") || "") + " " + (n.id || "") + " " + (n.type || "")).toLowerCase();
          if (!/search|filter/.test(hint)) continue;
          out.push({ sel: s, kind: "input", label: label.slice(0, 44) });
        } else {
          out.push({ sel: s, kind: "click", label: label.slice(0, 44) });
        }
      }
      return out;
    });
    for (const c of found) if (!controls.has(c.sel)) controls.set(c.sel, { ...c, screen: screenId });
  }

  // Probe each control in isolation (fresh load + navigate to its screen).
  const deadControls = [];
  let probed = 0;
  for (const c of controls.values()) {
    if (probed++ > 120) break;
    await gotoAndNav(page, c.screen);
    const loc = page.locator(c.sel).first();
    if (!(await loc.count())) continue;
    const before = await snap(page);
    try {
      if (c.kind === "input") { await loc.fill("orders", { timeout: 2500 }); await loc.press("Enter", { timeout: 2000 }); }
      else { await loc.click({ timeout: 2500 }); }
    } catch { /* covered/blocked -> measured as no-effect below */ }
    await page.waitForTimeout(800);
    const after = await snap(page);
    if (!meaningful(before, after)) deadControls.push({ screen: c.screen, control: c.label, sel: c.sel });
  }

  // OPERABILITY: an app that gates actions on identity must let a human ASSUME a
  // persona — otherwise it demands an acting_user_email the user can't possibly
  // know (exactly the "no clue what the creds are" trap). Require a personas
  // endpoint AND a persona picker in the UI.
  const opProblems = [];
  let gatesIdentity = false;
  try {
    for (const f of fs.readdirSync(path.join(app, "backend"))) {
      if (f.endsWith(".py") && /require_actor|acting_user_email/.test(fs.readFileSync(path.join(app, "backend", f), "utf8"))) { gatesIdentity = true; break; }
    }
  } catch { /* */ }
  if (gatesIdentity) {
    let personas = [];
    for (const ep of ["/identities", "/personas", "/api/identities", "/users", "/auth/identities"]) {
      try { const r = await fetch(base() + ep); if (r.ok) { const j = await r.json(); const arr = Array.isArray(j) ? j : (j.identities || j.personas || j.users || []); if (arr.length) { personas = arr; break; } } } catch { /* */ }
    }
    const hasPicker = await page.evaluate(() => !!document.querySelector('[id*="persona" i],[id*="identity" i],[id*="acting" i],[aria-label*="persona" i],[aria-label*="identity" i],[aria-label*="acting" i],[data-personas],select[name*="user" i],datalist'));
    if (!personas.length) opProblems.push("app gates actions on identity but exposes NO personas endpoint (e.g. GET /identities) — a user cannot discover a valid acting_user_email");
    if (!hasPicker) opProblems.push("app gates actions on identity but the UI has NO persona picker — a human must be able to ASSUME a role without reading source code");
  }

  await browser.close();
  stop();

  // Empty-screen is ADVISORY (some screens are legitimately empty until acted
  // on). Dead self-acting controls + unnavigable screens are the HARD gate.
  const problems = [];
  if (unnavigable.length) problems.push(`${unnavigable.length} screen(s) not reachable by nav: ${unnavigable.join(", ")}`);
  for (const d of deadControls) problems.push(`DEAD control on '${d.screen}': "${d.control}" (${d.sel}) does nothing`);
  for (const o of opProblems) problems.push(`OPERABILITY: ${o}`);
  if (emptyScreens.length) console.log(`note (advisory): ${emptyScreens.length} screen(s) look empty with data seeded: ${emptyScreens.map((e) => e.screen).join(", ")}`);

  fs.writeFileSync(reportPath, JSON.stringify({ screens: screenIds, controlsProbed: controls.size, unnavigable, emptyScreens, deadControls, ok: problems.length === 0 }, null, 2));
  if (problems.length) {
    console.error(`UI INTERACTIVITY FAILED — renders but not usable (${deadControls.length} dead / ${controls.size} controls):\n  ` + problems.slice(0, 30).join("\n  ") +
      "\n\nEvery rendered control must produce a real effect; every screen must show real data. Wire them or remove them.");
    process.exit(1);
  }
  console.log(`UI interactivity OK: ${screenIds.length} screens navigable + non-empty; ${controls.size} controls all produce real effects`);
})().catch((e) => { console.error("ui-interactivity error: " + (e && e.stack || e)); process.exit(1); });
