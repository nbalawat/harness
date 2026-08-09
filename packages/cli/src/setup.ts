// `harness setup` — the pilot preflight. The Claude Agent SDK is the
// harness's execution engine: setup verifies the whole live-build toolchain
// and provisions the engine into $HARNESS_HOME/runtime when asked.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { loadAgentSdk } from "@harness/runner";
import { storeRoot } from "./registry.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

// On Windows, CLIs installed as npm/pip shims are `.cmd`/`.bat` (e.g. `claude`,
// `npm`) and won't spawn without a shell; `shell: true` lets cmd.exe resolve the
// PATHEXT extension. Harmless on POSIX.
const SPAWN_SHELL = process.platform === "win32";

function has(cmd: string, args: string[] = ["--version"]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, shell: SPAWN_SHELL });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : null;
}

export async function setup(installSdk: boolean): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const node = process.versions.node;
  checks.push({ name: "node >= 20", ok: Number(node.split(".")[0]) >= 20, detail: `v${node}` });

  const git = has("git");
  checks.push({ name: "git (registry installs)", ok: git !== null, detail: git ?? "not found" });

  const uv = has("uv");
  checks.push({ name: "uv (runs generated apps)", ok: uv !== null, detail: uv ?? "not found — install from https://docs.astral.sh/uv/" });

  const docker = has("docker", ["--version"]);
  checks.push({ name: "docker (optional: container smoke)", ok: true, detail: docker ?? "not found — container checks will be skipped" });

  // The engine itself.
  let sdkOk = false;
  let sdkDetail = "";
  try {
    await loadAgentSdk();
    sdkOk = true;
    sdkDetail = "resolved";
  } catch {
    sdkDetail = "not found";
  }
  if (!sdkOk && installSdk) {
    const runtime = path.join(storeRoot(), "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    console.log(`installing Claude Agent SDK into ${runtime} ...`);
    const r = spawnSync("npm", ["install", "--prefix", runtime, "--no-audit", "--no-fund", "@anthropic-ai/claude-agent-sdk"], {
      encoding: "utf8",
      timeout: 300000,
      stdio: "inherit",
      shell: SPAWN_SHELL, // npm is npm.cmd on Windows
    });
    if (r.status === 0) {
      try {
        await loadAgentSdk();
        sdkOk = true;
        sdkDetail = `installed at ${runtime}`;
      } catch {
        sdkDetail = "installed but failed to load";
      }
    } else {
      sdkDetail = "npm install failed";
    }
  }
  checks.push({
    name: "Claude Agent SDK (execution engine)",
    ok: sdkOk,
    detail: sdkOk ? sdkDetail : `${sdkDetail} — run: harness setup --install-sdk`,
  });

  // Auth: either an API key or a logged-in Claude Code CLI session.
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasClaudeCli = has("claude", ["--version"]) !== null;
  checks.push({
    name: "agent auth (ANTHROPIC_API_KEY or claude login)",
    ok: hasKey || hasClaudeCli,
    detail: hasKey ? "ANTHROPIC_API_KEY set" : hasClaudeCli ? "claude CLI present" : "neither found — live runs will fail",
  });

  return { checks, ok: checks.every((c) => c.ok) };
}
