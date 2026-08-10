#!/usr/bin/env node
// run-index — the shared, per-user run store that makes the hosted dashboard
// STATELESS and multi-tenant. Instead of scanning a local directory (single
// machine), the UI reads runs from here, scoped to the caller's identity + teams.
// Any UI instance can serve any user, so the front door scales out horizontally.
//
// File-backed locally (this file); in prod the same HTTP contract is projected
// onto DynamoDB (run metadata) + S3 (artifacts/evidence) — one item per run,
// keyed by owner, so a scoped list is an indexed query, not a filesystem walk.
//
//   POST /v1/runs        upsert a run  {runId, owner, team, name, appName,
//                        projectType, status, progress, updatedAt, thumb, needsYou}
//   GET  /v1/runs        list runs the caller may see (owner OR team); ?all=1 = admin
//   GET  /v1/runs/<id>   one run (owner/team enforced)
//   GET  /healthz
//
// Identity from x-amzn-oidc-identity | x-goog-authenticated-user-email |
// x-firm-identity. Teams via TEAMS_JSON (identity -> [teams]).
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number(process.env.PORT ?? 8083);
const STORE = process.env.STORE ?? path.join(process.cwd(), "runindex-store");
const REQUIRE_IDENTITY = process.env.REQUIRE_IDENTITY !== "0";
const TEAMS = process.env.TEAMS_JSON ? JSON.parse(process.env.TEAMS_JSON) : {};
fs.mkdirSync(STORE, { recursive: true });
const FILE = path.join(STORE, "runs.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}
function save(map) {
  fs.writeFileSync(FILE, JSON.stringify(map));
}
function identityOf(req) {
  return req.headers["x-amzn-oidc-identity"] ?? req.headers["x-goog-authenticated-user-email"] ?? req.headers["x-firm-identity"] ?? null;
}
function teamsOf(identity) {
  return new Set(TEAMS[identity] ?? []);
}
function canSee(run, identity, teams) {
  if (identity && run.owner === identity) return true;
  return Boolean(run.team) && teams.has(run.team);
}
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" || url.pathname === "/health") return json(res, 200, { ok: true });

  if (url.pathname === "/v1/runs" && req.method === "POST") {
    const identity = identityOf(req);
    if (REQUIRE_IDENTITY && !identity) return json(res, 401, { error: "identity required" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 200_000) req.destroy();
    });
    req.on("end", () => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      if (!p.runId) return json(res, 400, { error: "missing runId" });
      const map = load();
      const prev = map[p.runId] ?? {};
      // A caller may only write runs they own (owner defaults to their identity).
      const owner = prev.owner ?? p.owner ?? identity;
      if (identity && owner !== identity && REQUIRE_IDENTITY) return json(res, 403, { error: "not your run" });
      map[p.runId] = {
        ...prev,
        ...p,
        owner,
        team: p.team ?? prev.team ?? null,
        updatedAt: p.updatedAt ?? new Date().toISOString(),
      };
      save(map);
      return json(res, 200, { ok: true, runId: p.runId });
    });
    return;
  }

  if (url.pathname === "/v1/runs" && req.method === "GET") {
    const identity = identityOf(req);
    const teams = teamsOf(identity);
    const all = url.searchParams.get("all") === "1"; // admin/local unscoped view
    // Optional filters: scope=individual|team (mine-solo vs any team project),
    // team=<name> (one specific team's shelf — must be a team you're on).
    const scope = url.searchParams.get("scope");
    const teamFilter = url.searchParams.get("team");
    let runs = Object.values(load());
    if (!all) runs = runs.filter((r) => canSee(r, identity, teams));
    // Tag each run's scope relative to the viewer so the UI can label it.
    runs = runs.map((r) => ({
      ...r,
      scope: r.team ? "team" : "individual",
      mine: r.owner === identity,
    }));
    if (scope === "individual") runs = runs.filter((r) => r.scope === "individual" && r.mine);
    else if (scope === "team") runs = runs.filter((r) => r.scope === "team");
    if (teamFilter) runs = runs.filter((r) => r.team === teamFilter && teams.has(teamFilter));
    runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // Echo who the viewer is and which teams they belong to, so the UI can show
    // "You're on: fsi, risk" and offer a per-team filter.
    return json(res, 200, { runs, viewer: identity, teams: [...teams] });
  }

  const one = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
  if (one && req.method === "GET") {
    const run = load()[decodeURIComponent(one[1])];
    if (!run) return json(res, 404, { error: "unknown run" });
    const identity = identityOf(req);
    if (REQUIRE_IDENTITY && !canSee(run, identity, teamsOf(identity))) return json(res, 403, { error: "not shared with you" });
    return json(res, 200, { run });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`run-index on :${PORT} store=${STORE}`));
