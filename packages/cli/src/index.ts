#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { Journal, foldState, loadProjectType, loadProjectTypeFile, reconcileInterrupted, reopenFailed, reviseNode, runLoop, type RunContext } from "@harness/runner";

interface RunConfig {
  projectTypeDir: string;
  answersFile?: string;
  mockAgents: boolean;
  acceptDefaults?: boolean;
  /** Who owns this run — enables multi-tenant + team-scoped discovery. Optional
   * (local-only users need nothing); defaults to the OS user @firm.local. */
  owner?: string;
  /** Team this run is built under, when building as a team (team-scoped). */
  team?: string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function loadAnswers(file?: string): Record<string, Record<string, string>> | undefined {
  if (!file) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function buildContext(workspace: string, config: RunConfig): RunContext {
  // A run is pinned to the DAG it started with — the immutability guarantee.
  const snapshot = path.join(workspace, "dag.snapshot.yaml");
  const def = fs.existsSync(snapshot)
    ? loadProjectTypeFile(snapshot)
    : loadProjectType(config.projectTypeDir);
  return {
    workspace,
    projectTypeDir: config.projectTypeDir,
    def,
    journal: new Journal(workspace),
    answers: loadAnswers(config.answersFile),
    mockAgents: config.mockAgents,
    acceptDefaults: config.acceptDefaults === true,
    interactive: process.stdin.isTTY === true,
  };
}

function report(ctx: RunContext, status: string, extra?: string): void {
  const state = foldState(ctx.journal.read());
  console.log(`\nrun ${status}${extra ? ` (${extra})` : ""}`);
  for (const node of ctx.def.nodes) {
    const s = state.committed.has(node.id)
      ? "committed"
      : state.skipped.has(node.id)
        ? "skipped"
        : state.failed.has(node.id)
          ? "FAILED"
          : "pending";
    console.log(`  ${node.id.padEnd(20)} ${node.kind.padEnd(14)} ${s}`);
  }
  console.log(`  total cost: $${state.totalCostUsd.toFixed(4)}`);
  console.log(`  workspace:  ${ctx.workspace}`);
}

async function cmdRun(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  // `harness run name@version` resolves from the local store of certified
  // installs; a path runs directly (authoring mode).
  let projectTypeDir: string;
  if (/^[a-z0-9-]+@[0-9][\w.-]*$/.test(positional[0] ?? "")) {
    const { installedPackageDir } = await import("./registry.js");
    const resolved = installedPackageDir(positional[0]);
    if (!resolved) {
      console.error(`'${positional[0]}' is not installed — run: harness install ${positional[0]} --registry <git-url>`);
      return 1;
    }
    projectTypeDir = resolved;
  } else {
    projectTypeDir = path.resolve(positional[0] ?? ".");
  }
  const workspace = path.resolve((flags.workspace as string) ?? ".harness-run");
  const os = await import("node:os");
  const config: RunConfig = {
    projectTypeDir,
    answersFile: flags.answers ? path.resolve(flags.answers as string) : undefined,
    mockAgents: flags["mock-agents"] === true,
    acceptDefaults: flags["accept-defaults"] === true,
    owner: (flags.owner as string) ?? process.env.HARNESS_IDENTITY ?? `${os.userInfo().username}@firm.local`,
    team: (flags.team as string) ?? process.env.HARNESS_TEAM ?? undefined,
  };

  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "run.json"), JSON.stringify(config, null, 2));
  fs.copyFileSync(path.join(projectTypeDir, "dag.yaml"), path.join(workspace, "dag.snapshot.yaml"));

  const ctx = buildContext(workspace, config);
  ctx.journal.append({
    type: "run.created",
    projectType: ctx.def.name,
    projectTypeVersion: ctx.def.version,
    owner: config.owner,
    team: config.team,
  });
  console.log(`running ${ctx.def.name}@${ctx.def.version} (${ctx.def.nodes.length} nodes)`);

  const result = await runLoop(ctx);
  report(ctx, result.status, result.failedNodeId ?? result.parkedNodeId);
  const tel = await import("./telemetry.js");
  tel.recordRun(ctx, result, "run");
  await tel.syncTelemetry();
  return result.status === "completed" ? 0 : result.status === "parked" ? 0 : 1;
}

async function cmdResume(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const workspace = path.resolve(positional[0] ?? ".harness-run");
  const config = JSON.parse(
    fs.readFileSync(path.join(workspace, "run.json"), "utf8"),
  ) as RunConfig;
  if (flags.answers) config.answersFile = path.resolve(flags.answers as string);
  if (flags["accept-defaults"] === true) config.acceptDefaults = true;

  const ctx = buildContext(workspace, config);
  // Crash/stop recovery: turn any interrupted (dangling-"running") node into a
  // clean failure first, so it's reopened and re-run rather than left hanging.
  const interrupted = reconcileInterrupted(ctx);
  if (interrupted.length > 0) console.log(`recovering interrupted node(s): ${interrupted.join(", ")}`);
  const reopened = reopenFailed(ctx);
  if (reopened.length > 0) console.log(`reopening failed node(s): ${reopened.join(", ")}`);
  console.log(`resuming ${ctx.def.name}@${ctx.def.version}`);
  const result = await runLoop(ctx);
  report(ctx, result.status, result.failedNodeId ?? result.parkedNodeId);
  const tel = await import("./telemetry.js");
  tel.recordRun(ctx, result, "resume");
  await tel.syncTelemetry();
  return result.status === "failed" ? 1 : 0;
}

async function cmdRevise(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const workspace = path.resolve(positional[0] ?? ".harness-run");
  const nodeId = positional[1];
  const feedback = flags.feedback as string | undefined;
  if (!nodeId || !feedback) {
    console.error('usage: harness revise <workspace> <nodeId> --feedback "what to change" [--resume]');
    return 1;
  }
  const config = JSON.parse(fs.readFileSync(path.join(workspace, "run.json"), "utf8")) as RunConfig;
  if (flags.answers) config.answersFile = path.resolve(flags.answers as string);
  if (flags["accept-defaults"] === true) config.acceptDefaults = true;
  const ctx = buildContext(workspace, config);
  const { reopened } = reviseNode(ctx, nodeId, feedback);
  console.log(`revising '${nodeId}' — reopened ${reopened.length} step(s): ${reopened.join(", ")}`);
  console.log("(steps whose inputs are unchanged will re-use their previous result)");
  if (flags.resume === true) {
    const result = await runLoop(ctx);
    report(ctx, result.status, result.failedNodeId ?? result.parkedNodeId);
    const tel = await import("./telemetry.js");
  tel.recordRun(ctx, result, "revise");
  await tel.syncTelemetry();
    return result.status === "failed" ? 1 : 0;
  }
  console.log(`run 'harness resume ${workspace}' to re-derive`);
  return 0;
}

function cmdCancel(args: string[]): number {
  const { positional, flags } = parseFlags(args);
  const workspace = path.resolve(positional[0] ?? ".harness-run");
  if (!fs.existsSync(workspace)) {
    console.error(`no such workspace: ${workspace}`);
    return 1;
  }
  // Cooperative stop: the engine polls this sentinel and halts at the next
  // checkpoint (interrupting an in-flight command/agent node), recording
  // run.cancelled. --force also SIGTERMs the live engine for an immediate stop.
  fs.writeFileSync(path.join(workspace, "cancel.requested"), new Date().toISOString());
  console.log(`stop requested for ${workspace} — the engine will halt and record run.cancelled`);
  if (flags.force === true) {
    try {
      const pid = Number(fs.readFileSync(path.join(workspace, "engine.lock"), "utf8"));
      if (pid) {
        process.kill(pid, "SIGTERM");
        console.log(`sent SIGTERM to engine pid ${pid}`);
      }
    } catch {
      /* no live engine holding the lock */
    }
  }
  console.log(`resume later with: harness resume ${workspace}   (the stopped step re-runs; committed work is kept)`);
  return 0;
}

function cmdRaiseBudget(args: string[]): number {
  const { positional, flags } = parseFlags(args);
  const workspace = path.resolve(positional[0] ?? ".harness-run");
  if (flags.run === undefined && (flags.node === undefined || flags.to === undefined)) {
    console.error("usage: harness raise-budget <workspace> [--run <usd>] [--node <id> --to <usd>]");
    return 1;
  }
  const file = path.join(workspace, "budget-overrides.json");
  const overrides: { run_budget_usd?: number; nodes?: Record<string, number> } = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  })();
  if (flags.run !== undefined) overrides.run_budget_usd = Number(flags.run);
  if (flags.node !== undefined && flags.to !== undefined) {
    overrides.nodes = overrides.nodes ?? {};
    overrides.nodes[String(flags.node)] = Number(flags.to);
  }
  fs.writeFileSync(file, JSON.stringify(overrides, null, 2));
  console.log(`budget override written to ${file}:`);
  console.log(`  ${JSON.stringify(overrides)}`);
  console.log(
    `apply it: harness resume ${workspace}` +
      (flags.node ? ` (to re-run ONLY that step: harness revise ${workspace} ${flags.node} --feedback "..." --resume)` : ""),
  );
  return 0;
}

function cmdStatus(args: string[]): number {
  const { positional } = parseFlags(args);
  const workspace = path.resolve(positional[0] ?? ".harness-run");
  const config = JSON.parse(
    fs.readFileSync(path.join(workspace, "run.json"), "utf8"),
  ) as RunConfig;
  const ctx = buildContext(workspace, config);
  report(ctx, "status");
  return 0;
}

function cliPackageRoot(): string {
  // dist/index.js -> packages/cli in source; the package root when bundled.
  try {
    return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  } catch {
    return path.dirname(process.argv[1] ?? ".");
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let code = 0;
  switch (command) {
    case "run":
      code = await cmdRun(rest);
      break;
    case "resume":
      code = await cmdResume(rest);
      break;
    case "revise":
      code = await cmdRevise(rest);
      break;
    case "cancel":
    case "stop":
      code = cmdCancel(rest);
      break;
    case "raise-budget":
      code = cmdRaiseBudget(rest);
      break;
    case "install": {
      const { positional, flags } = parseFlags(rest);
      const registry = flags.registry as string | undefined;
      if (!positional[0] || !registry) {
        console.error("usage: harness install <name>@<version> --registry <git-url>");
        code = 1;
        break;
      }
      const { install } = await import("./registry.js");
      try {
        const result = install(positional[0], registry);
        console.log(`installed ${result.tag} (certified ${result.digest.slice(0, 12)})`);
        console.log(`run it: harness run ${result.tag} --workspace my-app`);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        code = 1;
      }
      break;
    }
    case "list": {
      const { listInstalled } = await import("./registry.js");
      const installed = listInstalled();
      if (installed.length === 0) console.log("no certified project types installed");
      for (const p of installed) {
        console.log(`  ${p.tag.padEnd(28)} ${p.packageDigest.slice(0, 12)}  installed ${p.installedAt.slice(0, 10)}  from ${p.registry}`);
      }
      break;
    }
    case "setup": {
      const { flags } = parseFlags(rest);
      const { setup } = await import("./setup.js");
      const { checks, ok } = await setup(flags["install-sdk"] === true);
      console.log("harness preflight — a live build needs every required row green\n");
      for (const c of checks) console.log(`  ${c.ok ? "OK " : "FAIL"}  ${c.name.padEnd(44)} ${c.detail}`);
      console.log(ok ? "\nready to build with live agents" : "\nfix the FAIL rows above, then re-run: harness setup");
      code = ok ? 0 : 1;
      break;
    }
    case "lessons": {
      // The improvement loop's capture step: turn a run's remediation waves
      // into classified promotion candidates for the certified layer.
      const { positional, flags } = parseFlags(rest);
      const ws = path.resolve(positional[0] ?? ".");
      const { extractLessons } = await import("./lessons.js");
      const { lessons, summary } = extractLessons(ws);
      if (flags.json === true) {
        console.log(JSON.stringify({ lessons, summary }, null, 2));
      } else if (lessons.length === 0) {
        console.log("no remediation waves in this run — nothing to promote (a clean build teaches nothing new).");
      } else {
        console.log(`${summary.total} lesson(s) from ${new Set(lessons.map((l) => l.wave)).size} remediation wave(s):\n`);
        for (const l of lessons) {
          console.log(`  wave ${l.wave} · ${l.source} → ${l.target_step}`);
          console.log(`    finding: ${l.finding}`);
          console.log(`    promote to: ${l.suggested_promotion.toUpperCase()} — ${l.rationale}\n`);
        }
        const counts = Object.entries(summary).filter(([k]) => k !== "total").map(([k, v]) => `${v} ${k}`).join(", ");
        console.log(`promotion targets: ${counts}`);
        console.log(`\nreview these, apply the winners to the certified layer, then: harness certify <project-type> --update-golden`);
        console.log(`(see docs/IMPROVEMENT-LOOP.md)`);
      }
      break;
    }
    case "telemetry": {
      const { flags } = parseFlags(rest);
      const { summarize, syncTelemetry } = await import("./telemetry.js");
      if (flags.sync === true) console.log(await syncTelemetry());
      else console.log(summarize());
      break;
    }
    case "metrics": {
      const { positional, flags } = parseFlags(rest);
      const { metricsCommand } = await import("./metrics.js");
      const compareWith = flags.compare ? path.resolve(String(flags.compare)) : undefined;
      code = metricsCommand(path.resolve(positional[0] ?? ".harness-run"), flags.json === true, compareWith);
      break;
    }
    case "self-improve": {
      // Mine recurring weaknesses across many runs into bounded proposals
      // (human applies + re-certifies; evaluator stays outside the loop).
      const { positional, flags } = parseFlags(rest);
      const { selfImprove } = await import("./selfImprove.js");
      code = selfImprove(path.resolve(positional[0] ?? "."), {
        top: flags.top ? Number(flags.top) : undefined,
        json: flags.json === true,
      });
      break;
    }
    case "optimize": {
      // Certification-gated prompt-candidate evaluator (L0). Accepts a candidate
      // only if it still certifies (held-in + held-out); applies nothing.
      const { positional, flags } = parseFlags(rest);
      if (!positional[0]) {
        console.error("usage: harness optimize <project-type> --node <id> --candidates <dir>");
        code = 1;
        break;
      }
      const { optimize } = await import("./optimize.js");
      code = await optimize(positional[0], {
        node: flags.node as string | undefined,
        candidates: flags.candidates as string | undefined,
      });
      break;
    }
    case "publish": {
      const { positional, flags } = parseFlags(rest);
      const registryUrl = (flags["registry-url"] as string) ?? process.env.HARNESS_REGISTRY_URL;
      if (!positional[0] || !registryUrl) {
        console.error("usage: harness publish <workspace> --registry-url <url> [--team t] [--owner o] [--name n] [--visibility private|team|firm]");
        console.error("       (or set HARNESS_REGISTRY_URL)");
        process.exitCode = 1;
        break;
      }
      const vis = flags.visibility as string | undefined;
      const { publishWorkspace } = await import("./publish.js");
      const result = await publishWorkspace(path.resolve(positional[0]), {
        registryUrl,
        owner: flags.owner as string | undefined,
        team: flags.team as string | undefined,
        name: flags.name as string | undefined,
        visibility: vis === "private" || vis === "team" || vis === "firm" ? vis : undefined,
      });
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case "login": {
      // One-time BYO credential registration for the hosted model (optional;
      // local-only users just use ANTHROPIC_API_KEY).
      const { flags } = parseFlags(rest);
      const { login } = await import("./login.js");
      code = await login(flags);
      break;
    }
    case "deploy": {
      // Pattern (b) of the deployment story: build local first, deploy later.
      // Runs the certified type's deploy-plan generator against the finished
      // app — no rebuild, no revision cascade. Cloud is OPTIONAL: default target
      // is "local" (no cloud); pick cloud-run / aws-ecs / aws-apprunner to ship.
      const { positional, flags } = parseFlags(rest);
      if (!positional[0]) {
        console.error("usage: harness deploy <workspace> [--target local|cloud-run|aws-ecs|aws-apprunner]");
        process.exitCode = 1;
        break;
      }
      const ws = path.resolve(positional[0]);
      const cfg = JSON.parse(fs.readFileSync(path.join(ws, "run.json"), "utf8")) as { projectTypeDir: string };
      const arch = JSON.parse(fs.readFileSync(path.join(ws, "artifacts", "architecture", "architecture.json"), "utf8")) as Record<string, unknown>;
      arch.deploy_target = (flags.target as string) ?? "cloud-run";
      const stageDir = path.join(ws, "deploy-plan");
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(path.join(stageDir, "inputs.json"), JSON.stringify({ architecture: { path: "", data: arch } }));
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("node", [path.join(cfg.projectTypeDir, "scripts", "deploy-plan.cjs")], {
        cwd: stageDir,
        encoding: "utf8",
        env: { ...process.env, HARNESS_PROJECT_DIR: cfg.projectTypeDir },
      });
      if (r.status !== 0) {
        console.error(r.stderr || r.stdout);
        process.exitCode = 1;
        break;
      }
      console.log(r.stdout.trim());
      console.log(`deploy plan written to ${stageDir}/deploy — review, then apply via your CI (the harness never touches cloud directly)`);
      break;
    }
    case "compose": {
      const { positional, flags } = parseFlags(rest);
      if (!positional[0]) {
        console.error("usage: harness compose <spec.yaml> [--out dir] [--library dir]");
        process.exitCode = 1;
        break;
      }
      const { composeType } = await import("./compose.js");
      const spec = path.resolve(positional[0]);
      const out = path.resolve((flags.out as string) ?? path.basename(spec).replace(/\.[^.]+$/, ""));
      const lib = path.resolve((flags.library as string) ?? path.join(path.dirname(cliPackageRoot()), "stage-library"));
      const result = composeType(spec, out, fs.existsSync(lib) ? lib : path.resolve("stage-library"));
      console.log(`composed ${result.nodes} node(s) -> ${result.dir}`);
      console.log(`try it:  harness run ${result.dir} --workspace .compose-test --mock-agents --accept-defaults`);
      console.log(`certify: harness certify ${result.dir} --update-golden   (after adding fixtures)`);
      break;
    }
    case "self-update": {
      const { flags } = parseFlags(rest);
      const entry = process.argv[1] ?? "";
      if (!entry.endsWith("harness.cjs")) {
        console.log("self-update applies to the bundled binary (harness.cjs).");
        console.log("From a source checkout, update with: git pull && npm install && npm run bundle");
        break;
      }
      const registry = flags.registry as string | undefined;
      if (!registry) {
        console.error("usage: harness self-update --registry <git-url> [--ref <branch-or-tag>]");
        code = 1;
        break;
      }
      const os = await import("node:os");
      const { spawnSync } = await import("node:child_process");
      const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "harness-update-"));
      const cloneArgs = ["clone", "--depth", "1", ...(flags.ref ? ["--branch", flags.ref as string] : []), registry, checkout];
      for (const [what, cmd, args, cwd] of [
        ["fetch", "git", cloneArgs, undefined],
        ["install", "npm", ["install", "--no-audit", "--no-fund"], checkout],
        ["bundle", "npm", ["run", "bundle"], checkout],
      ] as [string, string, string[], string | undefined][]) {
        const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600000 });
        if (r.status !== 0) {
          console.error(`self-update ${what} failed:\n${(r.stderr ?? "").slice(-500)}`);
          code = 1;
          break;
        }
      }
      if (code === 0) {
        const fresh = path.join(checkout, "dist-bundle", "harness.cjs");
        fs.copyFileSync(entry, entry + ".bak");
        fs.copyFileSync(fresh, entry);
        console.log(`updated ${entry} (previous version kept at ${entry}.bak)`);
      }
      break;
    }
    case "certify-mcp": {
      const { positional } = parseFlags(rest);
      const { certifyMcp } = await import("./mcp.js");
      const { ok, servers } = await certifyMcp(path.resolve(positional[0] ?? "mcp"));
      for (const s2 of servers) {
        console.log(`  ${s2.ok ? "OK " : "FAIL"}  ${s2.name.padEnd(20)} tools: ${s2.tools.join(", ") || "-"}`);
        for (const prob of s2.problems) console.log(`        - ${prob.split("\n")[0]}`);
      }
      console.log(ok ? `\nall ${servers.length} mcp server(s) certified` : "\nMCP CERTIFICATION FAILED");
      code = ok ? 0 : 1;
      break;
    }
    case "new-mcp": {
      const { positional } = parseFlags(rest);
      if (!positional[0]) {
        console.error("usage: harness new-mcp <name> [mcp-dir]");
        code = 1;
        break;
      }
      const { scaffoldMcp } = await import("./mcp.js");
      try {
        const dir = scaffoldMcp(positional[0], path.resolve(positional[1] ?? "mcp"));
        console.log(`scaffolded ${dir} — implement TOOLS in server.mjs, then: harness certify-mcp`);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        code = 1;
      }
      break;
    }
    case "certify-modules": {
      const { positional } = parseFlags(rest);
      const { certifyModules } = await import("./certifyModules.js");
      const modulesDir = path.resolve(positional[0] ?? "modules");
      const ptDir = path.resolve(positional[1] ?? "project-types/agentic-app");
      const { ok, modules } = certifyModules(modulesDir, ptDir);
      console.log(`certifying ${modules.length} module(s) against substrate templates in ${path.basename(ptDir)}\n`);
      for (const m of modules) {
        console.log(`  ${m.ok ? "OK " : "FAIL"}  ${m.name.padEnd(20)} ${m.tested}`);
        for (const prob of m.problems) console.log(`        - ${prob.split("\n")[0]}`);
      }
      console.log(ok ? `\nall ${modules.length} modules certified` : "\nMODULE CERTIFICATION FAILED");
      code = ok ? 0 : 1;
      break;
    }
    case "certify": {
      const { positional, flags } = parseFlags(rest);
      const { certify } = await import("./certify.js");
      const report = await certify(positional[0] ?? ".", { updateGolden: flags["update-golden"] === true, updateHeldout: flags["update-heldout"] === true });
      console.log(`certifying ${report.name}@${report.version}`);
      for (const s of report.scenarios) {
        console.log(
          `  scenario ${s.scenario.padEnd(24)} ${(s.heldOut ? "held-out" : s.status).padEnd(10)} $${s.totalCostUsd.toFixed(2)} digest ${s.digest || "-"}`,
        );
      }
      if (report.revisionDrill) {
        console.log(
          `  revision drill (${report.revisionDrill.node}): ${report.revisionDrill.status}, ${report.revisionDrill.cachedReuses} cached re-use(s)`,
        );
      }
      if (report.gateRegression) {
        console.log(
          `  non-repeat guarantee: ${report.gateRegression.status === "held" ? "HELD — every past wave-class still caught by its gate" : "BROKEN — a gate regressed"}`,
        );
      }
      for (const p of report.problems) console.log(`  PROBLEM: ${p}`);
      console.log(report.ok ? `CERTIFIED ${report.name}@${report.version} (${report.packageDigest.slice(0, 12)})` : "NOT CERTIFIED");
      code = report.ok ? 0 : 1;
      break;
    }
    case "status":
      code = cmdStatus(rest);
      break;
    case "ui": {
      const { positional, flags } = parseFlags(rest);
      // No argument -> serve the current directory as the build root: the
      // storefront lists its runs and every certified type shipped with the
      // install. `harness ui <run-dir>` still opens a single run directly.
      const workspace = path.resolve(positional[0] ?? ".");
      const port = Number(flags.port ?? process.env.PORT ?? 4400);
      const { startUiServer } = await import("./ui.js");
      await startUiServer(workspace, port);
      const host = process.env.HARNESS_UI_HOST || "localhost";
      console.log(`dashboard: http://${host}:${port}  (workspace: ${workspace})`);
      return; // keep serving
    }
    default:
      console.log("usage: harness <run|resume|revise|status|metrics|ui|setup|certify|install|list|publish|telemetry|self-update>");
      console.log("  harness run <project-type-dir> [--workspace dir] [--answers file] [--mock-agents]");
      console.log("  harness resume <workspace> [--answers file]   # recovers interrupted + failed steps, keeps committed work");
      console.log('  harness revise <workspace> <nodeId> --feedback "what to change" [--resume]');
      console.log("  harness cancel <workspace> [--force]           # stop a running pipeline (records run.cancelled; resume re-runs the stopped step)");
      console.log("  harness raise-budget <workspace> [--run <usd>] [--node <id> --to <usd>]   # lift a cap a run hit, then resume/revise");
      console.log("  harness status <workspace>");
      console.log("  harness metrics <workspace> [--json]   # retries, doom-loops, escalations, convergence, cost");
      console.log("  harness metrics <a> --compare <b>      # A/B two runs: did a harness change help?");
      console.log("  harness certify <project-type-dir> [--update-golden]");
      console.log("  harness certify-modules [modules-dir] [project-type-dir]");
      console.log("  harness certify-mcp [mcp-dir]");
      console.log("  harness new-mcp <name> [mcp-dir]   # scaffold a certifiable MCP server");
      console.log("  harness install <name>@<version> --registry <git-url>");
      console.log("  harness list");
      console.log("  harness setup [--install-sdk]   # verify/provision the live-agent toolchain");
      code = command ? 1 : 0;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
