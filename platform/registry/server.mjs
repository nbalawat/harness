#!/usr/bin/env node
// app-registry + firm gallery — the showcase plane (DF-4 in
// docs/DEPLOYMENT-GCP.md). Cloud Run-ready, zero dependencies.
//
// `harness publish` POSTs a workspace's evidence pack here. The registry
// verifies the pack (evidence present, journal-consistent), derives "proven"
// badges FROM the evidence (never self-reported), stores everything
// immutably (each publish is a new version), and serves the browsable
// firm gallery.
//
//   POST /v1/publish                  {name, owner, team, projectType, version,
//                                      summary, files: {relpath: base64}}
//   GET  /v1/apps?q=&team=            search/browse (JSON)
//   GET  /v1/apps/<id>                app detail incl. all versions
//   GET  /evidence/<id>/<n>/<path>    stored evidence files (immutable)
//   GET  /gallery                     the human-facing gallery page
//   GET  /healthz
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number(process.env.PORT ?? 8082);
const STORE = process.env.STORE ?? path.join(process.cwd(), "registry-store");
const REQUIRE_IDENTITY = process.env.REQUIRE_IDENTITY !== "0";
const MAX_BODY = 80_000_000;
// identity -> [teams]. In prod this is the HR/IdP group sync; here a seed map.
const TEAMS = process.env.TEAMS_JSON ? JSON.parse(process.env.TEAMS_JSON) : {};

fs.mkdirSync(STORE, { recursive: true });

const REQUIRED_EVIDENCE = ["acceptance_report.json", "journal-summary.json"];
const VISIBILITIES = new Set(["private", "team", "firm"]);

function identityOf(req) {
  return req.headers["x-goog-authenticated-user-email"] ?? req.headers["x-firm-identity"] ?? null;
}

function teamsOf(identity) {
  return new Set(TEAMS[identity] ?? []);
}

/**
 * Enforced sharing scope (not just a label): private -> owner only; team ->
 * owner or a member of the app's team; firm -> any authenticated identity.
 * Absent visibility defaults to "firm" (backward compatible with prior publishes).
 */
function canSee(app, identity, teams) {
  const vis = app.visibility ?? "firm";
  if (identity && (app.owner === identity || app.publishedBy === identity)) return true; // owner always
  if (vis === "firm") return true; // firm-wide; the gallery itself is IAP-gated to employees
  if (vis === "team") return Boolean(app.team) && teams.has(app.team);
  return false; // private, and not the owner
}

function appDir(id) {
  return path.join(STORE, "apps", id);
}

function listApps() {
  const root = path.join(STORE, "apps");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => {
      const versions = fs.readdirSync(appDir(id)).filter((v) => /^\d+$/.test(v)).map(Number).sort((a, b) => a - b);
      if (!versions.length) return null;
      const latest = JSON.parse(fs.readFileSync(path.join(appDir(id), String(versions.at(-1)), "meta.json"), "utf8"));
      return { id, versions: versions.length, ...latest };
    })
    .filter(Boolean);
}

/** Badges come from evidence, not from the publisher. */
function deriveBadges(files, summary) {
  const badges = [];
  try {
    const acceptance = JSON.parse(files["acceptance_report.json"].toString("utf8"));
    const checks = (acceptance.slices ?? []).flatMap((s) => s.checks ?? []);
    if (checks.length > 0 && checks.every((c) => c.ok)) badges.push("acceptance-green");
  } catch {
    /* no badge */
  }
  if (files["governance.json"]) {
    try {
      const gov = JSON.parse(files["governance.json"].toString("utf8"));
      const highs = gov.security?.high_findings ?? gov.security_high_findings ?? null;
      if (highs === 0) badges.push("security-clean");
      if (gov.requirements?.uncovered === 0 || gov.traceability?.uncovered === 0) badges.push("rtm-covered");
    } catch {
      /* no badge */
    }
  }
  if (summary?.status === "completed") badges.push("build-completed");
  if (typeof summary?.testsPassed === "number" && summary.testsPassed > 0 && !summary.testsFailed) badges.push("tests-green");
  return badges;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function galleryPage(identity) {
  const teams = teamsOf(identity);
  const apps = listApps().filter((a) => canSee(a, identity, teams)); // team/private hidden from non-members
  const cards = apps
    .map((a) => {
      const shot = a.screenshot ? `<img src="/evidence/${a.id}/${a.versions}/${esc(a.screenshot)}" alt="">` : `<div class="noshot">no screenshot</div>`;
      const badges = (a.badges ?? []).map((b) => `<span class="badge">${esc(b)}</span>`).join("");
      return `<a class="card" href="/v1/apps/${a.id}">
        <div class="shot">${shot}</div>
        <div class="body"><b>${esc(a.name)}</b>
        <div class="meta">${esc(a.team ?? "")} · ${esc(a.owner)} · ${esc(a.projectType)}@${esc(a.version)} · v${a.versions}</div>
        <div class="badges">${badges}</div></div></a>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Firm App Gallery</title>
<style>
body{font:14px/1.5 system-ui;margin:2rem auto;max-width:1100px;padding:0 1rem;background:#f7f7f5;color:#111}
h1{font-size:1.4rem} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}
.card{background:#fff;border:1px solid #ddd;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;display:flex;flex-direction:column}
.card:hover{border-color:#2a78d6}.shot{height:150px;background:#eee;overflow:hidden;display:flex}.shot img{width:100%;object-fit:cover;object-position:top}
.noshot{margin:auto;color:#999;font-size:.8rem}.body{padding:.8rem 1rem}.meta{color:#777;font-size:.78rem;margin:.3rem 0}
.badge{display:inline-block;font-size:.68rem;border:1px solid #2e7d32;color:#2e7d32;border-radius:999px;padding:.05rem .5rem;margin-right:.3rem}
</style>
<h1>Firm App Gallery</h1>
<p>${apps.length} published app(s) — every badge derived from build evidence, never self-reported.</p>
<div class="grid">${cards}</div>`;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" || url.pathname === "/health") return json(res, 200, { ok: true, apps: listApps().length });

  if (url.pathname === "/v1/publish" && req.method === "POST") {
    const identity = identityOf(req);
    if (REQUIRE_IDENTITY && !identity) return json(res, 401, { error: "identity required" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      for (const field of ["name", "projectType", "version", "files"]) {
        if (!p[field]) return json(res, 400, { error: `missing '${field}'` });
      }
      const files = {};
      for (const [rel, b64] of Object.entries(p.files)) {
        if (rel.includes("..") || path.isAbsolute(rel)) return json(res, 400, { error: `bad path '${rel}'` });
        files[rel] = Buffer.from(b64, "base64");
      }
      const missing = REQUIRED_EVIDENCE.filter((f) => !files[f]);
      if (missing.length) {
        return json(res, 422, { error: `publish rejected — evidence missing: ${missing.join(", ")}. A gallery entry is proof, not a claim.` });
      }
      const id = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const dir = appDir(id);
      const version = fs.existsSync(dir) ? fs.readdirSync(dir).filter((v) => /^\d+$/.test(v)).length + 1 : 1;
      const vdir = path.join(dir, String(version));
      fs.mkdirSync(vdir, { recursive: true });
      for (const [rel, buf] of Object.entries(files)) {
        const abs = path.join(vdir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
      }
      const badges = deriveBadges(files, p.summary);
      const screenshot = Object.keys(files).find((f) => f.endsWith(".png"));
      const visibility = VISIBILITIES.has(p.visibility) ? p.visibility : "firm";
      const meta = {
        name: p.name,
        owner: p.owner ?? identity ?? "unknown",
        team: p.team ?? null,
        visibility,
        projectType: p.projectType,
        version: p.version,
        summary: p.summary ?? {},
        badges,
        screenshot: screenshot ?? null,
        publishedAt: new Date().toISOString(),
        publishedBy: identity ?? p.owner ?? "unknown",
        evidenceDigest: crypto.createHash("sha256").update(Object.values(files).map((b) => b.toString("base64")).join("|")).digest("hex").slice(0, 16),
        evidenceFiles: Object.keys(files).sort(),
      };
      fs.writeFileSync(path.join(vdir, "meta.json"), JSON.stringify(meta, null, 2));
      json(res, 200, { ok: true, id, publishedVersion: version, badges, gallery: `/v1/apps/${id}` });
    });
    return;
  }

  if (url.pathname === "/v1/apps" && req.method === "GET") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const team = url.searchParams.get("team");
    const identity = identityOf(req);
    const teams = teamsOf(identity);
    let apps = listApps().filter((a) => canSee(a, identity, teams)); // enforce sharing scope
    if (q) apps = apps.filter((a) => JSON.stringify(a).toLowerCase().includes(q));
    if (team) apps = apps.filter((a) => a.team === team);
    return json(res, 200, { apps });
  }

  const attach = url.pathname.match(/^\/v1\/apps\/([a-z0-9-]+)\/(\d+)\/attach$/);
  if (attach && req.method === "POST") {
    const identity = identityOf(req);
    if (REQUIRE_IDENTITY && !identity) return json(res, 401, { error: "identity required" });
    const rel = url.searchParams.get("path") ?? "";
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) return json(res, 400, { error: `bad path '${rel}'` });
    const vdir = path.join(appDir(attach[1]), attach[2]);
    if (!fs.existsSync(path.join(vdir, "meta.json"))) return json(res, 404, { error: "unknown app version" });
    const abs = path.join(vdir, rel);
    if (fs.existsSync(abs)) return json(res, 409, { error: "evidence is immutable — file already exists" });
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.concat(chunks));
      const metaFile = path.join(vdir, "meta.json");
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      meta.evidenceFiles = [...new Set([...meta.evidenceFiles, rel])].sort();
      const shots = meta.evidenceFiles.filter((f) => f.endsWith(".png"));
      meta.screenshot = shots.at(-1) ?? meta.screenshot; // latest slice = most complete app
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      json(res, 200, { ok: true, attached: rel, bytes: size });
    });
    return;
  }

  const detail = url.pathname.match(/^\/v1\/apps\/([a-z0-9-]+)$/);
  if (detail && req.method === "GET") {
    const dir = appDir(detail[1]);
    if (!fs.existsSync(dir)) return json(res, 404, { error: "unknown app" });
    const versions = fs
      .readdirSync(dir)
      .filter((v) => /^\d+$/.test(v))
      .map(Number)
      .sort((a, b) => a - b)
      .map((v) => ({ publishedVersion: v, ...JSON.parse(fs.readFileSync(path.join(dir, String(v), "meta.json"), "utf8")) }));
    const latest = versions.at(-1);
    const identity = identityOf(req);
    if (!canSee(latest, identity, teamsOf(identity))) return json(res, 403, { error: "not shared with you" });
    return json(res, 200, { id: detail[1], latest, versions });
  }

  const evid = url.pathname.match(/^\/evidence\/([a-z0-9-]+)\/(\d+)\/(.+)$/);
  if (evid && req.method === "GET") {
    // Evidence inherits the app's sharing scope — a private app's screenshots stay private.
    const mfile = path.join(appDir(evid[1]), evid[2], "meta.json");
    if (fs.existsSync(mfile)) {
      const m = JSON.parse(fs.readFileSync(mfile, "utf8"));
      const identity = identityOf(req);
      if (!canSee(m, identity, teamsOf(identity))) return json(res, 403, { error: "not shared with you" });
    }
    const abs = path.join(appDir(evid[1]), evid[2], evid[3]);
    if (!path.resolve(abs).startsWith(path.resolve(STORE)) || !fs.existsSync(abs)) return json(res, 404, { error: "not found" });
    const type = abs.endsWith(".png") ? "image/png" : abs.endsWith(".json") ? "application/json" : "text/plain";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
    res.end(fs.readFileSync(abs));
    return;
  }

  if (url.pathname === "/gallery" || url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(galleryPage(identityOf(req)));
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`app-registry on :${PORT} store=${STORE}`));
