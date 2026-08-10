#!/usr/bin/env node
// End-to-end test of the multi-tenant control plane behind the UI:
//   run-index (shared run store) + builder-controller (1 isolated build per
//   request) + the hosted UI reading runs from the index, scoped per user/team.
// Proves the UI is stateless and each of many users sees only their own apps,
// with team shelves — the piece that makes the front door scale to 100k.
// Exit 0 = all assertions pass.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "index.js");
const DEMO = path.join(REPO, "project-types", "demo");
const ANSWERS = JSON.parse(fs.readFileSync(path.join(DEMO, "fixtures", "answers.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mt-store-"));
const children = [];
let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗ FAIL:"} ${m}`);
  if (!c) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* booting */
    }
    await sleep(150);
  }
  throw new Error(`no boot: ${url}`);
}
function start(script, env, port) {
  const c = spawn(process.execPath, [path.join(REPO, script)], { env: { ...process.env, ...env, PORT: String(port) }, stdio: "ignore" });
  children.push(c);
  return waitHealth(`http://127.0.0.1:${port}/healthz`).then(() => `http://127.0.0.1:${port}`);
}
const getJson = (u, headers) =>
  new Promise((resolve, reject) => {
    http.get(u, { headers: headers ?? {} }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    }).on("error", reject);
  });
const postJson = (u, body, headers) =>
  fetch(u, { method: "POST", headers: { "content-type": "application/json", ...(headers ?? {}) }, body: JSON.stringify(body) });

async function main() {
  const teams = { "alice@firm.local": ["fsi"], "bob@firm.local": ["fsi"], "carol@firm.local": ["risk"] };
  const RUNINDEX = await start("platform/runindex/server.mjs", { STORE: path.join(TMP, "ri"), TEAMS_JSON: JSON.stringify(teams) }, 18310);
  const CTRL = await start("platform/builder-controller/server.mjs", { RUNINDEX_URL: RUNINDEX, CLI, WORKROOT: path.join(TMP, "builds"), BUILDER_MODE: "local" }, 18311);

  // Each user asks the controller to build multiple apps — one isolated build each.
  const plan = [
    ["alice@firm.local", "fsi", 2],
    ["bob@firm.local", "fsi", 2],
    ["carol@firm.local", "risk", 1],
  ];
  let expected = 0;
  for (const [owner, team, n] of plan) {
    for (let i = 0; i < n; i++) {
      const r = await postJson(`${CTRL}/v1/builds`, { projectType: DEMO, answers: ANSWERS, team, name: `${owner.split("@")[0]}-app${i + 1}` }, { "x-firm-identity": owner });
      ok(r.status === 202, `controller accepted a build for ${owner} (1 isolated builder)`);
      expected++;
    }
  }

  // Wait for all builds to finish (they register final status to the run-index).
  let done = 0;
  for (let i = 0; i < 80; i++) {
    const all = await getJson(`${RUNINDEX}/v1/runs?all=1`);
    done = all.runs.filter((r) => r.status !== "running").length;
    if (done >= expected) break;
    await sleep(500);
  }
  ok(done === expected, `all ${expected} builds completed and are recorded in the shared run store`);

  // The stateless UI reads runs from the index, scoped by identity/team.
  const uiProc = spawn(process.execPath, [CLI, "ui", REPO], { env: { ...process.env, PORT: "18312", HARNESS_RUN_INDEX_URL: RUNINDEX }, stdio: "ignore" });
  children.push(uiProc);
  await sleep(1500);
  const UIBASE = "http://127.0.0.1:18312";

  const apiRuns = (identity) => getJson(`${UIBASE}/api/runs`, identity ? { "x-firm-identity": identity } : {});

  // carol is alone on team "risk" -> pure owner scoping: she sees only her own.
  const carol = await apiRuns("carol@firm.local");
  ok(carol.runs.length === 1 && carol.runs[0].owner === "carol@firm.local", "UI: carol (solo team) sees exactly her 1 app — owner-scoped, from the shared store");
  // alice is on team fsi with bob -> she sees the FSI shelf (her 2 + bob's 2), not carol's.
  const alice = await apiRuns("alice@firm.local");
  const aliceOwners = new Set(alice.runs.map((r) => r.owner));
  ok(alice.runs.length === 4 && aliceOwners.has("alice@firm.local") && aliceOwners.has("bob@firm.local") && !aliceOwners.has("carol@firm.local"),
    "UI: alice sees the FSI team shelf (her 2 + bob's 2), never carol's app");
  // bob is on team fsi (via TEAMS_JSON) -> sees his own + alice's (team shelf), not carol's (risk).
  const bob = await apiRuns("bob@firm.local");
  const bobOwners = new Set(bob.runs.map((r) => r.owner));
  ok(bob.runs.length === 4 && bobOwners.has("alice@firm.local") && bobOwners.has("bob@firm.local") && !bobOwners.has("carol@firm.local"),
    "UI: bob sees the FSI team shelf (his 2 + alice's 2), never carol's private-team app");
  // admin/unscoped
  const admin = await apiRuns(null);
  ok(admin.runs.length === expected, `UI: unscoped view shows all ${expected} runs`);

  console.log(`\n${failed ? failed + " FAILED" : "ALL PASS"} — stateless UI + shared run store + builder controller: many users, many apps, scoped per user & team.`);
  for (const c of children) try { c.kill(); } catch { /* */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  for (const c of children) try { c.kill(); } catch { /* */ }
  process.exit(1);
});
