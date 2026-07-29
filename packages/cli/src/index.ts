#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { Journal, foldState, loadProjectType, loadProjectTypeFile, reopenFailed, reviseNode, runLoop, type RunContext } from "@harness/runner";

interface RunConfig {
  projectTypeDir: string;
  answersFile?: string;
  mockAgents: boolean;
  acceptDefaults?: boolean;
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
  const config: RunConfig = {
    projectTypeDir,
    answersFile: flags.answers ? path.resolve(flags.answers as string) : undefined,
    mockAgents: flags["mock-agents"] === true,
    acceptDefaults: flags["accept-defaults"] === true,
  };

  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "run.json"), JSON.stringify(config, null, 2));
  fs.copyFileSync(path.join(projectTypeDir, "dag.yaml"), path.join(workspace, "dag.snapshot.yaml"));

  const ctx = buildContext(workspace, config);
  ctx.journal.append({
    type: "run.created",
    projectType: ctx.def.name,
    projectTypeVersion: ctx.def.version,
  });
  console.log(`running ${ctx.def.name}@${ctx.def.version} (${ctx.def.nodes.length} nodes)`);

  const result = await runLoop(ctx);
  report(ctx, result.status, result.failedNodeId ?? result.parkedNodeId);
  (await import("./telemetry.js")).recordRun(ctx, result, "run");
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
  const reopened = reopenFailed(ctx);
  if (reopened.length > 0) console.log(`reopening failed node(s): ${reopened.join(", ")}`);
  console.log(`resuming ${ctx.def.name}@${ctx.def.version}`);
  const result = await runLoop(ctx);
  report(ctx, result.status, result.failedNodeId ?? result.parkedNodeId);
  (await import("./telemetry.js")).recordRun(ctx, result, "resume");
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
    (await import("./telemetry.js")).recordRun(ctx, result, "revise");
    return result.status === "failed" ? 1 : 0;
  }
  console.log(`run 'harness resume ${workspace}' to re-derive`);
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
    case "telemetry": {
      const { summarize } = await import("./telemetry.js");
      console.log(summarize());
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
      const report = await certify(positional[0] ?? ".", { updateGolden: flags["update-golden"] === true });
      console.log(`certifying ${report.name}@${report.version}`);
      for (const s of report.scenarios) {
        console.log(
          `  scenario ${s.scenario.padEnd(24)} ${s.status.padEnd(10)} $${s.totalCostUsd.toFixed(2)} digest ${s.digest || "-"}`,
        );
      }
      if (report.revisionDrill) {
        console.log(
          `  revision drill (${report.revisionDrill.node}): ${report.revisionDrill.status}, ${report.revisionDrill.cachedReuses} cached re-use(s)`,
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
      const port = Number(flags.port ?? 4400);
      const { startUiServer } = await import("./ui.js");
      await startUiServer(workspace, port);
      console.log(`dashboard: http://localhost:${port}  (workspace: ${workspace})`);
      return; // keep serving
    }
    default:
      console.log("usage: harness <run|resume|revise|status|ui|setup|certify|install|list|telemetry|self-update>");
      console.log("  harness run <project-type-dir> [--workspace dir] [--answers file] [--mock-agents]");
      console.log("  harness resume <workspace> [--answers file]");
      console.log('  harness revise <workspace> <nodeId> --feedback "what to change" [--resume]');
      console.log("  harness status <workspace>");
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
