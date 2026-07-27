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
  const projectTypeDir = path.resolve(positional[0] ?? ".");
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
  const ctx = buildContext(workspace, config);
  const { reopened } = reviseNode(ctx, nodeId, feedback);
  console.log(`revising '${nodeId}' — reopened ${reopened.length} step(s): ${reopened.join(", ")}`);
  console.log("(steps whose inputs are unchanged will re-use their previous result)");
  if (flags.resume === true) {
    const result = await runLoop(ctx);
    report(ctx, result.status, result.failedNodeId ?? result.parkedNodeId);
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
    case "status":
      code = cmdStatus(rest);
      break;
    case "ui": {
      const { positional, flags } = parseFlags(rest);
      const workspace = path.resolve(positional[0] ?? ".harness-run");
      const port = Number(flags.port ?? 4400);
      const { startUiServer } = await import("./ui.js");
      await startUiServer(workspace, port);
      console.log(`dashboard: http://localhost:${port}  (workspace: ${workspace})`);
      return; // keep serving
    }
    default:
      console.log("usage: harness <run|resume|revise|status|ui>");
      console.log("  harness run <project-type-dir> [--workspace dir] [--answers file] [--mock-agents]");
      console.log("  harness resume <workspace> [--answers file]");
      console.log('  harness revise <workspace> <nodeId> --feedback "what to change" [--resume]');
      console.log("  harness status <workspace>");
      code = command ? 1 : 0;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
