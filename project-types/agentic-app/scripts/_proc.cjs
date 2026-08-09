// Cross-platform process/OS helpers for the certified scripts.
// The scripts boot the app-under-test and must run on macOS, Linux, AND Windows.
// POSIX process-group tricks (`process.kill(-pid)`) and POSIX-only tools
// (`find`, `python3`) don't exist on Windows — this module hides the difference.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const isWin = process.platform === "win32";

// A detached child is a process-group leader on POSIX (so we can signal the
// whole group). On Windows there are no process groups we can signal that way —
// we kill the tree by PID with taskkill /T — so detaching only risks a stray
// console window. Detach on POSIX only.
const detach = !isWin;

// Kill a spawned child AND everything it spawned (uvicorn, its workers).
// POSIX: signal the negative PID (the process group the detached child leads).
// Windows: taskkill /T walks and kills the child's whole process tree by PID.
function killTree(child, signal = "SIGTERM") {
  if (!child || child.pid == null) return;
  try {
    if (isWin) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    /* already gone */
  }
}

// Recursively remove build/test cache dirs (the cross-platform replacement for
// `find <app> -name __pycache__ -type d -exec rm -rf {} +`).
function rmCaches(root, names = ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]) {
  const set = new Set(names);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (set.has(e.name)) {
        fs.rmSync(p, { recursive: true, force: true });
      } else {
        walk(p);
      }
    }
  };
  walk(root);
}

// Resolve a working Python launcher across platforms: `python3` (POSIX),
// `python` or the `py` launcher (Windows). Cached after first probe.
let _python = null;
function pythonCmd() {
  if (_python) return _python;
  const candidates = isWin
    ? [["python"], ["py", "-3"], ["python3"]]
    : [["python3"], ["python"]];
  for (const [cmd, ...pre] of candidates) {
    try {
      const r = spawnSync(cmd, [...pre, "--version"], { encoding: "utf8", timeout: 15000, shell: isWin });
      if (r.status === 0) {
        _python = { cmd, pre };
        return _python;
      }
    } catch {
      /* try next */
    }
  }
  // Last resort — let the caller fail loudly with a real error.
  _python = isWin ? { cmd: "python", pre: [] } : { cmd: "python3", pre: [] };
  return _python;
}

module.exports = { isWin, detach, killTree, rmCaches, pythonCmd };
