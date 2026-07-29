// npm distribution: assemble a self-contained package so onboarding is
//   npm install -g <pkg>     (or: npm install -g ./harness-*.tgz)
//   harness ui
// The package ships the engine bundle PLUS the certified catalog (project
// types, modules, MCP servers) in the same layout as the source repo, so
// every path-resolution rule (modules at <type>/../../modules, mcp at
// <type>/../../mcp) works unchanged. No GitHub, no checkout, no build step.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist-bundle", "harness.cjs");
const out = path.join(root, "dist-pkg");

if (!fs.existsSync(bundle)) {
  console.error("bundle missing — run: npm run bundle");
  process.exit(1);
}

const VERSION = "0.9.1"; // platform release version (tracks agentic-app certification line)

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(bundle, path.join(out, "harness.cjs"));
fs.chmodSync(path.join(out, "harness.cjs"), 0o755);

const SKIP = new Set(["__pycache__", "node_modules", ".DS_Store"]);
function copyTree(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => !SKIP.has(path.basename(p)) && !path.basename(p).startsWith(".harness"),
  });
}
for (const dir of ["project-types", "modules", "mcp"]) {
  copyTree(path.join(root, dir), path.join(out, dir));
}

fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "@valueaddwithai/harness",
      version: VERSION,
      description:
        "Certified SDLC workflow factory: build working agentic applications from a problem statement, with approvable designs, certified modules, and governance evidence.",
      license: "UNLICENSED",
      bin: { harness: "./harness.cjs" },
      engines: { node: ">=20" },
      // Everything is pre-built; nothing to compile on install.
      scripts: {},
    },
    null,
    2,
  ) + "\n",
);

fs.writeFileSync(
  path.join(out, "README.md"),
  [
    "# harness",
    "",
    "Build working agentic applications from a problem statement.",
    "",
    "## Get started (two commands)",
    "",
    "```sh",
    "npm install -g @valueaddwithai/harness",
    "harness ui",
    "```",
    "",
    "Open http://localhost:4400, press **Start building**, and answer the intake",
    "questions (upload your documents right in the form). Build as many apps in",
    "parallel as you like — one browser tab per build.",
    "",
    "First live build: run `harness setup --install-sdk` once (provisions the",
    "Claude Agent SDK into ~/.harness/runtime) and set `ANTHROPIC_API_KEY`.",
    "",
    "Command line instead of the UI:",
    "",
    "```sh",
    "harness run <project-type> --workspace my-app",
    "harness status my-app",
    "```",
  ].join("\n") + "\n",
);

const pack = spawnSync("npm", ["pack", "--pack-destination", path.join(root, "dist-bundle")], {
  cwd: out,
  encoding: "utf8",
});
if (pack.status !== 0) {
  console.error(pack.stderr);
  process.exit(1);
}
const tarball = pack.stdout.trim().split("\n").pop();
const size = Math.round(fs.statSync(path.join(root, "dist-bundle", tarball)).size / 1024);
console.log(`packed dist-bundle/${tarball} (${size} KB)`);
console.log("install anywhere:  npm install -g ./dist-bundle/" + tarball);
console.log("publish:           npm publish dist-pkg/ --access restricted");
