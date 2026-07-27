// deprecation: inventory + metadata validation.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

export function survey(modulesDir) {
  const deprecated = [];
  const problems = [];
  for (const name of fs.readdirSync(modulesDir)) {
    const manifestPath = path.join(modulesDir, name, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.deprecated) {
      if (!manifest.successor) problems.push(name + " is deprecated without a successor");
      else if (!fs.existsSync(path.join(modulesDir, manifest.successor))) problems.push(name + " successor '" + manifest.successor + "' does not exist");
      else deprecated.push({ name, successor: manifest.successor });
    }
  }
  return { deprecated, problems };
}

if (process.argv[2]) {
  const { deprecated, problems } = survey(process.argv[2]);
  for (const d of deprecated) console.log("deprecated: " + d.name + " -> " + d.successor);
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}
