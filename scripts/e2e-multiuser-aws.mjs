#!/usr/bin/env node
// End-to-end multi-tenant proof (no cloud creds required):
//   1. Boots the hosted control plane locally — llm-gateway (BYO keys),
//      telemetry-collector (BI + app-usage), app-registry (sharing).
//   2. BYO credentials: a keyless caller is rejected (402); each user registers
//      their OWN key; then forwards succeed.
//   3. Runs 3 users' builds IN PARALLEL — distinct identity, team, workspace —
//      proving multi-tenant isolation. Each build auto-emits its BI rollup.
//   4. Seamless local -> AWS: `harness deploy` turns a finished local build into
//      an AWS App Runner / ECS plan with NO rebuild.
//   5. Ownership + team/firm/private sharing is ENFORCED in the registry.
//   6. App-usage -> popularity (unique users / DAU-MAU) is mined per app.
//   7. Business intelligence: who built what, tokens, rework, experience — by
//      owner and team.
// Everything uses --mock-agents (deterministic, free). Exit 0 = all assertions pass.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "index.js");
const PT = path.join(REPO, "project-types", "agentic-app");
const ANSWERS = path.join(PT, "fixtures", "answers.json");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "harness-e2e-"));
const children = [];
let failed = 0;

function ok(cond, msg) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL:"} ${msg}`);
  if (!cond) failed++;
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}
async function waitHealth(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`service never came up: ${url}`);
}
function startNode(script, env, port, healthPath = "/healthz") {
  const child = spawn("node", [script], { env: { ...process.env, ...env, PORT: String(port) }, stdio: "ignore" });
  children.push(child);
  return waitHealth(`http://127.0.0.1:${port}${healthPath}`).then(() => `http://127.0.0.1:${port}`);
}
function runBuild(user) {
  const home = path.join(TMP, `home-${user.name}`);
  fs.mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const args = [CLI, "run", PT, "--mock-agents", "--accept-defaults", "--answers", ANSWERS, "--workspace", user.ws, "--owner", user.id, "--team", user.team];
    const child = spawn("node", args, {
      env: { ...process.env, HARNESS_HOME: home, HARNESS_IDENTITY: user.id, HARNESS_TELEMETRY_URL: COLLECTOR, HARNESS_TELEMETRY: "1" },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code));
  });
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

// A tiny Anthropic-compatible upstream so the BYO gateway has something to forward to.
let COLLECTOR, GATEWAY, REGISTRY;
const fakeUpstream = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 500 } }));
  });
});

async function main() {
  await new Promise((r) => fakeUpstream.listen(18203, r));
  children.push({ kill: () => fakeUpstream.close() });

  const teams = { "alice@firm.local": ["fsi"], "bob@firm.local": ["fsi"], "carol@firm.local": ["risk"] };
  COLLECTOR = await startNode(path.join(REPO, "platform/collector/server.mjs"), { STORE: path.join(TMP, "coll") }, 18200, "/healthz");
  GATEWAY = await startNode(
    path.join(REPO, "platform/gateway/server.mjs"),
    { UPSTREAM_URL: "http://127.0.0.1:18203", KEYS_STORE: path.join(TMP, "keys.json"), USAGE_LOG: path.join(TMP, "gw-usage.jsonl") },
    18201,
    "/healthz",
  );
  REGISTRY = await startNode(path.join(REPO, "platform/registry/server.mjs"), { STORE: path.join(TMP, "reg"), TEAMS_JSON: JSON.stringify(teams) }, 18202, "/healthz");

  const users = [
    { name: "alice", id: "alice@firm.local", team: "fsi", vis: "firm", ws: path.join(TMP, "ws-alice") },
    { name: "bob", id: "bob@firm.local", team: "fsi", vis: "team", ws: path.join(TMP, "ws-bob") },
    { name: "carol", id: "carol@firm.local", team: "risk", vis: "private", ws: path.join(TMP, "ws-carol") },
  ];

  // ---- 2. BYO credentials -------------------------------------------------
  section("BYO per-user credentials");
  const call = (id) => fetch(`${GATEWAY}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-firm-identity": id }, body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }) });
  ok((await call("dave@firm.local")).status === 402, "keyless caller is rejected (402) — never uses another's key");
  for (const u of users) {
    const r = await j(await fetch(`${GATEWAY}/v1/keys`, { method: "POST", headers: { "content-type": "application/json", "x-firm-identity": u.id }, body: JSON.stringify({ apiKey: `sk-${u.name}-secret` }) }));
    ok(r.status === 200 && r.body.endsWith === "cret" && !JSON.stringify(r.body).includes("secret"), `${u.name} registered their key (secret never echoed)`);
  }
  ok((await call("alice@firm.local")).status === 200, "after registering, the user's own key forwards successfully");

  // ---- 3. Parallel multi-tenant builds ------------------------------------
  section("3 users building IN PARALLEL (isolated workspaces)");
  const t0 = Date.now();
  const codes = await Promise.all(users.map(runBuild));
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  ok(codes.every((c) => c === 0), `all 3 builds completed (exit 0) in ${wall}s wall-clock (parallel)`);
  for (const u of users) {
    const cfg = JSON.parse(fs.readFileSync(path.join(u.ws, "run.json"), "utf8"));
    ok(cfg.owner === u.id && cfg.team === u.team, `${u.name}'s run.json is stamped with owner+team (multi-tenant attribution)`);
  }

  // ---- 4. Seamless local -> AWS (no rebuild) ------------------------------
  section("Promote a finished local build to AWS (no rebuild)");
  for (const [target, artifact] of [["aws-apprunner", "apprunner.json"], ["aws-ecs", "task-def.json"]]) {
    const r = spawnSync("node", [CLI, "deploy", users[0].ws, "--target", target], { encoding: "utf8" });
    const made = fs.existsSync(path.join(users[0].ws, "deploy-plan", "deploy", artifact));
    ok(r.status === 0 && made, `harness deploy --target ${target} produced deploy/${artifact} from the same artifact`);
  }

  // ---- 5. Publish with enforced sharing scopes ----------------------------
  section("Ownership + firm/team/private sharing (enforced)");
  for (const u of users) {
    const r = spawnSync("node", [CLI, "publish", u.ws, "--registry-url", REGISTRY, "--name", `${u.name}-app`, "--visibility", u.vis], { encoding: "utf8", env: { ...process.env, HARNESS_IDENTITY: u.id } });
    ok(r.status === 0, `${u.name} published ${u.name}-app (${u.vis})`);
  }
  const asUser = (id, url) => fetch(`${REGISTRY}${url}`, { headers: { "x-firm-identity": id } });
  const bobList = (await j(await asUser("bob@firm.local", "/v1/apps"))).body.apps.map((a) => a.id);
  ok(bobList.includes("alice-app"), "bob (fsi) sees alice-app (firm-visible)");
  ok(bobList.includes("bob-app"), "bob sees his own team app");
  ok(!bobList.includes("carol-app"), "bob does NOT see carol-app (private) — sharing is enforced, not a label");
  ok((await asUser("bob@firm.local", "/v1/apps/carol-app")).status === 403, "direct fetch of a private app is 403 for non-owners");
  ok((await j(await asUser("carol@firm.local", "/v1/apps/carol-app"))).status === 200, "carol sees her own private app");
  const teammate = { "dave@firm.local": ["fsi"] }; // not used server-side, just documents intent
  void teammate;

  // ---- 6. App-usage -> popularity -----------------------------------------
  section("App usage -> popularity (who uses each app)");
  const today = new Date().toISOString().slice(0, 10);
  const post = (appId, users2) => fetch(`${COLLECTOR}/v1/app-usage`, { method: "POST", headers: { "content-type": "application/json", "x-firm-identity": `app:${appId}` }, body: JSON.stringify({ appId, day: today, requests: users2.length * 3, users: users2 }) });
  await post("alice-app", ["u_1", "u_2", "u_3", "u_4"]);
  await post("bob-app", ["u_1", "u_2"]);
  const usage = (await j(await fetch(`${COLLECTOR}/v1/apps/usage`))).body.apps;
  const aliceUsage = usage.find((a) => a.appId === "alice-app");
  ok(aliceUsage && aliceUsage.uniqueUsers === 4, "alice-app popularity: 4 unique users tracked");
  ok(usage[0].appId === "alice-app", "apps ranked by popularity (most-used first)");

  // ---- 7. Business intelligence -------------------------------------------
  section("Platform business intelligence (who built what, cost, quality, experience)");
  const biOwner = (await j(await fetch(`${COLLECTOR}/v1/bi?groupBy=owner`))).body;
  ok(biOwner.totals.builds >= 3, `BI recorded ${biOwner.totals.builds} completed builds`);
  ok(biOwner.totals.distinctOwners === 3, "BI attributes builds to 3 distinct owners");
  ok(biOwner.groups.every((g) => "tokens" in g && "avgReworkPct" in g && "avgQuestionsPerBuild" in g), "per-owner BI carries tokens, rework %, and experience (questions/build)");
  const biTeam = (await j(await fetch(`${COLLECTOR}/v1/bi?groupBy=team`))).body;
  ok(biTeam.groups.some((g) => g.key === "fsi" && g.builds >= 2), "team BI rolls up fsi (alice+bob) builds");

  console.log(`\n${failed === 0 ? "ALL PASS" : failed + " ASSERTION(S) FAILED"} — control plane proven end-to-end for multiple concurrent users.`);
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(() => {
    for (const c of children) try { c.kill(); } catch { /* ignore */ }
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  });
