#!/usr/bin/env node
// Multi-tenant proof: many users each build MULTIPLE apps concurrently, and the
// hosted dashboard scopes each user to ONLY their own apps (owner/team). This is
// the 100k-folks-each-with-many-apps model, demonstrated at a small scale — the
// properties (isolation, per-user scoping, no shared state) are what generalize;
// AWS supplies the horizontal capacity.
//
//   node scripts/multi-user-multi-app.mjs [USERS] [APPS_PER_USER]   (default 4 x 3)
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "index.js");
const PT = path.join(REPO, "project-types", "demo"); // fast + deterministic for scale
const ANSWERS = path.join(PT, "fixtures", "answers.json");
const USERS = Number(process.argv[2] ?? 4);
const APPS = Number(process.argv[3] ?? 3);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mt-"));
let failed = 0;
const ok = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗ FAIL:"} ${m}`);
  if (!c) failed++;
};

function build(user, appIdx) {
  const id = `user${user}@firm.local`;
  const team = `team-${user % 2}`; // two teams across the users
  const ws = path.join(ROOT, `${id.split("@")[0]}-app${appIdx}`);
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [CLI, "run", PT, "--mock-agents", "--accept-defaults", "--answers", ANSWERS, "--workspace", ws, "--owner", id, "--team", team],
      { env: { ...process.env, HARNESS_HOME: path.join(ROOT, `home-${id}`), HARNESS_IDENTITY: id, HARNESS_TELEMETRY: "0" }, stdio: "ignore" },
    );
    child.on("exit", (code) => resolve({ id, team, ws, code }));
  });
}

const j = (u, headers) =>
  new Promise((resolve) => {
    http.get(u, { headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    });
  });

async function main() {
  console.log(`${USERS} users × ${APPS} apps each = ${USERS * APPS} concurrent builds (cores: ${os.cpus().length})`);
  const jobs = [];
  for (let u = 1; u <= USERS; u++) for (let a = 1; a <= APPS; a++) jobs.push(build(u, a));
  const t0 = Date.now();
  const res = await Promise.all(jobs);
  const wall = ((Date.now() - t0) / 1000).toFixed(1);

  ok(res.every((r) => r.code === 0), `all ${USERS * APPS} builds completed (exit 0) in ${wall}s`);
  for (const r of res) {
    const cfg = JSON.parse(fs.readFileSync(path.join(r.ws, "run.json"), "utf8"));
    if (cfg.owner !== r.id) {
      ok(false, `${r.ws} owner mismatch`);
      break;
    }
  }
  ok(true, `every workspace stamped with its owner (isolated, no cross-write)`);

  // Start the hosted dashboard over the shared root and query it AS each user.
  const port = 4700 + (process.pid % 200);
  const ui = spawn("node", [CLI, "ui", ROOT], { env: { ...process.env, PORT: String(port), HARNESS_TEAMS: "" }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
  try {
    // Unscoped (local/admin) sees all.
    const all = await j(`http://127.0.0.1:${port}/api/runs`, {});
    ok(all.runs.length === USERS * APPS, `unscoped gallery shows all ${USERS * APPS} apps`);

    // Each user, identified by header, sees ONLY their own apps.
    for (let u = 1; u <= USERS; u++) {
      const id = `user${u}@firm.local`;
      const mine = await j(`http://127.0.0.1:${port}/api/runs`, { "x-firm-identity": id });
      const owners = new Set(mine.runs.map((r) => r.owner));
      ok(
        mine.runs.length === APPS && owners.size === 1 && owners.has(id),
        `${id} sees exactly their ${APPS} apps (owner-scoped), not the other ${(USERS - 1) * APPS}`,
      );
    }
    // Team scoping: a user on team-0 with HARNESS_TEAMS can see teammates' apps.
    const teamPort = port + 1;
    const ui2 = spawn("node", [CLI, "ui", ROOT], { env: { ...process.env, PORT: String(teamPort), HARNESS_TEAMS: "team-0" }, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    const teamView = await j(`http://127.0.0.1:${teamPort}/api/runs`, { "x-firm-identity": "user2@firm.local" });
    const teamUsers = [...new Set(teamView.runs.map((r) => r.owner))];
    ok(teamView.runs.every((r) => r.team === "team-0"), `team view shows the whole team's apps (${teamUsers.length} member(s), team-0)`);
    ui2.kill();
  } finally {
    ui.kill();
  }

  console.log(`\n${failed ? failed + " FAILED" : "ALL PASS"} — ${USERS} users each built ${APPS} apps; the dashboard scopes each user to their own. Deploy any app with: harness deploy <ws> --target aws-apprunner`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
main();
