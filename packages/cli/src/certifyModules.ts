// Per-module certification — the scale answer for a catalog of hundreds.
// Project-type goldens certify COMBINATIONS; this certifies each module's own
// contract in isolation: manifest completeness, agent guide, clean composition
// onto the standard substrate, python syntax, and the module's own tests run
// against a real composed app.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

/** Modules every app composes — the substrate a module under test sits on. */
const SUBSTRATE = ["persistence-core", "agent-runtime", "chat-shell"];

const IS_WIN = process.platform === "win32";

/**
 * A working Python launcher: `python3` on POSIX; `python` or the `py` launcher
 * on Windows (which has no `python3`). Probed once and cached.
 */
let _pythonCmd: { cmd: string; pre: string[] } | null = null;
function pythonCmd(): { cmd: string; pre: string[] } {
  if (_pythonCmd) return _pythonCmd;
  const candidates: [string, ...string[]][] = IS_WIN
    ? [["python"], ["py", "-3"], ["python3"]]
    : [["python3"], ["python"]];
  for (const [cmd, ...pre] of candidates) {
    try {
      const r = spawnSync(cmd, [...pre, "--version"], { encoding: "utf8", timeout: 15000, shell: IS_WIN });
      if (r.status === 0) return (_pythonCmd = { cmd, pre });
    } catch {
      /* try next */
    }
  }
  return (_pythonCmd = IS_WIN ? { cmd: "python", pre: [] } : { cmd: "python3", pre: [] });
}

export interface ModuleReport {
  name: string;
  ok: boolean;
  problems: string[];
  tested: string; // "pytest", "command", "pytest+command", or "none"
}

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  /** app (default): composes into generated apps. tool: certifier/generator utilities. pack: curated module bundle. */
  kind?: "app" | "tool" | "pack";
  provides?: unknown[];
  requires?: unknown[];
  compose?: { overlay?: string };
  certify?: { tests?: string; command?: string; python_deps?: string[] };
  /** pack only: the modules the pack composes. */
  modules?: string[];
  /** app only: modules this one cannot be composed with. */
  conflicts?: string[];
}

function overlay(moduleDir: string, appDir: string): void {
  const composeDir = path.join(moduleDir, "compose");
  if (!fs.existsSync(composeDir)) return;
  fs.cpSync(composeDir, appDir, { recursive: true });
}

/** requires entries that exactly name sibling modules are composable dependencies. */
function moduleDeps(modulesDir: string, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const manifestPath = path.join(modulesDir, name, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) return [];
  let manifest: Manifest = {};
  try {
    manifest = parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const req of manifest.requires ?? []) {
    if (typeof req === "string" && fs.existsSync(path.join(modulesDir, req, "manifest.yaml"))) {
      out.push(...moduleDeps(modulesDir, req, seen), req);
    }
  }
  return [...new Set(out)];
}

/** A minimal but REAL composed app: base template + substrate + declared module deps + generated glue. */
function makeScratchApp(modulesDir: string, projectTypeDir: string, moduleDir: string): string {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "harness-module-"));
  fs.cpSync(path.join(projectTypeDir, "templates", "base"), app, { recursive: true });
  for (const name of SUBSTRATE) overlay(path.join(modulesDir, name), app);
  for (const dep of moduleDeps(modulesDir, path.basename(moduleDir))) overlay(path.join(modulesDir, dep), app);
  overlay(moduleDir, app);
  fs.writeFileSync(
    path.join(app, "backend", "models.py"),
    'TABLES = {\n    "conversations": ["id", "user"],\n    "messages": ["id", "conversation_id", "content"],\n    "approvals": ["id", "message", "approved"],\n}\n' +
      '# Generic-API exposure (module-test substrate: chat tables open, approvals closed).\n' +
      'OPEN_READ_TABLES = {"conversations", "messages"}\n' +
      'OPEN_WRITE_TABLES = {"conversations", "messages"}\n',
  );
  fs.mkdirSync(path.join(app, "agents", "evals"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "agents", "roster.json"),
    JSON.stringify(
      {
        agents: [
          {
            name: "Test Assistant",
            role: "Answers questions during module certification.",
            tools: [],
            eval_criteria: ["responds"],
            addresses: ["REQ-001"],
          },
        ],
      },
      null,
      2,
    ),
  );
  const mainPy = path.join(app, "backend", "main.py");
  fs.writeFileSync(mainPy, fs.readFileSync(mainPy, "utf8").replaceAll("__APP_NAME__", "Module Cert App"));
  return app;
}

function certifyOne(modulesDir: string, projectTypeDir: string, name: string): ModuleReport {
  const moduleDir = path.join(modulesDir, name);
  const problems: string[] = [];
  let tested: string[] = [];

  // 1. Manifest contract.
  const manifestPath = path.join(moduleDir, "manifest.yaml");
  let manifest: Manifest = {};
  if (!fs.existsSync(manifestPath)) {
    problems.push("missing manifest.yaml");
  } else {
    try {
      manifest = parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
    } catch (e) {
      problems.push(`manifest.yaml unparseable: ${String(e).slice(0, 100)}`);
    }
    if (manifest.name !== name) problems.push(`manifest name '${manifest.name}' != directory '${name}'`);
    for (const field of ["version", "description"] as const) {
      if (!manifest[field]) problems.push(`manifest missing ${field}`);
    }
    if (!Array.isArray(manifest.provides) || manifest.provides.length === 0) problems.push("manifest must declare provides");
    if (!Array.isArray(manifest.requires)) problems.push("manifest must declare requires (empty list is fine)");
    if (manifest.kind && !["app", "tool", "pack"].includes(manifest.kind)) problems.push(`unknown kind '${manifest.kind}'`);
    if ((manifest.kind ?? "app") === "app" && manifest.compose?.overlay !== "compose/") {
      problems.push("manifest compose.overlay must be 'compose/'");
    }
    if (manifest.kind === "pack") {
      if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
        problems.push("pack must list the modules it bundles");
      } else {
        for (const m of manifest.modules) {
          if (!fs.existsSync(path.join(modulesDir, m, "manifest.yaml"))) problems.push(`pack references unknown module '${m}'`);
        }
      }
    }
    for (const c of manifest.conflicts ?? []) {
      if (!fs.existsSync(path.join(modulesDir, c, "manifest.yaml"))) problems.push(`conflicts references unknown module '${c}'`);
    }
  }

  // 2. Agent guide — the module's law for build agents.
  const guide = path.join(moduleDir, "agent-guide.md");
  if (!fs.existsSync(guide) || fs.readFileSync(guide, "utf8").trim().length < 80) {
    problems.push("agent-guide.md missing or too thin to guide a build agent");
  }

  const kind = manifest.kind ?? "app";

  // 3. Overlay sanity (app modules only — tools/packs don't compose into apps).
  if (kind === "app") {
    const composeDir = path.join(moduleDir, "compose");
    if (!fs.existsSync(composeDir) || fs.readdirSync(composeDir).length === 0) {
      problems.push("compose/ overlay missing or empty");
    }
  }

  if (problems.length > 0) return { name, ok: false, problems, tested: "none" };

  // Tools and packs are certified by their own command/tests, no scratch app.
  if (kind !== "app") {
    const tested: string[] = [];
    if (manifest.certify?.command) {
      const cmd = spawnSync(manifest.certify.command, {
        shell: true,
        cwd: moduleDir,
        encoding: "utf8",
        timeout: 300000,
        env: { ...process.env, HARNESS_MODULE_DIR: moduleDir, HARNESS_MODULES_DIR: modulesDir },
      });
      if (cmd.status !== 0) problems.push(`certify command failed:\n${(cmd.stderr ?? cmd.stdout ?? "").slice(-400)}`);
      tested.push("command");
    }
    if (kind === "pack") tested.push("modules-exist");
    if (tested.length === 0) problems.push("no certify tests declared — every module must prove its contract");
    return { name, ok: problems.length === 0, problems, tested: tested.join("+") || "none" };
  }

  // 4. Compose a real app and prove the module lives in it.
  const app = makeScratchApp(modulesDir, projectTypeDir, moduleDir);
  const pyFiles: string[] = [];
  for (const entry of fs.readdirSync(path.join(app, "backend"))) {
    if (entry.endsWith(".py")) pyFiles.push(path.join(app, "backend", entry));
  }
  const _py = pythonCmd();
  const compile = spawnSync(_py.cmd, [..._py.pre, "-m", "py_compile", ...pyFiles], { encoding: "utf8", timeout: 60000, shell: IS_WIN });
  if (compile.status !== 0) problems.push(`python compile failed:\n${(compile.stderr ?? "").slice(-400)}`);

  // 5. The module's own tests, against the composed app.
  if (problems.length === 0 && manifest.certify?.tests) {
    const src = path.join(moduleDir, manifest.certify.tests);
    const dest = path.join(app, "backend", "module_tests");
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".py"))) {
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
    }
    const extraDeps = (manifest.certify?.python_deps ?? []).flatMap((d) => ["--with", d]);
    const pytest = spawnSync(
      "uv",
      ["run", "--with", "fastapi", "--with", "httpx", "--with", "pytest", ...extraDeps, "python", "-m", "pytest", "module_tests", "-q"],
      { cwd: path.join(app, "backend"), encoding: "utf8", timeout: 300000, env: { ...process.env, HARNESS_AGENT_MODE: "stub" } },
    );
    if (pytest.status !== 0) {
      problems.push(`module tests failed:\n${(pytest.stdout ?? "").slice(-600)}`);
    }
    tested.push("pytest");
  }
  if (problems.length === 0 && manifest.certify?.command) {
    const cmd = spawnSync(manifest.certify.command, {
      shell: true,
      cwd: app,
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, HARNESS_MODULE_DIR: moduleDir },
    });
    if (cmd.status !== 0) problems.push(`certify command failed:\n${(cmd.stderr ?? cmd.stdout ?? "").slice(-400)}`);
    tested.push("command");
  }
  if (tested.length === 0) problems.push("no certify tests declared — every module must prove its contract");

  fs.rmSync(app, { recursive: true, force: true });
  return { name, ok: problems.length === 0, problems, tested: tested.join("+") || "none" };
}

export function certifyModules(modulesDir: string, projectTypeDir: string): { ok: boolean; modules: ModuleReport[] } {
  const names = fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const modules = names.map((n) => certifyOne(modulesDir, projectTypeDir, n));
  return { ok: modules.every((m) => m.ok), modules };
}
