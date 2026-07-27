// Generates the certified module catalog consumed by architecture agents.
// Run after any module change; certify-modules verifies freshness in CI.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesDir = path.join(root, "modules");

const catalog = { modules: [], packs: [] };
for (const name of fs.readdirSync(modulesDir).sort()) {
  const manifestPath = path.join(modulesDir, name, "manifest.yaml");
  if (!fs.existsSync(manifestPath)) continue;
  const m = parse(fs.readFileSync(manifestPath, "utf8"));
  const kind = m.kind ?? "app";
  if (kind === "app") {
    catalog.modules.push({ name: m.name, version: m.version, description: m.description, requires: (m.requires ?? []).filter((r) => typeof r === "string" && fs.existsSync(path.join(modulesDir, r))) });
  } else if (kind === "pack") {
    catalog.packs.push({ name: m.name, description: m.description, modules: m.modules ?? [] });
  }
}
const out = path.join(root, "project-types", "agentic-app", "catalog.json");
fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + "\n");
console.log(`catalog.json: ${catalog.modules.length} modules, ${catalog.packs.length} packs`);
