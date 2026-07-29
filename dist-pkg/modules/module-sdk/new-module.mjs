// module-sdk: scaffold a certifiable module skeleton.
import * as fs from "node:fs";
import * as path from "node:path";

export function scaffold(name, { kind = "app", modulesDir = "modules" } = {}) {
  if (!/^[a-z][a-z0-9-]+$/.test(name)) throw new Error("module names are lowercase-kebab");
  const dir = path.join(modulesDir, name);
  if (fs.existsSync(dir)) throw new Error(name + " already exists");
  const py = name.replace(/-/g, "_");
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  const manifest = [
    "name: " + name,
    "version: 0.1.0",
    'description: "TODO: one line on why this must be a module (see docs/MODULES.md)"',
    ...(kind !== "app" ? ["kind: " + kind] : []),
    "provides:",
    '  - "TODO: the interface downstream code may rely on"',
    "requires: []",
    ...(kind === "app" ? ["compose:", "  overlay: compose/"] : []),
    "certify:",
    ...(kind === "app" ? ["  tests: test/"] : ['  command: node "$HARNESS_MODULE_DIR/test/test.mjs"']),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "manifest.yaml"), manifest);
  fs.writeFileSync(
    path.join(dir, "agent-guide.md"),
    "# " + name + " — agent guide\n\nTODO: write the module's law for build agents — what MUST go through it,\nwhat is forbidden, and the failure mode this module exists to prevent.\nThis stub is intentionally long enough to pass the certifier's floor while\nfailing any honest human review until replaced.\n",
  );
  if (kind === "app") {
    fs.mkdirSync(path.join(dir, "compose", "backend"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "compose", "backend", py + ".py"),
      '"""' + name + ' module. See agent-guide."""\n\n\ndef ping():\n    return "' + name + ' ready"\n',
    );
    fs.writeFileSync(
      path.join(dir, "test", "test_" + py + ".py"),
      "import os\nimport sys\n\nos.environ[\"HARNESS_AGENT_MODE\"] = \"stub\"\nsys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\n\nfrom " + py + " import ping  # noqa: E402\n\n\ndef test_ping():\n    assert ping() == \"" + name + " ready\"\n",
    );
  } else {
    fs.writeFileSync(path.join(dir, "test", "test.mjs"), 'console.log("' + name + ' OK");\n');
  }
  return dir;
}

if (process.argv[2]) {
  const kindFlag = process.argv.indexOf("--kind");
  const dirFlag = process.argv.indexOf("--modules-dir");
  console.log(
    "scaffolded " +
      scaffold(process.argv[2], {
        kind: kindFlag !== -1 ? process.argv[kindFlag + 1] : "app",
        modulesDir: dirFlag !== -1 ? process.argv[dirFlag + 1] : "modules",
      }),
  );
}
