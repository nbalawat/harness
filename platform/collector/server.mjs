#!/usr/bin/env node
// telemetry-collector — the evidence plane's front door (DF-3 in
// docs/DEPLOYMENT-GCP.md). Cloud Run-ready, zero dependencies.
//
// Receives journal-derived run events from every harness install, validates
// them against the event schema, and stores them append-only. Locally the
// store is a JSONL file; on GCP the same rows stream to BigQuery via Pub/Sub
// (PUBSUB_TOPIC env) — the HTTP contract is identical in both modes.
//
//   POST /v1/events   {events: [...]}  -> {accepted, rejected: [{index, error}]}
//   GET  /v1/fleet    fleet aggregates by type@version (the dashboard feed)
//   GET  /v1/events?since=ISO          raw event tail (platform team debugging)
//   GET  /healthz
//
// Identity: behind IAP the caller identity arrives in
// x-goog-authenticated-user-email; locally x-firm-identity is accepted.
// REQUIRE_IDENTITY=1 (default in prod) rejects anonymous posts.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const STORE = process.env.STORE ?? path.join(process.cwd(), "collector-store");
const REQUIRE_IDENTITY = process.env.REQUIRE_IDENTITY !== "0";
const MAX_BATCH = 500;
const MAX_BODY = 2_000_000;

fs.mkdirSync(STORE, { recursive: true });
const eventsFile = path.join(STORE, "events.jsonl");
const usageFile = path.join(STORE, "app-usage.jsonl");
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC ?? null; // projects/<p>/topics/<t>

/** Access token from the metadata server (the service's own identity on GCP). */
async function gcpToken() {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`metadata token: ${res.status}`);
  return (await res.json()).access_token;
}

/** Publish accepted events to Pub/Sub -> BigQuery subscription (DF-3). */
async function publishToPubsub(events) {
  if (!PUBSUB_TOPIC || !events.length) return;
  try {
    const token = await gcpToken();
    const res = await fetch(`https://pubsub.googleapis.com/v1/${PUBSUB_TOPIC}:publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: events.map((e) => ({ data: Buffer.from(JSON.stringify(e)).toString("base64") })) }),
    });
    if (!res.ok) console.error(`pubsub publish failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`pubsub publish error: ${String(e).slice(0, 200)}`); // local store already has the rows
  }
}

/** The fleet event contract. Extra fields pass through; these are required. */
const REQUIRED = ["ts", "event", "projectType", "version"];
const EVENT_KINDS = new Set([
  "run.started",
  "run.completed",
  "run.parked",
  "run.failed",
  "node.cost",
  "budget.blocked",
  "gate.answered",
  "revision.requested",
  "publish.completed",
]);

function identityOf(req) {
  return (
    req.headers["x-goog-authenticated-user-email"] ??
    req.headers["x-firm-identity"] ??
    null
  );
}

function validate(e) {
  if (typeof e !== "object" || e === null) return "event must be an object";
  for (const k of REQUIRED) {
    if (e[k] === undefined || e[k] === null || e[k] === "") return `missing required field '${k}'`;
  }
  if (!EVENT_KINDS.has(e.event)) return `unknown event kind '${e.event}'`;
  if (Number.isNaN(Date.parse(e.ts))) return `unparseable ts '${e.ts}'`;
  if (e.costUsd !== undefined && typeof e.costUsd !== "number") return "costUsd must be a number";
  return null;
}

function readAll() {
  if (!fs.existsSync(eventsFile)) return [];
  return fs
    .readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The dashboard feed: reliability / cost / adoption per type@version. */
function fleet() {
  const rows = readAll();
  const byType = new Map();
  const users = new Set();
  for (const e of rows) {
    if (e.identity) users.add(e.identity);
    const key = `${e.projectType}@${e.version}`;
    const agg =
      byType.get(key) ??
      {
        typeVersion: key,
        runsStarted: 0,
        runsCompleted: 0,
        runsFailed: 0,
        runsParked: 0,
        liveRuns: 0,
        costUsd: 0,
        budgetBlocks: 0,
        revisions: 0,
        publishes: 0,
        failureParetoByNode: {},
      };
    if (e.event === "run.started") agg.runsStarted += 1;
    if (e.event === "run.completed") {
      agg.runsCompleted += 1;
      if (e.mock === false) agg.liveRuns += 1;
      agg.costUsd += e.costUsd ?? 0;
    }
    if (e.event === "run.parked") agg.runsParked += 1;
    if (e.event === "run.failed") {
      agg.runsFailed += 1;
      if (e.nodeId) agg.failureParetoByNode[e.nodeId] = (agg.failureParetoByNode[e.nodeId] ?? 0) + 1;
    }
    if (e.event === "budget.blocked") agg.budgetBlocks += 1;
    if (e.event === "revision.requested") agg.revisions += 1;
    if (e.event === "publish.completed") agg.publishes += 1;
    byType.set(key, agg);
  }
  const types = [...byType.values()].map((a) => ({
    ...a,
    completionRate: a.runsCompleted + a.runsFailed > 0 ? a.runsCompleted / (a.runsCompleted + a.runsFailed) : null,
    costUsd: Number(a.costUsd.toFixed(4)),
  }));
  return { totalEvents: rows.length, distinctUsers: users.size, types };
}

/**
 * Business intelligence rollup — who built what, at what cost/quality/experience.
 * groupBy: owner | team | projectType. Mines the completed-run rows for tokens,
 * cost, rework %, audit rounds, and the build experience (questions/revisions),
 * and returns leaderboards. This is the "learn across the platform" feed.
 */
function bi(groupBy) {
  const key = ["owner", "team", "projectType"].includes(groupBy) ? groupBy : "owner";
  const rows = readAll().filter((e) => e.event === "run.completed");
  const g = new Map();
  for (const e of rows) {
    const k = e[key] ?? "(none)";
    const a =
      g.get(k) ??
      { key: k, builds: 0, apps: new Set(), costUsd: 0, tokens: 0, reworkPctSum: 0, auditRoundsSum: 0, auditRoundsN: 0, loopDetections: 0, questionsSum: 0, revisionsSum: 0, liveBuilds: 0 };
    a.builds += 1;
    if (e.appName) a.apps.add(e.appName);
    a.costUsd += e.costUsd ?? 0;
    a.tokens += e.totalTokens ?? 0;
    if (typeof e.reworkPct === "number") a.reworkPctSum += e.reworkPct;
    if (typeof e.auditRounds === "number") {
      a.auditRoundsSum += e.auditRounds;
      a.auditRoundsN += 1;
    }
    a.loopDetections += e.loopDetections ?? 0;
    a.questionsSum += e.questionsAnswered ?? 0;
    a.revisionsSum += e.revisions ?? 0;
    if (e.mock === false) a.liveBuilds += 1;
    g.set(k, a);
  }
  const groups = [...g.values()]
    .map((a) => ({
      key: a.key,
      builds: a.builds,
      distinctApps: a.apps.size,
      liveBuilds: a.liveBuilds,
      costUsd: Number(a.costUsd.toFixed(4)),
      tokens: a.tokens,
      avgReworkPct: a.builds ? Math.round(a.reworkPctSum / a.builds) : 0,
      avgAuditRounds: a.auditRoundsN ? Number((a.auditRoundsSum / a.auditRoundsN).toFixed(1)) : null,
      loopDetections: a.loopDetections,
      avgQuestionsPerBuild: a.builds ? Number((a.questionsSum / a.builds).toFixed(1)) : 0,
      revisions: a.revisionsSum,
    }))
    .sort((x, y) => y.builds - x.builds);
  return {
    groupBy: key,
    totals: {
      builds: rows.length,
      distinctOwners: new Set(rows.map((r) => r.owner ?? r.identity)).size,
      costUsd: Number(rows.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)),
      tokens: rows.reduce((s, r) => s + (r.totalTokens ?? 0), 0),
    },
    groups,
  };
}

function usageRowsAll() {
  if (!fs.existsSync(usageFile)) return [];
  return fs.readFileSync(usageFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** App-usage rollup — WHO USES each deployed app (the popularity metric). */
function appsUsage() {
  const rows = usageRowsAll();
  const g = new Map();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  for (const r of rows) {
    const a = g.get(r.appId) ?? { appId: r.appId, requests: 0, users: new Set(), dau: new Set(), mau: new Set(), lastSeen: null };
    a.requests += r.requests ?? 0;
    for (const u of r.users ?? []) {
      a.users.add(u);
      if ((r.day ?? "") >= monthAgo) a.mau.add(u);
      if ((r.day ?? "") === today) a.dau.add(u);
    }
    a.lastSeen = a.lastSeen && a.lastSeen > (r.day ?? "") ? a.lastSeen : r.day ?? a.lastSeen;
    g.set(r.appId, a);
  }
  return [...g.values()]
    .map((a) => ({ appId: a.appId, requests: a.requests, uniqueUsers: a.users.size, dau: a.dau.size, mau: a.mau.size, lastSeen: a.lastSeen }))
    .sort((x, y) => y.uniqueUsers - x.uniqueUsers); // most popular first
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" || url.pathname === "/health") return json(res, 200, { ok: true });

  if (url.pathname === "/v1/events" && req.method === "POST") {
    const identity = identityOf(req);
    if (REQUIRE_IDENTITY && !identity) return json(res, 401, { error: "identity required (IAP header missing)" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const events = Array.isArray(parsed.events) ? parsed.events : null;
      if (!events) return json(res, 400, { error: "body must be {events: [...]}" });
      if (events.length > MAX_BATCH) return json(res, 413, { error: `batch too large (max ${MAX_BATCH})` });
      const rejected = [];
      const lines = [];
      events.forEach((e, index) => {
        const error = validate(e);
        if (error) rejected.push({ index, error });
        else lines.push(JSON.stringify({ ...e, identity: e.identity ?? identity, receivedAt: new Date().toISOString() }));
      });
      if (lines.length) fs.appendFileSync(eventsFile, lines.join("\n") + "\n");
      void publishToPubsub(lines.map((l) => JSON.parse(l)));
      json(res, 200, { accepted: lines.length, rejected });
    });
    return;
  }

  if (url.pathname === "/v1/fleet" && req.method === "GET") return json(res, 200, fleet());

  // Business intelligence: cross-platform rollups (adoption, cost, quality,
  // experience) grouped by owner / team / projectType.
  if (url.pathname === "/v1/bi" && req.method === "GET") return json(res, 200, bi(url.searchParams.get("groupBy") ?? "owner"));

  // App-usage ingest (from the usage-beacon in deployed apps) — who uses what.
  if (url.pathname === "/v1/app-usage" && req.method === "POST") {
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
      if (!p.appId || !p.day) return json(res, 400, { error: "missing appId or day" });
      const row = { appId: String(p.appId), day: String(p.day), requests: Number(p.requests ?? 0), users: Array.isArray(p.users) ? p.users.slice(0, 5000) : [], receivedAt: new Date().toISOString() };
      fs.appendFileSync(usageFile, JSON.stringify(row) + "\n");
      return json(res, 200, { ok: true });
    });
    return;
  }

  // App popularity rollup — unique users, DAU/MAU, request volume, most popular first.
  if (url.pathname === "/v1/apps/usage" && req.method === "GET") return json(res, 200, { apps: appsUsage() });

  if (url.pathname === "/v1/events" && req.method === "GET") {
    const since = url.searchParams.get("since");
    const rows = readAll().filter((e) => !since || e.receivedAt >= since);
    return json(res, 200, { events: rows.slice(-1000) });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`telemetry-collector on :${PORT} store=${STORE}`));
