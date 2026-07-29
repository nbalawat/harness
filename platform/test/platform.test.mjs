// Platform services end-to-end: real HTTP against the actual servers —
// collector (DF-3), gateway (DF-2), registry/gallery (DF-4) — plus the CLI
// integrations (`harness publish` of the REAL fsi-kyc-desk workspace,
// telemetry queue -> collector sync). No mocks of our own code; the only
// fake is the model upstream behind the gateway.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO, "packages/cli/dist/index.js");
const ID_HEADER = { "x-firm-identity": "test.user@firm.local" };

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `harness-platform-${prefix}-`));
}

const children = [];
async function startService(script, env) {
  const child = spawn(process.execPath, [path.join(REPO, script)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const port = env.PORT;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return `http://127.0.0.1:${port}`;
    } catch {
      /* booting */
    }
  }
  throw new Error(`service ${script} did not boot:\n${log}`);
}
after(() => children.forEach((c) => c.kill()));

// ---------------------------------------------------------------------------
// telemetry-collector
// ---------------------------------------------------------------------------

let collector;
before(async () => {
  collector = await startService("platform/collector/server.mjs", { PORT: "18091", STORE: tmpDir("coll") });
});

test("collector: validates events, stores good ones, reports fleet aggregates", async () => {
  const batch = {
    events: [
      { ts: new Date().toISOString(), event: "run.completed", projectType: "agentic-app", version: "0.9.0", costUsd: 111.68, mock: false },
      { ts: new Date().toISOString(), event: "run.failed", projectType: "agentic-app", version: "0.9.0", nodeId: "slice-2" },
      { ts: new Date().toISOString(), event: "budget.blocked", projectType: "agentic-app", version: "0.9.0" },
      { ts: "not-a-date", event: "run.completed", projectType: "x", version: "1" }, // bad ts
      { event: "run.completed", projectType: "x", version: "1" }, // missing ts
      { ts: new Date().toISOString(), event: "made.up", projectType: "x", version: "1" }, // unknown kind
    ],
  };
  const res = await fetch(`${collector}/v1/events`, { method: "POST", headers: ID_HEADER, body: JSON.stringify(batch) });
  const data = await res.json();
  assert.equal(data.accepted, 3);
  assert.equal(data.rejected.length, 3, "malformed events are rejected individually, not the whole batch");

  const fleet = await (await fetch(`${collector}/v1/fleet`)).json();
  const aa = fleet.types.find((t) => t.typeVersion === "agentic-app@0.9.0");
  assert.equal(aa.runsCompleted, 1);
  assert.equal(aa.runsFailed, 1);
  assert.equal(aa.liveRuns, 1);
  assert.equal(aa.budgetBlocks, 1);
  assert.equal(aa.costUsd, 111.68);
  assert.equal(aa.completionRate, 0.5);
  assert.deepEqual(aa.failureParetoByNode, { "slice-2": 1 }, "failure Pareto by node feeds the platform team's fix-the-type loop");
  assert.equal(fleet.distinctUsers, 1);
});

test("collector: anonymous posts are rejected when identity is required", async () => {
  const res = await fetch(`${collector}/v1/events`, { method: "POST", body: JSON.stringify({ events: [] }) });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// llm-gateway (fake Anthropic-compatible upstream; everything else real)
// ---------------------------------------------------------------------------

let gateway;
let upstreamHits = 0;
before(async () => {
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const wantStream = JSON.parse(body).stream === true;
      if (wantStream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"output_tokens":0}}}\n\n');
        res.write('data: {"type":"content_block_delta","delta":{"text":"streamed reply"}}\n\n');
        res.write('data: {"type":"message_delta","usage":{"output_tokens":2000}}\n\n');
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: "hello from fake model" }], usage: { input_tokens: 500000, output_tokens: 100000 } }));
      }
    });
  });
  await new Promise((r) => upstream.listen(18092, r));
  children.push({ kill: () => upstream.close() });
  gateway = await startService("platform/gateway/server.mjs", {
    PORT: "18093",
    UPSTREAM_URL: "http://127.0.0.1:18092",
    USAGE_LOG: path.join(tmpDir("gw"), "usage.jsonl"),
    QUOTA_USD_DAILY: "2", // tiny: first call allowed at $0 spent; after its $3 the next blocks
    MODEL_ALLOWLIST: "claude-",
  });
});

function askGateway(payload, headers = {}) {
  return fetch(`${gateway}/v1/messages`, {
    method: "POST",
    headers: { ...ID_HEADER, ...headers },
    body: JSON.stringify(payload),
  });
}

test("gateway: enforces identity, allow-list, quota; meters usage joinable to runs", async () => {
  // no identity -> 401
  const anon = await fetch(`${gateway}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5" }) });
  assert.equal(anon.status, 401);

  // disallowed model -> 403, never reaches the upstream
  const hitsBefore = upstreamHits;
  const banned = await askGateway({ model: "gpt-9", messages: [] });
  assert.equal(banned.status, 403);
  assert.equal(upstreamHits, hitsBefore, "blocked calls never touch the model");

  // allowed -> passthrough + metered ($3.00: 500k in @ $3 + 100k out @ $15 for sonnet)
  const ok = await askGateway({ model: "claude-sonnet-5", messages: [] }, { "x-harness-run-id": "run-42", "x-harness-node-id": "slice-1" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).content[0].text, "hello from fake model");

  const usage = await (await fetch(`${gateway}/v1/usage?identity=test.user@firm.local`)).json();
  assert.equal(usage.requests, 1);
  assert.equal(usage.costUsd, 3.0, "gateway-metered cost matches the price table");
  assert.equal(usage.rows[0].runId, "run-42", "usage rows join to fleet telemetry via run id");
  assert.equal(usage.rows[0].nodeId, "slice-1");

  // $3 already spent >= $2 quota -> 429 before the upstream
  const hits2 = upstreamHits;
  const blocked = await askGateway({ model: "claude-sonnet-5", messages: [] });
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /quota/);
  assert.equal(upstreamHits, hits2, "quota blocks never spend upstream tokens");
});

test("gateway: streaming passes through byte-for-byte and still meters usage", async () => {
  gateway = await startService("platform/gateway/server.mjs", {
    PORT: "18094",
    UPSTREAM_URL: "http://127.0.0.1:18092",
    USAGE_LOG: path.join(tmpDir("gw2"), "usage.jsonl"),
    QUOTA_USD_DAILY: "50",
  });
  const res = await askGateway({ model: "claude-haiku-4-5", stream: true, messages: [] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /event-stream/);
  const text = await res.text();
  assert.ok(text.includes("streamed reply"), "SSE frames intact through the proxy");
  assert.ok(text.includes("[DONE]"));
  const usage = await (await fetch(`${gateway}/v1/usage`)).json();
  assert.equal(usage.requests, 1);
  // haiku: 1000 in @ $1/M + 2000 out @ $5/M = 0.001 + 0.01
  assert.equal(usage.costUsd, 0.011, "usage extracted from the SSE frames");
});

// ---------------------------------------------------------------------------
// app-registry + gallery, fed by the REAL fsi-kyc-desk workspace via the CLI
// ---------------------------------------------------------------------------

let registry;
before(async () => {
  registry = await startService("platform/registry/server.mjs", { PORT: "18095", STORE: tmpDir("reg") });
});

test("publish rejects an evidence-free pack — a gallery entry is proof, not a claim", async () => {
  const res = await fetch(`${registry}/v1/publish`, {
    method: "POST",
    headers: ID_HEADER,
    body: JSON.stringify({ name: "vapor", projectType: "agentic-app", version: "0.9.0", files: { "README.md": Buffer.from("trust me").toString("base64") } }),
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /evidence missing/);
});

test("harness publish: the real KYC workspace lands in the gallery with evidence-derived badges", async (t) => {
  const ws = path.join(REPO, "fsi-kyc-desk");
  if (!fs.existsSync(path.join(ws, "journal.jsonl"))) return t.skip("fsi-kyc-desk workspace not present");

  const out = spawnSync(process.execPath, [CLI, "publish", ws, "--registry-url", registry, "--team", "fsi-onboarding"], {
    encoding: "utf8",
    cwd: REPO,
  });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /published 'KYC Review Desk' as kyc-review-desk v1/);

  const detail = await (await fetch(`${registry}/v1/apps/kyc-review-desk`)).json();
  assert.equal(detail.latest.projectType, "agentic-app");
  assert.equal(detail.latest.team, "fsi-onboarding");
  // Badges derived from the workspace's actual evidence: 54-check acceptance
  // ledger green, 0 security highs, 95/95 RTM, completed journal.
  for (const badge of ["acceptance-green", "security-clean", "rtm-covered", "build-completed"]) {
    assert.ok(detail.latest.badges.includes(badge), `expected badge ${badge}, got: ${detail.latest.badges}`);
  }
  assert.ok(detail.latest.evidenceFiles.includes("governance.json"));
  assert.ok(detail.latest.evidenceFiles.some((f) => f.startsWith("screenshots/")), "slice screenshots shipped");

  // The gallery page shows it; the evidence screenshot is fetchable and immutable.
  const gallery = await (await fetch(`${registry}/gallery`)).text();
  assert.ok(gallery.includes("KYC Review Desk"));
  const shot = await fetch(`${registry}/evidence/kyc-review-desk/1/${detail.latest.screenshot}`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/png");
  assert.match(shot.headers.get("cache-control"), /immutable/);

  // Republish -> version 2; version 1 remains (immutability).
  const again = spawnSync(process.execPath, [CLI, "publish", ws, "--registry-url", registry], { encoding: "utf8", cwd: REPO });
  assert.match(again.stdout, /v2/);
  const detail2 = await (await fetch(`${registry}/v1/apps/kyc-review-desk`)).json();
  assert.equal(detail2.versions.length, 2);
  assert.equal(detail2.versions[0].publishedVersion, 1, "published evidence is never overwritten");
});

// ---------------------------------------------------------------------------
// CLI telemetry queue -> collector (DF-3 end to end)
// ---------------------------------------------------------------------------

test("a mock run queues fleet events locally and syncs them to the collector", async () => {
  const home = tmpDir("home");
  const wsDir = tmpDir("runs");
  const env = {
    ...process.env,
    HARNESS_HOME: home,
    HARNESS_TELEMETRY_URL: collector,
    HARNESS_IDENTITY: "builder.jane@firm.local",
  };
  const demo = path.join(REPO, "project-types/demo");
  const run = spawnSync(
    process.execPath,
    [CLI, "run", demo, "--workspace", path.join(wsDir, "d1"), "--answers", path.join(demo, "fixtures/answers.json"), "--mock-agents", "--accept-defaults"],
    { encoding: "utf8", cwd: REPO, env },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);

  // The run auto-synced: queue drained, event visible in the fleet feed.
  const queue = fs.readFileSync(path.join(home, "telemetry-queue.jsonl"), "utf8").trim();
  assert.equal(queue, "", "queue drained after successful sync");
  const fleet = await (await fetch(`${collector}/v1/fleet`)).json();
  const demoRow = fleet.types.find((t) => t.typeVersion.startsWith("demo-pipeline@"));
  assert.ok(demoRow, "demo run visible in fleet aggregates");
  assert.ok(fleet.distinctUsers >= 2, "identity attributed (jane joins the earlier test user)");

  // Offline resilience: with the collector down, events queue and the run still succeeds.
  const env2 = { ...env, HARNESS_TELEMETRY_URL: "http://127.0.0.1:1" };
  const run2 = spawnSync(
    process.execPath,
    [CLI, "run", demo, "--workspace", path.join(wsDir, "d2"), "--answers", path.join(demo, "fixtures/answers.json"), "--mock-agents", "--accept-defaults"],
    { encoding: "utf8", cwd: REPO, env: env2 },
  );
  assert.equal(run2.status, 0, "an unreachable collector never breaks a build");
  const queued = fs.readFileSync(path.join(home, "telemetry-queue.jsonl"), "utf8").trim().split("\n");
  assert.equal(queued.length, 1, "event stays queued for the next sync");

  // Explicit sync drains it once the collector is back.
  const sync = spawnSync(process.execPath, [CLI, "telemetry", "--sync"], { encoding: "utf8", cwd: REPO, env });
  assert.match(sync.stdout, /synced 1 event/);
});
