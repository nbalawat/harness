#!/usr/bin/env node
// builder-controller — turns a "Start build" request into ONE isolated builder
// and registers the run in the shared run-index (so the stateless UI shows it,
// scoped to the owner/team). This is the fan-out point behind the UI: one build
// = one isolated worker, no shared bottleneck.
//
//   POST /v1/builds  {owner, team, projectType, answers, name?}  -> {runId}
//   GET  /healthz
//
// Backends (BUILDER_MODE):
//   local (default) — spawn the engine in a child process (dev / single box)
//   ecs             — `aws ecs run-task` one Fargate task per build (the fleet)
//
// Config: CLI (path to packages/cli/dist/index.js), WORKROOT, RUNINDEX_URL,
//   GATEWAY_URL (optional, injected as ANTHROPIC_BASE_URL for real-agent builds),
//   and for ecs: ECS_CLUSTER, ECS_TASKDEF, ECS_SUBNETS, ECS_SG, ECS_CONTAINER.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const PORT = Number(process.env.PORT ?? 8084);
const MODE = process.env.BUILDER_MODE ?? "local";
const CLI = process.env.CLI ?? path.resolve("packages/cli/dist/index.js");
const WORKROOT = process.env.WORKROOT ?? path.join(os.tmpdir(), "harness-builds");
const RUNINDEX_URL = process.env.RUNINDEX_URL ?? null;
const GATEWAY_URL = process.env.GATEWAY_URL ?? null;
fs.mkdirSync(WORKROOT, { recursive: true });
let seq = 0;

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function identityOf(req) {
  return req.headers["x-amzn-oidc-identity"] ?? req.headers["x-firm-identity"] ?? null;
}
async function register(run, identity) {
  if (!RUNINDEX_URL) return;
  try {
    await fetch(new URL("/v1/runs", RUNINDEX_URL), {
      method: "POST",
      headers: { "content-type": "application/json", "x-firm-identity": identity },
      body: JSON.stringify(run),
    });
  } catch {
    /* run-index best-effort — never blocks a build */
  }
}
function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
function finalState(ws, projectType) {
  const intake = readJson(path.join(ws, "artifacts", "intake", "intake.json"));
  const events = fs.existsSync(path.join(ws, "journal.jsonl"))
    ? fs.readFileSync(path.join(ws, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const committed = new Set(events.filter((e) => e.type === "node.committed").map((e) => e.nodeId)).size;
  const skipped = new Set(events.filter((e) => e.type === "node.skipped").map((e) => e.nodeId)).size;
  const completed = events.some((e) => e.type === "run.completed");
  return {
    appName: (intake?.project_name) ?? path.basename(projectType),
    progress: { done: committed + skipped, total: committed + skipped },
    status: completed ? "completed" : "failed",
  };
}

/** Fetch the caller's Claude engine env from the gateway (Bedrock or Anthropic). */
async function credEnv(owner) {
  if (!GATEWAY_URL) return {};
  try {
    const r = await fetch(new URL("/v1/credential/env", GATEWAY_URL), { headers: { "x-firm-identity": owner } });
    if (!r.ok) return {};
    return (await r.json()).env ?? {};
  } catch {
    return {};
  }
}

async function launchLocal(runId, ws, projectType, answersFile, owner, team) {
  // Inject the caller's resolved credential env: Bedrock (CLAUDE_CODE_USE_BEDROCK
  // + AWS creds/region/model) or Anthropic (ANTHROPIC_BASE_URL -> gateway).
  const env = { ...process.env, HARNESS_IDENTITY: owner, HARNESS_TEAM: team ?? "", HARNESS_TELEMETRY: "0", ...(await credEnv(owner)) };
  const args = [CLI, "run", projectType, "--mock-agents", "--accept-defaults", "--answers", answersFile, "--workspace", ws, "--owner", owner];
  if (team) args.push("--team", team);
  const child = spawn("node", args, { env, stdio: "ignore" });
  child.on("exit", async () => {
    const fin = finalState(ws, projectType);
    await register({ runId, owner, team, projectType, name: fin.appName, appName: fin.appName, status: fin.status, progress: fin.progress }, owner);
  });
}

function launchEcs(runId, projectType, answersB64, owner, team) {
  // One Fargate task per build — the fleet. The task runs the builder image whose
  // entrypoint reads these env vars, runs the engine, and posts to the run-index.
  const overrides = {
    containerOverrides: [{
      name: process.env.ECS_CONTAINER ?? "builder",
      environment: [
        { name: "HARNESS_RUN_ID", value: runId }, { name: "HARNESS_IDENTITY", value: owner },
        { name: "HARNESS_TEAM", value: team ?? "" }, { name: "PROJECT_TYPE", value: projectType },
        { name: "ANSWERS_B64", value: answersB64 }, { name: "RUNINDEX_URL", value: RUNINDEX_URL ?? "" },
        ...(GATEWAY_URL ? [{ name: "ANTHROPIC_BASE_URL", value: GATEWAY_URL }] : []),
      ],
    }],
  };
  const netcfg = { awsvpcConfiguration: { subnets: (process.env.ECS_SUBNETS ?? "").split(","), securityGroups: (process.env.ECS_SG ?? "").split(","), assignPublicIp: "DISABLED" } };
  const args = ["ecs", "run-task", "--cluster", process.env.ECS_CLUSTER ?? "harness-builders", "--launch-type", "FARGATE",
    "--task-definition", process.env.ECS_TASKDEF ?? "harness-builder", "--overrides", JSON.stringify(overrides),
    "--network-configuration", JSON.stringify(netcfg)];
  spawn("aws", args, { stdio: "ignore" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" || url.pathname === "/health") return json(res, 200, { ok: true, mode: MODE });

  if (url.pathname === "/v1/builds" && req.method === "POST") {
    const identity = identityOf(req);
    if (!identity) return json(res, 401, { error: "identity required" });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on("end", async () => {
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const projectType = p.projectType;
      if (!projectType) return json(res, 400, { error: "missing projectType" });
      const owner = p.owner ?? identity;
      const team = p.team ?? null;
      seq += 1;
      const runId = `${owner.split("@")[0]}-${path.basename(projectType)}-${Date.now()}-${seq}`;
      // Register as running immediately so the UI shows it in-flight.
      await register({ runId, owner, team, projectType, name: p.name ?? path.basename(projectType), status: "running", progress: { done: 0, total: 0 } }, owner);

      const ws = path.join(WORKROOT, runId);
      fs.mkdirSync(ws, { recursive: true });
      const answersFile = path.join(ws, "_answers.json");
      fs.writeFileSync(answersFile, JSON.stringify(p.answers ?? {}));
      if (MODE === "ecs") {
        launchEcs(runId, projectType, Buffer.from(JSON.stringify(p.answers ?? {})).toString("base64"), owner, team);
      } else {
        void launchLocal(runId, ws, projectType, answersFile, owner, team);
      }
      return json(res, 202, { ok: true, runId, mode: MODE });
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`builder-controller on :${PORT} mode=${MODE} workroot=${WORKROOT}`));
