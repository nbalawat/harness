// Single-file distribution: everything a pilot user needs in one harness.cjs
// (node >= 20 required). The Agent SDK stays external/optional — mock and
// certification replays never need it; live runs prompt to install it.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist-bundle", "harness.cjs");

await build({
  entryPoints: [path.join(root, "packages/cli/dist/index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  banner: {
    js: "#!/usr/bin/env node\nconst importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "importMetaUrl" },
  external: ["@anthropic-ai/claude-agent-sdk"],
  logLevel: "warning",
});
// The entry file carries its own shebang, which esbuild preserves below our
// banner — a shebang anywhere but byte 0 is a syntax error. Keep only the first.
const lines = fs.readFileSync(outfile, "utf8").split("\n");
const cleaned = [lines[0], ...lines.slice(1).filter((l) => !l.startsWith("#!"))].join("\n");
fs.writeFileSync(outfile, cleaned);
fs.chmodSync(outfile, 0o755);
const kb = Math.round(fs.statSync(outfile).size / 1024);
console.log(`bundled ${path.relative(root, outfile)} (${kb} KB)`);
